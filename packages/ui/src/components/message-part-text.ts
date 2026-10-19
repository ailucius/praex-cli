export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

// Whole seconds the model spent thinking, at least 1, like the CLI and Claude/ChatGPT ("Thought for 4s").
export function thoughtSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

// A reasoning part is still thinking until its own end time lands. A finished message closes it
// even when the part never got an end (aborted streams, older providers).
export function reasoningState(
  part: { time?: { start?: number; end?: number } },
  messageCompleted?: number,
): { thinking: true } | { thinking: false; ms: number } {
  const start = part.time?.start
  const end = part.time?.end ?? messageCompleted
  if (typeof end !== "number") return { thinking: true }
  if (typeof start !== "number" || end < start) return { thinking: false, ms: 0 }
  return { thinking: false, ms: end - start }
}
