import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

// Rough size of the summary a compaction writes back (template headings plus a few lines each).
export const SUMMARY_ESTIMATE = 1_500

/**
 * Decide whether auto-compaction can actually help.
 *
 * Compaction can only shrink the conversation. The fixed part of every request (system
 * prompt, tool schemas, MCP tools, skills) stays the same size, so when that overhead alone
 * fills most of a small window (hosted tiers: 32K context, 8K output, 24.5K usable) a summary
 * frees nothing and auto-compaction would fire again on every turn. In that case the caller
 * should skip compaction and tell the user where the space went.
 *
 * `count` is what the last request used, `conversation` is the estimated size of the history
 * compaction would replace, `preserve` is the recent tail it keeps verbatim.
 */
export function compactionPlan(input: { count: number; conversation: number; usable: number; preserve: number }) {
  const conversation = Math.max(0, input.conversation)
  const overhead = Math.max(0, input.count - conversation)
  const kept = Math.min(input.preserve, conversation) + SUMMARY_ESTIMATE
  const freed = Math.max(0, conversation - kept)
  // Large windows keep upstream behavior: anything that frees 8K+ is worth it. Small windows
  // need a fifth of the usable budget back, or the next turn overflows again.
  const minimum = Math.min(8_000, Math.max(2_000, Math.floor(input.usable * 0.2)))
  return { overhead, freed, worthwhile: freed >= minimum }
}

function kilo(tokens: number) {
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}K`
  return String(tokens)
}

/** One plain line explaining why the conversation was not compacted. */
export function overheadHint(input: { overhead: number; context: number; modelName?: string }) {
  // Hosted names carry a plan suffix ("Velox II · free"); the hint wants the bare name.
  const name = input.modelName?.split(" · ")[0]?.trim()
  const model = name ? `${name}'s` : "the model's"
  const used = input.overhead > 0 ? `~${kilo(input.overhead)} of ${model} ${kilo(input.context)}` : `most of ${model} ${kilo(input.context)}`
  return `Tools and instructions use ${used} context. Disable unused MCP servers or skills to make room for the conversation.`
}
