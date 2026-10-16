import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import * as Locale from "./locale"

// The hosted tiers are served with a 32k client context, and every turn carries the same
// fixed prefix (system prompt + tool schemas, ~20k tokens on Praex). Showing raw
// "20.6K (63%)" after one short question reads as "already almost full" when the prefix
// is cached upstream and only the conversation grows. So the meter reports the
// conversation's share of the room that is actually left: the smallest prompt seen in the
// session is the prefix estimate, everything above it is the conversation.
// The label is always the real context size, formatted ("9.9K"). Showing the conversation
// tokens alone printed raw tiny integers ("1", "24") because on the first turn the prefix
// estimate is that turn's whole prompt, leaving only the output tokens.
export function contextUsage(messages: AssistantMessage[], limit: number | undefined) {
  const answered = messages.filter((item) => item.role === "assistant" && item.tokens.output > 0)
  const last = answered.at(-1)
  if (!last) return
  const total = (m: AssistantMessage) =>
    m.tokens.input + m.tokens.output + m.tokens.reasoning + m.tokens.cache.read + m.tokens.cache.write
  const prompt = (m: AssistantMessage) => m.tokens.input + m.tokens.cache.read + m.tokens.cache.write
  const tokens = total(last)
  if (tokens <= 0) return
  if (!limit || limit <= 0) return { label: Locale.number(tokens), tokens, pct: undefined }
  const prefix = Math.min(...answered.map(prompt))
  const room = limit - prefix
  // Degenerate data (prefix estimate at or above the limit): fall back to the raw share.
  if (room <= 0 || prefix < 0) {
    const pct = Math.min(100, Math.round((tokens / limit) * 100))
    return { label: `${Locale.number(tokens)} (${pct}% of context)`, tokens, pct }
  }
  const used = Math.max(0, tokens - prefix)
  const pct = Math.min(100, Math.round((used / room) * 100))
  return { label: `${Locale.number(tokens)} (${pct}% of context)`, tokens, pct }
}
