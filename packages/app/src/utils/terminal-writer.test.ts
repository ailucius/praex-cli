import { describe, expect, test } from "bun:test"
import { terminalWriter } from "./terminal-writer"

describe("terminalWriter", () => {
  test("buffers and flushes once per schedule", () => {
    const calls: string[] = []
    const scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => scheduled.push(flush),
    )

    writer.push("a")
    writer.push("b")
    writer.push("c")

    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    expect(calls).toEqual(["abc"])
  })

  test("flush is a no-op when empty", () => {
    const calls: string[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls.push(data)
        done?.()
      },
      (flush) => flush(),
    )
    writer.flush()
    expect(calls).toEqual([])
  })

  test("flush waits for pending write completion", () => {
    const calls: string[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (data, finish) => {
        calls.push(data)
        done = finish
      },
      (flush) => flush(),
    )

    writer.push("a")

    let settled = false
    writer.flush(() => {
      settled = true
    })

    expect(calls).toEqual(["a"])
    expect(settled).toBe(false)

    done?.()
    expect(settled).toBe(true)
  })

  // 10-27 (audit9 R9-12): ghostty-web acknowledges writes on requestAnimationFrame, so a
  // minimized desktop window holds the callback while PTY output keeps arriving.
  describe("held renderer callback (audit9 R9-12)", () => {
    const KiB = 1024
    const MiB = 1024 * KiB

    function stalled(options?: Parameters<typeof terminalWriter>[2]) {
      const writes: string[] = []
      const callbacks: VoidFunction[] = []
      const scheduled: VoidFunction[] = []
      const writer = terminalWriter(
        (data, done) => {
          writes.push(data)
          if (done) callbacks.push(done)
        },
        (flush) => scheduled.push(flush),
        options,
      )
      const drain = () => {
        while (callbacks.length || scheduled.length) {
          callbacks.shift()?.()
          scheduled.shift()?.()
        }
      }
      return { writer, writes, scheduled, drain }
    }

    test("a backlog is written in bounded slices, not one huge write", () => {
      const { writer, writes, scheduled, drain } = stalled()
      writer.push("first")
      scheduled.shift()?.()
      expect(writes).toEqual(["first"])

      // 6 MiB arrive while the first write is still unacknowledged (below the pending cap).
      const chunks = Array.from({ length: 96 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(64 * KiB))
      for (const chunk of chunks) writer.push(chunk)
      let closed = false
      writer.flush(() => {
        closed = true
      })
      expect(writes).toHaveLength(1)

      drain()
      expect(closed).toBe(true)
      expect(writes.length).toBeGreaterThan(2)
      for (const data of writes) expect(data.length).toBeLessThanOrEqual(256 * KiB)
      // Nothing is lost or reordered below the cap.
      expect(writes.slice(1).join("")).toBe(chunks.join(""))
    })

    test("pending output is capped and the gap is marked instead of silently dropped", () => {
      const { writer, writes, scheduled, drain } = stalled({ hidden: () => true })
      writer.push("first")
      scheduled.shift()?.()

      // 10 MiB while the renderer is stalled: more than the 8 MiB pending cap.
      const total = 160
      for (let i = 0; i < total; i++) writer.push(`<${i}>`.padEnd(64 * KiB, "."))
      drain()

      const out = writes.slice(1).join("")
      expect(out.length).toBeLessThanOrEqual(8 * MiB + 200)
      const marker = out.match(/\[output skipped: ([\d.]+) (KB|MB) while the window was hidden\]/)
      expect(marker).not.toBeNull()
      // The marker comes first and the newest output is kept after it, in order.
      expect(out.indexOf("[output skipped:")).toBeLessThan(out.indexOf(`<${total - 1}>`))
      expect(out.endsWith(`<${total - 1}>`.padEnd(64 * KiB, "."))).toBe(true)
      const skipped = Number(marker![1]) * (marker![2] === "MB" ? MiB : KiB)
      const kept = out.length - out.indexOf("]\r\n") - 3
      expect(skipped + kept).toBeCloseTo(total * 64 * KiB, -5)
      for (const data of writes) expect(data.length).toBeLessThanOrEqual(256 * KiB + 200)
    })

    test("a gap while the window is visible says the terminal fell behind", () => {
      const { writer, writes, scheduled, drain } = stalled({ maxPending: 4 * KiB, maxWrite: KiB, hidden: () => false })
      writer.push("first")
      scheduled.shift()?.()
      for (let i = 0; i < 6; i++) writer.push(String(i).repeat(KiB))
      drain()
      const out = writes.slice(1).join("")
      expect(out).toContain("[output skipped: 2 KB because the terminal fell behind]")
      expect(out.endsWith("2".repeat(KiB) + "3".repeat(KiB) + "4".repeat(KiB) + "5".repeat(KiB))).toBe(true)
      for (const data of writes.slice(1)) expect(data.length).toBeLessThanOrEqual(KiB + 100)
    })

    test("a write that throws does not leave the writer stuck", () => {
      const writes: string[] = []
      const scheduled: VoidFunction[] = []
      let fail = true
      const writer = terminalWriter(
        (data, done) => {
          if (fail) {
            fail = false
            throw new Error("renderer write failed")
          }
          writes.push(data)
          done?.()
        },
        (flush) => scheduled.push(flush),
      )

      writer.push("a")
      expect(() => scheduled.shift()?.()).toThrow("renderer write failed")

      writer.push("b")
      let closed = false
      writer.flush(() => {
        closed = true
      })
      while (scheduled.length) scheduled.shift()?.()
      expect(writes).toEqual(["b"])
      expect(closed).toBe(true)
    })
  })
})
