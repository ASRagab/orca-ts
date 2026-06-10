# Per-backend parity pass (task 6.4)

Each TS driver was diffed against its Scala sibling at `/Users/ahmad.ragab/Dev/tools/orca` (v0.0.11). Lifecycle, arg construction, result branding, and failure/cancel paths match unless listed below as a deliberate divergence.

## Shared subprocess helper (`subprocess-run.ts`)
- Maps Scala's `StreamConversation` reader-thread + `StreamSource.fromProcess` boilerplate. TS owns: spawn, stdout line-split, stderr capture, non-zero-exit failure, cancellation, and break-on-`completed` (for persistent processes).
- **Divergence:** the helper does NOT catch spawn/setup exceptions — each driver wraps the call in its own try/catch/finally. Keeps spawn-error→fail and resource teardown synchronous with the failure (codex's ask_user bridge cleanup ordering depends on it).
- **Divergence:** `closeOnComplete` kills the process once the turn settles (pi rpc stays open for the next command). Scala relies on per-backend conversation lifecycle; TS centralizes it.

## codex (`codex-run.ts` ↔ `CodexBackend`/`CodexConversation`)
- Refactored onto the shared helper with zero behavior change — the full pre-existing codex suite passes unchanged (the regression gate for the extraction). Prompt-as-argv, schema file + `--output-schema`, interactive `ask_user` MCP bridge, and resume all preserved.
- **Lifecycle note:** with break-on-`completed`, codex's success path no longer `await`s `process.exit` / drains trailing stdout (codex exits after `turn.completed`, so harmless). The non-zero-exit failure path is unchanged (no terminal event → loop runs to stdout end → exit check).

## claude (`claude-run.ts` ↔ `ClaudeBackend`/`ClaudeArgs`/`ClaudeConversation`)
- Args match `ClaudeArgs.streamJson`: `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages`, `--model`, `--resume`, `--permission-mode`, inline `--json-schema`. Opening user turn written to stdin as the `OutboundMessage.UserText` NDJSON shape, then stdin closed.
- Structured output: the `result` message's `structured_output` field (the schema-enforced JSON subtree) is preferred over `result`, matching Scala `structuredOutput.orElse(output)`; the value is validated against the Zod schema (typed validation error + raw on mismatch). Without `--json-schema`, `result` is used unchanged.
- **Divergences (deliberate):**
  - ask_user MCP bridge, `--mcp-config`, control-request tool approval, and the system-prompt **file** (`--append-system-prompt-file`) are not ported. Autonomous-only (`canAskUser=false`); system prompt / git policy / retry are composed into the opening user turn instead (consistent with codex's TS prompt composition).
  - Fresh runs let claude mint the session id (captured from `result`) rather than pre-allocating a `--session-id` UUID + `SessionRegistry.ClaimedOnce`; resume passes `--resume <id>`. The claimed-once registry is an orchestrator concern out of this change's scope.
- **Permission default matches the oracle:** non-readOnly → `--permission-mode bypassPermissions`, mapping Scala `LlmConfig`'s default `autoApprove = AutoApprove.All` (confirmed `LlmConfig.scala:10`); readOnly → `--permission-mode plan`. (`Only(empty) → acceptEdits` and `Only(set) → --allowedTools` are reachable in Scala via explicit config but not yet surfaced by orca-ts `BackendConfig`.)

## opencode (`opencode-run.ts` ↔ `OpencodeBackend`/`OpencodeServer`/`OpencodeConversation`/`OpencodeHttp`)
- Lazy shared `opencode serve`, reused across conversations; open `GET /event` SSE first, then `POST /session/{id}/prompt_async`; read to terminal `session.idle`/`session.error`. Message body matches `OpencodeArgs.message` (`{providerID,modelID}` model, system, tool gate disabling `question` on autonomous + write tools on read-only, `format` json_schema). Session create via `POST /session`.
- The per-turn SSE connection is closed in a `finally` (stream-scoped `AbortController`), matching Scala `runAutonomous`'s `finally source.interrupt()` — `session.idle` ends the turn but not the stream, so a successful turn must close it explicitly. Covered by the "closes the SSE stream after a successful turn" test.
- Default `fetch` transport (`createFetchOpenCodeHttp`) sends preemptive `Authorization: Basic base64("opencode:<password>")` on every request (the `OPENCODE_SERVER_PASSWORD` the spawn set) and throws on non-2xx responses, matching `JavaNetOpencodeHttp`. Covered by `tests/opencode-fetch-http.test.ts`.
- **Divergences (deliberate):**
  - Teardown is a caller-invoked `opencode().shutdown()` — orca-ts has no Ox `releaseAfterScope` equivalent. Documented in `docs/backends.md` and the ADR matrix.
  - HTTP/SSE transport is injectable (`startServer`/`connect`); `createFetchOpenCodeHttp` is the default and the live path is also exercised under the integration smoke.
  - `question`/`permission` reply paths and interactive mode are not ported (autonomous-only).

## pi (`pi-run.ts` ↔ `PiBackend`/`PiArgs`/`PiConversation`/`rpc`)
- Args match `PiArgs.rpc`: `--mode rpc --session-dir <dir>`, `--continue` on resume, `--model`, and `--tools read,grep,find,ls` on read-only turns (`PiArgs.ReadOnlyTools`). Prompt sent as the `{type:"prompt"}` stdin command; process killed once `agent_end` settles (`closeOnComplete`).
- **Divergences (deliberate):**
  - `PiAskUserExtension` (`--extension` + the ask-user entry in the read-only `--tools` set) not ported — autonomous-only.
  - No native schema flag, so structured output is post-hoc Zod validation of the final `agent_end` text (typed validation error on mismatch).
  - Per-session `--session-dir` is a temp dir keyed by session id; the `SessionRegistry.ClaimedOnce` claim-after-success semantics are out of scope.
  - System-prompt file (`--append-system-prompt`) replaced by prompt composition, as with claude.

## Not ported anywhere (consistent with proposal/design)
- `DefaultClaudeTool`/`DefaultOpencodeTool`/`DefaultPiTool`/`DefaultCodexTool`, the MCP ask-user bridge for non-codex backends, and the gemini live driver (still a stub).
