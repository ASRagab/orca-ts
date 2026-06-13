# Backend matrix

Four live autonomous backends, one SPI. Gemini is cut (its CLI is deprecated in
favor of `agy`); future Google support will be a new `agy` tag, not a revived
Gemini backend — do not author against Gemini.

| Tag | Constructor | CLI requirement | Non-spending readiness probe | Auth proof |
|---|---|---|---|---|
| `claude` | `claude()` | `claude` on PATH, authenticated | `claude --version` | credentials file / token env; else live smoke |
| `codex` | `codex()` | `codex` on PATH, authenticated | `codex --version` + `codex login status` | **definitive** (`login status` reports "Logged in") |
| `opencode` | `opencode()` | `opencode` on PATH; Orca manages `opencode serve` | `opencode --version` + `opencode auth list` | **definitive** (provider listed) |
| `pi` | `pi()` | `pi` on PATH, authenticated | `pi --version` | `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` env; else live smoke |

`scripts/orca-doctor.sh` implements exactly these probes and classifies each
backend `ready | unauth | missing | misconfig | unverified`. `--smoke` (or
`ORCA_REAL_BACKEND_SMOKE=1`) runs one real cheap turn through the `orca` binary
for definitive auth proof on claude/pi.

## Transport notes that affect flows

- **Subprocess backends** (`claude`, `codex`, `pi`): each turn spawns the CLI,
  streams to a terminal result. Shared 120s inactivity watchdog + 600s
  wall-clock cap. No managed process to clean up.
- **OpenCode**: a long-lived `opencode serve` driven over HTTP/SSE, started
  lazily and reused across conversations. **You must call `selected.shutdown?.()`
  (or `opencode().shutdown()`) when the flow ends**, or the server leaks. Always
  put it in a `finally`. Only OpenCode returns a non-undefined `shutdown`.

## Structured output reliability

- `claude`, `codex`, `pi`: native schema enforcement is reliable; pass `schema`
  and read `outcome.result.structured`.
- `opencode`: structured output after tool use is unreliable (server hang
  observed on 1.16.x). For tool-using turns, omit `schema` for OpenCode and
  parse JSON out of `outcome.result.output` instead. See `gotchas.md`.
- Backends without a native schema flag (`pi`) validate post-hoc against the Zod
  schema and may emit off-shape values (capitalized enums, arrays where a string
  is expected) — use `z.preprocess(...)` to normalize before `z.enum`/`z.string`.

## `ask_user`

Autonomous conversations reject human interaction (`canAskUser=false`) on every
backend. Do not author a flow that depends on the running agent asking the
operator a question — that interactivity is intentionally not ported. Decisions
the workflow needs must be encoded as flow logic or CLI args.

## Selecting at run time

`selectBackend()` resolution order:

1. `ORCA_BACKEND` (set by `orca --backend <tag>`) chooses the tag; unset → `default`.
2. `config` applies to all backends; `perBackend[tag]` overrides it for one.
3. `ORCA_BACKEND_MODEL` overrides `perBackend[tag].model` and `config.model`.

Invalid tags throw before any process starts. Prefer `selectBackend` in saved
workflows so the same `.orca/workflows/<name>.ts` can be re-run on a different
backend via `--backend` without editing the file.
