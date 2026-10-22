import type { Message, Part } from "@opencode-ai/sdk/v2"

// Long sessions read cleanly when routine work folds away: once a turn is over, a run of
// consecutive steps that only read, searched or ran commands collapses to one calm line
// ("Read 3 files · ran 2 commands") that opens on click. Edits, subagents, plans, questions,
// failures and anything the model wrote stay as they are. A turn that is still running is
// never folded, so nothing above the live output moves while it streams.

const PHRASES: Record<string, [string, string]> = {
  read: ["read 1 file", "read # files"],
  bash: ["ran 1 command", "ran # commands"],
  glob: ["searched 1 time", "searched # times"],
  grep: ["searched 1 time", "searched # times"],
  list: ["listed 1 folder", "listed # folders"],
  webfetch: ["fetched 1 page", "fetched # pages"],
  websearch: ["searched the web once", "searched the web # times"],
  skill: ["loaded 1 skill", "loaded # skills"],
  lsp: ["checked diagnostics once", "checked diagnostics # times"],
}

const QUIET_PARTS = new Set(["step-start", "step-finish", "reasoning", "snapshot", "patch"])

export type WorkGroup = {
  // The first step of the run; it carries the summary line.
  id: string
  members: string[]
  tools: number
  summary: string
}

export function workSummary(tools: readonly string[]) {
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const phrase = PHRASES[tool]
    if (!phrase) continue
    const key = phrase[1]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const phrases = [...counts].map(([plural, count]) => {
    const entry = Object.values(PHRASES).find((item) => item[1] === plural)!
    return count === 1 ? entry[0] : plural.replace("#", String(count))
  })
  const text = phrases.join(" · ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function groupable(message: Message, parts: readonly Part[]) {
  if (message.role !== "assistant" || message.summary || message.error) return
  if (message.finish !== "tool-calls" || !message.time.completed) return
  const tools: string[] = []
  for (const part of parts) {
    if (part.type === "tool") {
      if (part.state.status !== "completed" || !PHRASES[part.tool]) return
      tools.push(part.tool)
      continue
    }
    if (part.type === "text" && !part.text.trim()) continue
    if (!QUIET_PARTS.has(part.type)) return
  }
  return tools.length ? tools : undefined
}

function final(message: Message) {
  return (
    message.role === "assistant" &&
    !!message.time.completed &&
    !!message.finish &&
    !["tool-calls", "unknown"].includes(message.finish)
  )
}

// Maps each folded step's message id to its group. `idle` is whether the session has stopped.
export function groupWork(
  messages: readonly Message[],
  parts: Readonly<Record<string, readonly Part[] | undefined>>,
  idle: boolean,
): Map<string, WorkGroup> {
  const out = new Map<string, WorkGroup>()
  // A step is folded only once a later step finished its turn (or the session stopped).
  const lastFinal = messages.findLast(final)?.id ?? ""
  let run: { members: string[]; tools: string[] } | undefined
  const flush = () => {
    if (run && run.tools.length >= 2) {
      const group = {
        id: run.members[0]!,
        members: run.members,
        tools: run.tools.length,
        summary: workSummary(run.tools),
      }
      for (const id of run.members) out.set(id, group)
    }
    run = undefined
  }
  for (const message of messages) {
    const own = parts[message.id] ?? []
    if (message.role === "user") {
      if (own.some((part) => part.type === "text" && !part.synthetic && part.text.trim())) flush()
      continue
    }
    const tools = groupable(message, own)
    if (!tools || !(idle || message.id < lastFinal)) {
      flush()
      continue
    }
    run ??= { members: [], tools: [] }
    run.members.push(message.id)
    run.tools.push(...tools)
  }
  flush()
  return out
}
