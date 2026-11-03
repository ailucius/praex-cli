# Publishing praex to npm and Homebrew

Nothing here has been published. Everything below is prepared and tested locally on Linux x64 against release v0.1.41.

What exists in this branch:

* `packaging/npm/build.mjs`: builds the npm packages for a release tag. It is a dry run unless you pass `--publish`.
* `packaging/npm/launcher/praex`, `packaging/npm/README.md`: the `@praex/cli` package's launcher and README.
* `packaging/homebrew/generate-formula.mjs`: writes the formula for a release tag.
* `packaging/homebrew-tap/`: the contents of the future `downoff/homebrew-tap` repo (README and `Formula/praex.rb` for v0.1.41).

npm layout: `@praex/cli` (a small Node launcher) lists `praex-linux-x64`, `praex-darwin-x64` and `praex-darwin-arm64` as optionalDependencies. npm installs only the one that matches the machine. There is no postinstall script and no download at install time. Every package carries `LICENSE` (the OpenCode MIT license) and `THIRD-PARTY-NOTICES.md`; the build stops if either is missing.

## 1. npm, one time

1. Sign in at https://www.npmjs.com (or create the account that should own praex).
2. Turn on two factor authentication for "Authorization and writes" (Account, Two Factor Authentication).
3. On this machine:

```bash
npm login
npm whoami
```

npm refused the bare name `praex` ("too similar to existing package rax"), so the main package is `@praex/cli` (the `@praex` scope belongs to the `praex` npm account); the platform packages keep their unscoped names. First published 3 Nov 2026 as 0.1.41. Publishing needs 2FA on the account; with a security key, npm prints an approval link per publish (`--otp` is only for authenticator apps). A brand-new package name lands in npm's staging first (public placeholder 0.0.0-stage) until the owner approves it under Staged Packages on npmjs.com.

## 2. npm, publish a release

From the repo root:

```bash
node packaging/npm/build.mjs v0.1.41 --smoke
node packaging/npm/build.mjs v0.1.41 --publish --otp 123456
```

The first command is the dry run: it downloads the release assets, checks each against the release's SHA256SUMS, builds and packs the packages, installs them into a temp folder, runs `praex --version`, and runs `npm publish --dry-run`. The second publishes for real: the three platform packages first, then `praex`.

If the one time code expires partway (four uploads, about 160 MB), run the same command again with a fresh code. Versions already on npm are skipped.

Check:

```bash
npm view praex version
npm install -g @praex/cli && praex --version
```

## 3. Homebrew, one time

Create the tap repo and push the prepared contents:

```bash
cp -r packaging/homebrew-tap /tmp/homebrew-tap
cd /tmp/homebrew-tap
git init -b main && git add . && git commit -m "praex 0.1.41"
gh repo create downoff/homebrew-tap --public --source . --push
```

Check on a Mac (Homebrew is not installed on the Linux box, so this has not run yet):

```bash
brew install downoff/tap/praex
praex --version
brew test praex
brew audit --strict --online downoff/tap/praex
```

## 4. Every new release

```bash
node packaging/npm/build.mjs vX.Y.Z --smoke
node packaging/npm/build.mjs vX.Y.Z --publish --otp 123456

git clone https://github.com/downoff/homebrew-tap.git /tmp/homebrew-tap
node packaging/homebrew/generate-formula.mjs vX.Y.Z --out /tmp/homebrew-tap/Formula/praex.rb
cd /tmp/homebrew-tap && git commit -am "praex X.Y.Z" && git push
```

New platforms turn on by themselves: once a release ships `praex-linux-arm64.tar.gz` or `praex-windows-x64.zip`, both scripts pick them up. The first publish of `praex-linux-arm64` or `praex-windows-x64` claims that name.

## 5. After both are live

Add to the Install section of the repo README and the praex.ai download page:

```bash
npm install -g @praex/cli
brew install downoff/tap/praex
```

## Decisions for you

* Tap owner. The CLI repo now lives at `ailucius/praex-cli` (`downoff/praex-cli` redirects to it), and the formula and npm metadata point at `ailucius/praex-cli`. The tap is prepared as `downoff/homebrew-tap` as asked. If you would rather have `ailucius/homebrew-tap` (`brew install ailucius/tap/praex`), create it there instead and change `downoff/tap` in `packaging/npm/README.md` and `packaging/homebrew-tap/README.md`.
* Updates. npm and Homebrew installs set `PRAEX_DISABLE_AUTOUPDATE=1`, so the background updater does not overwrite a binary that npm or Homebrew owns. Users update with `npm install -g @praex/cli@latest` or `brew upgrade praex`. A manual `praex upgrade` still replaces the binary in place and suggests the curl installer. A small follow up in the CLI could detect an npm or Homebrew install and print the matching command instead.
