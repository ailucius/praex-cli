// Edit permission requests carry the proposed change (`metadata.diff`, and `metadata.files` for
// apply_patch) so a client can show it before the user approves. A full-file write or a large
// patch would otherwise push an unbounded payload to every client, including a phone on Remote
// Control, so the preview is capped here. The cut keeps the text a valid unified patch: whole
// lines only, and the hunk that gets cut has its header counts rewritten to match what is kept.

export const MAX_LINES = 400
export const MAX_CHARS = 64_000
// Each apply_patch file keeps at least this much, so a long first file cannot hide the rest.
const FILE_FLOOR = { lines: 20, chars: 2_000 }

export type Limit = { lines: number; chars: number }
export type Truncated = { shown: number; total: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

function split(diff: string) {
  const lines = diff.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function bound(diff: string, limit: Limit = { lines: MAX_LINES, chars: MAX_CHARS }) {
  const lines = split(diff)
  if (lines.length <= limit.lines && diff.length <= limit.chars) return { diff }

  const kept: string[] = []
  let chars = 0
  for (const line of lines) {
    if (kept.length >= limit.lines) break
    const cost = line.length + 1
    if (chars + cost > limit.chars) {
      // One very long line (minified code) would otherwise hide everything after the headers.
      const room = limit.chars - chars - 1
      if (room > 1 && /^[ +-]/.test(line) && !line.startsWith("---") && !line.startsWith("+++"))
        kept.push(line.slice(0, room))
      break
    }
    kept.push(line)
    chars += cost
  }

  const header = kept.findLastIndex((line) => line.startsWith("@@"))
  if (header !== -1) {
    const body = kept.slice(header + 1)
    if (body.length === 0) kept.splice(header, 1)
    else {
      const match = HUNK.exec(kept[header])
      if (match) {
        const removed = body.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
        const added = body.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
        kept[header] = `@@ -${match[1]},${removed} +${match[3]},${added} @@${match[5]}`
      }
    }
  }

  return {
    diff: kept.join("\n") + "\n",
    truncated: { shown: kept.length, total: lines.length } satisfies Truncated,
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

// Bounds the diff fields of an edit permission request's metadata. Anything else passes through.
export function metadata(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input }

  if (typeof input.diff === "string") {
    const result = bound(input.diff)
    next.diff = result.diff
    if (result.truncated) next.diffTruncated = result.truncated
  }

  if (Array.isArray(input.files)) {
    const left = { lines: MAX_LINES, chars: MAX_CHARS }
    next.files = input.files.map((file) => {
      if (!record(file) || typeof file.patch !== "string") return file
      const result = bound(file.patch, {
        lines: Math.max(left.lines, FILE_FLOOR.lines),
        chars: Math.max(left.chars, FILE_FLOOR.chars),
      })
      left.lines -= split(result.diff).length
      left.chars -= result.diff.length
      if (!result.truncated) return file
      return { ...file, patch: result.diff, truncated: result.truncated }
    })
  }

  return next
}

export * as PermissionDiff from "./diff"
