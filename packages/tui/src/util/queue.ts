import type { Message, Part } from "@opencode-ai/sdk/v2"
import { stripPromptPartIDs } from "../prompt/part"
import type { PromptInfo } from "../prompt/history"
import { promptOffsetWidth } from "../prompt/display"

// Messages sent while a step of a turn is running wait on the server until the next step reads
// them. Those are the user messages newer than the running step that carry text the user wrote
// (a background task's hidden result message is not one). Between steps nothing is "queued":
// the next step is about to read them.
export function queuedMessageIDs(
  messages: readonly Message[],
  parts: Readonly<Record<string, readonly Part[] | undefined>>,
): string[] {
  const step = messages.findLast((message) => message.role === "assistant")
  if (!step || step.role !== "assistant" || step.time.completed) return []
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.id > step.id &&
        (parts[message.id] ?? []).some((part) => part.type === "text" && !part.synthetic && part.text.trim()),
    )
    .map((message) => message.id)
}

// The composer contents that would send this message again: its text and attachments.
export function promptFromMessageParts(parts: readonly Part[]): PromptInfo {
  return parts.reduce<PromptInfo>(
    (prompt, part) => {
      if (part.type === "text" && !part.synthetic) prompt.input += part.text
      if (part.type === "file") prompt.parts.push(stripPromptPartIDs(part))
      return prompt
    },
    { input: "", parts: [] },
  )
}

// Several prompts in one composer, separated by a blank line. Attachment markers keep their
// place: their offsets move by the text that now comes before them.
export function joinPrompts(prompts: readonly PromptInfo[]): PromptInfo {
  let input = ""
  const parts: PromptInfo["parts"] = []
  for (const prompt of prompts) {
    if (input) input += "\n\n"
    const shift = promptOffsetWidth(input)
    input += prompt.input
    for (const part of prompt.parts) {
      const source = "source" in part ? part.source : undefined
      const text = source && "text" in source ? source.text : undefined
      if (!shift || !text || typeof text.start !== "number" || typeof text.end !== "number") {
        parts.push(part)
        continue
      }
      parts.push({
        ...part,
        source: { ...source, text: { ...text, start: text.start + shift, end: text.end + shift } },
      } as PromptInfo["parts"][number])
    }
  }
  return { input, parts }
}
