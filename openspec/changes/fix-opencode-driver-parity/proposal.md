# Fix OpenCode Driver Parity

## Why

The opencode dogfood run on the ai-slop-cleanup workflow failed with "opaque" agent errors that were assumed to be an opencode/model problem. A line-by-line comparison of the TS driver against the Scala oracle (`/Users/ahmad.ragab/Dev/tools/orca/opencode/src/main/scala/orca/tools/opencode/`) shows the opacity is substantially self-inflicted: the TS driver drops all three channels through which opencode reports errors (assistant `info.error`, tool `status:"error"` frames, and the `{name, data:{message}}` error envelope) and consumes the global `/event` firehose without session filtering. Fixing these parity gaps should make agent failures surface as readable errors instead of silent garbage output, and is a prerequisite for any further opencode viability diagnosis.

## What Changes

- **Bug A (critical)**: Filter the `/event` SSE firehose by session ID. Foreign sessions' `session.idle`/`session.error`/`message.updated` currently settle or pollute this turn's state. Terminal frames with a *missing* session ID still settle the turn (oracle `forall` semantics) so protocol deviations don't hang.
- **Bug B (critical)**: Process `message.updated` only for `role:"assistant"`. User-echo updates currently clobber `state.structured`/`state.usage` after the assistant's update, producing empty output at idle.
- **Bug C (critical)**: Read `info.error` from the assistant message and fail the turn at `session.idle` instead of unconditionally succeeding. Also fail when idle arrives with no assistant message and no text. This is the most likely mechanism behind the `Failed with exit code 1` opacity.
- **Bug D**: Extract error messages from both envelope shapes — `{message}` and `{name, data:{message}}` — with raw-JSON fallback, for both `session.error` and the new `info.error` path.
- **Bug E**: Emit `tool_result` with `isError: true` for tool parts with `status:"error"` (currently only `completed` is mapped). Optionally emit `tool_call` on first `status:"running"` per part ID.
- **Bug F**: On cancel, best-effort `POST /session/{id}/abort` so a cancelled turn stops editing on the shared server.
- **Minor parity nits (opportunistic)**: include `cache.write` in the usage input axis (G); map `field:"reasoning"` part deltas to thinking deltas (H).
- **Tests**: 8 scripted-SSE test scenarios in `tests/opencode-backend.test.ts`, each encoding the failure mode it guards against.

No new capabilities; all changes are faithful porting of existing oracle behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `conversation-backends`: The OpenCode HTTP/SSE backend requirement gains spec-level behavior: session-scoped event filtering, error surfacing from assistant `info.error` and tool error frames, error-envelope message extraction, idle-without-assistant failure, and server-side turn abort on cancel.

## Impact

- `src/backends/opencode-sse.ts` — event shape extensions (session IDs, `info.error`, `role`), filtering, error extraction, idle success/fail logic, tool error frames.
- `src/backends/opencode-run.ts` — thread `serverSession` into the SSE consumer; abort POST on cancel; (follow-up, Part 2 step 5) inactivity timer counts only own-session events.
- `tests/opencode-backend.test.ts` — 8 new scripted-SSE scenarios plus fake-HTTP abort assertion.
- No public API changes; no other backends affected.
- Unblocks the re-diagnosis sequence in `.orca/opencode-troubleshooting-plan.md` Part 2 (single-file dogfood re-run, env/model A/B, timeout hardening decision).
