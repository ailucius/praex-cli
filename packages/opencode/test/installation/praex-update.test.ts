import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { checkDigest, swapInto } from "../../src/installation/praex-update"

describe("praex self-update", () => {
  test("parallel updates each stage their own file; the result is a complete binary and nothing is left over", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "praex-swap-"))
    const dest = path.join(dir, "praex")
    await fs.writeFile(dest, "old")
    const sources = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const file = path.join(dir, `src-${i}`)
        await fs.writeFile(file, `build-${i}-`.repeat(200_000))
        return file
      }),
    )
    await Promise.all(sources.map((s) => swapInto(s, dest)))
    const final = await fs.readFile(dest, "utf8")
    expect(final).toMatch(/^(build-\d-)+$/)
    expect(final.length).toBe("build-0-".length * 200_000)
    expect((await fs.stat(dest)).mode & 0o777).toBe(0o755)
    const left = (await fs.readdir(dir)).filter((f) => f.startsWith(".praex-update"))
    expect(left).toEqual([])
  })

  test("a failed swap removes its staged file and leaves the old binary", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "praex-swap-"))
    const dest = path.join(dir, "praex")
    await fs.writeFile(dest, "old")
    await expect(swapInto(path.join(dir, "missing"), dest)).rejects.toThrow()
    expect(await fs.readFile(dest, "utf8")).toBe("old")
    expect((await fs.readdir(dir)).filter((f) => f.startsWith(".praex-update"))).toEqual([])
  })

  test("the digest check still refuses a tarball that does not match", () => {
    const bytes = new TextEncoder().encode("release")
    const good = createHash("sha256").update(bytes).digest("hex")
    expect(() => checkDigest(bytes, good)).not.toThrow()
    expect(() => checkDigest(bytes, good.toUpperCase())).not.toThrow()
    expect(() => checkDigest(bytes, "0".repeat(64))).toThrow("checksum mismatch")
  })
})
