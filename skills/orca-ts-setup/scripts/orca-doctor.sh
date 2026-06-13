#!/usr/bin/env bash
# orca-doctor — probe Orca backends for readiness without spending tokens.
#
# Used by orca-ts-setup (preflight: enable >=1 backend) and orca-ts-flow
# (runtime healing: re-verify a backend after an auth/crash failure). Locates
# every CLI at runtime via `command -v` — never hardcodes a path.
#
#   orca-doctor.sh --backend codex                 # probe one backend
#   orca-doctor.sh --backend claude --backend pi    # probe several
#   orca-doctor.sh --all                            # probe all four
#   orca-doctor.sh --backend codex --json           # machine-readable (for orca-ts-flow)
#   orca-doctor.sh --backend codex --smoke          # + live one-turn smoke (spends a little)
#
# Live smoke also runs when ORCA_REAL_BACKEND_SMOKE=1 is set in the environment.
#
# Per-backend status is one of:
#   ready       CLI on PATH, --version ok, and auth confirmed (or unverifiable)
#   unauth      CLI present but not authenticated
#   missing     CLI not on PATH
#   misconfig   CLI present but --version failed (broken install)
#   unverified  CLI + version ok, auth could not be cheaply proven (claude/pi)
#
# Exit 0 iff at least one chosen backend is `ready` or `unverified`.
# Exit 1 if every chosen backend is missing/unauth/misconfig.
set -uo pipefail

# GNU `timeout` is not installed on stock macOS (and may be `gtimeout` via
# coreutils). Fall back to running the probe uncapped rather than failing every
# backend as misconfig when no timeout binary exists.
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
run_timeout() {
  local secs="$1"; shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$secs" "$@"
  else
    "$@"
  fi
}

backends=()
want_json=0
do_smoke=0
[ "${ORCA_REAL_BACKEND_SMOKE:-}" = "1" ] && do_smoke=1

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backends+=("${2:-}"); shift 2 ;;
    --backend=*) backends+=("${1#*=}"); shift ;;
    --all) backends=(claude codex opencode pi); shift ;;
    --json) want_json=1; shift ;;
    --smoke) do_smoke=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "orca-doctor: unknown arg '$1'" >&2; shift ;;
  esac
done

if [ "${#backends[@]}" -eq 0 ]; then
  echo "orca-doctor: no backend chosen — pass --backend <name> or --all" >&2
  exit 2
fi

# Probe one backend. Echoes: "<tag>\t<status>\t<reason>\t<fix>"
probe() {
  local tag="$1" bin ver
  case "$tag" in
    claude|codex|opencode|pi) ;;
    *) printf '%s\t%s\t%s\t%s\n' "$tag" "missing" "unknown backend tag" \
        "expected one of: claude codex opencode pi"; return ;;
  esac

  bin="$(command -v "$tag" 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    printf '%s\t%s\t%s\t%s\n' "$tag" "missing" "CLI not on PATH" \
      "$(install_hint "$tag")"
    return
  fi

  if ! ver="$(run_timeout 10 "$tag" --version 2>&1)"; then
    printf '%s\t%s\t%s\t%s\n' "$tag" "misconfig" "\`$tag --version\` failed: ${ver%%$'\n'*}" \
      "reinstall the $tag CLI; ensure it runs outside Orca"
    return
  fi

  # Auth probe — definitive where the CLI offers a non-spending status check.
  case "$tag" in
    codex)
      local out
      if out="$(run_timeout 15 codex login status 2>&1)" && printf '%s' "$out" | grep -qiE 'logged in'; then
        printf '%s\t%s\t%s\t%s\n' "$tag" "ready" "${ver%%$'\n'*}; ${out%%$'\n'*}" ""
      else
        printf '%s\t%s\t%s\t%s\n' "$tag" "unauth" "not logged in" "run: codex login"
      fi
      ;;
    opencode)
      local out
      out="$(run_timeout 15 opencode auth list 2>&1 || true)"
      if printf '%s' "$out" | grep -qE 'oauth|api|apikey'; then
        printf '%s\t%s\t%s\t%s\n' "$tag" "ready" "${ver%%$'\n'*}; credentials present" ""
      else
        printf '%s\t%s\t%s\t%s\n' "$tag" "unauth" "no credentials in opencode auth list" \
          "run: opencode auth login"
      fi
      ;;
    claude)
      # Claude Code has no safe non-interactive auth-status check. Treat a
      # present credentials file / token env as auth; otherwise unverified.
      if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}" ] \
         || [ -f "$HOME/.claude/.credentials.json" ]; then
        printf '%s\t%s\t%s\t%s\n' "$tag" "ready" "${ver%%$'\n'*}; credentials found" ""
      else
        printf '%s\t%s\t%s\t%s\n' "$tag" "unverified" "${ver%%$'\n'*}; auth not provable cheaply" \
          "if a run fails on auth, run: claude  (then /login), or --smoke to confirm now"
      fi
      ;;
    pi)
      if [ -n "${ANTHROPIC_OAUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}" ]; then
        printf '%s\t%s\t%s\t%s\n' "$tag" "ready" "${ver%%$'\n'*}; token env present" ""
      else
        printf '%s\t%s\t%s\t%s\n' "$tag" "unverified" "${ver%%$'\n'*}; auth not provable cheaply" \
          "set ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN or run pi's login, or --smoke to confirm now"
      fi
      ;;
  esac
}

install_hint() {
  case "$1" in
    claude)   echo "install Claude Code: https://docs.anthropic.com/en/docs/claude-code" ;;
    codex)    echo "install Codex CLI, then: codex login" ;;
    opencode) echo "install opencode: https://opencode.ai, then: opencode auth login" ;;
    pi)       echo "install the pi CLI and authenticate it" ;;
    *)        echo "install the $1 CLI" ;;
  esac
}

# Optional live smoke: one cheap autonomous turn through the real `orca` binary.
# Definitive auth proof, stack-agnostic (needs only the orca binary on PATH).
run_smoke() {
  local tag="$1"
  local orca_bin tmp flow out
  orca_bin="$(command -v orca 2>/dev/null || true)"
  if [ -z "$orca_bin" ]; then
    echo "  smoke[$tag]: SKIPPED (orca binary not on PATH)" >&2
    return 0
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/orca-smoke.XXXXXX")"
  flow="$tmp/ping.ts"
  cat > "$flow" <<'TS'
import { flow, selectBackend, llm } from "orca-ts";
await flow([])(async () => {
  const s = selectBackend({ default: "claude" });
  try {
    const c = llm().autonomous(s.backend, { prompt: "Reply with the single word: pong." });
    const o = await c.awaitResult();
    if (o.type !== "success") { console.error(`smoke-failed:${o.type}`); process.exitCode = 1; return; }
    console.log("orca-smoke-ok");
  } finally {
    await s.shutdown?.();
  }
});
TS
  if out="$(cd "$tmp" && run_timeout 120 "$orca_bin" --backend "$tag" --no-typecheck ping.ts 2>&1)" \
     && printf '%s' "$out" | grep -q "orca-smoke-ok"; then
    echo "  smoke[$tag]: OK (live turn succeeded)" >&2
    rm -rf "$tmp"; return 0
  fi
  echo "  smoke[$tag]: FAILED — ${out##*$'\n'}" >&2
  rm -rf "$tmp"; return 1
}

results=()
for tag in "${backends[@]}"; do
  results+=("$(probe "$tag")")
done

# Pass = at least one backend ready or unverified (version ok). Smoke, when on,
# demotes a backend to fail if its live turn does not succeed.
any_pass=0
json_rows=()
for row in "${results[@]}"; do
  IFS=$'\t' read -r tag status reason fix <<< "$row"
  smoke_note=""
  if [ "$do_smoke" -eq 1 ] && { [ "$status" = "ready" ] || [ "$status" = "unverified" ]; }; then
    if run_smoke "$tag"; then status="ready"; smoke_note=" (smoke ok)"; else status="unauth"; reason="live smoke failed"; fix="re-authenticate the $tag CLI"; fi
  fi
  case "$status" in ready|unverified) any_pass=1 ;; esac

  if [ "$want_json" -eq 1 ]; then
    esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
    json_rows+=("{\"backend\":\"$(esc "$tag")\",\"status\":\"$(esc "$status")\",\"reason\":\"$(esc "$reason")\",\"fix\":\"$(esc "$fix")\"}")
  else
    icon="✖"; case "$status" in ready) icon="✓" ;; unverified) icon="◐" ;; esac
    printf '%s %-9s %-10s %s%s\n' "$icon" "$tag" "$status" "$reason" "$smoke_note"
    [ -n "$fix" ] && [ "$status" != "ready" ] && printf '    fix: %s\n' "$fix"
  fi
done

if [ "$want_json" -eq 1 ]; then
  printf '{"pass":%s,"backends":[%s]}\n' \
    "$([ "$any_pass" -eq 1 ] && echo true || echo false)" \
    "$(IFS=,; echo "${json_rows[*]}")"
fi

if [ "$any_pass" -eq 1 ]; then
  [ "$want_json" -eq 1 ] || echo "doctor OK — at least one backend usable"
  exit 0
else
  [ "$want_json" -eq 1 ] || echo "doctor FAILED — no chosen backend is usable; resolve the items above" >&2
  exit 1
fi
