import { describe, expect, test } from "bun:test"
import { splitFences } from "../../src/routes/session/index"

describe("splitFences", () => {
  test("prose, fenced code, prose", () => {
    const out = splitFences("Hello\n\n```python\nprint(1)\n```\n\nBye")
    expect(out).toEqual([
      { type: "markdown", text: "Hello" },
      { type: "code", lang: "python", text: "print(1)" },
      { type: "markdown", text: "Bye" },
    ])
  })
  test("unterminated fence while streaming is code", () => {
    const out = splitFences("Start\n```ts\nconst a = 1")
    expect(out.at(-1)).toEqual({ type: "code", lang: "ts", text: "const a = 1" })
  })
  test("no fences -> one markdown segment; tildes and longer fences work", () => {
    expect(splitFences("just text")).toEqual([{ type: "markdown", text: "just text" }])
    const out = splitFences("~~~~\nx\n~~~~\n")
    expect(out).toEqual([{ type: "code", lang: "", text: "x" }])
  })
  test("a shorter closing fence does not close a longer one", () => {
    const out = splitFences("````md\n```\ninner\n```\n````")
    expect(out).toEqual([{ type: "code", lang: "md", text: "```\ninner\n```" }])
  })
  // 10-27: splitFences returns new objects on every streamed delta. Rendered with <For> (keyed by object), each delta
  // remounted the <markdown> and the reply text blinked blank every other frame while streaming. <Index> keeps it.
  test("the reply renders its segments by position, so streaming text never remounts", async () => {
    const src = await Bun.file(new URL("../../src/routes/session/index.tsx", import.meta.url)).text()
    const textPart = src.slice(src.indexOf("function TextPart("), src.indexOf("function ToolPart("))
    expect(textPart).toContain("<Index each={segments()}>")
    expect(textPart).not.toContain("<For each={segments()}>")
  })
})

// 10-27 Tide design (founder's pick): replies open with the tide ∿ in the user's ▎ column; a quick clean finish shows no
// "Done" line, a turn from 20 s on shows "✓ 1m 12s · Velox III" with a gold check.
describe("Tide reply design", () => {
  test("replies carry the tide mark and quick turns drop the done line", async () => {
    const src = await Bun.file(new URL("../../src/routes/session/index.tsx", import.meta.url)).text()
    const textPart = src.slice(src.indexOf("function TextPart("), src.indexOf("function ToolPart("))
    expect(textPart).toContain("<ReplyMark live={!props.message.time.completed} />")
    const { DONE_LINE_MIN_MS } = await import("../../src/routes/session/index")
    expect(DONE_LINE_MIN_MS).toBe(20_000)
    expect(src).not.toContain("Done${duration()")
  })
})
