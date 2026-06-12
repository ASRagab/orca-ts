# Backends

The v1 contract is backend-neutral: every backend maps native transport messages into the shared read-only `Conversation` interface.

Supported target backends are Claude, OpenCode, Codex, and Pi, each shipping a live autonomous driver (`claude()`, `opencode()`, `codex()`, `pi()`) behind the same SPI. Gemini is cut: its CLI is being deprecated by Google in favor of the Antigravity CLI (`agy`), and it never shipped a live streaming driver. Future Google support will be a new `agy` backend tag, not a revived Gemini backend.

Codex, Claude, and Pi are subprocess-stream backends: they share one `runSubprocessConversation` helper (`subprocess-run.ts`) that owns process spawn, stdout line-splitting, stderr capture, non-zero-exit failure, cancellation, a 120s inactivity watchdog, and a 600s wall-clock cap by default. Each supplies only its command/args builder and a per-line consumer. OpenCode is the exception — a long-lived `opencode serve` process driven over HTTP/SSE through a shared server manager, with its own 120s inactivity watchdog, 600s wall-clock cap, 30s startup timeout, and abortable POSTs.

Backend fixture collection uses the shared conversation harness so adapters keep protocol parsing local while event capture and final outcome collection stay in one module.

Autonomous human interaction is rejected. `UserQuestion` and `ApproveTool` remain explicit model variants; interactive support is only available when a backend starts an interactive session with an Orca-owned bridge.

## Codex

The Codex backend starts `codex exec --json` and maps JSONL events into the shared `Conversation` contract. Configure the local Codex CLI and credentials before running live integration checks.

The Codex child run lifecycle is internal to the backend adapter: config resolution, prompt composition, temporary schema files, the interactive `ask_user` bridge, process execution, stream consumption, stderr handling, cancellation, and cleanup are owned together.

Codex parity status:

- Backend config: model, approval policy, read-only mode, retry metadata, system prompt, self-managed git policy, and structured output are represented in the shared config model.
- Sessions/resume: TypeScript-facing session handles are backend-branded; Codex thread ids are captured from JSONL and can be requested on subsequent calls.
- Structured output: Zod schemas are converted to JSON Schema for supported live calls and validated again on return.
- `ask_user`: autonomous conversations reject `ask_user`; explicit interactive conversations use an Orca-owned MCP bridge.
- Approval events: Codex approval remains spawn-policy/config based until JSONL exposes approval request events.
- Tool events: Codex tool-call and tool-result events preserve call id, tool name, raw input, output content, and error status when the JSONL stream exposes them.

## Claude

The Claude backend spawns `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages` and feeds its stream-json read path into the shared conversation stream over `runSubprocessConversation`. The opening user turn is written to stdin as a `{"type":"user",...}` NDJSON frame, then stdin closes. Parity notes:

- Backend config: model (`--model`), read-only (`--permission-mode plan`; otherwise `bypassPermissions` for autonomous acting), system prompt / git policy / retry composed into the opening turn.
- Structured output: schema inlined via `--json-schema`; the final result is validated against the Zod schema and returns a typed validation error (with raw output) on mismatch.
- Sessions/resume: `--resume <id>` when a branded session handle is supplied; fresh runs let Claude mint the id, captured from the `result` message.
- Cancellation: `SIGTERM` to the child; the conversation completes cancelled.
- `ask_user`: autonomous only (`canAskUser=false`); the MCP ask-user bridge is intentionally not ported.

## OpenCode

The OpenCode backend drives a shared `opencode serve` process over HTTP/SSE (`opencode-run.ts`). The server is started lazily and reused across conversations through `createOpenCodeServerManager`; `opencode().shutdown()` stops it (orca-ts has no global scope hook, so the backend owner drives teardown). Each turn opens the `GET /event` SSE stream first, then starts the turn with `POST /session/{id}/prompt_async`, and reads to a terminal `session.idle`/`session.error`. Parity notes:

- Backend config travels in the message body: model (`{providerID, modelID}`), system prompt, per-tool gate (autonomous disables `question`; read-only disables `write`/`edit`/`bash`/`patch`).
- Structured output: schema sent as `format: {type: "json_schema", schema}`; the server-enforced `structured` payload is surfaced on the result.
- Cancellation: aborts the SSE stream and completes cancelled; the shared server stays alive for later conversations.
- The HTTP/SSE transport is injectable (`startServer`/`connect`) so unit tests use a fake and the `fetch`-backed default is exercised only under the integration smoke.

## Pi

The Pi backend spawns `pi --mode rpc --session-dir <dir>` (one dir per session id; `--continue` on resume) and feeds the rpc JSONL read path into the shared conversation stream. The prompt is sent as a stdin `{"type":"prompt",...}` command; the process is killed once `agent_end` settles the turn (pi rpc stays open for the next command otherwise). Parity notes:

- Backend config: model (`--model`); system prompt / git policy / retry composed into the prompt.
- Structured output: Pi has no native schema flag, so the final text is validated post-hoc against the Zod schema (typed validation error on mismatch).
- Cancellation: `SIGTERM` to the child; the conversation completes cancelled.
- `ask_user`: autonomous only; `PiAskUserExtension` is intentionally not ported.

## Selecting a backend at run time

Use `selectBackend()` when a flow should honor `ORCA_BACKEND` and the CLI `--backend` flag:

```ts
const selected = selectBackend({
  default: "codex",
  config: { readOnly: true },
  perBackend: {
    opencode: { model: "openai/gpt-5.5" }
  }
});
```

Resolution order:

1. `ORCA_BACKEND` chooses the backend tag; unset or empty falls back to `default`.
2. `config` applies to every backend.
3. `perBackend[tag]` overrides shared config for one backend.
4. `ORCA_BACKEND_MODEL` overrides `perBackend[tag].model` and `config.model`.

Invalid backend tags throw before a live backend process starts. OpenCode returns `shutdown`, and flow owners must call it when done because `opencode serve` is a managed process.

## Live backend smoke

The live backend smoke is gated so default tests and `bun run verify` stay deterministic:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

`ORCA_REAL_BACKEND` accepts `codex` (default), `claude`, `opencode`, or `pi`. The smoke creates a disposable git repository, runs one short autonomous conversation, and asserts a successful branded result. It skips when the selected backend's CLI is absent from `PATH`; with the gate disabled the test is skipped entirely.

## Monitoring and current dogfood baseline

`workflows/ai-slop-cleanup.ts --monitor` writes `.orca/monitoring/<runId>.json` with stage timing, per-file outcomes, validation command durations, repair counts, failure categories, changed paths, and backend usage/tokens when emitted. `bun run scripts/summarize-run.ts` summarizes those logs by backend, stage, file, repairs, failures, and usage.

Observed on 2026-06-12 using clean disposable repositories with `--no-publish --monitor --max-files=1` against `src/conversation/ask-user.ts`:

- Codex dogfood: total run `143.2s`, agent turn `128.8s`, per-file validation `4.2s`, final verify `4.7s`, usage `584,019` tokens.
- OpenCode dogfood: total run `68.6s`, agent turn `54.7s`, per-file validation `3.4s`, final verify `4.5s`, usage `55,497` tokens.

The measured bottleneck is backend/agent latency, not the conservative per-file validation gate. Validation de-duplication remains a follow-up experiment; current evidence does not justify relaxing typecheck/lint coverage yet.
