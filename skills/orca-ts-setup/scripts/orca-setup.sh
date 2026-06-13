#!/usr/bin/env bash
# orca-setup — locate or install the standalone `orca` binary, then confirm it
# runs. Binary-only use needs neither Bun, Node, nor a JVM.
#
#   orca-setup.sh                 # use an on-PATH orca, else run the installer
#   ORCA_VERSION=0.1.0 orca-setup.sh
#   ORCA_INSTALL_DIR="$HOME/.local/bin" orca-setup.sh
#
# Honors ORCA_VERSION and ORCA_INSTALL_DIR (passed through to install.sh).
# When ORCA_INSTALL_DIR is unset, install.sh defaults to $HOME/.local/bin.
# Prints the resolved binary path and version on success.
set -uo pipefail

INSTALL_URL="https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh"

confirm() {
  local bin="$1" v
  if v="$("$bin" --version 2>&1)"; then
    echo "✓ orca: $bin ($v)"
    return 0
  fi
  echo "✖ \`$bin --version\` failed: ${v%%$'\n'*}" >&2
  return 1
}

# 1. Already on PATH? Honor it (re-runnable / doctor mode — no reinstall).
existing="$(command -v orca 2>/dev/null || true)"
if [ -n "$existing" ]; then
  if [ -n "${ORCA_VERSION:-}" ]; then
    cur="$("$existing" --version 2>/dev/null | sed -E 's/^orca[[:space:]]+//')"
    if [ "$cur" != "$ORCA_VERSION" ]; then
      echo "⚠ on-PATH orca is $cur but ORCA_VERSION=$ORCA_VERSION requested — installing pinned version" >&2
    else
      confirm "$existing" && exit 0
    fi
  else
    confirm "$existing" && exit 0
  fi
fi

# 2. Not present (or wrong pin) — run the documented installer.
if ! command -v curl >/dev/null 2>&1; then
  echo "✖ curl not found — install curl, or download the release binary manually from" >&2
  echo "  https://github.com/ASRagab/orca-ts/releases" >&2
  exit 1
fi

echo "Installing orca via $INSTALL_URL ${ORCA_VERSION:+(version $ORCA_VERSION)} ${ORCA_INSTALL_DIR:+to $ORCA_INSTALL_DIR}" >&2
if ! curl -fsSL "$INSTALL_URL" | bash; then
  echo "✖ installer failed (network or checksum). Manual fallback:" >&2
  echo "  1. Download the tarball + SHA256SUMS.txt for your platform from" >&2
  echo "     https://github.com/ASRagab/orca-ts/releases" >&2
  echo "  2. Verify: shasum -a 256 -c SHA256SUMS.txt" >&2
  echo "  3. Move the extracted 'orca' onto your PATH" >&2
  exit 1
fi

# 3. Re-resolve and confirm (installer may drop into a dir not yet on PATH).
# install.sh installs to ${ORCA_INSTALL_DIR:-$HOME/.local/bin}; mirror that
# default here so the fallback finds a freshly-installed binary even when the
# target dir is not yet on PATH and ORCA_INSTALL_DIR was left unset.
hash -r 2>/dev/null || true
resolved="$(command -v orca 2>/dev/null || true)"
install_dir="${ORCA_INSTALL_DIR:-$HOME/.local/bin}"
if [ -z "$resolved" ] && [ -x "$install_dir/orca" ]; then
  resolved="$install_dir/orca"
  echo "⚠ orca installed to $resolved but that dir is not on PATH — add it: export PATH=\"$install_dir:\$PATH\"" >&2
fi

if [ -z "$resolved" ]; then
  echo "✖ orca not found after install; check the installer output above" >&2
  exit 1
fi

confirm "$resolved"
