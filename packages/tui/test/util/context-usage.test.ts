import { describe, expect, test } from "bun:test"
import { contextUsage } from "../../src/util/context-usage"

const msg = (input: number, output: number, cacheRead = 0) =>
  ({
    role: "assistant",
    tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } },
  }) as any

describe("contextUsage", () => {
  test("label is the last turn's context size out of the window", () => {
    // Reported on velox-ii-baked: a 9943-token prompt against 32k read "1", then "9.9K (0% of context)".
    const out = contextUsage([msg(9_943, 1)], 32_768)
    expect(out?.label).toBe("9.9K of 32.8K")
    expect(out?.pct).toBe(30)
  })
  test("uses the latest answered turn, counting cached tokens", () => {
    const out = contextUsage([msg(9_943, 1), msg(6_000, 400, 4_000)], 32_768)
    expect(out?.label).toBe("10.4K of 32.8K")
  })
  test("no limit -> raw token count", () => {
    expect(contextUsage([msg(1_000, 50)], undefined)?.label).toBe("1.1K")
  })
  test("no answered message -> undefined", () => {
    expect(contextUsage([msg(1_000, 0)], 32_768)).toBeUndefined()
  })
  test("over the limit caps the percent at 100", () => {
    expect(contextUsage([msg(40_000, 10)], 32_768)?.pct).toBe(100)
  })
})
