import { describe, expect, test } from "bun:test"
import { isQueuedUserMessage } from "../../src/session/queued"

const user = (id: string) => ({ info: { id, role: "user" } })
const assistant = (id: string, parentID: string) => ({ info: { id, role: "assistant", parentID } })

describe("isQueuedUserMessage", () => {
  test("a user message no step has read yet is queued", () => {
    const messages = [user("msg_1"), assistant("msg_2", "msg_1"), user("msg_3")]
    expect(isQueuedUserMessage(messages, "msg_3")).toBe(true)
  })

  test("a message a later step answered or read is not queued", () => {
    const messages = [user("msg_1"), assistant("msg_2", "msg_1"), user("msg_3"), assistant("msg_4", "msg_3")]
    expect(isQueuedUserMessage(messages, "msg_3")).toBe(false)
    expect(isQueuedUserMessage(messages, "msg_1")).toBe(false)
  })

  test("only user messages that exist can be queued", () => {
    const messages = [user("msg_1"), assistant("msg_2", "msg_1")]
    expect(isQueuedUserMessage(messages, "msg_2")).toBe(false)
    expect(isQueuedUserMessage(messages, "msg_9")).toBe(false)
  })
})
