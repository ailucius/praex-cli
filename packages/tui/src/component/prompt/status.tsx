import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "../../context/theme"
import { useSync } from "../../context/sync"
import { useKV } from "../../context/kv"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { statusItems, type StatusItem } from "../../context/status-items"
import { TIDE_GLYPH, tideColor } from "../spinner"
import {
  formatElapsed,
  formatSteps,
  formatTokenCount,
  pickVerb,
  subagentProgress,
  toolActivity,
  toolInput,
} from "../../util/status-line"

export const BRAND_GLYPH = TIDE_GLYPH

type Theme = ReturnType<typeof useTheme>["theme"]

export function toneColor(theme: Theme, tone: StatusItem["tone"]): RGBA {
  switch (tone) {
    case "primary":
      return theme.primary
    case "accent":
      return theme.accent
    case "success":
      return theme.success
    case "warning":
      return theme.warning
    case "error":
      return theme.error
  }
  return theme.textMuted
}

// The user message the running turn answers: the parent of the newest unfinished assistant
// step, or the newest user message when the first step has not been created yet.
export function activeTurn(messages: readonly (UserMessage | AssistantMessage)[]) {
  const step = messages.findLast((m): m is AssistantMessage => m.role === "assistant" && !m.time.completed)
  if (step) {
    const parent = messages.find((m): m is UserMessage => m.role === "user" && m.id === step.parentID)
    if (parent) return parent
  }
  return messages.findLast((m): m is UserMessage => m.role === "user")
}

// Turn output so far: real counts from finished steps, plus a chars/4 estimate for the step
// that is still streaming (providers only report tokens when a step ends).
function turnTokens(
  messages: readonly (UserMessage | AssistantMessage)[],
  parts: Record<string, Part[] | undefined>,
  turnID: string,
) {
  let total = 0
  for (const message of messages) {
    if (message.role !== "assistant" || message.parentID !== turnID) continue
    const reported = message.tokens.output + message.tokens.reasoning
    if (reported > 0) {
      total += reported
      continue
    }
    for (const part of parts[message.id] ?? []) {
      if (part.type === "text" || part.type === "reasoning") total += Math.ceil(part.text.length / 4)
    }
  }
  return total
}

// "∿ Editing hello.py… 0:42 · ↓ 1.2k tokens · esc to interrupt", shown above the input while
// the session works. The glyph breathes in the brand colour; one verb per turn, unless a tool
// is running, then its activity.
export function WorkingLine(props: { sessionID: string; interrupt: number; interruptKey: string }) {
  const { theme } = useTheme()
  const sync = useSync()
  const kv = useKV()
  const dialog = useDialog()
  const animate = createMemo(() => kv.get("animations_enabled", true))
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), animate() ? 90 : 1000)
    onCleanup(() => clearInterval(timer))
  })

  const status = createMemo(() => sync.data.session_status?.[props.sessionID] ?? { type: "idle" as const })
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const turn = createMemo(() => activeTurn(messages()))

  // A subagent's progress, read from its own session (synced live like any other).
  const childSteps = (sessionID: unknown) => {
    if (typeof sessionID !== "string") return 0
    const parts = (sync.data.message[sessionID] ?? []).flatMap((m) => sync.data.part[m.id] ?? [])
    return subagentProgress(parts).steps
  }

  // What the session is doing right now: a running tool's activity, else the tool call the
  // model is still writing (its arguments stream in), else thinking, else the turn's verb.
  // A delegated task also says how far its subagent has got ("Delegating: Audit · 8 steps").
  const activity = createMemo((): { text: string; detail?: string } => {
    const step = messages().findLast((m): m is AssistantMessage => m.role === "assistant" && !m.time.completed)
    const parts = step ? (sync.data.part[step.id] ?? []) : []
    const tools = parts.filter((p) => p.type === "tool")
    const running = tools.findLast((p) => p.state.status === "running")
    if (running) {
      const label = toolActivity(running.tool, toolInput(running))
      if (label && running.tool === "task") {
        const steps = childSteps(running.state.status === "running" ? running.state.metadata?.sessionId : undefined)
        return { text: label, detail: steps > 0 ? formatSteps(steps) : undefined }
      }
      if (label) return { text: label }
    }
    const writing = tools.findLast((p) => p.state.status === "pending")
    if (writing) {
      const label = toolActivity(writing.tool, toolInput(writing))
      if (label) return { text: label }
    }
    const last = parts.at(-1)
    if (last?.type === "reasoning" && !last.time.end) return { text: "Thinking" }
    return { text: pickVerb(turn()?.id ?? props.sessionID) }
  })

  // A queued prompt's clock starts when its turn starts, not when it was typed.
  const elapsed = createMemo(() => {
    const t = turn()
    if (!t) return
    const first = messages().find((m) => m.role === "assistant" && m.parentID === t.id)
    const previous = messages().findLast(
      (m): m is AssistantMessage => m.role === "assistant" && !!m.time.completed && m.parentID !== t.id,
    )
    const start = first?.time.created ?? Math.max(t.time.created, previous?.time.completed ?? 0)
    return formatElapsed(now() - start)
  })

  const tokens = createMemo(() => {
    const id = turn()?.id
    if (!id) return 0
    return turnTokens(messages(), sync.data.part, id)
  })

  // The same breathing tilde as a running row (component/spinner), on the same clock.
  const glyphColor = createMemo(() => (animate() ? tideColor(theme, theme.primary, now()) : theme.primary))

  const retry = createMemo(() => {
    const value = status()
    if (value.type !== "retry") return
    return value
  })
  const retryText = createMemo(() => {
    const r = retry()
    if (!r) return ""
    let message = r.message
    if (message.includes("exceeded your current quota") && message.includes("gemini"))
      message = "Gemini is rate limited right now"
    if (message.length > 72) message = message.slice(0, 72) + "…"
    const wait = r.next ? Math.max(0, Math.round((r.next - now()) / 1000)) : 0
    return `${message} · retrying${wait > 0 ? ` in ${formatElapsed(wait * 1000)}` : ""} (attempt ${r.attempt})`
  })

  return (
    <box flexDirection="row" flexShrink={1} minWidth={0}>
      <text fg={glyphColor()} wrapMode="none">
        {BRAND_GLYPH}{" "}
      </text>
      <Show
        when={retry()}
        fallback={
          <text fg={theme.text} wrapMode="none" flexShrink={1}>
            {activity().text}
            <Show when={activity().detail} fallback="…">
              <span style={{ fg: theme.textMuted }}> · {activity().detail} ·</span>
            </Show>
            <Show when={elapsed()}>
              <span style={{ fg: theme.textMuted }}> {elapsed()}</span>
            </Show>
            <Show when={tokens() > 0}>
              <span style={{ fg: theme.textMuted }}> · ↓ {formatTokenCount(tokens())} tokens</span>
            </Show>
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: props.interrupt > 0 ? theme.primary : theme.textMuted }}>
              {props.interruptKey} {props.interrupt > 0 ? "again to interrupt" : "to interrupt"}
            </span>
          </text>
        }
      >
        <box
          flexShrink={1}
          onMouseUp={() => {
            const r = retry()
            if (r && r.message.length > 72) void DialogAlert.show(dialog, "Retry error", r.message)
          }}
        >
          <text fg={theme.error} wrapMode="none">
            {retryText()}
            <span style={{ fg: theme.textMuted }}> · </span>
            <span style={{ fg: props.interrupt > 0 ? theme.primary : theme.textMuted }}>
              {props.interruptKey} {props.interrupt > 0 ? "again to interrupt" : "to interrupt"}
            </span>
          </text>
        </box>
      </Show>
    </box>
  )
}

export type FooterItem = { id: string; label: string; color?: RGBA }

// One line of " · "-separated facts. Items with an empty label are skipped by the caller.
export function FooterItems(props: { items: FooterItem[] }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} wrapMode="none">
      <For each={props.items}>
        {(item, index) => (
          <>
            <Show when={index() > 0}>
              <span style={{ fg: theme.textMuted }}> · </span>
            </Show>
            <span style={{ fg: item.color ?? theme.textMuted }}>{item.label}</span>
          </>
        )}
      </For>
    </text>
  )
}

// Items registered by other features (see context/status-items.ts), ready for FooterItems.
export function useRegisteredFooterItems() {
  const { theme } = useTheme()
  return createMemo<FooterItem[]>(() =>
    statusItems().map((item) => ({ id: item.id, label: item.label, color: toneColor(theme, item.tone) })),
  )
}
