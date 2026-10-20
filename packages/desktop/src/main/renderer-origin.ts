// 10-20: A14. The one place that says where the renderer lives. windows.ts loads it from here
// (custom protocol in builds, the electron-vite dev server in dev), and the IPC sender gate and
// the navigation guard check against the same answer. No electron import, so it is unit-testable.

export const RENDERER_PROTOCOL = "oc"
export const RENDERER_HOST = "renderer"

/** The URL a window loads for `html`: the dev server when electron-vite runs one, else oc://renderer. */
export function rendererPageUrl(html: string, devUrl = process.env.ELECTRON_RENDERER_URL) {
  if (devUrl) return new URL(html, devUrl).toString()
  return `${RENDERER_PROTOCOL}://${RENDERER_HOST}/${html}`
}

/** True when `value` is a page of our own renderer (and, with `html`, an .html document). */
export function isRendererUrl(value?: string | null, html = false, devUrl = process.env.ELECTRON_RENDERER_URL) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (html && !url.pathname.endsWith(".html")) return false
  if (url.protocol === `${RENDERER_PROTOCOL}:` && url.host === RENDERER_HOST) return true
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}
