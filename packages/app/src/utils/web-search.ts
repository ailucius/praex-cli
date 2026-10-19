import { createSignal } from "solid-js"

// The composer's "Web search" switch (+ menu). A per-device preference, so plain storage.
const KEY = "praex.composer.web-search"

function read() {
  try {
    return localStorage.getItem(KEY) !== "off"
  } catch {
    return true
  }
}

const [webSearch, setSignal] = createSignal(read())

export { webSearch }

export function setWebSearch(on: boolean) {
  setSignal(on)
  try {
    localStorage.setItem(KEY, on ? "on" : "off")
  } catch {}
}

/** Per-message tool overrides sent with a prompt (undefined = the agent's defaults). */
export function composerToolOverrides(): Record<string, boolean> | undefined {
  return webSearch() ? undefined : { websearch: false, webfetch: false }
}
