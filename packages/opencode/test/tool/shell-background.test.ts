// 10-28: background shell commands (src/tool/shell/background.ts). POSIX only: process groups and sh.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import * as Background from "../../src/tool/shell/background"

const posix = process.platform !== "win32"
const sh = "/bin/sh"
const waitFor = <T>(get: () => T | undefined, ms = 5000) =>
  new Promise<T>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const value = get()
      if (value !== undefined) return resolve(value)
      if (Date.now() - t0 > ms) return reject(new Error("timed out"))
      setTimeout(tick, 25)
    }
    tick()
  })

describe.if(posix)("background shell commands", () => {
  test("returns at once, logs the output, and reports the exit code and last lines", async () => {
    let exit: Background.Exit | undefined
    const t0 = Date.now()
    const started = Background.start({
      shell: sh,
      command: "echo one; sleep 0.3; echo two; exit 3",
      cwd: os.tmpdir(),
      env: process.env,
      onExit: (e) => (exit = e),
    })
    expect(Date.now() - t0).toBeLessThan(250)
    expect(started.pid).toBeGreaterThan(0)
    expect(started.log.startsWith(Background.logDir())).toBe(true)
    const done = await waitFor(() => exit)
    expect(done.code).toBe(3)
    expect(done.signal).toBeNull()
    expect(done.tail).toBe("one\ntwo")
    expect(fs.readFileSync(started.log, "utf8")).toBe("one\ntwo\n")
  })

  test("the stop hint stops the command and what it started (process group)", async () => {
    let exit: Background.Exit | undefined
    const started = Background.start({
      shell: sh,
      command: "sleep 30 & sleep 30; wait",
      cwd: os.tmpdir(),
      env: process.env,
      onExit: (e) => (exit = e),
    })
    expect(Background.stopHint(started.pid)).toBe(`kill -- -${started.pid}`)
    process.kill(-started.pid, "SIGTERM")
    const done = await waitFor(() => exit)
    expect(done.signal).toBe("SIGTERM")
    // nothing of the group is left
    expect(() => process.kill(-started.pid, 0)).toThrow()
  })

  test("stopAll ends every command still running (Praex exiting)", async () => {
    const exits: Background.Exit[] = []
    for (let i = 0; i < 2; i++)
      Background.start({ shell: sh, command: "sleep 30", cwd: os.tmpdir(), env: process.env, onExit: (e) => exits.push(e) })
    expect(Background.runningCount()).toBe(2)
    Background.stopAll()
    expect(Background.runningCount()).toBe(0)
    await waitFor(() => (exits.length === 2 ? true : undefined))
    expect(exits.every((e) => e.signal === "SIGTERM")).toBe(true)
  })

  test("tail reads only the end of a big log and drops a cut first line", () => {
    const file = path.join(os.tmpdir(), `praex-bg-tail-${process.pid}.log`)
    fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n")
    const out = Background.tail(file, 3, 100)
    expect(out).toBe("line 4997\nline 4998\nline 4999")
    expect(Background.tail(file + ".missing")).toBe("")
    fs.rmSync(file)
  })

  test("a shell that cannot start fails at once and does not crash the process", () => {
    expect(() =>
      Background.start({ shell: "/nonexistent/sh", command: "true", cwd: os.tmpdir(), env: process.env, onExit: () => {} }),
    ).toThrow()
  })
})
