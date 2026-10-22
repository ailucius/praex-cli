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

// Tools whose denied call means a file was not saved.
const SAVE_TOOLS = new Set(["write", "edit", "apply_patch"])

// A tool call a permission rule denied is not a failure and gets a calm label instead of the red
// error card. The server marks it with metadata.denied (plus metadata.workspace when a chat was
// kept to its own folder); older parts are recognised by the generic denial text.
export function deniedLabel(
  tool: string,
  error: string,
  metadata: Record<string, unknown>,
): "notSaved" | "outsideFolder" | "denied" | undefined {
  if (metadata.denied !== true && !error.includes("specified a rule")) return
  if (typeof metadata.workspace !== "string") return "denied"
  return SAVE_TOOLS.has(tool) ? "notSaved" : "outsideFolder"
}

// Tools that fold into the quiet "Explored 2 reads, 1 search" group. 10-22: with foldCommands (a finished
// turn) a shell command that completed folds in too; a denied or failed one keeps its own row.
export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])
export function quietGroupPart(
  part: { type: string; tool?: string; state?: { status?: string } },
  options?: { foldCommands?: boolean },
): boolean {
  if (part.type !== "tool" || !part.tool) return false
  if (CONTEXT_GROUP_TOOLS.has(part.tool)) return true
  return !!options?.foldCommands && part.tool === "bash" && part.state?.status === "completed"
}
