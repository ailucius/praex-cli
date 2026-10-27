/** @jsxImportSource @opentui/solid */
// 10-27 (audit9 R9-11): removal events for history the TUI never loaded (session not hydrated,
// or evicted from the 100-message window) must be no-ops, and one throwing handler must not
// drop the other events of the same batch.
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait } from "./sync-fixture"

function event(type: string, properties: Record<string, unknown> = {}) {
  return { directory, project: "proj_test", payload: { id: `evt_${type}_${Math.random()}`, type, properties } } as any
}

function messageUpdated(sessionID: string, messageID: string) {
  return event("message.updated", {
    sessionID,
    info: { id: messageID, sessionID, role: "user", time: { created: 0 } },
  })
}

function captureErrors() {
  const original = console.error
  const calls: unknown[][] = []
  console.error = (...args: unknown[]) => {
    calls.push(args)
  }
  return {
    calls,
    restore: () => {
      console.error = original
    },
  }
}

describe("tui sync: removal of unloaded history (audit9 R9-11)", () => {
  for (const type of ["message.removed", "message.part.removed"] as const) {
    test(`${type} for a session that was never hydrated is a no-op`, async () => {
      await using tmp = await tmpdir()
      await Bun.write(`${tmp.path}/kv.json`, "{}")
      const { app, emit, sync } = await mount(undefined, tmp.path)
      const errors = captureErrors()
      try {
        expect(sync.data.message.ses_unloaded).toBeUndefined()
        expect(sync.data.part.msg_unloaded).toBeUndefined()
        expect(() =>
          emit(event(type, { sessionID: "ses_unloaded", messageID: "msg_unloaded", partID: "prt_unloaded" })),
        ).not.toThrow()
        // The guard, not the handler isolation, must absorb this: nothing may be logged as a failure.
        expect(errors.calls).toEqual([])
        expect(sync.data.message.ses_unloaded).toBeUndefined()
        expect(sync.data.part.msg_unloaded).toBeUndefined()
      } finally {
        errors.restore()
        app.renderer.destroy()
      }
    })
  }

  test("message.removed still removes a loaded message", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)
    try {
      emit(messageUpdated("ses_loaded", "msg_loaded"))
      await wait(() => sync.data.message.ses_loaded?.length === 1)
      emit(event("message.removed", { sessionID: "ses_loaded", messageID: "msg_loaded" }))
      await wait(() => sync.data.message.ses_loaded?.length === 0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a throwing event handler does not drop the rest of the batch", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, sdk } = await mount(undefined, tmp.path)
    const errors = captureErrors()
    const off = sdk.event.on("event", (item) => {
      if ((item.payload.type as string) === "test.boom") throw new Error("boom handler")
    })
    try {
      // The first event flushes immediately; the next two arrive within 16 ms and share one batch.
      emit(event("test.first"))
      emit(event("test.boom"))
      emit(messageUpdated("ses_batch", "msg_batch"))
      await wait(() => sync.data.message.ses_batch?.length === 1)
      expect(errors.calls.some((args) => args.some((arg) => String(arg).includes("boom handler")))).toBe(true)
    } finally {
      off()
      errors.restore()
      app.renderer.destroy()
    }
  })
})
