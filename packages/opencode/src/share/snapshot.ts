// Praex Share snapshot: the compact, read-only copy of a session that `/share` uploads.
//
// What goes in: the session title, a model label, the creation time, and for each message its
// role, its visible text, and one short line per tool call ("Read src/auth.ts", "Ran `bun test`").
// What never goes in: tool output, file contents (attachments are named, never inlined), text
// the CLI injected on the user's behalf (synthetic parts, e.g. the body of an @-mentioned file),
// reasoning, and absolute paths under the user's home directory. Common credential shapes are
// redacted here, and the gateway scrubs and caps the snapshot again before storing it.
import os from "node:os"
import path from "node:path"
import type * as SDK from "@opencode-ai/sdk/v2"

export const SNAPSHOT_MAX_TEXT = 40_000
export const SNAPSHOT_MAX_TOOLS = 60
export const SNAPSHOT_MAX_TOOL_LINE = 160
export const SNAPSHOT_MAX_MESSAGES = 1000
export const SNAPSHOT_MAX_BYTES = 1_900_000 // the gateway accepts up to 2 MB

export type SnapshotMessage = { role: "user" | "assistant"; text: string; tools?: string[] }
export type Snapshot = {
  id?: string
  title: string
  model: string
  created: number
  messages: SnapshotMessage[]
  trimmed?: number
}

type WithParts = { info: SDK.Message; parts: SDK.Part[] }

// 10-20 audit F3 added Stripe sk_live_/sk_test_, Bearer/Basic headers, npm, Hugging Face, Slack
// webhooks, AWS ASIA keys, URL credentials, mysql -p and uppercase KEY=... env lines.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bwhsec_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted]"],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted]"],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/g, "[redacted]"],
  [/\b(https?|ftp):\/\/[^\s:@/]+:[^\s@/]+@/g, "$1://[redacted]@"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [redacted]"],
  [/(\bmysql(?:dump|admin)?\b[^\n|;&]*?\s-p)(?!\s)\S+/g, "$1[redacted]"],
]
const ASSIGN =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"']{8,})/gi
// .env style: an UPPERCASE name holding KEY anywhere (OPENAI_KEY=, STRIPE_KEY=, KEY=). Case
// sensitive, so prose like "monkey: something" stays.
const ENV_ASSIGN = /\b([A-Z0-9_]*KEY[A-Z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"']{6,})/g
export function redact(s: string): string {
  let out = s
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  out = out.replace(ASSIGN, (_, k, sep) => `${k}${sep}[redacted]`)
  return out.replace(ENV_ASSIGN, (all, k, sep, v) => (v === "[redacted]" ? all : `${k}${sep}[redacted]`))
}

const clip = (s: string, n: number, mark = "…") => (s.length > n ? s.slice(0, n - mark.length) + mark : s)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

type Paths = { directory?: string; home?: string }
// Paths inside the project become relative; anything else under the home directory gets "~".
export function displayPath(p: string, opts: Paths): string {
  if (!p) return p
  const home = opts.home ?? os.homedir()
  if (opts.directory && path.isAbsolute(p)) {
    const rel = path.relative(opts.directory, p)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel
    if (!rel) return "."
  }
  if (home && (p === home || p.startsWith(home + path.sep))) return "~" + p.slice(home.length)
  return p
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

/** One short, human line for a tool call. Never includes tool output. */
export function toolLine(part: SDK.ToolPart, opts: Paths = {}): string {
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const p = (key: string) => displayPath(str(input[key]), opts)
  const failed = part.state?.status === "error" ? " (failed)" : ""
  const line = (() => {
    switch (part.tool) {
      case "read":
        return `Read ${p("filePath")}`
      case "write":
        return `Wrote ${p("filePath")}`
      case "edit":
      case "multiedit":
        return `Edited ${p("filePath")}`
      case "apply_patch": {
        const files = [...str(input.patchText).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
          displayPath(m[1].trim(), opts),
        )
        return files.length ? `Edited ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}` : "Applied a patch"
      }
      case "bash":
      case "shell":
        return `Ran \`${oneLine(str(input.command))}\``
      case "glob":
        return `Searched files: ${str(input.pattern)}`
      case "grep":
        return `Searched for "${str(input.pattern)}"`
      case "list":
        return `Listed ${p("path") || "the project"}`
      case "webfetch":
        return `Fetched ${str(input.url)}`
      case "websearch":
      case "web_search":
        return `Searched the web: ${str(input.query)}`
      case "task":
        return `Ran a subagent: ${str(input.description)}`
      case "todowrite":
        return "Updated the to-do list"
      case "todoread":
        return "Checked the to-do list"
      case "question":
        return "Asked a question"
      case "skill":
        return `Loaded the ${str(input.name)} skill`
      case "lsp":
        return "Checked code intelligence"
      default: {
        const title = part.state?.status === "completed" || part.state?.status === "running" ? str(part.state.title) : ""
        return title ? `${part.tool}: ${title}` : `Used ${part.tool}`
      }
    }
  })()
  return redact(clip(oneLine(line) + failed, SNAPSHOT_MAX_TOOL_LINE))
}

/** The model's display name without the plan suffix the picker adds ("Velox II · Free" -> "Velox II"). */
export function modelLabel(name: string | undefined): string {
  return oneLine(name ?? "").replace(/\s*·\s*(free|pro|max)$/i, "")
}

export function buildSnapshot(input: {
  session: { title?: string; time: { created: number } }
  messages: WithParts[]
  model?: string
  id?: string
  directory?: string
  home?: string
}): Snapshot {
  const opts: Paths = { directory: input.directory, home: input.home }
  const out: SnapshotMessage[] = []
  for (const msg of input.messages) {
    const role = msg.info.role
    if (role !== "user" && role !== "assistant") continue
    // Compaction summaries are the CLI's own bookkeeping, not part of the conversation.
    if (role === "assistant" && (msg.info as SDK.AssistantMessage).summary) continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    const texts: string[] = []
    const tools: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text") {
        if (part.synthetic || part.ignored || !part.text.trim()) continue
        texts.push(part.text.trim())
      } else if (part.type === "tool") {
        tools.push(toolLine(part, opts))
      } else if (part.type === "file") {
        const source = part.source && "path" in part.source ? str(part.source.path) : ""
        tools.push(redact(clip(`Attached ${displayPath(part.filename || source || "a file", opts)}`, SNAPSHOT_MAX_TOOL_LINE)))
      } else if (part.type === "subtask") {
        tools.push(redact(clip(`Ran a subagent: ${oneLine(part.description)}`, SNAPSHOT_MAX_TOOL_LINE)))
      }
    }
    const text = redact(clip(texts.join("\n\n"), SNAPSHOT_MAX_TEXT, "\n\n[Trimmed for the share link]"))
    if (!text && !tools.length) continue
    const kept = tools.slice(0, SNAPSHOT_MAX_TOOLS)
    if (tools.length > SNAPSHOT_MAX_TOOLS) kept.push(`${tools.length - SNAPSHOT_MAX_TOOLS} more tool calls`)
    out.push({ role, text, ...(kept.length ? { tools: kept } : {}) })
  }

  let messages = out.length > SNAPSHOT_MAX_MESSAGES ? out.slice(-SNAPSHOT_MAX_MESSAGES) : out
  let trimmed = out.length - messages.length
  const snapshot = (): Snapshot => ({
    ...(input.id ? { id: input.id } : {}),
    title: redact(clip(oneLine(input.session.title ?? ""), 200)) || "Untitled session",
    model: modelLabel(input.model),
    created: input.session.time.created,
    messages,
    ...(trimmed ? { trimmed } : {}),
  })
  // Over the size cap: drop the oldest messages until it fits (the page says how many).
  while (messages.length > 1 && Buffer.byteLength(JSON.stringify(snapshot())) > SNAPSHOT_MAX_BYTES) {
    const drop = Math.max(1, Math.floor(messages.length / 10))
    messages = messages.slice(drop)
    trimmed += drop
  }
  return snapshot()
}
