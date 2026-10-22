import { describe, expect, test } from "bun:test"
import { softWrap } from "../../src/util/soft-wrap"

describe("soft wrap at spaces (10-22)", () => {
  test("breaks at spaces, never inside sum(xs)", () => {
    const text = "Fixed. Now it returns `sum(xs) / len(xs)` and returns 0 for an empty list."
    for (const width of [24, 26, 27, 28, 30]) {
      const lines = softWrap(text, width).split("\n")
      expect(lines.every((line) => line.length <= width)).toBe(true)
      expect(lines.some((line) => line.endsWith("sum("))).toBe(false)
      expect(lines.join(" ")).toBe(text)
    }
  })

  test("list items and quotes keep their shape", () => {
    expect(softWrap("- first item that is long enough to wrap around here", 24)).toBe(
      "- first item that is\n  long enough to wrap\n  around here",
    )
    expect(softWrap("> a quoted line that is long enough to wrap", 22)).toBe("> a quoted line that\n> is long enough to\n> wrap")
  })

  test("headings, tables, short lines and long words are left alone", () => {
    expect(softWrap("# A heading that is long enough to wrap around", 20)).toBe("# A heading that is long enough to wrap around")
    expect(softWrap("| a | b | c | d | e | f | g |", 20)).toBe("| a | b | c | d | e | f | g |")
    expect(softWrap("short", 20)).toBe("short")
    expect(softWrap("see https://example.com/a/very/long/path/that/does/not/fit", 20)).toBe(
      "see\nhttps://example.com/a/very/long/path/that/does/not/fit",
    )
  })

  test("a word that would start a list on the next line stays on the line before", () => {
    const lines = softWrap("the total is about - 5 units or so", 20).split("\n")
    expect(lines.some((line) => /^- /.test(line))).toBe(false)
  })
})
