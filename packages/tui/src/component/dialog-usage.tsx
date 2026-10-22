import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { usePraexAccount } from "../context/praex-account"
import { usePraex } from "./use-praex"
import * as Model from "../util/model"
import { allowanceLine, UPGRADE_HINT } from "../util/praex-account"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
})

// compact token counts: 12_500 -> "12.5k", 3_200_000 -> "3.2M"
function tok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function DialogUsage(props: { sessionID?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sync = useSync()
  const praex = usePraex()
  const account = usePraexAccount()
  void account.refresh(true)

  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const assistants = createMemo(() =>
    (props.sessionID ? (sync.data.message[props.sessionID] ?? []) : []).filter(
      (m): m is AssistantMessage => m.role === "assistant",
    ),
  )

  // Session running totals are accumulated on the Session Info (source of truth = DB).
  const totals = createMemo(() => {
    const s = session()
    const t = s?.tokens
    return {
      cost: s?.cost ?? 0,
      input: t?.input ?? 0,
      output: t?.output ?? 0,
      reasoning: t?.reasoning ?? 0,
      cacheRead: t?.cache.read ?? 0,
      cacheWrite: t?.cache.write ?? 0,
    }
  })

  // Live context window = tokens on the last assistant reply, vs the model's context limit.
  const context = createMemo(() => {
    const last = assistants().findLast((m) => m.tokens.output > 0)
    if (!last) return { tokens: 0, percent: null as number | null }
    const used =
      last.tokens.input +
      last.tokens.output +
      last.tokens.reasoning +
      last.tokens.cache.read +
      last.tokens.cache.write
    const model = sync.data.provider.find((p) => p.id === last.providerID)?.models[last.modelID]
    return {
      tokens: used,
      percent: model?.limit.context ? Math.round((used / model.limit.context) * 100) : null,
    }
  })

  // Per-model breakdown, most expensive first.
  const perModel = createMemo(() => {
    const map = new Map<
      string,
      { model: string; cost: number; input: number; output: number; messages: number }
    >()
    for (const m of assistants()) {
      const key = `${m.providerID}/${m.modelID}`
      // 10-22: the display name ("Velox III · Free"), not the internal id (velox-ii-baked)
      const model = Model.name(sync.data.provider, m.providerID, m.modelID)
      const e = map.get(key) ?? { model, cost: 0, input: 0, output: 0, messages: 0 }
      e.cost += m.cost ?? 0
      e.input += m.tokens.input + m.tokens.cache.read + m.tokens.cache.write
      e.output += m.tokens.output + m.tokens.reasoning
      e.messages += 1
      map.set(key, e)
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      {/* 10-22: the hosted plan and what is left of today's allowance */}
      <Show
        when={praex.signedIn()}
        fallback={<text fg={theme.textMuted}>Not signed in to Praex. Type /login to use {praex.freeName()} for free.</text>}
      >
        <box>
          <text fg={theme.text}>{account.account()?.signedIn ? allowanceLine(account.account()!) : "Praex plan · reading…"}</text>
          <Show when={account.account()?.error}>
            <text fg={theme.textMuted}>{account.account()?.error}</text>
          </Show>
          <Show when={account.account()?.plan === "free"}>
            <text fg={theme.textMuted}>{UPGRADE_HINT}</text>
          </Show>
        </box>
      </Show>

      <Show when={props.sessionID} fallback={<text fg={theme.textMuted}>Open a session to see its tokens and cost.</text>}>
      <text fg={theme.text}>This session</text>
      <box flexDirection="row" gap={4}>
        <box>
          <text fg={theme.textMuted}>Spent</text>
          <text fg={theme.primary}>{money.format(totals().cost)}</text>
        </box>
        <box>
          <text fg={theme.textMuted}>Context</text>
          <text fg={theme.text}>
            {tok(context().tokens)}
            {context().percent != null ? ` · ${context().percent}%` : ""}
          </text>
        </box>
        <box>
          <text fg={theme.textMuted}>Replies</text>
          <text fg={theme.text}>{assistants().length}</text>
        </box>
      </box>

      <box>
        <text fg={theme.text}>Tokens</text>
        <box flexDirection="row" gap={3}>
          <text fg={theme.textMuted}>in {tok(totals().input)}</text>
          <text fg={theme.textMuted}>out {tok(totals().output)}</text>
          <text fg={theme.textMuted}>reason {tok(totals().reasoning)}</text>
          <text fg={theme.textMuted}>
            cache {tok(totals().cacheRead)}r / {tok(totals().cacheWrite)}w
          </text>
        </box>
      </box>

      <Show
        when={perModel().length > 0}
        fallback={<text fg={theme.textMuted}>No model usage recorded yet.</text>}
      >
        <box>
          <text fg={theme.text}>By model</text>
          <For each={perModel()}>
            {(row) => (
              <box flexDirection="row" justifyContent="space-between" gap={2}>
                <text fg={theme.text}>{row.model}</text>
                <text fg={theme.textMuted}>
                  {tok(row.input)}▸{tok(row.output)} · {money.format(row.cost)}
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>

      </Show>

      <text fg={theme.textMuted} paddingBottom={1}>
        BYOK keys bill your own provider. Praex-hosted models count toward your plan.
      </text>
    </box>
  )
}
