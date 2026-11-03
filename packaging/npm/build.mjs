#!/usr/bin/env node
// Builds the npm packages for one praex GitHub release and, only with --publish,
// publishes them. Without --publish it is a dry run: it downloads and verifies
// the release assets, writes the packages, packs them, and runs
// `npm publish --dry-run` on each tarball. Nothing leaves this machine.
//
//   node packaging/npm/build.mjs v0.1.41                 # dry run
//   node packaging/npm/build.mjs v0.1.41 --smoke         # dry run + local install test
//   node packaging/npm/build.mjs v0.1.41 --publish       # real publish (needs npm login)
//
// Options:
//   --out DIR        output directory (default packaging/npm/dist)
//   --assets DIR     use release assets already downloaded to DIR
//   --repo OWNER/R   GitHub repo with the release (default ailucius/praex-cli)
//   --npm-tag TAG    npm dist-tag for --publish (default latest)
//   --otp CODE       one-time password for npm 2FA, passed to npm publish
//   --smoke          install the packed tarballs into a temp prefix and run `praex --version`
//
// Layout: one package per platform (praex-<os>-<arch>, holding bin/praex) plus
// the main package `@praex/cli` (npm refused the bare name `praex` as too similar to `rax`), which lists them as optionalDependencies so npm
// installs only the one matching the machine. No postinstall script, no
// download at install time.

import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../..")

// Release asset name -> npm package. Platforms without an asset in the
// release's SHA256SUMS are skipped, so new ones turn on by themselves once a
// release ships them.
const PLATFORMS = [
  { asset: "praex-linux-x64.tar.gz", pkg: "praex-linux-x64", os: "linux", cpu: "x64", label: "Linux x64" },
  { asset: "praex-linux-arm64.tar.gz", pkg: "praex-linux-arm64", os: "linux", cpu: "arm64", label: "Linux arm64" },
  { asset: "praex-darwin-x64.tar.gz", pkg: "praex-darwin-x64", os: "darwin", cpu: "x64", label: "macOS Intel" },
  { asset: "praex-darwin-arm64.tar.gz", pkg: "praex-darwin-arm64", os: "darwin", cpu: "arm64", label: "macOS Apple Silicon" },
  { asset: "praex-windows-x64.zip", pkg: "praex-windows-x64", os: "win32", cpu: "x64", label: "Windows x64" },
]

const DESCRIPTION = "Praex, the open source AI coding agent for your terminal."
const LEGAL_FILES = ["LICENSE", "THIRD-PARTY-NOTICES.md"]

function parseArgs(argv) {
  const args = { out: path.join(here, "dist"), repo: "ailucius/praex-cli", npmTag: "latest", publish: false, smoke: false }
  const rest = [...argv]
  while (rest.length) {
    const a = rest.shift()
    if (a === "--publish") args.publish = true
    else if (a === "--smoke") args.smoke = true
    else if (a === "--out") args.out = path.resolve(rest.shift())
    else if (a === "--assets") args.assets = path.resolve(rest.shift())
    else if (a === "--repo") args.repo = rest.shift()
    else if (a === "--npm-tag") args.npmTag = rest.shift()
    else if (a === "--otp") args.otp = rest.shift()
    else if (a === "-h" || a === "--help") args.help = true
    else if (!args.tag) args.tag = a
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(" ")}`)
  return execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts })
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

function parseSums(text) {
  const sums = new Map()
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/i)
    if (!m) continue
    const prev = sums.get(m[2])
    if (prev && prev !== m[1].toLowerCase()) throw new Error(`SHA256SUMS lists two different hashes for ${m[2]}`)
    sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

async function fetchAssets(args, version) {
  const dir = args.assets ?? path.join(args.out, "assets", `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const base = `https://github.com/${args.repo}/releases/download/${args.tag}`
  const sumsFile = path.join(dir, "SHA256SUMS")
  if (!args.assets) await download(`${base}/SHA256SUMS`, sumsFile)
  const sums = parseSums(fs.readFileSync(sumsFile, "utf8"))

  const found = []
  for (const p of PLATFORMS) {
    const expected = sums.get(p.asset)
    if (!expected) {
      console.log(`skip ${p.pkg}: ${p.asset} is not in this release`)
      continue
    }
    const file = path.join(dir, p.asset)
    if (!fs.existsSync(file) || sha256(file) !== expected) {
      if (args.assets) throw new Error(`${file} is missing or does not match SHA256SUMS`)
      console.log(`download ${p.asset}`)
      await download(`${base}/${p.asset}`, file)
    }
    const actual = sha256(file)
    if (actual !== expected) throw new Error(`checksum mismatch for ${p.asset}: got ${actual}, SHA256SUMS says ${expected}`)
    console.log(`ok ${p.asset} sha256 ${actual}`)
    found.push({ ...p, file, sha256: actual })
  }
  if (!found.length) throw new Error("no usable assets in this release")
  return found
}

function extract(p, destBin) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "praex-npm-"))
  try {
    if (p.asset.endsWith(".zip")) run("unzip", ["-q", "-o", p.file, "-d", tmp])
    else run("tar", ["-xzf", p.file, "-C", tmp])
    const name = p.os === "win32" ? "praex.exe" : "praex"
    const src = path.join(tmp, name)
    if (!fs.existsSync(src)) throw new Error(`${p.asset} does not contain ${name} at its root`)
    fs.mkdirSync(path.dirname(destBin), { recursive: true })
    fs.copyFileSync(src, destBin)
    fs.chmodSync(destBin, 0o755)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function copyLegal(dir) {
  for (const f of LEGAL_FILES) {
    const src = path.join(root, f)
    if (!fs.existsSync(src)) throw new Error(`${src} is missing; the OpenCode MIT attribution must ship in every package`)
    fs.copyFileSync(src, path.join(dir, f))
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n")
}

function common(args, version) {
  return {
    version,
    license: "MIT",
    homepage: "https://praex.ai",
    repository: { type: "git", url: `git+https://github.com/${args.repo}.git` },
    bugs: { url: `https://github.com/${args.repo}/issues` },
  }
}

function buildPlatform(args, version, p, pkgRoot) {
  const dir = path.join(pkgRoot, p.pkg)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  extract(p, path.join(dir, "bin", p.os === "win32" ? "praex.exe" : "praex"))
  copyLegal(dir)
  fs.writeFileSync(
    path.join(dir, "README.md"),
    [
      `# ${p.pkg}`,
      "",
      `The praex binary for ${p.label}. Do not install this package directly. Install \`@praex/cli\` instead:`,
      "",
      "```bash",
      "npm install -g @praex/cli",
      "```",
      "",
      "See https://praex.ai and the [@praex/cli package](https://www.npmjs.com/package/@praex/cli).",
      "",
    ].join("\n"),
  )
  writeJson(path.join(dir, "package.json"), {
    name: p.pkg,
    description: `The praex binary for ${p.label}. Install @praex/cli instead of this one.`,
    ...common(args, version),
    os: [p.os],
    cpu: [p.cpu],
    ...(p.os === "linux" ? { libc: ["glibc"] } : {}),
    files: ["bin/", "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md"],
    preferUnplugged: true,
  })
  return dir
}

function buildMain(args, version, platforms, pkgRoot) {
  const dir = path.join(pkgRoot, "praex")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
  fs.copyFileSync(path.join(here, "launcher", "praex"), path.join(dir, "bin", "praex"))
  fs.chmodSync(path.join(dir, "bin", "praex"), 0o755)
  fs.copyFileSync(path.join(here, "README.md"), path.join(dir, "README.md"))
  copyLegal(dir)
  writeJson(path.join(dir, "package.json"), {
    name: "@praex/cli",
    description: DESCRIPTION,
    ...common(args, version),
    keywords: ["praex", "ai", "coding-agent", "cli", "terminal", "llm"],
    bin: { praex: "bin/praex" },
    files: ["bin/", "LICENSE", "THIRD-PARTY-NOTICES.md", "README.md"],
    engines: { node: ">=18" },
    optionalDependencies: Object.fromEntries(platforms.map((p) => [p.pkg, version])),
  })
  return dir
}

function pack(dir, dest) {
  const out = run("npm", ["pack", "--json", "--pack-destination", dest], { cwd: dir })
  const info = JSON.parse(out)[0]
  const missing = LEGAL_FILES.filter((f) => !info.files.some((x) => x.path === f))
  if (missing.length) throw new Error(`${info.name} tarball is missing ${missing.join(", ")}`)
  console.log(`packed ${info.filename} (${(info.size / 1e6).toFixed(1)} MB, ${info.files.length} files, LICENSE + notices included)`)
  return path.join(dest, info.filename)
}

function isPublished(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" })
  return r.status === 0 && r.stdout.trim() === version
}

function publish(args, tarball, name, version) {
  if (args.publish && isPublished(name, version)) {
    console.log(`already on npm: ${name}@${version}, skipping`)
    return
  }
  const argv = ["publish", tarball, "--access", "public", "--tag", args.npmTag]
  if (!args.publish) argv.push("--dry-run")
  if (args.otp) argv.push("--otp", args.otp)
  console.log(`$ npm ${argv.join(" ").replace(/--otp \S+/, "--otp ***")}`)
  const r = spawnSync("npm", argv, { stdio: "inherit" })
  if (r.status !== 0) throw new Error(`npm publish failed for ${name}@${version}`)
}

function smoke(tarballs, version) {
  const host = PLATFORMS.find((p) => p.os === process.platform && p.cpu === process.arch)
  const hostTgz = host && tarballs.find((t) => path.basename(t).startsWith(`${host.pkg}-${version}`))
  if (!hostTgz) {
    console.log(`smoke: no package for ${process.platform}-${process.arch} in this release, skipping`)
    return
  }
  const mainTgz = tarballs.find((t) => path.basename(t) === `praex-cli-${version}.tgz`)
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "praex-smoke-"))
  try {
    // Install the two local tarballs the way `npm install -g @praex/cli` would, into
    // a throwaway prefix. Other platform packages are not on the registry yet,
    // and npm skips them because their os/cpu do not match this machine.
    run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", mainTgz, hostTgz], { stdio: "inherit" })
    const bin = path.join(prefix, process.platform === "win32" ? "praex.cmd" : "bin/praex")
    const got = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()
    console.log(`smoke: ${bin} --version -> ${got}`)
    if (got !== version) throw new Error(`smoke: expected ${version}, got ${got}`)
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.tag) {
    console.log("usage: node packaging/npm/build.mjs <tag> [--publish] [--smoke] [--out DIR] [--assets DIR] [--repo OWNER/REPO] [--npm-tag TAG] [--otp CODE]")
    process.exit(args.help ? 0 : 1)
  }
  const version = args.tag.replace(/^v/, "")
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a semver tag: ${args.tag}`)
  if (args.publish && version.includes("-") && args.npmTag === "latest") {
    throw new Error("prerelease versions need an explicit --npm-tag (for example next)")
  }

  console.log(`praex npm packages for ${args.tag} from ${args.repo} (${args.publish ? "PUBLISH" : "dry run"})`)
  const platforms = await fetchAssets(args, version)
  const pkgRoot = path.join(args.out, "packages")
  const tgzDir = path.join(args.out, "tarballs")
  fs.rmSync(tgzDir, { recursive: true, force: true })
  fs.mkdirSync(tgzDir, { recursive: true })

  const tarballs = []
  for (const p of platforms) tarballs.push(pack(buildPlatform(args, version, p, pkgRoot), tgzDir))
  const mainTgz = pack(buildMain(args, version, platforms, pkgRoot), tgzDir)
  tarballs.push(mainTgz)

  if (args.smoke) smoke(tarballs, version)

  // Platform packages first, so `@praex/cli` never points at versions that are not on npm yet.
  for (const [i, p] of platforms.entries()) publish(args, tarballs[i], p.pkg, version)
  publish(args, mainTgz, "@praex/cli", version)

  console.log(args.publish ? `published @praex/cli@${version}` : `dry run done; tarballs in ${tgzDir}; nothing was published`)
}

main().catch((err) => {
  console.error(`error: ${err.message}`)
  process.exit(1)
})
