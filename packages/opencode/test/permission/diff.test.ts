import { describe, expect, test } from "bun:test"
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff"
import { PermissionDiff } from "../../src/permission/diff"

const numbered = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n"

describe("permission diff preview", () => {
  test("passes a small diff through unchanged", () => {
    const diff = createTwoFilesPatch("a.txt", "a.txt", "one\ntwo\n", "one\nthree\n")
    const result = PermissionDiff.bound(diff)
    expect(result.diff).toBe(diff)
    expect(result.truncated).toBeUndefined()
  })

  test("caps a large new file and keeps a valid patch", () => {
    const diff = createTwoFilesPatch("big.txt", "big.txt", "", numbered(2000))
    const result = PermissionDiff.bound(diff, { lines: 50, chars: 64_000 })

    expect(result.truncated).toEqual({ shown: 50, total: diff.trimEnd().split("\n").length })
    expect(result.diff.trimEnd().split("\n")).toHaveLength(50)
    // The cut hunk header matches the kept lines, so the preview parses and applies cleanly.
    const [parsed] = parsePatch(result.diff)
    const body = parsed.hunks[0].lines.length
    expect(parsed.hunks[0].newLines).toBe(body)
    expect(applyPatch("", result.diff)).toBe(numbered(body))
  })

  test("caps by characters when lines are long", () => {
    const long = "x".repeat(10_000)
    const diff = createTwoFilesPatch("min.js", "min.js", "", `${long}\n${long}\n${long}\n`)
    const result = PermissionDiff.bound(diff, { lines: 400, chars: 12_000 })
    expect(result.diff.length).toBeLessThanOrEqual(12_000)
    expect(result.truncated).toBeDefined()
  })

  test("drops a hunk header that lost all of its lines", () => {
    const before = numbered(200)
    const after = before.replace("line 5\n", "line five\n").replace("line 150\n", "line 150 changed\n")
    const diff = createTwoFilesPatch("a.txt", "a.txt", before, after)
    const lines = diff.trimEnd().split("\n")
    const second = lines.findLastIndex((line) => line.startsWith("@@"))
    const result = PermissionDiff.bound(diff, { lines: second + 1, chars: 64_000 })

    expect(result.diff.trimEnd().split("\n").filter((line) => line.startsWith("@@"))).toHaveLength(1)
    expect(applyPatch(before, result.diff)).toBe(before.replace("line 5\n", "line five\n"))
  })

  test("metadata bounds diff and apply_patch files and flags the cut", () => {
    const big = createTwoFilesPatch("big.txt", "big.txt", "", numbered(3000))
    const small = createTwoFilesPatch("small.txt", "small.txt", "a\n", "b\n")
    const result = PermissionDiff.metadata({
      filepath: "big.txt, small.txt",
      diff: big + small,
      files: [
        { filePath: "/w/big.txt", type: "add", patch: big },
        { filePath: "/w/small.txt", type: "update", patch: small },
      ],
    })

    expect(result.filepath).toBe("big.txt, small.txt")
    expect((result.diff as string).split("\n").length).toBeLessThanOrEqual(PermissionDiff.MAX_LINES + 1)
    expect(result.diffTruncated).toMatchObject({ shown: PermissionDiff.MAX_LINES })
    const files = result.files as Array<Record<string, unknown>>
    expect(files[0].truncated).toBeDefined()
    // The second file still gets its own preview after the first used up the shared budget.
    expect(files[1].patch).toBe(small)
    expect(files[1].truncated).toBeUndefined()
  })
})
