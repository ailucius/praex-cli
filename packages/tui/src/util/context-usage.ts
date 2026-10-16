import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import * as Locale from "./locale"

// Context meter: how much of the model's window the last turn filled, as "9.9K of 32.8K".
// 10-16: this used to report the conversation's share of the room left after the fixed prefix
// (system prompt + tool schemas), which printed "9.9K (0% of context)" — a number and a percent
// that contradicted each other. The plain fraction is honest and needs no explaining.
export function contextUsage(messages: AssistantMessage[], limit: number | undefined) {
  const last = messages.findLast((item) => item.role === "assistant" && item.tokens.output > 0)
  if (!last) return
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (tokens <= 0) return
  if (!limit || limit <= 0) return { label: Locale.number(tokens), tokens, pct: undefined }
  const pct = Math.min(100, Math.round((tokens / limit) * 100))
  return { label: `${Locale.number(tokens)} of ${Locale.number(limit)}`, tokens, pct }
}
