import { describe, expect, test } from "bun:test"
import { allowanceLine, leftText, planLabel, resetsIn } from "../../src/util/praex-account"

describe("Praex allowance lines (10-22)", () => {
  const now = Date.parse("2026-10-22T19:00:00Z")

  test("plan, share left and reset time", () => {
    expect(
      allowanceLine({ signedIn: true, plan: "free", left: 0.623, resetsAt: "2026-10-23T00:00:00Z" }, now),
    ).toBe("Free plan · 62% of today's allowance left · resets in 5 h")
    expect(allowanceLine({ signedIn: true, plan: "max" }, now)).toBe("Max plan")
  })

  test("edges: used up, under 1%, minutes, past reset", () => {
    expect(leftText(0)).toBe("today's allowance is used up")
    expect(leftText(0.004)).toBe("under 1% of today's allowance left")
    expect(resetsIn("2026-10-22T19:40:00Z", now)).toBe("40 min")
    expect(resetsIn("2026-10-22T18:00:00Z", now)).toBe("soon")
    expect(planLabel(undefined)).toBe("Praex plan")
  })
})
