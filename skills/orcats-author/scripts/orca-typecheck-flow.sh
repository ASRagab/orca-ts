#!/usr/bin/env bash
# Compatibility wrapper for the mandatory self-contained artifact checker.
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: orca-typecheck-flow.sh <artifact.ts>" >&2; exit 2; }
artifact="$1"
[ -f "$artifact" ] || { echo "artifact not found: $artifact" >&2; exit 2; }
orcats_bin="$(command -v orcats 2>/dev/null || true)"
[ -n "$orcats_bin" ] || { echo "orcats binary not on PATH" >&2; exit 1; }
exec "$orcats_bin" check "$artifact"
