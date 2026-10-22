import { onMount, type ComponentProps } from "solid-js"

// 10-22: the one sign that something is working, the same idea as the TUI's breathing tilde: a "∿" that
// breathes in the accent colour. It never changes shape, every instance reads one clock (so several on
// screen breathe together), and under prefers-reduced-motion it stays still.
const PERIOD_MS = 1800

export function WorkingMark(props: { class?: string; label?: string; style?: ComponentProps<"span">["style"] }) {
  let el: HTMLSpanElement | undefined
  onMount(() => {
    if (el) el.style.animationDelay = `-${Date.now() % PERIOD_MS}ms`
  })
  return (
    <span
      ref={el}
      data-component="working-mark"
      class={props.class}
      style={props.style}
      role={props.label ? "status" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      ∿
    </span>
  )
}
