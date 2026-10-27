// 10-27 (audit9 R9-12): bounded drain. ghostty-web acknowledges a write on requestAnimationFrame,
// so a hidden or minimized window holds the callback while PTY output keeps arriving. The whole
// backlog used to be joined into one write of any size. Now each write takes at most WRITE_LIMIT
// characters and at most PENDING_LIMIT characters wait in the queue. Past that the oldest queued
// output is dropped and a visible marker is written in its place. Reconnecting with the cursor
// cannot fill that gap: the server replay buffer keeps only the last 2 MiB and would skip
// anything older without telling the client.
const WRITE_LIMIT = 256 * 1024
const PENDING_LIMIT = 8 * 1024 * 1024

export type TerminalWriterOptions = {
  maxWrite?: number
  maxPending?: number
  hidden?: () => boolean
}

const documentHidden = () => typeof document !== "undefined" && document.hidden === true
const highSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const lowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

function size(chars: number) {
  if (chars < 1024 * 1024) return `${Math.max(1, Math.round(chars / 1024))} KB`
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

export function terminalWriter(
  write: (data: string, done?: VoidFunction) => void,
  schedule: (flush: VoidFunction) => void = queueMicrotask,
  options: TerminalWriterOptions = {},
) {
  const maxWrite = Math.max(1, options.maxWrite ?? WRITE_LIMIT)
  const maxPending = Math.max(1, options.maxPending ?? PENDING_LIMIT)
  const hidden = options.hidden ?? documentHidden
  let chunks: string[] = []
  let head = 0
  let pending = 0
  let skipped = 0
  let skippedHidden = false
  let waits: VoidFunction[] | undefined
  let scheduled = false
  let writing = false

  const queued = () => head < chunks.length || skipped > 0

  const compact = () => {
    if (head === chunks.length) {
      chunks = []
      head = 0
      return
    }
    if (head > 1024 && head * 2 > chunks.length) {
      chunks = chunks.slice(head)
      head = 0
    }
  }

  const settle = () => {
    if (scheduled || writing || queued()) return
    const list = waits
    if (!list?.length) return
    waits = undefined
    for (const fn of list) {
      fn()
    }
  }

  const marker = () => {
    const reason = skippedHidden ? "while the window was hidden" : "because the terminal fell behind"
    const text = `[output skipped: ${size(skipped)} ${reason}]`
    skipped = 0
    skippedHidden = false
    // ESC ends any escape sequence the dropped output left open; SGR 0 keeps the marker readable.
    return `\x1b[0m\r\n${text}\r\n`
  }

  const take = () => {
    const parts: string[] = []
    if (skipped > 0) parts.push(marker())
    let budget = maxWrite
    while (head < chunks.length && budget > 0) {
      const chunk = chunks[head]
      if (chunk.length <= budget) {
        parts.push(chunk)
        budget -= chunk.length
        pending -= chunk.length
        head += 1
        continue
      }
      // Split a large chunk, never between the two halves of a surrogate pair.
      let cut = budget
      if (highSurrogate(chunk.charCodeAt(cut - 1))) cut = cut > 1 ? cut - 1 : parts.length ? 0 : cut + 1
      if (cut > 0) {
        parts.push(chunk.slice(0, cut))
        chunks[head] = chunk.slice(cut)
        pending -= cut
      }
      break
    }
    compact()
    return parts.join("")
  }

  const run = () => {
    if (writing) return
    scheduled = false
    if (!queued()) {
      settle()
      return
    }
    const data = take()
    writing = true
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      writing = false
      if (queued()) {
        if (scheduled) return
        scheduled = true
        schedule(run)
        return
      }
      settle()
    }
    try {
      write(data, done)
    } catch (error) {
      // A throwing write must not leave `writing` set, or nothing would ever be written again.
      done()
      throw error
    }
  }

  const push = (input: string) => {
    if (!input) return
    let data = input
    if (pending + data.length > maxPending) {
      if (data.length >= maxPending) {
        skipped += pending
        chunks = []
        head = 0
        pending = 0
        let cut = data.length - maxPending
        if (cut > 0 && lowSurrogate(data.charCodeAt(cut))) cut += 1
        skipped += cut
        data = data.slice(cut)
      } else {
        // Drop the oldest queued output first; the newest is what the screen ends up showing.
        while (pending + data.length > maxPending && head < chunks.length) {
          const chunk = chunks[head]
          head += 1
          pending -= chunk.length
          skipped += chunk.length
        }
        compact()
      }
      if (hidden()) skippedHidden = true
    }
    if (data) {
      chunks.push(data)
      pending += data.length
    }

    if (scheduled || writing) return
    scheduled = true
    schedule(run)
  }

  const flush = (done?: VoidFunction) => {
    if (!scheduled && !writing && !queued()) {
      done?.()
      return
    }
    if (done) {
      if (waits) waits.push(done)
      else waits = [done]
    }
    run()
  }

  return { push, flush }
}
