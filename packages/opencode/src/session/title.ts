// 10-22: small models sometimes answer the first message instead of titling it ("Tokyo" for "Name the
// capital of Japan in one word."). A title of one or two words that shares no word with a request of
// four words or more is taken for an answer, and the request itself, shortened, becomes the title.
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 1 || /\d/.test(word))

export function answered(title: string, request: string) {
  const asked = words(request)
  const named = words(title)
  if (asked.length < 4 || named.length === 0 || named.length > 2) return false
  // "Debugging" titles "debug": a shared start of four letters counts as the same word
  const same = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4))
  return !named.some((word) => asked.some((other) => same(word, other)))
}

export function fromRequest(request: string, max = 50) {
  // "@src/auth.ts" reads as "auth.ts"
  const text = request
    .replace(/@(\S+)/g, (_, file: string) => file.split("/").pop() ?? file)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.?!:;,]+$/, "")
  const short = text.length <= max ? text : text.slice(0, text.lastIndexOf(" ", max) > 20 ? text.lastIndexOf(" ", max) : max).trimEnd()
  return short.charAt(0).toUpperCase() + short.slice(1)
}

export * as SessionTitle from "./title"
