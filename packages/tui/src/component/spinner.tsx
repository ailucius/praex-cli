import { Show } from "solid-js"
import { tint, useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "opentui-spinner/solid"

// Praex's one signature element: the tilde. Anything working right now shows it breathing in
// the accent colour, from the working line above the input to a running tool row, so the eye
// learns one sign for "active". The glyph never changes shape (no jitter, no width change);
// only its colour rises and falls. Every instance reads the same clock, so several on screen
// breathe together instead of flickering out of step.
export const TIDE_GLYPH = "∿"
const TIDE_PERIOD = 2600
const TIDE_FRAMES = Array.from({ length: 8 }, () => TIDE_GLYPH)
// Shape-changing frames for callers that draw with one fixed colour (the headless
// `praex run` footer), where a colour-only tide would look static.
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Theme = ReturnType<typeof useTheme>["theme"]

// 0..1, the same for every caller at the same moment.
export function tidePhase(now = Date.now()) {
  return (Math.sin((now / TIDE_PERIOD) * Math.PI * 2) + 1) / 2
}

export function tideColor(theme: Theme, base: RGBA = theme.primary, now = Date.now()) {
  return tint(theme.textMuted, base, 0.3 + tidePhase(now) * 0.7)
}

export function Spinner(props: { children?: JSX.Element; color?: RGBA; glyph?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const glyph = () => props.glyph ?? theme.primary
  return (
    <Show
      when={kv.get("animations_enabled", true)}
      fallback={
        <text fg={color()}>
          <span style={{ fg: glyph() }}>{TIDE_GLYPH}</span> {props.children}
        </text>
      }
    >
      <box flexDirection="row" gap={1}>
        <spinner frames={TIDE_FRAMES} interval={90} color={() => tideColor(theme, glyph())} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
