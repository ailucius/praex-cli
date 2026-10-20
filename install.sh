#!/bin/sh
# Praex CLI installer
# Usage: curl -fsSL https://praex.ai/install.sh | bash
# POSIX sh on purpose: `curl ... | sh` runs dash on Debian and Ubuntu.
set -eu
# pipefail is not POSIX; use it where the shell has it.
(set -o pipefail) 2>/dev/null && set -o pipefail

BASE_URL="${PRAEX_BASE_URL:-https://praex.ai}"
INSTALL_DIR="${PRAEX_INSTALL_DIR:-$HOME/.local/bin}"

unsupported() {
  echo "praex: $1" >&2
  echo "praex ships for Linux x86_64 (glibc, CPUs with AVX2) and macOS (Apple Silicon or Intel)." >&2
  echo "Windows users: praex runs under WSL." >&2
  exit 1
}

os="$(uname -s)"
arch="$(uname -m)"

# An Intel shell on Apple Silicon (Rosetta) gets the native arm64 build.
if [ "$os" = Darwin ] && [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

case "$os-$arch" in
  Linux-x86_64)          ASSET=praex-linux-x64.tar.gz ;;
  Darwin-arm64)          ASSET=praex-darwin-arm64.tar.gz ;;
  Darwin-x86_64)         ASSET=praex-darwin-x64.tar.gz ;;
  Linux-aarch64|Linux-arm64)
    unsupported "there is no Linux arm64 build yet (found $os $arch)." ;;
  *)
    unsupported "this platform is not supported (found $os $arch)." ;;
esac

if [ "$os" = Linux ]; then
  # The Linux build links against glibc; Alpine and other musl systems cannot run it.
  if [ -f /etc/alpine-release ] || ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
    unsupported "musl based systems such as Alpine are not supported yet. Use a glibc based image (Debian, Ubuntu, Fedora)."
  fi
  # The x64 build needs AVX2 (Intel Haswell or AMD Excavator, 2013 or later).
  if [ -r /proc/cpuinfo ] && ! grep -qw avx2 /proc/cpuinfo; then
    unsupported "this CPU has no AVX2, which the Linux build needs. Virtual machines may need the host CPU model passed through."
  fi
fi
if [ "$os" = Darwin ] && [ "$arch" = x86_64 ]; then
  if ! sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2; then
    unsupported "this Mac's CPU has no AVX2, which the Intel build needs (Macs from late 2013 on have it)."
  fi
fi

# macOS has no sha256sum; it ships shasum instead.
if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "praex: need sha256sum or shasum to verify the download" >&2; exit 1
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  echo "praex: need curl or wget to download" >&2; exit 1
fi

echo "Downloading praex ($ASSET)..."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fetch "$BASE_URL/dl/$ASSET" "$tmp/$ASSET"
fetch "$BASE_URL/dl/SHA256SUMS" "$tmp/SHA256SUMS"

echo "Verifying checksum..."
# SHA256SUMS covers every platform, so check our asset rather than the whole
# file: the tarballs we did not download are legitimately absent.
want="$(awk -v a="$ASSET" '$2 == a || $2 == "*" a {print $1; exit}' "$tmp/SHA256SUMS")"
if [ -z "$want" ]; then echo "praex: no checksum published for $ASSET" >&2; exit 1; fi
got="$(sha_cmd "$tmp/$ASSET")"
if [ "$want" != "$got" ]; then
  echo "praex: checksum mismatch for $ASSET" >&2
  echo "  expected: $want" >&2
  echo "  actual:   $got" >&2
  exit 1
fi

# Unpack and test the new binary before it replaces anything, so a build that cannot run on
# this machine never overwrites a working install.
mkdir -p "$tmp/new"
tar xzf "$tmp/$ASSET" -C "$tmp/new"
chmod +x "$tmp/new/praex"
if ! version="$("$tmp/new/praex" --version 2>&1)"; then
  echo "praex: the downloaded build does not run on this machine. Nothing was installed." >&2
  [ -n "$version" ] && echo "$version" | tail -3 | sed "s/^/  /" >&2
  echo "  Please report it at https://praex.ai with the output of: uname -a" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
# Rename into place (same filesystem after the copy), so a praex that is running keeps working.
cp "$tmp/new/praex" "$INSTALL_DIR/.praex-install.$$"
mv -f "$INSTALL_DIR/.praex-install.$$" "$INSTALL_DIR/praex"
if ! version="$("$INSTALL_DIR/praex" --version 2>&1)"; then
  echo "praex: installed to $INSTALL_DIR/praex but it does not start." >&2
  [ -n "$version" ] && echo "$version" | tail -3 | sed "s/^/  /" >&2
  exit 1
fi

echo ""
echo "  Installed: $INSTALL_DIR/praex ($(echo "$version" | tail -1))"
# Not on PATH yet: add it to the shell's startup file (once), the way bun and rustup do, so
# `praex` works in every new terminal. PRAEX_NO_MODIFY_PATH=1 skips this.
on_path=1
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    on_path=0
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    case "$(basename "${SHELL:-bash}")" in
      zsh)  rc="$HOME/.zshrc" ;;
      fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path \"$INSTALL_DIR\"" ;;
      bash) if [ "$os" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      *)    rc="$HOME/.profile" ;;
    esac
    if [ "${PRAEX_NO_MODIFY_PATH:-0}" != 1 ]; then
      mkdir -p "$(dirname "$rc")"
      if ! grep -qsF "$INSTALL_DIR" "$rc"; then
        printf '\n# praex\n%s\n' "$line" >> "$rc"
        echo "  Added $INSTALL_DIR to your PATH in $rc"
      fi
      echo "  Open a new terminal, or run this once here:  $line"
    else
      echo "  NOTE: add $INSTALL_DIR to your PATH:  $line"
    fi
    ;;
esac
echo ""
if [ "$on_path" = 1 ]; then echo "  Start it:           praex"; else echo "  Start it:           $INSTALL_DIR/praex   (or praex, in a new terminal)"; fi
echo "  Free hosted model:  praex login   (Velox II: free, every day)"
echo "  Or bring your own keys. praex speaks every major provider."
