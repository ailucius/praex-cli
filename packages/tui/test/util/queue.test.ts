import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { joinPrompts, promptFromMessageParts, queuedMessageIDs } from "../../src/util/queue"

const user = (id: string) => ({ id, role: "user", sessionID: "s", time: { created: 1 } }) as unknown as Message
const step = (id: string, completed?: number) =>
  ({ id, role: "assistant", sessionID: "s", time: { created: 1, completed } }) as unknown as Message
const text = (id: string, value: string, synthetic?: boolean) =>
  ({ id: `p_${id}`, messageID: id, sessionID: "s", type: "text", text: value, synthetic }) as unknown as Part

describe("queued messages", () => {
  test("user messages newer than the running step are queued", () => {
    const messages = [user("m1"), step("m2"), user("m3"), user("m4")]
    const parts = { m1: [text("m1", "audit")], m3: [text("m3", "hey")], m4: [text("m4", "and tests")] }
    expect(queuedMessageIDs(messages, parts)).toEqual(["m3", "m4"])
  })

  test("nothing is queued between steps or when the turn is over", () => {
    const parts = { m3: [text("m3", "hey")] }
    expect(queuedMessageIDs([user("m1"), step("m2", 5), user("m3")], parts)).toEqual([])
    expect(queuedMessageIDs([user("m1")], {})).toEqual([])
  })

  test("a hidden background result message is not queued", () => {
    const messages = [user("m1"), step("m2"), user("m3")]
    expect(queuedMessageIDs(messages, { m3: [text("m3", "<task>", true)] })).toEqual([])
  })

  test("a message comes back as its text and attachments", () => {
    const file = { id: "f", messageID: "m3", sessionID: "s", type: "file", mime: "text/plain", url: "file:///a" }
    expect(promptFromMessageParts([text("m3", "hey"), text("m3", "ctx", true), file as unknown as Part])).toEqual({
      input: "hey",
      parts: [{ type: "file", mime: "text/plain", url: "file:///a" }] as never,
    })
  })

  test("prompts join with a blank line and attachments keep their place", () => {
    const at = (start: number, end: number) =>
      ({
        type: "file",
        mime: "text/plain",
        url: "file:///a",
        source: { type: "file", path: "a", text: { value: "@a", start, end } },
      }) as never
    const joined = joinPrompts([
      { input: "fix @a", parts: [at(4, 6)] },
      { input: "see @a", parts: [at(4, 6)] },
    ])
    expect(joined.input).toBe("fix @a\n\nsee @a")
    expect(joined.parts.map((part) => (part as { source: { text: { start: number } } }).source.text.start)).toEqual([
      4, 12,
    ])
  })
})
