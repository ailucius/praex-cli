import path from "path"
import os from "os"
import fs from "fs/promises"
import { createHash, randomBytes } from "crypto"
import { InstallationLocal } from "@opencode-ai/core/installation/version"

// Praex release channel. praex.ai serves /dl/* straight from GCS, so a release
// is live the moment release.sh uploads it - no site deploy involved.
// PRAEX_DL_BASE overrides the channel for tests and future beta tracks.
const BASE_URL = process.env["PRAEX_DL_BASE"] || "https://praex.ai/dl"

export interface Manifest {
  version: string
  /** checksum of the tarball for THIS platform */
  sha256: string
  /** tarball filename for THIS platform */
  asset: string
}

// Platforms we publish a binary for. Keyed by `${process.platform}-${process.arch}`.
const ASSETS: Record<string, string> = {
  "linux-x64": "praex-linux-x64.tar.gz",
  "darwin-arm64": "praex-darwin-arm64.tar.gz",
  "darwin-x64": "praex-darwin-x64.tar.gz",
}

const LEGACY_ASSET = "praex-linux-x64.tar.gz"

function platformKey() {
  return `${process.platform}-${process.arch}`
}

export function supported() {
  // Local/source builds run under bun itself - overwriting process.execPath
  // there would clobber the bun binary, never the praex install.
  if (InstallationLocal) return false
  return platformKey() in ASSETS
}

export async function fetchManifest(): Promise<Manifest | undefined> {
  const res = await fetch(`${BASE_URL}/latest.json`, {
    signal: AbortSignal.timeout(10_000),
    headers: { "cache-control": "no-cache" },
  }).catch(() => undefined)
  if (!res?.ok) return undefined
  const json: unknown = await res.json().catch(() => undefined)
  if (!json || typeof json !== "object") return undefined
  const { version, sha256, platforms } = json as Record<string, unknown>
  if (typeof version !== "string") return undefined

  const key = platformKey()
  const asset = ASSETS[key]
  if (!asset) return undefined

  // Preferred shape: a per-platform map. Falls back to the flat top-level
  // sha256 (which is, and must stay, linux-x64) so a client reading a
  // manifest published before multi-platform releases still updates.
  const entry = (platforms as Record<string, unknown> | undefined)?.[key]
  if (entry && typeof entry === "object") {
    const sum = (entry as Record<string, unknown>)["sha256"]
    if (typeof sum === "string") {
      return { version: version.replace(/^v/, ""), sha256: sum.toLowerCase(), asset }
    }
  }
  if (asset === LEGACY_ASSET && typeof sha256 === "string") {
    return { version: version.replace(/^v/, ""), sha256: sha256.toLowerCase(), asset }
  }
  return undefined
}

/** Throws unless the bytes match the manifest's sha256. */
export function checkDigest(bytes: Uint8Array, sha256: string) {
  const sum = createHash("sha256").update(bytes).digest("hex")
  if (sum !== sha256.toLowerCase()) throw new Error("checksum mismatch, refusing to install")
}

/**
 * Copy `binary` next to `dest` under a name no other praex process uses, then rename it over
 * `dest`. Two terminals updating at once each stage their own file (10-20 audit F5: a shared
 * staged name let one process rename or delete another's half-written copy); the last rename
 * wins and both are complete binaries. The staged file is removed if anything fails.
 */
export async function swapInto(binary: string, dest: string) {
  const staged = path.join(path.dirname(dest), `.praex-update-${process.pid}-${randomBytes(6).toString("hex")}`)
  try {
    await fs.copyFile(binary, staged)
    await fs.chmod(staged, 0o755)
    await fs.rename(staged, dest)
  } finally {
    await fs.rm(staged, { force: true }).catch(() => {})
  }
}

/**
 * Download the latest release, verify its checksum against the manifest, and
 * atomically replace the running binary. The running process keeps its old
 * inode; the new version applies on next launch. Returns the installed version.
 */
export async function apply(manifest?: Manifest): Promise<string> {
  if (!supported()) throw new Error(`praex self-update does not ship a binary for ${platformKey()}`)
  const m = manifest ?? (await fetchManifest())
  if (!m) throw new Error("could not reach the praex release channel")

  const dest = process.execPath
  const destDir = path.dirname(dest)
  const writable = await fs
    .access(destDir, fs.constants.W_OK)
    .then(() => true)
    .catch(() => false)
  if (!writable) throw new Error(`no write access to ${destDir}`)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "praex-update-"))
  try {
    const res = await fetch(`${BASE_URL}/${m.asset}`, {
      signal: AbortSignal.timeout(300_000),
    }).catch(() => undefined)
    if (!res?.ok) throw new Error(`download failed${res ? ` (HTTP ${res.status})` : ""}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    checkDigest(bytes, m.sha256)

    const tarball = path.join(tmp, "praex.tar.gz")
    await Bun.write(tarball, bytes)
    const untar = Bun.spawn({ cmd: ["tar", "xzf", tarball, "-C", tmp], stdout: "ignore", stderr: "ignore" })
    if ((await untar.exited) !== 0) throw new Error("failed to extract release tarball")
    const binary = path.join(tmp, "praex")

    // Stage next to the destination so the final rename stays on one filesystem
    // and is atomic even while another praex process is running.
    await swapInto(binary, dest)
    return m.version
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
