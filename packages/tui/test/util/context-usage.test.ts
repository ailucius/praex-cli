import { describe, expect, test } from "bun:test"
import { contextUsage } from "../../src/util/context-usage"

const msg = (input: number, output: number, cacheRead = 0) =>
  ({
    role: "assistant",
    tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } },
  }) as any

describe("contextUsage", () => {
  test("first turn on a fixed-prefix model reads as nearly empty, not 63%", () => {
    // 20.6k prompt (prefix) + 90 output against a 32k window
    const out = contextUsage([msg(20_600, 90)], 32_768)
    expect(out?.label).toBe("20.7K (1% of context)")
  })
  test("conversation growth is measured against the room left after the prefix", () => {
    const out = contextUsage([msg(20_600, 90), msg(26_700, 400)], 32_768)
    // prefix 20.6k; last total 27.1k -> used 6.5k of 12.2k room ≈ 53%
    expect(out?.pct).toBe(53)
    expect(out?.label).toBe("27.1K (53% of context)")
  })
  test("label is the formatted context size, never the raw conversation delta", () => {
    // Reported on velox-ii-baked: 9943-token prompt against 32k; the meter read "1" then "24".
    const first = contextUsage([msg(9_943, 1)], 32_768)
    expect(first?.label).toBe("9.9K (0% of context)")
    const second = contextUsage([msg(9_943, 1), msg(9_960, 7)], 32_768)
    expect(second?.label).toBe("10.0K (0% of context)")
  })
  test("no limit -> raw token count", () => {
    expect(contextUsage([msg(1_000, 50)], undefined)?.label).toBe("1.1K")
  })
  test("no answered message -> undefined", () => {
    expect(contextUsage([msg(1_000, 0)], 32_768)).toBeUndefined()
  })
  test("prefix above the limit falls back to the raw share, capped at 100", () => {
    const out = contextUsage([msg(40_000, 10)], 32_768)
    expect(out?.pct).toBe(100)
  })
})
