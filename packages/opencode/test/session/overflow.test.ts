import { describe, expect, test } from "bun:test"
import { compactionPlan, overheadHint, SUMMARY_ESTIMATE } from "../../src/session/overflow"

// Hosted Praex tiers: 32768 context, 8192 output, so 24576 usable; the compaction tail keeps
// 25% of usable (6144 tokens) verbatim.
const HOSTED = { usable: 24_576, preserve: 6_144 }

describe("session.overflow.compactionPlan", () => {
  test("skips compaction when the fixed prompt alone fills a small window", () => {
    // ~22K of system prompt + tools + MCP, ~3K of actual conversation.
    const plan = compactionPlan({ ...HOSTED, count: 25_000, conversation: 3_000 })
    expect(plan.worthwhile).toBe(false)
    expect(plan.overhead).toBe(22_000)
    expect(plan.freed).toBe(0)
  })

  test("skips compaction on the first turn, when there is nothing to summarise", () => {
    const plan = compactionPlan({ ...HOSTED, count: 26_000, conversation: 400 })
    expect(plan.worthwhile).toBe(false)
    expect(plan.overhead).toBe(25_600)
  })

  test("skips compaction right after a compaction (summary + tail is all that is left)", () => {
    // What made it loop: summary (~1.5K) + kept tail (~6K) on top of ~18K overhead still
    // overflows, and compacting again would produce the same thing.
    const plan = compactionPlan({ ...HOSTED, count: 25_500, conversation: SUMMARY_ESTIMATE + 6_000 })
    expect(plan.worthwhile).toBe(false)
  })

  test("compacts when the conversation is what fills the window", () => {
    const plan = compactionPlan({ ...HOSTED, count: 25_000, conversation: 17_000 })
    expect(plan.worthwhile).toBe(true)
    expect(plan.overhead).toBe(8_000)
    expect(plan.freed).toBe(17_000 - 6_144 - SUMMARY_ESTIMATE)
  })

  test("keeps upstream behavior for large-context models", () => {
    // 200K context, 32K output: a long conversation always compacts.
    const large = { usable: 168_000, preserve: 8_000 }
    expect(compactionPlan({ ...large, count: 170_000, conversation: 140_000 }).worthwhile).toBe(true)
    // Freeing 8K+ is enough on a large window even if most of it is overhead.
    expect(compactionPlan({ ...large, count: 170_000, conversation: 20_000 }).worthwhile).toBe(true)
  })

  test("never reports negative overhead when the estimate exceeds the real count", () => {
    const plan = compactionPlan({ ...HOSTED, count: 10_000, conversation: 30_000 })
    expect(plan.overhead).toBe(0)
    expect(plan.worthwhile).toBe(true)
  })
})

describe("session.overflow.overheadHint", () => {
  test("names the overhead and the window in one plain line", () => {
    const hint = overheadHint({ overhead: 22_400, context: 32_768, modelName: "Velox II" })
    expect(hint).toBe(
      "Tools and instructions use ~22K of Velox II's 32K context. Disable unused MCP servers or skills to make room for the conversation.",
    )
    expect(hint).not.toContain("\n")
  })

  test("drops the plan suffix from hosted model names", () => {
    expect(overheadHint({ overhead: 23_000, context: 32_768, modelName: "Velox II · Free" })).toStartWith(
      "Tools and instructions use ~23K of Velox II's 32K context.",
    )
  })

  test("falls back to wording without a number when the overhead is unknown", () => {
    expect(overheadHint({ overhead: 0, context: 32_768 })).toStartWith(
      "Tools and instructions use most of the model's 32K context.",
    )
  })
})
