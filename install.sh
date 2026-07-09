#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "orcats installer requires $1" >&2
    exit 1
  }
}

need curl
need tar

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "orcats installer supports macOS and Linux only" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *)
    echo "orcats installer supports arm64 and x64 only" >&2
    exit 1
    ;;
esac

asset="orcats-${os}-${arch}.tar.gz"
if [[ -n "${ORCA_VERSION:-}" ]]; then
  version="${ORCA_VERSION#v}"
  base_url="https://github.com/ASRagab/orca-ts/releases/download/v${version}"
else
  base_url="https://github.com/ASRagab/orca-ts/releases/latest/download"
fi

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

curl -fsSLo "$workdir/$asset" "$base_url/$asset"
curl -fsSLo "$workdir/SHA256SUMS.txt" "$base_url/SHA256SUMS.txt"

grep "  $asset$" "$workdir/SHA256SUMS.txt" > "$workdir/SHA256SUMS.check" || {
  echo "checksum for $asset not found" >&2
  exit 1
}

(
  cd "$workdir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS.check
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS.check
  else
    echo "orcats installer requires sha256sum or shasum" >&2
    exit 1
  fi
)

tar -xzf "$workdir/$asset" -C "$workdir"
install_dir="${ORCA_INSTALL_DIR:-$HOME/.local/bin}"
install -d "$install_dir"
install -m 0755 "$workdir/orcats" "$install_dir/orcats"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add to PATH: export PATH=\"$install_dir:\$PATH\"" ;;
esac

"$install_dir/orcats" --version
