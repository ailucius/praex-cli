// Reads the fields of a tool call's arguments while the model is still streaming them.
// The server publishes the head of the raw JSON for a pending tool part (see
// TOOL_INPUT_PREVIEW_MAX in the server's processor), so this has to cope with a cut-off
// object. Only fields that have fully arrived are returned: half a path or half a command
// would make the row jump ("Reading tmp", then "Reading 1687a3ab", ...).

const FIELD = /"((?:[^"\\]|\\.)*)"\s*:\s*/y
const STRING_BODY = /((?:[^"\\]|\\.)*)/y

function unescape(body: string) {
  // Drop a trailing escape that has not fully arrived ("\" or "\u00").
  const safe = body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")
  try {
    return JSON.parse(`"${safe}"`) as string
  } catch {
    return safe
  }
}

export function partialToolInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  const text = raw.trim()
  if (!text.startsWith("{")) return {}
  try {
    const value = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}

  const out: Record<string, unknown> = {}
  let index = 1
  while (index < text.length) {
    // Skip whitespace and commas between fields.
    while (index < text.length && /[\s,]/.test(text[index]!)) index++
    if (text[index] !== '"') break
    FIELD.lastIndex = index
    const field = FIELD.exec(text)
    if (!field) break
    const key = unescape(field[1]!)
    index = FIELD.lastIndex
    const next = text[index]
    if (next === undefined) break
    if (next === '"') {
      STRING_BODY.lastIndex = index + 1
      const body = STRING_BODY.exec(text)
      const value = body?.[1] ?? ""
      index = index + 1 + value.length
      if (text[index] !== '"') break
      out[key] = unescape(value)
      index++
      continue
    }
    // A number at the very end may still be streaming, so it needs a delimiter after it.
    const scalar = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[\s,}])/.exec(text.slice(index))
    if (scalar) {
      out[key] = JSON.parse(scalar[1]!)
      index += scalar[1]!.length
      continue
    }
    // Nested objects and arrays are not needed for previews: skip them whole, or stop if
    // they have not finished streaming.
    const end = skipNested(text, index)
    if (end === undefined) break
    index = end
  }
  return out
}

function skipNested(text: string, start: number) {
  const open = text[start]
  if (open !== "{" && open !== "[") return
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return
}
