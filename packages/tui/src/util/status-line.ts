// Pure helpers for the working line, the finished line and the footer. Kept free of
// Solid/opentui so they can be unit tested and reused by the home header.

import type { Part } from "@opencode-ai/sdk/v2"
import { partialToolInput } from "./partial-json"

// Path for a one-line slot: keeps the head ("~" or "/tmp") and as many trailing segments
// as fit, so "~/dev/very/long/tree/project:main" becomes "~/…/tree/project:main".
// Falls back to a plain middle cut when even the last segment does not fit.
export function truncatePath(value: string, max: number): string {
  if (max <= 0) return ""
  if (value.length <= max) return value
  if (max <= 4) return value.slice(-max)
  const parts = value.split("/")
  if (parts.length > 2) {
    const head = parts[0] === "" ? "/" + parts[1] : parts[0]
    const rest = parts[0] === "" ? parts.slice(2) : parts.slice(1)
    let tail = rest[rest.length - 1] ?? ""
    let out = `${head}/…/${tail}`
    if (out.length <= max) {
      for (let i = rest.length - 2; i >= 0; i--) {
        const next = `${rest[i]}/${tail}`
        const candidate = `${head}/…/${next}`
        if (candidate.length > max) break
        tail = next
        out = candidate
      }
      return out
    }
    if (tail.length + 2 <= max) return `…/${tail}`
  }
  const keepStart = Math.ceil((max - 1) / 2)
  const keepEnd = Math.floor((max - 1) / 2)
  return value.slice(0, keepStart) + "…" + value.slice(value.length - keepEnd)
}

// Working-line clock: "14s" under a minute, then "1:05", then "1:02:03".
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
  return `${minutes}:${seconds}`
}

// Finished-line duration: "14s", "2m 05s", "1h 04m".
export function formatTook(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`
}

// "340", "1.2k", "18k".
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${Math.round(n / 1000)}k`
}

// A small, calm set with a light Roman touch. One verb per turn, never per frame.
export const WORKING_VERBS = [
  "Working",
  "Thinking",
  "Considering",
  "Deliberating",
  "Weighing it up",
  "Drafting",
  "Marshalling",
  "Forging",
] as const

export function pickVerb(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return WORKING_VERBS[Math.abs(hash) % WORKING_VERBS.length]
}

function basename(value: string) {
  const trimmed = value.replace(/[\\/]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return index >= 0 ? trimmed.slice(index + 1) : trimmed
}

function short(value: string, max: number) {
  const line = value.split("\n")[0].trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

const TEST_COMMAND =
  /(^|\s|&&|;)(bun test|npm (run )?test|pnpm (run )?test|yarn test|pytest|vitest|jest|go test|cargo test|make test|mix test|rspec)\b/

// What a running tool is doing, phrased for the working line ("Editing hello.py").
// Returns undefined for tools we have nothing useful to say about.
export function toolActivity(tool: string, input: Record<string, unknown> = {}): string | undefined {
  const file = text(input.filePath) ?? text(input.file_path) ?? text(input.path)
  switch (tool) {
    case "read":
      return file ? `Reading ${basename(file)}` : "Reading"
    case "edit":
    case "multiedit":
    case "apply_patch":
      return file ? `Editing ${basename(file)}` : "Editing files"
    case "write":
      return file ? `Writing ${basename(file)}` : "Writing a file"
    case "bash": {
      const command = text(input.command)
      if (command && TEST_COMMAND.test(command)) return "Running tests"
      const description = text(input.description)
      if (description) return short(description, 48)
      return command ? `Running ${short(command, 40)}` : "Running a command"
    }
    case "grep": {
      const pattern = text(input.pattern)
      return pattern ? `Searching for ${short(pattern, 32)}` : "Searching"
    }
    case "glob":
      return "Finding files"
    case "list":
      return "Listing files"
    case "webfetch": {
      const url = text(input.url)
      if (!url) return "Fetching a page"
      try {
        return `Fetching ${new URL(url).host}`
      } catch {
        return "Fetching a page"
      }
    }
    case "websearch":
      return "Searching the web"
    case "task": {
      const description = text(input.description)
      return description ? `Delegating: ${short(description, 40)}` : "Delegating to a subagent"
    }
    case "todowrite":
      return "Updating the plan"
    case "skill":
      return "Loading a skill"
    case "lsp":
      return "Checking diagnostics"
  }
  return undefined
}

// "1 step", "8 steps": the actions a subagent has taken (its tool calls).
export function formatSteps(count: number) {
  return `${count} ${count === 1 ? "step" : "steps"}`
}

// A tool part's input, including what has streamed so far while the call is still pending.
export function toolInput(part: Extract<Part, { type: "tool" }>): Record<string, unknown> {
  if (part.state.status === "pending") return partialToolInput(part.state.raw)
  return (part.state.input ?? {}) as Record<string, unknown>
}

// What a subagent is doing, read from its session's parts in order: how many actions it has
// taken and the newest one, phrased like the working line ("Reading web.py").
export function subagentProgress(parts: readonly Part[]): { steps: number; action?: string } {
  let steps = 0
  let action: string | undefined
  for (const part of parts) {
    if (part.type === "tool") {
      steps++
      const input = toolInput(part)
      // A call still being written names its action once its first field has arrived.
      if (part.state.status === "pending" && Object.keys(input).length === 0) continue
      action = toolActivity(part.tool, input) ?? action
      continue
    }
    if (part.type === "reasoning" && part.time?.end === undefined && part.text.trim()) {
      action = "Thinking"
      continue
    }
    // Text before any action is the subagent planning; after some, it is writing its report.
    if (part.type === "text" && !part.synthetic && part.text.trim())
      action = steps > 0 ? "Writing the report" : "Planning"
  }
  return { steps, action }
}
