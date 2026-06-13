#!/usr/bin/env bash
# orca-run — run a saved Orca flow through the standalone binary and surface its
# exit status. Stack-agnostic: depends only on the `orca` binary, not on the
# target repo's package manager. Used by orca-ts-flow.
#
#   orca-run.sh .orca/workflows/<name>.ts                 # run with defaults
#   orca-run.sh .orca/workflows/<name>.ts --backend codex # override backend
#   orca-run.sh .orca/workflows/<name>.ts --monitor --max-files=1
#
# Everything after the flow path is forwarded verbatim to the flow (and to the
# `orca` CLI for --backend/--no-typecheck). The flow's own args (e.g. --monitor)
# are honored by the flow. orca prints any per-agent cost/usage summary itself;
# this wrapper adds the exit line and points at the monitor log dir.
set -uo pipefail

[ $# -lt 1 ] && { echo "usage: orca-run.sh <flow.ts> [orca/flow args...]" >&2; exit 2; }
flow="$1"; shift
[ -f "$flow" ] || { echo "✖ flow not found: $flow" >&2; exit 2; }

orca_bin="$(command -v orca 2>/dev/null || true)"
[ -z "$orca_bin" ] && { echo "✖ orca binary not on PATH — run orca-setup.sh first" >&2; exit 1; }

monitor_dir="${ORCA_MONITOR_DIR:-$(pwd)/.orca/monitoring}"

echo "▶ $orca_bin $flow $*" >&2
"$orca_bin" "$flow" "$@"
ec=$?
echo "▶ orca flow exit=$ec" >&2
if [ -d "$monitor_dir" ]; then
  latest="$(ls -t "$monitor_dir"/*.json 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] && echo "▶ monitor log: $latest" >&2
fi
exit $ec
