## 1. SSE wire shapes and error extraction

- [x] 1.1 Extend `OpenCodeSseEvent` shapes in `src/backends/opencode-sse.ts`: `properties.sessionID`, `part.sessionID`, `info.sessionID`, `info.role`, `info.error`
- [x] 1.2 Add shared `extractOpenCodeErrorMessage(error: unknown): string` — try `.message`, then `.data.message`, else `JSON.stringify(error)` (Bug D)
- [x] 1.3 Use the extractor in the existing `session.error` path

## 2. Session filtering (Bug A)

- [x] 2.1 Change `createOpenCodeSseConsumer(conversation, session: string)` to take the resolved session ID; thread `serverSession` from `runOpenCodeConversation` (consumer construction already follows session resolution)
- [x] 2.2 Extract per-event session ID per oracle rules: part events `properties.sessionID ?? part.sessionID`; `message.updated` `properties.sessionID ?? info.sessionID`; `session.idle`/`session.error` `properties.sessionID`
- [x] 2.3 Apply filter: non-terminal events with foreign session ID → ignore; terminal events ignore only when session ID present AND foreign (missing-ID terminal settles)

## 3. Assistant state and idle settle (Bugs B, C)

- [x] 3.1 In `message.updated` handling, early-return unless `info.role === "assistant"`; emit `assistant_turn_end` only for assistant frames (Bug B)
- [x] 3.2 Capture `info.error` into consumer state from assistant frames (Bug C)
- [x] 3.3 Rework `session.idle`: `state.error` → fail with extracted message; no assistant info AND empty output → fail "session went idle without an assistant message"; else succeed (Bug C)

## 4. Tool frames and minor parity (Bugs E, G, H)

- [x] 4.1 Emit `tool_result` with `isError: true` and `part.state.output` for tool parts with `status === "error"` (Bug E)
- [x] 4.2 Emit `tool_call` on first `status === "running"` per `part.id` (oracle `startedTools` dedup)
- [x] 4.3 Include `cache.write` in `normalizeUsage` input axis (nit G)
- [x] 4.4 Map `field: "reasoning"` part deltas to thinking deltas (nit H)

## 5. Cancel abort and inactivity relevance (Bugs F, follow-up D6)

- [x] 5.1 In `runOpenCodeConversation`, on abort fire-and-forget `POST /session/{serverSession}/abort` with `"{}"`, try/catch-ignored (Bug F)
- [x] 5.2 Have `applyOpenCodeSseLine` report whether the line was relevant to this session; reset the inactivity timer only on relevant lines (design D6)

## 6. Tests (`tests/opencode-backend.test.ts`, scripted SSE fixtures)

- [x] 6.1 Foreign-session `session.idle` does not settle the turn; own-session idle does (Bug A)
- [x] 6.2 Terminal frame with no `sessionID` settles the turn (oracle forall semantics)
- [x] 6.3 User-echo `message.updated` after the assistant's does not clobber structured/usage (Bug B)
- [x] 6.4 `session.idle` after assistant `message.updated` with `info.error` → turn fails with extracted message (Bug C)
- [x] 6.5 Idle with no assistant message and no text → fails "went idle without an assistant message" (Bug C)
- [x] 6.6 `session.error` with `{name, data:{message:"boom"}}` → failure message is "boom" (Bug D)
- [x] 6.7 Tool part `status:"error"` → `tool_result` with `isError: true` and output (Bug E)
- [x] 6.8 Abort mid-turn → `POST /session/{id}/abort` observed on fake HTTP (Bug F)

## 7. Verification

- [x] 7.1 `bun run typecheck && bun run lint && bun test tests/opencode-backend.test.ts`
- [x] 7.2 Live smoke: `ORCA_REAL_BACKEND=opencode bun run test:integration:real`
- [ ] 7.3 Re-run single-file dogfood (`bun ./bin/orca --backend opencode workflows/ai-slop-cleanup.ts --no-publish --start-group=flow/tools/runner --max-files=1`) and confirm previously opaque errors now surface readable messages (plan Part 2 step 1)
