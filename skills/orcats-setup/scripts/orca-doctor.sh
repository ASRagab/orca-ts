#!/usr/bin/env bash
# orca-doctor — prove selected backend transport readiness.
#
# Static probes never spend tokens and therefore report `unverified` at best.
# `--smoke` (or ORCA_REAL_BACKEND_SMOKE=1) is explicit consent for one bounded
# live turn; only that turn can promote a backend/transport pair to `ready`.
set -uo pipefail

TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
run_timeout() {
  local secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$secs" "$@"; else "$@"; fi
}

backends=()
want_json=0
do_smoke=0
requested_transport=""
[ "${ORCA_REAL_BACKEND_SMOKE:-}" = "1" ] && do_smoke=1

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backends+=("${2:-}"); shift 2 ;;
    --backend=*) backends+=("${1#*=}"); shift ;;
    --transport) requested_transport="${2:-}"; shift 2 ;;
    --transport=*) requested_transport="${1#*=}"; shift ;;
    --all) backends=(claude codex opencode pi); shift ;;
    --json) want_json=1; shift ;;
    --smoke) do_smoke=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "orca-doctor: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

if [ "${#backends[@]}" -eq 0 ]; then
  echo "orca-doctor: no backend chosen — pass --backend <name> or --all" >&2
  exit 2
fi

transport_for() {
  case "$1" in
    claude) printf '%s' "${requested_transport:-${ORCA_CLAUDE_TRANSPORT:-stream-json}}" ;;
    codex|pi) printf '%s' "subprocess" ;;
    opencode) printf '%s' "http-sse" ;;
  esac
}

install_hint() {
  case "$1" in
    claude) echo "install Claude Code: https://docs.anthropic.com/en/docs/claude-code" ;;
    codex) echo "install Codex CLI, then: codex login" ;;
    opencode) echo "install opencode: https://opencode.ai, then: opencode auth login" ;;
    pi) echo "install the pi CLI and authenticate it" ;;
    *) echo "install the $1 CLI" ;;
  esac
}

# Echoes: backend<TAB>transport<TAB>status<TAB>reason<TAB>fix
probe() {
  local tag="$1" transport bin ver out adapter adapter_bin
  transport="$(transport_for "$tag")"
  case "$tag:$transport" in
    claude:stream-json|claude:acp|codex:subprocess|opencode:http-sse|pi:subprocess) ;;
    claude:*)
      printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "misconfig" \
        "unsupported Claude transport" "set ORCA_CLAUDE_TRANSPORT=stream-json or acp"
      return ;;
    *)
      printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "unknown" "missing" \
        "unknown backend tag" "expected one of: claude codex opencode pi"
      return ;;
  esac

  bin="$(command -v "$tag" 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "missing" \
      "CLI not on PATH" "$(install_hint "$tag")"
    return
  fi
  if ! ver="$(run_timeout 10 "$tag" --version 2>&1)"; then
    printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "misconfig" \
      "\`$tag --version\` failed: ${ver%%$'\n'*}" \
      "reinstall the $tag CLI; ensure it runs outside Orcats"
    return
  fi

  if [ "$tag" = "claude" ] && [ "$transport" = "acp" ]; then
    adapter="${ORCA_CLAUDE_ACP_COMMAND:-claude-agent-acp}"
    adapter_bin="${adapter%% *}"
    if ! command -v "$adapter_bin" >/dev/null 2>&1; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "missing" \
        "ACP adapter '$adapter_bin' not on PATH" \
        "install claude-agent-acp or set ORCA_CLAUDE_ACP_COMMAND"
      return
    fi
  fi

  case "$tag" in
    codex)
      if out="$(run_timeout 15 codex login status 2>&1)" \
         && printf '%s' "$out" | grep -qiE 'logged in'; then
        printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unverified" \
          "${ver%%$'\n'*}; static auth confirmed; transport not exercised" \
          "run with --smoke to prove $transport readiness"
      else
        printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unauth" \
          "not logged in" "run: codex login"
      fi ;;
    opencode)
      out="$(run_timeout 15 opencode auth list 2>&1 || true)"
      if printf '%s' "$out" | grep -qE 'oauth|api|apikey'; then
        printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unverified" \
          "${ver%%$'\n'*}; static credentials found; transport not exercised" \
          "run with --smoke to prove $transport readiness"
      else
        printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unauth" \
          "no credentials in opencode auth list" "run: opencode auth login"
      fi ;;
    claude)
      printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unverified" \
        "${ver%%$'\n'*}; static auth cannot prove selected transport" \
        "run with --smoke to prove $transport; if auth fails, run claude then /login" ;;
    pi)
      printf '%s\t%s\t%s\t%s\t%s\n' "$tag" "$transport" "unverified" \
        "${ver%%$'\n'*}; static auth cannot prove selected transport" \
        "run with --smoke to prove $transport; configure pi auth if it fails" ;;
  esac
}

run_smoke() {
  local tag="$1" transport="$2" orca_bin tmp flow out
  orca_bin="$(command -v orcats 2>/dev/null || true)"
  if [ -z "$orca_bin" ]; then
    echo "  smoke[$tag/$transport]: FAILED (orcats binary not on PATH)" >&2
    return 1
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/orca-smoke.XXXXXX")"
  flow="$tmp/ping.ts"
  cat > "$flow" <<'TS'
import { flow, selectBackend, llm } from "@twelvehart/orcats";
await flow([])(async () => {
  const s = selectBackend({ default: "claude" });
  try {
    const c = llm().autonomous(s.backend, { prompt: "Reply with the single word: pong." });
    const o = await c.awaitResult();
    if (o.type !== "success") { console.error(`smoke-failed:${o.type}`); process.exitCode = 1; return; }
    console.log("orcats-smoke-ok");
  } finally { await s.shutdown?.(); }
});
TS
  if out="$(cd "$tmp" && ORCA_CLAUDE_TRANSPORT="$transport" \
      run_timeout 120 "$orca_bin" --backend "$tag" --no-typecheck ping.ts 2>&1)" \
     && printf '%s' "$out" | grep -q "orcats-smoke-ok"; then
    echo "  smoke[$tag/$transport]: OK (live turn succeeded)" >&2
    rm -rf "$tmp"; return 0
  fi
  echo "  smoke[$tag/$transport]: FAILED — ${out##*$'\n'}" >&2
  rm -rf "$tmp"; return 1
}

results=()
for tag in "${backends[@]}"; do results+=("$(probe "$tag")"); done

any_ready=0
json_rows=()
for row in "${results[@]}"; do
  IFS=$'\t' read -r tag transport status reason fix <<< "$row"
  if [ "$do_smoke" -eq 1 ] && [ "$status" = "unverified" ]; then
    if run_smoke "$tag" "$transport"; then
      status="ready"; reason="bounded live turn succeeded"
      fix=""; any_ready=1
    else
      status="unauth"; reason="selected-transport live smoke failed"
      fix="repair $tag/$transport authentication or transport, then rerun --smoke"
    fi
  fi
  [ "$status" = "ready" ] && any_ready=1

  if [ "$want_json" -eq 1 ]; then
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    json_rows+=("{\"backend\":\"$(esc "$tag")\",\"transport\":\"$(esc "$transport")\",\"status\":\"$(esc "$status")\",\"reason\":\"$(esc "$reason")\",\"fix\":\"$(esc "$fix")\"}")
  else
    icon="✖"; case "$status" in ready) icon="✓" ;; unverified) icon="◐" ;; esac
    printf '%s %-9s %-12s %-10s %s\n' "$icon" "$tag" "$transport" "$status" "$reason"
    [ -n "$fix" ] && [ "$status" != "ready" ] && printf '    fix: %s\n' "$fix"
  fi
done

if [ "$want_json" -eq 1 ]; then
  printf '{"pass":%s,"backends":[%s]}\n' \
    "$([ "$any_ready" -eq 1 ] && echo true || echo false)" \
    "$(IFS=,; echo "${json_rows[*]}")"
fi

if [ "$any_ready" -eq 1 ]; then
  [ "$want_json" -eq 1 ] || echo "doctor OK — selected transport proved usable"
  exit 0
fi
[ "$want_json" -eq 1 ] || echo "doctor INCOMPLETE — no selected transport proved usable" >&2
exit 1
