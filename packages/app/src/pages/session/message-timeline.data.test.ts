import { describe, expect, mock, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

// The real message-part module pulls in client-only Solid components; the grouping it
// provides is not what these tests are about.
mock.module("@opencode-ai/ui/message-part", () => ({
  renderable: (part: Part) => (part.type === "text" || part.type === "reasoning") && !!part.text?.trim(),
  groupParts: (refs: { messageID: string; part: Part }[]) =>
    refs.map((ref) => ({ type: "part", key: ref.part.id, ref })),
}))
const { Timeline } = await import("./message-timeline.data")

const user = { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 1 } } as unknown as UserMessage

function assistant(id: string, summary: boolean) {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: user.id,
    summary,
    mode: summary ? "compaction" : "build",
    finish: "stop",
    time: { created: 2, completed: 3 },
  } as unknown as AssistantMessage
}

const template = "## Goal\n(none)\n\n## Constraints & Preferences\n(none)\n\n## Next Steps\n(none)"

function rows(parts: Record<string, Part[]>, assistants: AssistantMessage[]) {
  return Timeline.constructMessageRows(user, (id) => parts[id] ?? [], assistants, 1, "idle", false)
}

describe("Timeline.constructMessageRows compaction", () => {
  test("shows the divider and hides the summary template", () => {
    const result = rows(
      {
        [user.id]: [{ id: "prt_c", type: "compaction", auto: true } as unknown as Part],
        msg_summary: [{ id: "prt_t", type: "text", text: template } as unknown as Part],
      },
      [assistant("msg_summary", true)],
    )
    const tags = result.map((row) => row._tag)
    expect(tags).toContain("TurnDivider")
    expect(tags).not.toContain("AssistantPart")
  })

  test("still renders ordinary assistant replies", () => {
    const result = rows({ msg_reply: [{ id: "prt_r", type: "text", text: "hello" } as unknown as Part] }, [
      assistant("msg_reply", false),
    ])
    expect(result.map((row) => row._tag)).toContain("AssistantPart")
  })
})

describe("Timeline.constructMessageRows thinking", () => {
  const streaming = { ...assistant("msg_live", false), time: { created: 2 } } as unknown as AssistantMessage
  const busy = (parts: Record<string, Part[]>) =>
    Timeline.constructMessageRows(user, (id) => parts[id] ?? [], [streaming], 1, "busy", true).map((row) => row._tag)

  test("shows one Thinking status before anything streams", () => {
    expect(busy({}).filter((tag) => tag === "Thinking")).toHaveLength(1)
  })

  test("hands over to the reasoning row once thinking streams, never both", () => {
    const tags = busy({
      msg_live: [
        { id: "prt_think", type: "reasoning", text: "Weighing options", time: { start: 2 } } as unknown as Part,
      ],
    })
    expect(tags).toContain("AssistantPart")
    expect(tags).not.toContain("Thinking")
  })
})

describe("Timeline.constructMessageRows stopped replies", () => {
  const reply = { msg_reply: [{ id: "prt_r", type: "text", text: "The story begins and then" } as unknown as Part] }
  const dividers = (message: AssistantMessage) =>
    rows(reply, [message]).flatMap((row) => (row._tag === "TurnDivider" ? [row.label] : []))

  test("10-22: a reply cut at the output limit says so", () => {
    expect(dividers({ ...assistant("msg_reply", false), finish: "length" } as AssistantMessage)).toEqual(["cutoff"])
  })

  test("an interrupted reply shows Interrupted, not a cut-off", () => {
    const aborted = {
      ...assistant("msg_reply", false),
      finish: undefined,
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    } as unknown as AssistantMessage
    expect(dividers(aborted)).toEqual(["interrupted"])
  })

  test("a finished reply has no divider", () => {
    expect(dividers(assistant("msg_reply", false))).toEqual([])
  })
})
