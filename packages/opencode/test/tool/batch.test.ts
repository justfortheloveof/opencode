import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { Permission } from "../../src/permission"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

const config = { experimental: { batch_tool: true } }

const ctx = {
  sessionID: SessionID.make("ses_test-batch"),
  messageID: MessageID.make("msg_test-batch"),
  callID: "call_test-batch",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await Instance.disposeAll()
})

function getBatch(registry: ToolRegistry.Interface) {
  return Effect.gen(function* () {
    const tools = yield* registry.all()
    const batch = tools.find((t) => t.id === "batch")
    if (!batch) return yield* Effect.die("batch tool not found in registry")
    return batch
  })
}

describe("tool.batch", () => {
  describe("parameter validation", () => {
    it.live("rejects empty tool_calls array", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const exit = yield* Effect.exit(batch.execute({ tool_calls: [] }, ctx))
            expect(exit._tag).toBe("Failure")
          }),
        { config },
      ),
    )

    it.live("rejects item missing tool field", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const exit = yield* Effect.exit(batch.execute({ tool_calls: [{ parameters: {} }] } as any, ctx))
            expect(exit._tag).toBe("Failure")
          }),
        { config },
      ),
    )
  })

  describe("disallowed tools", () => {
    it.live("rejects batch to prevent self-recursion", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute({ tool_calls: [{ tool: "batch", parameters: {} }] }, ctx)
            expect(result.metadata.failed).toBe(1)
            expect(result.metadata.successful).toBe(0)
            expect(result.output).toContain("1 failed")
          }),
        { config },
      ),
    )

    it.live("disallowed tool does not stop other calls", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "batch", parameters: {} },
                  { tool: "glob", parameters: { pattern: "*" } },
                ],
              },
              ctx,
            )
            expect(result.metadata.successful).toBe(1)
            expect(result.metadata.failed).toBe(1)
            expect(result.metadata.totalCalls).toBe(2)
          }),
        { config },
      ),
    )
  })

  describe("tool resolution", () => {
    it.live("rejects unknown tool name", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute({ tool_calls: [{ tool: "fake_tool", parameters: {} }] }, ctx)
            expect(result.metadata.failed).toBe(1)
            expect(result.output).toContain("1 failed")
          }),
        { config },
      ),
    )
  })

  describe("successful execution", () => {
    it.live("executes single tool call", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute({ tool_calls: [{ tool: "glob", parameters: { pattern: "*" } }] }, ctx)
            expect(result.metadata.successful).toBe(1)
            expect(result.metadata.failed).toBe(0)
          }),
        { config },
      ),
    )

    it.live("executes multiple tools in parallel", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "glob", parameters: { pattern: "*.ts" } },
                  { tool: "glob", parameters: { pattern: "*.json" } },
                ],
              },
              ctx,
            )
            expect(result.metadata.successful).toBe(3)
            expect(result.metadata.failed).toBe(0)
            expect(result.metadata.totalCalls).toBe(3)
          }),
        { config },
      ),
    )

    it.live("returns all-success output message", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "glob", parameters: { pattern: "*.json" } },
                ],
              },
              ctx,
            )
            expect(result.output).toContain("All 2 tools executed successfully")
            expect(result.output).toContain("Keep using the batch tool")
          }),
        { config },
      ),
    )
  })

  describe("partial failure", () => {
    it.live("succeeds for valid and fails for invalid", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "nonexistent", parameters: {} },
                ],
              },
              ctx,
            )
            expect(result.metadata.successful).toBe(1)
            expect(result.metadata.failed).toBe(1)
            expect(result.metadata.details).toEqual([
              { tool: "glob", success: true },
              { tool: "nonexistent", success: false },
            ])
          }),
        { config },
      ),
    )

    it.live("returns mixed-result output message", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "nonexistent", parameters: {} },
                ],
              },
              ctx,
            )
            expect(result.output).toContain("Executed 1/2 tools successfully. 1 failed.")
          }),
        { config },
      ),
    )
  })

  describe("excess beyond limit", () => {
    it.live(
      "handles exactly 25 calls without excess errors",
      () =>
        provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const batch = yield* getBatch(registry)
              const calls = Array.from({ length: 25 }, () => ({
                tool: "glob",
                parameters: { pattern: "*" },
              }))
              const result = yield* batch.execute({ tool_calls: calls }, ctx)
              expect(result.metadata.successful).toBe(25)
              expect(result.metadata.failed).toBe(0)
              expect(result.metadata.totalCalls).toBe(25)
            }),
          { config },
        ),
      30_000,
    )

    it.live(
      "rejects excess calls beyond 25",
      () =>
        provideTmpdirInstance(
          () =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const batch = yield* getBatch(registry)
              const calls = Array.from({ length: 27 }, () => ({
                tool: "glob",
                parameters: { pattern: "*" },
              }))
              const result = yield* batch.execute({ tool_calls: calls }, ctx)
              expect(result.metadata.totalCalls).toBe(27)
              expect(result.metadata.successful).toBe(25)
              expect(result.metadata.failed).toBe(2)
              expect(result.output).toContain("2 failed")
            }),
          { config },
        ),
      30_000,
    )
  })

  describe("permission delegation", () => {
    it.live("ask override includes tool field with batch-internal callID", () =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(dir, "src"), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(dir, "src", "test.txt"), "hello"))

            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const captured: Array<Omit<Permission.Request, "id" | "sessionID">> = []
            const next = {
              ...ctx,
              ask: (req: Omit<Permission.Request, "id" | "sessionID">) => {
                captured.push(req)
                return Effect.void
              },
            }
            yield* batch.execute({ tool_calls: [{ tool: "glob", parameters: { pattern: "*" } }] }, next)
            expect(captured.length).toBeGreaterThan(0)
            const req = captured[0]
            expect(req.tool).toBeDefined()
            expect(req.tool!.messageID).toBe(ctx.messageID)
            expect(req.tool!.callID).toBeDefined()
            expect(req.tool!.callID).not.toBe(ctx.callID)
          }),
        { config },
      ),
    )
  })

  describe("inner tool validation", () => {
    it.live("reports error for sub-tool with invalid parameters", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute({ tool_calls: [{ tool: "glob", parameters: {} }] }, ctx)
            expect(result.metadata.failed).toBe(1)
            expect(result.metadata.successful).toBe(0)
          }),
        { config },
      ),
    )
  })

  describe("output format", () => {
    it.live("returns correct title format", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "nonexistent", parameters: {} },
                ],
              },
              ctx,
            )
            expect(result.title).toBe("Batch execution (1/2 successful)")
          }),
        { config },
      ),
    )

    it.live("returns metadata with expected shape", () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const batch = yield* getBatch(registry)
            const result = yield* batch.execute(
              {
                tool_calls: [
                  { tool: "glob", parameters: { pattern: "*" } },
                  { tool: "glob", parameters: { pattern: "*.json" } },
                ],
              },
              ctx,
            )
            expect(result.metadata.totalCalls).toBe(2)
            expect(result.metadata.successful).toBe(2)
            expect(result.metadata.failed).toBe(0)
            expect(result.metadata.tools).toEqual(["glob", "glob"])
            expect(result.metadata.details).toEqual([
              { tool: "glob", success: true },
              { tool: "glob", success: true },
            ])
          }),
        { config },
      ),
    )
  })
})
