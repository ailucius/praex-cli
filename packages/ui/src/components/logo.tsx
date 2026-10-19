import { type ComponentProps } from "solid-js"

// Praex brand mark: a white wave (the "~" of praex.ai) on a black rounded tile.
// The mark is never recoloured: it stays white on black in both themes. On dark grounds
// a hairline edge keeps the black tile from dissolving into the page.

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
      <rect
        data-slot="logo-logo-mark-tile"
        x="0.25"
        y="2.25"
        width="15.5"
        height="15.5"
        rx="3.4"
        fill="#000000"
        stroke="rgba(255, 255, 255, 0.24)"
        stroke-width="0.6"
      />
      <path
        data-slot="logo-logo-mark-wave"
        d={wave(0, 2, 16)}
        stroke="#ffffff"
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
      <rect x="1" y="11" width="78" height="78" rx="16.5" fill="#000000" stroke="rgba(255, 255, 255, 0.24)" stroke-width="2" />
      <path
        d={wave(0, 10, 80)}
        stroke="#ffffff"
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
      {/* the mark keeps its colours in both themes: white wave on a black tile, hairline edge */}
      <rect x="0.5" y="0.5" width="41" height="41" rx="8.5" fill="#000000" stroke="rgba(255, 255, 255, 0.24)" stroke-width="1" />
      <path
        d={wave(0, 0, 42)}
        stroke="#fafafa"
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
