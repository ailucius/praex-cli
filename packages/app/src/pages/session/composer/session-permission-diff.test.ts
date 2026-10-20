import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/sdk/v2/client"
import { permissionDiffs } from "./session-permission-diff"

const request = (input: Partial<PermissionRequest>) =>
  ({
    id: "perm_1",
    sessionID: "ses_1",
    permission: "edit",
    patterns: ["src/app.ts"],
    metadata: {},
    always: ["*"],
    ...input,
  }) as PermissionRequest

const patch = [
  "===================================================================",
  "--- /w/src/app.ts\t",
  "+++ /w/src/app.ts\t",
  "@@ -1,3 +1,3 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  " const c = 4",
  "",
].join("\n")

describe("permissionDiffs", () => {
  test("reads the diff of an edit or write request, named by its pattern", () => {
    const [entry, ...rest] = permissionDiffs(request({ metadata: { filepath: "/w/src/app.ts", diff: patch } }))
    expect(rest).toHaveLength(0)
    expect(entry).toEqual({ file: "src/app.ts", patch, additions: 1, deletions: 1, truncated: undefined })
  })

  test("carries the server's truncation note", () => {
    const [entry] = permissionDiffs(
      request({ metadata: { filepath: "/w/src/app.ts", diff: patch, diffTruncated: { shown: 400, total: 9000 } } }),
    )
    expect(entry.truncated).toEqual({ shown: 400, total: 9000 })
  })

  test("splits apply_patch requests into one entry per file", () => {
    const entries = permissionDiffs(
      request({
        patterns: ["src/app.ts", "src/b.ts"],
        metadata: {
          filepath: "src/app.ts, src/b.ts",
          diff: patch + patch,
          files: [
            { filePath: "/w/src/app.ts", relativePath: "src/app.ts", type: "update", patch },
            {
              filePath: "/w/src/b.ts",
              relativePath: "src/b.ts",
              type: "add",
              patch: "@@ -0,0 +1 @@\n+export {}\n",
              truncated: { shown: 20, total: 80 },
            },
            { filePath: "/w/src/gone.ts", relativePath: "src/gone.ts", type: "delete", patch: "" },
          ],
        },
      }),
    )
    expect(entries.map((entry) => entry.file)).toEqual(["src/app.ts", "src/b.ts"])
    expect(entries[1]).toMatchObject({ additions: 1, deletions: 0, truncated: { shown: 20, total: 80 } })
  })

  test("shows nothing for other permissions or an edit without a diff", () => {
    expect(permissionDiffs(request({ permission: "bash", patterns: ["ls"], metadata: { diff: patch } }))).toEqual([])
    expect(permissionDiffs(request({ metadata: { filepath: "/w/src/app.ts" } }))).toEqual([])
    expect(permissionDiffs(request({ metadata: { diff: "   " } }))).toEqual([])
  })
})
