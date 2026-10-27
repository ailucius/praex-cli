// 10-27: the busy indicator used to be an 8-cell blocks scanner repainting every 40 ms (founder: "flashing pixels when
// the model is streaming"). It is now one glyph at a calm rate; keep it that way.
import { describe, expect, test } from "bun:test"
import { BUSY_FRAMES, BUSY_INTERVAL_MS, busyElapsed } from "../../../src/cli/cmd/run/footer.view"

describe("footer busy indicator", () => {
  test("every frame is one terminal cell, so the status line never shifts", () => {
    for (const frame of BUSY_FRAMES) expect(Bun.stringWidth(frame)).toBe(1)
  })

  test("repaints at most ~10 times a second", () => {
    expect(BUSY_INTERVAL_MS).toBeGreaterThanOrEqual(100)
  })

  test("elapsed time reads like Claude Code's: seconds, then minutes and seconds", () => {
    expect(busyElapsed(0)).toBe("0s")
    expect(busyElapsed(12_400)).toBe("12s")
    expect(busyElapsed(185_000)).toBe("3m 05s")
    expect(busyElapsed(-50)).toBe("0s")
  })
})
