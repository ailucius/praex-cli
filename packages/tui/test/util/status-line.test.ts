import { describe, expect, test } from "bun:test"
import {
  WORKING_VERBS,
  formatElapsed,
  formatTokenCount,
  formatTook,
  pickVerb,
  toolActivity,
  truncatePath,
} from "../../src/util/status-line"

describe("truncatePath", () => {
  test("leaves a path that fits alone", () => {
    expect(truncatePath("~/dev/praex:main", 40)).toBe("~/dev/praex:main")
  })

  test("keeps the head and as many trailing segments as fit", () => {
    const value = "~/dev/some/deeply/nested/tree/project-folder:main"
    const out = truncatePath(value, 30)
    expect(out.length).toBeLessThanOrEqual(30)
    expect(out.startsWith("~/…/")).toBe(true)
    expect(out.endsWith("project-folder:main")).toBe(true)
  })

  test("absolute paths keep their first segment", () => {
    const out = truncatePath("/tmp/a-very-long-folder-name/another/one/project", 28)
    expect(out.startsWith("/tmp/…/")).toBe(true)
    expect(out.endsWith("/project")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(28)
  })

  test("falls back to a middle cut when the last segment is too long", () => {
    const out = truncatePath("~/x/" + "a".repeat(60), 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toContain("…")
  })

  test("never exceeds the budget", () => {
    const value =
      "/tmp/claude-1000/-home-downoff-Desktop-CLAUDE/1687a3ab/scratchpad/polish/proj/some/deeper/name:master"
    for (const max of [5, 10, 17, 33, 60, 99]) expect(truncatePath(value, max).length).toBeLessThanOrEqual(max)
  })
})

describe("time formats", () => {
  test("elapsed switches to m:ss after a minute", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(14_400)).toBe("14s")
    expect(formatElapsed(65_000)).toBe("1:05")
    expect(formatElapsed(3_723_000)).toBe("1:02:03")
  })

  test("took reads as words", () => {
    expect(formatTook(13_600)).toBe("14s")
    expect(formatTook(125_000)).toBe("2m 05s")
    expect(formatTook(3_840_000)).toBe("1h 04m")
  })

  test("token counts", () => {
    expect(formatTokenCount(340)).toBe("340")
    expect(formatTokenCount(1234)).toBe("1.2k")
    expect(formatTokenCount(2000)).toBe("2k")
    expect(formatTokenCount(18_400)).toBe("18k")
  })
})

describe("verbs and activity", () => {
  test("verb is stable per seed and from the set", () => {
    expect(pickVerb("msg_1")).toBe(pickVerb("msg_1"))
    expect(WORKING_VERBS).toContain(pickVerb("msg_2") as (typeof WORKING_VERBS)[number])
  })

  test("tool activity", () => {
    expect(toolActivity("read", { filePath: "/x/y/hello.py" })).toBe("Reading hello.py")
    expect(toolActivity("edit", { filePath: "/x/hello.py" })).toBe("Editing hello.py")
    expect(toolActivity("bash", { command: "bun test --timeout 5" })).toBe("Running tests")
    expect(toolActivity("bash", { command: "git status" })).toBe("Running git status")
    expect(toolActivity("webfetch", { url: "https://praex.ai/docs" })).toBe("Fetching praex.ai")
    expect(toolActivity("unknown_tool", {})).toBeUndefined()
  })
})
