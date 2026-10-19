import { describe, expect, test } from "bun:test"
import { readPartText, reasoningState, thoughtSeconds } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("thoughtSeconds", () => {
  test("rounds to whole seconds", () => {
    expect(thoughtSeconds(12_400)).toBe(12)
    expect(thoughtSeconds(12_600)).toBe(13)
  })

  test("never reads below one second", () => {
    expect(thoughtSeconds(0)).toBe(1)
    expect(thoughtSeconds(109)).toBe(1)
  })

  test("keeps counting past a minute", () => {
    expect(thoughtSeconds(72_000)).toBe(72)
  })
})

describe("reasoningState", () => {
  test("is thinking while the part has no end and the message is open", () => {
    expect(reasoningState({ time: { start: 1_000 } })).toEqual({ thinking: true })
  })

  test("is done with the part's own duration", () => {
    expect(reasoningState({ time: { start: 1_000, end: 13_000 } }, 99_000)).toEqual({ thinking: false, ms: 12_000 })
  })

  test("a finished message closes a part that never got an end", () => {
    expect(reasoningState({ time: { start: 1_000 } }, 5_000)).toEqual({ thinking: false, ms: 4_000 })
  })

  test("bad clocks read as done, not as a negative duration", () => {
    expect(reasoningState({ time: { start: 9_000, end: 1_000 } })).toEqual({ thinking: false, ms: 0 })
  })
})
