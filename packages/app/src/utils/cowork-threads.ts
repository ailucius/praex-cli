import { createSignal } from "solid-js"

// Threads that have run Cowork at least once, so the sidebar can tag them as tasks.
// A per-device record (the server does not store the agent on the session).
const KEY = "praex.cowork-threads"
const LIMIT = 500

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

const [threads, setThreads] = createSignal<string[]>(read())

export function isCoworkThread(sessionID: string) {
  return threads().includes(sessionID)
}

export function markCoworkThread(sessionID: string) {
  if (threads().includes(sessionID)) return
  const next = [sessionID, ...threads()].slice(0, LIMIT)
  setThreads(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}
