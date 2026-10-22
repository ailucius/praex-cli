// 10-22: the terminal renderer's word wrap also breaks after "(", "/", "." and "-", so a reply could end
// a line with "sum(" and start the next with "xs)". Paragraph, list and quote lines are wrapped here at
// spaces first, before the renderer sees them. Raw characters are counted, so concealed markup (``, **)
// only makes a line a little shorter than it could be, never longer. A single word wider than the line
// (a long URL or path) is still left to the renderer. Headings, tables and HTML are left alone, and a
// word that would start a list, quote or heading on the new line stays on the line before.
const SKIP = /^\s*(#|\||<|```|~~~|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$)/
const STARTS_BLOCK = /^([-+*>#|]|\d+[.)]|```|~~~)$/

const width = (text: string) => (typeof Bun !== "undefined" ? Bun.stringWidth(text) : text.length)

function wrapLine(line: string, max: number) {
  if (width(line) <= max || SKIP.test(line)) return line
  const lead =
    line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)/)?.[1] ?? line.match(/^(\s*>\s?)/)?.[1] ?? line.match(/^(\s*)/)?.[1] ?? ""
  // continuation lines keep a quote's ">" and line up under a list item's text
  const indent = lead.includes(">") ? lead : " ".repeat(width(lead))
  const words = line.slice(lead.length).match(/\S+\s*/g) ?? []
  const out: string[] = []
  let current = lead
  for (const word of words) {
    const bare = word.trimEnd()
    const fits = width(current) + width(bare) <= max
    const empty = current.trim() === "" || current === indent
    if (fits || empty || STARTS_BLOCK.test(bare)) {
      current += word
      continue
    }
    out.push(current.trimEnd())
    current = indent + word
  }
  out.push(current.trimEnd())
  return out.join("\n")
}

export function softWrap(text: string, max: number) {
  if (!Number.isFinite(max) || max < 20) return text
  return text
    .split("\n")
    .map((line) => wrapLine(line, max))
    .join("\n")
}
