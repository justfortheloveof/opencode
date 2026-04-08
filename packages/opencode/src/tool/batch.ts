import z from "zod"
import { Effect, Exit, Cause } from "effect"
import { Tool } from "./tool"
import { PartID } from "../session/schema"
import { errorMessage } from "../util/error"
import type { Session } from "../session"
import type { Agent } from "../agent/agent"
import type { Plugin } from "../plugin"
import DESCRIPTION from "./batch.txt"

const DISALLOWED = new Set(["batch"])
const HIDDEN = new Set(["invalid", "apply_patch", ...DISALLOWED])

const parameters = z.object({
  tool_calls: z
    .array(
      z.object({
        tool: z.string().describe("The name of the tool to execute"),
        parameters: z.object({}).loose().describe("Parameters for the tool"),
      }),
    )
    .min(1, "Provide at least one tool call")
    .describe("Array of tool calls to execute in parallel"),
})

type Params = z.infer<typeof parameters>
type Call = Params["tool_calls"][number]

type Result =
  | { success: true; tool: string; result: Tool.ExecuteResult }
  | { success: false; tool: string; error: unknown }

function formatValidationError(error: z.ZodError) {
  const errors = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root"
      return `  - ${path}: ${issue.message}`
    })
    .join("\n")

  return `Invalid parameters for tool 'batch':\n${errors}\n\nExpected payload format:\n  [{"tool": "tool_name", "parameters": {...}}, {...}]`
}

export function makeBatch(deps: {
  all: Tool.Def[]
  sessions: Session.Interface
  agents: Agent.Interface
  plugin: Plugin.Interface
}): Tool.Def {
  const map = new Map(deps.all.map((t) => [t.id, t]))

  const fail = (pid: PartID, call: Call, ctx: Tool.Context, start: number, msg: string): Effect.Effect<Result> =>
    deps.sessions
      .updatePart({
        id: pid,
        messageID: ctx.messageID,
        sessionID: ctx.sessionID,
        type: "tool",
        tool: call.tool,
        callID: pid,
        state: {
          status: "error",
          input: call.parameters,
          error: msg,
          time: { start, end: Date.now() },
        },
      })
      .pipe(Effect.map(() => ({ success: false as const, tool: call.tool, error: new Error(msg) })))

  const run = (call: Call, ctx: Tool.Context): Effect.Effect<Result> => {
    const start = Date.now()
    const pid = PartID.ascending()

    return Effect.gen(function* () {
      if (DISALLOWED.has(call.tool))
        return yield* fail(
          pid,
          call,
          ctx,
          start,
          `Tool '${call.tool}' is not allowed in batch. Disallowed: ${Array.from(DISALLOWED).join(", ")}`,
        )

      const tool = map.get(call.tool)
      if (!tool) {
        const names = Array.from(map.keys()).filter((n) => !HIDDEN.has(n))
        return yield* fail(
          pid,
          call,
          ctx,
          start,
          `Tool '${call.tool}' not in registry. External tools (MCP, environment) cannot be batched - call them directly. Available: ${names.join(", ")}`,
        )
      }
      const exec = Effect.gen(function* () {
        const args = tool.parameters.parse(call.parameters)

        yield* deps.sessions.updatePart({
          id: pid,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: pid,
          state: {
            status: "running",
            input: call.parameters,
            time: { start },
          },
        })

        const ask: typeof ctx.ask = (req) => ctx.ask({ ...req, tool: { messageID: ctx.messageID, callID: pid } })
        const metadata: typeof ctx.metadata = (val) =>
          deps.sessions
            .updatePart({
              id: pid,
              messageID: ctx.messageID,
              sessionID: ctx.sessionID,
              type: "tool",
              tool: call.tool,
              callID: pid,
              state: {
                status: "running",
                title: val.title,
                metadata: val.metadata,
                input: call.parameters,
                time: { start },
              },
            })
            .pipe(Effect.asVoid)

        yield* deps.plugin.trigger(
          "tool.execute.before",
          { tool: call.tool, sessionID: ctx.sessionID, callID: pid },
          { args },
        )

        const result = yield* tool.execute(args, { ...ctx, callID: pid, ask, metadata })

        yield* deps.plugin.trigger(
          "tool.execute.after",
          { tool: call.tool, sessionID: ctx.sessionID, callID: pid, args },
          result,
        )
        const attachments = result.attachments?.map((a) => ({
          ...a,
          id: PartID.ascending(),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
        }))

        yield* deps.sessions.updatePart({
          id: pid,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: call.tool,
          callID: pid,
          state: {
            status: "completed",
            input: call.parameters,
            output: result.output,
            title: result.title,
            metadata: result.metadata,
            attachments,
            time: { start, end: Date.now() },
          },
        })

        return { success: true as const, tool: call.tool, result }
      })

      const exit = yield* Effect.exit(exec)
      if (Exit.isFailure(exit)) return yield* fail(pid, call, ctx, start, errorMessage(Cause.squash(exit.cause)))
      return exit.value
    })
  }

  return {
    id: "batch",
    description: DESCRIPTION,
    parameters,
    formatValidationError,
    execute: (params: Params, ctx) =>
      Effect.gen(function* () {
        const parsed = parameters.safeParse(params)
        if (!parsed.success) throw new Error(formatValidationError(parsed.error))

        const calls = params.tool_calls.slice(0, 25)
        const excess = params.tool_calls.slice(25)

        const results: Result[] = yield* Effect.forEach(calls, (call) => run(call, ctx), {
          concurrency: "unbounded",
        })

        const now = Date.now()
        for (const call of excess) {
          const pid = PartID.ascending()
          yield* deps.sessions.updatePart({
            id: pid,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: pid,
            state: {
              status: "error",
              input: call.parameters,
              error: "Maximum of 25 tools allowed in batch",
              time: { start: now, end: now },
            },
          })
          results.push({
            success: false as const,
            tool: call.tool,
            error: new Error("Maximum of 25 tools allowed in batch"),
          })
        }

        const ok = results.filter((r) => r.success).length
        const failed = results.length - ok

        const output =
          failed > 0
            ? `Executed ${ok}/${results.length} tools successfully. ${failed} failed.`
            : `All ${ok} tools executed successfully.\n\nKeep using the batch tool for optimal performance in your next response!`

        return {
          title: `Batch execution (${ok}/${results.length} successful)`,
          output,
          attachments: results
            .filter((r): r is Extract<Result, { success: true }> => r.success)
            .flatMap((r) => r.result.attachments ?? []),
          metadata: {
            totalCalls: results.length,
            successful: ok,
            failed,
            tools: params.tool_calls.map((c) => c.tool),
            details: results.map((r) => ({ tool: r.tool, success: r.success })),
          },
        }
      }),
  }
}
