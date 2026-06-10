# Design — Fix OpenCode Driver Parity

## Context

The TS OpenCode driver (`src/backends/opencode-sse.ts`, `src/backends/opencode-run.ts`) consumes the opencode server's global `/event` SSE firehose and maps frames into the normalized conversation event model. The Scala oracle (`/Users/ahmad.ragab/Dev/tools/orca/opencode/src/main/scala/orca/tools/opencode/OpencodeConversation.scala`, `OpencodeEvent.scala`) implements six behaviors the TS port dropped: session filtering, assistant-role filtering, `info.error` capture, two-shape error-envelope extraction, tool error frames, and server-side abort on cancel. The dogfood session's "opaque agent errors" are substantially explained by these gaps: agent failures rode `info.error` and tool `status:"error"` frames the driver discarded, then `session.idle` reported success with empty output.

Full bug-by-bug analysis with oracle line references: `.orca/opencode-troubleshooting-plan.md` Part 1.

## Goals / Non-Goals

**Goals:**

- Restore parity with the Scala oracle for the six behaviors above (Bugs A–F) plus two minor nits (G: `cache.write` in usage input; H: reasoning deltas).
- Make opencode agent failures surface as readable failure messages at the workflow level.
- Keep the hang-vs-slow trace methodology sound: only own-session events should count as activity.

**Non-Goals:**

- `permission.asked` / `question.asked` porting (deferred; env auto-approves today — see plan Part 3).
- Fixing the upstream opencode 1.16.2 structured-`format`+tools stall (upstream bug; the no-`format` workaround stays).
- Re-diagnosing opencode viability — that is Part 2 of the plan and happens after this change lands.
- Changing any other backend or the `Conversation` contract surface.

## Decisions

### D1: Session filtering lives in the SSE consumer, parameterized by session ID

`createOpenCodeSseConsumer(conversation, session: string)` — the consumer takes the resolved `ses_…` ID at construction. `runOpenCodeConversation` already resolves the session (`opencode-run.ts:86`) before building the consumer (line 90), so threading requires no restructuring.

Session ID extraction per event type, matching the oracle exactly:
- part events (`message.part.updated`): `properties.sessionID ?? part.sessionID`
- `message.updated`: `properties.sessionID ?? info.sessionID`
- `session.idle` / `session.error`: `properties.sessionID`

Filter rule (oracle `forall` semantics, `OpencodeEvent.scala:44-50`): non-terminal events with a session ID ≠ ours → ignore; **terminal** events (`session.idle`, `session.error`) are ignored only when they carry a session ID AND it ≠ ours. A terminal frame with a *missing* session ID settles the turn — protocol deviations must settle, not hang.

*Alternative considered:* filtering in `runOpenCodeConversation` before handing lines to the consumer. Rejected: extraction rules differ per event type, so the consumer (which already parses the event shape) is the natural seam; pre-filtering would duplicate the parse.

### D2: `session.idle` becomes a three-way settle, driven by captured assistant state

State gains `error: unknown | undefined` (captured from assistant `message.updated` `info.error` only — Bug B's role filter gates this). At `session.idle`:

1. `state.error` present → `conversation.fail(backendFailed("opencode", extractOpenCodeErrorMessage(state.error)))`
2. no assistant info ever seen AND `state.output === ""` → fail `"session went idle without an assistant message"`
3. otherwise → succeed as today.

This mirrors oracle `finishTurn` (`OpencodeConversation.scala:139-147`) and is the load-bearing fix: it converts "success with garbage output → JSON repair loop → looks stuck" into a fast, readable failure.

### D3: Shared two-shape error extractor

`extractOpenCodeErrorMessage(error: unknown): string` — try `.message`, then `.data.message`, else `JSON.stringify(error)`. Used by both the `session.error` path and the new `info.error` path. Matches oracle `OpencodeEvent.scala:153-163`.

### D4: Tool error frames map to `tool_result` with `isError: true`

`message.part.updated` with `state.status === "error"` emits `tool_result { isError: true, output: part.state.output }` (oracle `ToolFinished(ok=false)`). Cheap addition while in the same switch: emit `tool_call` on first `status === "running"` per `part.id` (oracle's `startedTools` dedup) for trace tool-start visibility.

### D5: Cancel fires best-effort server-side abort

On abort in `runOpenCodeConversation`, fire-and-forget `POST /session/{serverSession}/abort` with `"{}"` body, try/catch-ignored, before the stream is torn down. `serverSession` is already in scope. This stops a cancelled turn from continuing to edit files headless on the shared server — the direct cause of the "killed mid-run cleanup leaves the target file dirty" gotcha.

*Alternative considered:* awaiting the abort response. Rejected: oracle is best-effort (`OpencodeConversation.scala:63-68`); blocking cancel on a possibly-wedged server inverts the priority.

### D6: Inactivity timer counts only relevant events (follow-up wiring)

With Bug A fixed, foreign traffic must no longer reset the inactivity watchdog. `applyOpenCodeSseLine` returns whether the line was relevant to this session; `runOpenCodeConversation` resets the timer only on relevant lines. This is the minimal change that keeps the existing watchdog design while making it meaningful. (Absolute per-turn wall-clock cap stays as the documented fallback if a trace later shows own-session traffic during a wedged turn — plan Part 2 step 5.)

### D7: Tests are scripted-SSE fixtures, one per failure mode

Extend `tests/opencode-backend.test.ts` with eight scenarios (foreign idle ignored; missing-session terminal settles; user echo doesn't clobber; `info.error` fails at idle; idle-without-assistant fails; wrapped error envelope extracted; tool error frame surfaces; abort POST observed on fake HTTP). Each test name encodes the *why* per the verification gate in the plan.

## Risks / Trade-offs

- [Session ID field name drift across opencode versions (`sessionID` vs `sessionId`)] → Extract via the exact field names the oracle reads; the live smoke test (`ORCA_REAL_BACKEND=opencode bun run test:integration:real`) catches drift against the installed opencode.
- [Stricter idle handling could fail turns that previously "succeeded" with usable text but a stale `info.error`] → Oracle has shipped these exact semantics; error-bearing assistant messages are genuine failures. Rule 2 only fires on *empty* output, so partial-text turns still succeed.
- [Bug A filtering could hide a real signal if opencode routes our result through a child session] → Oracle behaves identically and works in production Scala orca; terminal missing-ID frames still settle, so a protocol surprise fails loudly rather than hanging.
- [Fire-and-forget abort may not land if the server is wedged] → Acceptable; it's strictly better than never sending it, and the subprocess teardown path is unchanged.

## Migration Plan

Pure driver-internal change; no API or config migration. Land all fixes in one change, gated by `bun run typecheck && bun run lint && bun test tests/opencode-backend.test.ts`, then the live smoke. Rollback = revert the commit; no data or state involved.

## Open Questions

- Does the real `Failed with exit code 1` error use the `{message}` or `{name, data:{message}}` envelope? D3 handles both; the post-fix dogfood re-run (plan Part 2 step 1) will show which, and whether the root cause is env, model, or upstream.
- Whether to also emit `assistant_turn_end` only on assistant frames vs once at idle (oracle emits TurnEnd once, at idle). Default: follow the oracle.
