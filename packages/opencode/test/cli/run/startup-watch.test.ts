import { afterEach, describe, expect, test } from "bun:test"
import { StartupWatch } from "../../../src/cli/cmd/run/startup-watch"

afterEach(() => StartupWatch.stop())

describe("run startup deadline (10-22)", () => {
  test("defaults to 60 s and reads PRAEX_RUN_START_TIMEOUT", () => {
    expect(StartupWatch.seconds({})).toBe(60)
    expect(StartupWatch.seconds({ PRAEX_RUN_START_TIMEOUT: "5" })).toBe(5)
    expect(StartupWatch.seconds({ PRAEX_RUN_START_TIMEOUT: "nope" })).toBe(60)
    expect(StartupWatch.seconds({ PRAEX_RUN_START_TIMEOUT: "0" })).toBe(60)
  })

  test("names the step it was stuck in and where to look", () => {
    const text = StartupWatch.message("creating the session", 60, "/data/praex")
    expect(text).toContain("did not start within 60 s (stuck while creating the session)")
    expect(text).toContain("/data/praex")
    expect(text).toContain("--print-logs")
  })

  test("fires with the latest step, and not at all once stopped", async () => {
    const fired: string[] = []
    process.env.PRAEX_RUN_START_TIMEOUT = "0.05"
    try {
      StartupWatch.start((step) => fired.push(step))
      StartupWatch.step("loading providers and models")
      await Bun.sleep(120)
      expect(fired).toEqual(["loading providers and models"])

      StartupWatch.start((step) => fired.push(step))
      StartupWatch.stop()
      await Bun.sleep(120)
      expect(fired).toHaveLength(1)
    } finally {
      delete process.env.PRAEX_RUN_START_TIMEOUT
    }
  })
})
