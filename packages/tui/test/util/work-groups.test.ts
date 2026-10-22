import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { groupWork, workSummary } from "../../src/util/work-groups"

const user = (id: string) => ({ id, role: "user", sessionID: "s", time: { created: 1 } }) as unknown as Message
const step = (id: string, finish = "tool-calls", extra: Record<string, unknown> = {}) =>
  ({
    id,
    role: "assistant",
    sessionID: "s",
    finish,
    time: { created: 1, completed: 2 },
    ...extra,
  }) as unknown as Message
const tool = (id: string, name: string, status = "completed") =>
  ({ id: `${id}_${name}`, messageID: id, type: "tool", tool: name, state: { status } }) as unknown as Part
const text = (id: string, value: string) =>
  ({ id: `${id}_t`, messageID: id, type: "text", text: value }) as unknown as Part

describe("work summary", () => {
  test("counts by kind in order of first use, sentence case", () => {
    expect(workSummary(["bash", "read", "bash", "read", "read", "grep", "glob"])).toBe(
      "Ran 2 commands · read 3 files · searched 2 times",
    )
    expect(workSummary(["read"])).toBe("Read 1 file")
  })
})

describe("groupWork", () => {
  const turn = [user("m1"), step("m2"), step("m3"), step("m4"), step("m5", "stop")]
  const parts = {
    m1: [text("m1", "audit")],
    m2: [tool("m2", "read")],
    m3: [tool("m3", "bash"), tool("m3", "read")],
    m4: [tool("m4", "grep")],
    m5: [text("m5", "Done.")],
  }

  test("folds consecutive routine steps of a finished turn into one group", () => {
    const groups = groupWork(turn, parts, true)
    const group = groups.get("m2")
    expect(group).toEqual({
      id: "m2",
      members: ["m2", "m3", "m4"],
      tools: 4,
      summary: "Read 2 files · ran 1 command · searched 1 time",
    })
    expect(groups.get("m4")).toBe(group!)
    expect(groups.has("m5")).toBe(false)
  })

  test("never folds a turn that is still running", () => {
    const running = [user("m1"), step("m2"), step("m3"), step("m4")]
    expect(groupWork(running, parts, false).size).toBe(0)
    // An earlier, finished turn still folds while a new one runs.
    const both = [...turn, user("m6"), step("m7"), step("m8")]
    const more = { ...parts, m6: [text("m6", "next")], m7: [tool("m7", "read")], m8: [tool("m8", "read")] }
    const groups = groupWork(both, more, false)
    expect(groups.get("m2")?.members).toEqual(["m2", "m3", "m4"])
    expect(groups.has("m7")).toBe(false)
  })

  test("edits, failures, text and single calls stay visible", () => {
    const mixed = [user("m1"), step("m2"), step("m3"), step("m4"), step("m5"), step("m6", "stop")]
    const groups = groupWork(
      mixed,
      {
        m2: [tool("m2", "read")],
        m3: [tool("m3", "edit")],
        m4: [tool("m4", "bash", "error")],
        m5: [text("m5", "Now the tests"), tool("m5", "bash")],
        m6: [text("m6", "ok")],
      },
      true,
    )
    expect(groups.size).toBe(0)
  })

  test("a message the user sent mid-turn splits the run", () => {
    const split = [user("m1"), step("m2"), user("m3"), step("m4"), step("m5", "stop")]
    const groups = groupWork(
      split,
      { m2: [tool("m2", "read"), tool("m2", "read")], m3: [text("m3", "hey")], m4: [tool("m4", "bash")], m5: [] },
      true,
    )
    expect(groups.get("m2")?.members).toEqual(["m2"])
    expect(groups.has("m4")).toBe(false)
  })
})
