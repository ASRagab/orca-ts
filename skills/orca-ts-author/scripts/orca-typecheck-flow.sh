#!/usr/bin/env bash
# orca-typecheck-flow — best-effort author-time typecheck of a generated flow.
#
#   orca-typecheck-flow.sh <flow.ts>
#
# Typechecks the flow WHEN a TypeScript toolchain is reachable — defined as: the
# flow's repo has a tsconfig.json and resolves `@twelvehart/orca-ts` (as a
# dependency, or because it IS this package repo). It does so by writing a
# scratch tsconfig that
# EXTENDS the repo's own tsconfig (inheriting its lib/types/resolution) and
# includes only the flow, then running `tsc --noEmit`. In a target repo with no
# TS setup (e.g. a Python/Go project using only the standalone binary) there is
# nothing to typecheck against, so it reports SKIPPED — correctness then rides on
# the CI-gated templates plus the codegen self-audit (reference/gotchas.md).
#
# Exit codes:
#   0  typecheck passed, OR skipped (no reachable TS setup)
#   1  real typecheck failure in the flow
set -uo pipefail

[ $# -lt 1 ] && { echo "usage: orca-typecheck-flow.sh <flow.ts>" >&2; exit 2; }
flow="$1"
[ -f "$flow" ] || { echo "✖ flow not found: $flow" >&2; exit 2; }

skip() { echo "TYPECHECK SKIPPED: $1" >&2; exit 0; }

# TS compiler runner.
tsc_run=""
if command -v bunx >/dev/null 2>&1; then tsc_run="bunx tsc"
elif command -v npx >/dev/null 2>&1; then tsc_run="npx --no-install tsc"
elif command -v tsc >/dev/null 2>&1; then tsc_run="tsc"
fi
[ -z "$tsc_run" ] && skip "no TypeScript compiler reachable (bunx/npx/tsc)"

flow_abs="$(cd "$(dirname "$flow")" && pwd)/$(basename "$flow")"

# Nearest tsconfig.json from the flow upward = the repo's TS setup.
proj="" base_tsconfig=""
dir="$(dirname "$flow_abs")"
while [ "$dir" != "/" ]; do
  if [ -f "$dir/tsconfig.json" ]; then proj="$dir"; base_tsconfig="$dir/tsconfig.json"; break; fi
  dir="$(dirname "$dir")"
done
[ -z "$proj" ] && skip "no tsconfig.json in the flow's repo (TS toolchain not reachable)"

# @twelvehart/orca-ts must resolve from the repo: installed as a dep, or this
# is the package repo.
resolves=0
[ -f "$proj/node_modules/@twelvehart/orca-ts/package.json" ] && resolves=1
if [ "$resolves" -eq 0 ] && [ -f "$proj/package.json" ] \
   && grep -q '"name"[[:space:]]*:[[:space:]]*"@twelvehart/orca-ts"' "$proj/package.json"; then resolves=1; fi
[ "$resolves" -eq 0 ] && skip "@twelvehart/orca-ts is not a resolvable dependency of this repo"

# Scratch tsconfig in the repo root (so node_modules + self-reference resolve),
# extending the repo's own config and checking only the flow.
scratch="$proj/.orca-flowcheck.$$.tsconfig.json"
cleanup() { rm -f "$scratch"; }
trap cleanup EXIT
cat > "$scratch" <<EOF
{
  "extends": "$base_tsconfig",
  "compilerOptions": { "rootDir": "." },
  "include": ["$flow_abs"]
}
EOF

out="$(cd "$proj" && $tsc_run --noEmit -p "$scratch" 2>&1)"
if [ $? -eq 0 ]; then
  echo "typecheck OK: $flow"
  exit 0
fi

echo "✖ typecheck FAILED for $flow:" >&2
printf '%s\n' "$out" | grep -E 'error TS' >&2 || printf '%s\n' "$out" >&2
exit 1
