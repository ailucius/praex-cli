import { type ComponentProps } from "solid-js"

// Praex brand mark: a dark rounded tile carrying the wave (the "~" of praex.ai).
// The tile follows the theme's strong icon colour and the wave the page background,
// so the mark stays legible on both light and dark grounds.

const wave = (x: number, y: number, size: number) => {
  // One level sine period inside a square of `size` at (x, y): the same geometry as
  // praex.ai's favicon and the Android icon (x 0.19 to 0.81, amplitude 0.13).
  const s = size
  const p = (px: number, py: number) => `${x + px * s} ${y + py * s}`
  return [
    `M ${p(0.19, 0.5)}`,
    `C ${p(0.3171, 0.3267)}, ${p(0.3729, 0.3267)}, ${p(0.5, 0.5)}`,
    `S ${p(0.6829, 0.6733)}, ${p(0.81, 0.5)}`,
  ].join(" ")
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect data-slot="logo-logo-mark-tile" x="0" y="2" width="16" height="16" rx="3.5" fill="var(--icon-strong-base)" />
      <path
        data-slot="logo-logo-mark-wave"
        d={wave(0, 2, 16)}
        stroke="var(--background-base)"
        stroke-width="2.1"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="10" width="80" height="80" rx="17" fill="var(--icon-strong-base)" />
      <path
        d={wave(0, 10, 80)}
        stroke="var(--background-base)"
        stroke-width="9.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <rect x="0" y="0" width="42" height="42" rx="9" fill="var(--icon-strong-base)" />
      <path
        d={wave(0, 0, 42)}
        stroke="var(--background-base)"
        stroke-width="5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <text
        x="56"
        y="33"
        font-size="36"
        font-weight="600"
        letter-spacing="-0.5"
        fill="var(--icon-strong-base)"
        style={{ "font-family": "var(--font-family-sans, system-ui, sans-serif)" }}
      >
        praex
      </text>
    </svg>
  )
}
