// @ts-nocheck
import { For } from "solid-js"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { DataProvider } from "../context/data"
import { FileComponentProvider } from "../context/file"
import { AssistantParts } from "./message-part"

// The thinking row in its four states: streaming and done, folded and open.

const SESSION_ID = "ses_reasoning_story"
const NOW = 1_760_000_000_000

const THINKING = `**Reading the request**

The user wants the retry logic moved out of the fetch wrapper so the queue owns backoff. The wrapper currently retries three times with a fixed 500ms delay, which fights the queue's own exponential schedule.

**Weighing options**

I could keep a thin retry in the wrapper for network resets only, or remove it entirely and let the queue see every failure. Removing it is simpler and keeps one source of truth for timing.

**Checking callers**

Two other modules call the wrapper directly: the health check and the settings sync. The health check should not retry at all, and the settings sync already has its own loop, so neither depends on the wrapper's retries.`

const LONG_THINKING = [THINKING, THINKING.replaceAll("wrapper", "client"), THINKING].join("\n\n")

const ANSWER = `Move the retries into the queue and make the fetch wrapper a single attempt.

1. Delete \`retry()\` from \`fetch-wrapper.ts\`.
2. Let \`queue.ts\` apply its exponential backoff to every failure.
3. The health check and settings sync need no change.`

function assistant(id: string, done: boolean): AssistantMessage {
  return {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    parentID: "msg_user",
    time: done ? { created: NOW, completed: NOW + 20_000 } : { created: NOW },
    modelID: "faber-ii",
    providerID: "praex",
    mode: "build",
    agent: "build",
    path: { cwd: "/project", root: "/project" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

function reasoning(id: string, text: string, ms?: number): Part {
  return {
    id,
    sessionID: SESSION_ID,
    messageID: id.replace("prt", "msg"),
    type: "reasoning",
    text,
    time: ms === undefined ? { start: NOW } : { start: NOW, end: NOW + ms },
  } as Part
}

function text(id: string, value: string): Part {
  return { id, sessionID: SESSION_ID, messageID: id, type: "text", text: value, time: { start: NOW } } as Part
}

const cases = [
  {
    label: "Streaming, folded",
    open: false,
    message: assistant("msg_a", false),
    parts: [reasoning("prt_a", THINKING)],
  },
  {
    label: "Streaming, open",
    open: true,
    message: assistant("msg_b", false),
    parts: [reasoning("prt_b", THINKING)],
  },
  {
    label: "Done, folded",
    open: false,
    message: assistant("msg_c", true),
    parts: [reasoning("prt_c", THINKING, 12_300), text("prt_c_text", ANSWER)],
  },
  {
    label: "Done, open, long",
    open: true,
    message: assistant("msg_d", true),
    parts: [reasoning("prt_d", LONG_THINKING, 72_000), text("prt_d_text", ANSWER)],
  },
]

function Gallery() {
  const data = {
    session: [{ id: SESSION_ID, title: "Thinking row" }],
    session_status: {},
    session_diff: {},
    message: { [SESSION_ID]: cases.map((item) => item.message) },
    part: Object.fromEntries(cases.map((item) => [item.message.id, item.parts])),
    provider: { all: new Map([["praex", { id: "praex", models: { "faber-ii": { name: "Faber II" } } }]]) },
  }

  return (
    <DataProvider data={data} directory="/project">
      <FileComponentProvider component={() => null}>
        <div
          style={{ "max-width": "720px", margin: "0 auto", display: "flex", "flex-direction": "column", gap: "28px" }}
        >
          <For each={cases}>
            {(item) => (
              <section style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                <div style={{ "font-size": "11px", color: "var(--text-weaker)", "letter-spacing": "0.02em" }}>
                  {item.label}
                </div>
                <div
                  data-slot="session-turn-assistant-content"
                  style={{ display: "flex", "flex-direction": "column", gap: "12px" }}
                >
                  <AssistantParts messages={[item.message]} showReasoningSummaries={item.open} />
                </div>
              </section>
            )}
          </For>
        </div>
      </FileComponentProvider>
    </DataProvider>
  )
}

export default {
  title: "UI/ReasoningPart",
  id: "components-reasoning-part",
  component: Gallery,
}

export const States = {
  render: () => <Gallery />,
}
