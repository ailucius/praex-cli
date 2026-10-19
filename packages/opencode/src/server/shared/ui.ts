import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined
let localUIPromise: Promise<Record<string, string> | null> | undefined

// Source checkouts have no embedded bundle; serve the built PWA from packages/app/dist.
// Praex never proxies a hosted web app: with no bundle at all the server says so plainly.
function localUI() {
  return (localUIPromise ??= (async () => {
    try {
      const { fileURLToPath } = await import("node:url")
      const path = await import("node:path")
      const fs = await import("node:fs/promises")
      const dist = fileURLToPath(new URL("../../../../app/dist/", import.meta.url))
      const entries = await fs.readdir(dist, { recursive: true, withFileTypes: true })
      const map: Record<string, string> = {}
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const parent = entry.parentPath ?? dist
        const abs = path.join(parent, entry.name)
        const rel = path.relative(dist, abs).replaceAll("\\", "/")
        if (rel.endsWith(".map")) continue
        map[rel] = abs
      }
      return map["index.html"] ? map : null
    } catch {
      return null
    }
  })())
}

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts")
      .then((module) => module.default as Record<string, string>)
      .catch(() => localUI()))
}

const NO_UI_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Praex</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0b12;color:#ebe9f2;font:15px/1.6 system-ui,-apple-system,sans-serif;text-align:center;padding:0 24px}p{color:#9791a8}</style>
</head><body><main><h1 style="font-size:20px;font-weight:600">The Praex web app isn't included in this build</h1><p>The server is running. Use the Praex desktop app or the terminal, or install a full build from praex.ai/download.</p></main></body></html>`

// No embedded or local bundle (or the embedded UI is turned off).
function noBundledUI() {
  return HttpServerResponse.text(NO_UI_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  })
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)
    return noBundledUI()
  })
}
