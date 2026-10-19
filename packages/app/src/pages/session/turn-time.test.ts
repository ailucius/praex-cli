import { describe, expect, test } from "bun:test"
import { formatTurnTime } from "./turn-time"

describe("formatTurnTime", () => {
  const now = new Date(2026, 9, 19, 9, 30).getTime()
  test("today and yesterday read as relative days", () => {
    expect(formatTurnTime(new Date(2026, 9, 19, 8, 5).getTime(), "en-US", now)).toBe("Today 8:05 AM")
    expect(formatTurnTime(new Date(2026, 9, 18, 23, 51).getTime(), "en-US", now)).toBe("Yesterday 11:51 PM")
  })
  test("this week shows the weekday, older shows the date", () => {
    expect(formatTurnTime(new Date(2026, 9, 15, 15, 40).getTime(), "en-US", now)).toBe("Thu 3:40 PM")
    expect(formatTurnTime(new Date(2026, 8, 2, 15, 40).getTime(), "en-US", now)).toBe("Sep 2, 3:40 PM")
  })
})
