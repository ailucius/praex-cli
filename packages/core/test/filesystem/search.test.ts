import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { artifact } from "@opencode-ai/core/filesystem/artifact"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Ripgrep.defaultLayer)

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        expect(result.map((item) => item.path)).toEqual([RelativePath.make(path.join("src", "match.ts"))])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make(path.join("src", "match.ts")))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

describe("file finder skips build artifacts (10-22)", () => {
  const cases: [string, boolean][] = [
    ["__pycache__/calc.cpython-314.pyc", true],
    ["src/__pycache__/x.py", true],
    ["calc.pyc", true],
    ["node_modules/react/index.js", true],
    ["build/Main.class", true],
    ["deep/.DS_Store", true],
    ["src/calc.py", false],
    ["README.md", false],
    ["docs/objects.md", false],
    ["dist/app.js", false],
  ]
  for (const [file, skipped] of cases)
    it.live(`${skipped ? "skips" : "keeps"} ${file}`, () => Effect.sync(() => expect(artifact(file)).toBe(skipped)))
})
