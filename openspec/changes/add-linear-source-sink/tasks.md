## 1. Linear Tool And Runtime Accessor

- [x] 1.1 Add `src/tools/linear.ts` with `LinearTool`, request/response types, an injectable GraphQL transport, and default `fetch` transport.
- [x] 1.2 Implement personal API key and OAuth bearer-token authentication headers with tests that verify token values are redacted from failures.
- [x] 1.3 Add Linear tool methods for issue fetch/update, comment creation, Agent Activity creation, Agent Session update, and team workflow-state lookup.
- [x] 1.4 Add deterministic Linear GraphQL tests for success, GraphQL `errors`, non-2xx HTTP responses, and nullable Linear fields.
- [x] 1.5 Add `linear` to `FlowContext`, `FlowOverrides`, default context construction, public accessors, root exports, and test fakes.
- [x] 1.6 Add flow-runtime tests proving `linear()` resolves the default tool and honors an override.

## 2. Linear Webhook Sources

- [x] 2.1 Add Linear webhook request types that preserve raw body, headers, URL, method, and parsed payload for tests and default listeners.
- [x] 2.2 Implement Linear HMAC verification using raw body, `Linear-Signature`, timing-safe comparison, and timestamp freshness checks.
- [x] 2.3 Add fixture tests proving valid webhooks deliver events and invalid signatures, missing signatures, stale timestamps, and reserialized bodies do not.
- [x] 2.4 Implement the Linear source listener factory with injectable listener support and no import-time socket side effects.
- [x] 2.5 Implement `linearIssueSource()` normalization for issue/comment payloads, filters, actor self-exclusion, dedupe keys, and in-process duplicate suppression.
- [x] 2.6 Implement `linearAgentSource()` normalization for created sessions, prompted sessions, prompt context, activity content, stop signals, dedupe keys, and in-process duplicate suppression.
- [x] 2.7 Add loop-io tests proving Linear issue and Agent Session sources are ordinary `Source` values and fire served loop handlers with normalized events.

## 3. Linear Sinks

- [x] 3.1 Implement `linearIssueSink()` using `LinearTool` to create comments, update issue fields, and record final summaries or PR URLs.
- [x] 3.2 Implement `linearAgentSink()` using `LinearTool` to create terminal Agent Activities and update Agent Session external URLs or plan state.
- [x] 3.3 Add sink tests for successful issue updates, successful agent responses, PR URL attachment, final errors, and typed `err(RuntimeError)` failures.
- [x] 3.4 Add tests proving Linear sinks do not throw on transport failures and do not leak authentication tokens in failure output.

## 4. Public Surface, Docs, And Examples

- [x] 4.1 Export Linear tool types, sources, sinks, and event/output types from the appropriate public root and loop surfaces.
- [x] 4.2 Update `docs/loops.md` or add a focused Linear doc covering manual webhook setup, required env vars, issue-source usage, agent-session preview status, and Slack composition.
- [x] 4.3 Add a checked example loop that receives a Linear ticket, sends an early Linear progress update, performs triage, emits a final Linear update, and composes an optional Slack notification without live credentials.
- [x] 4.4 Add documentation warnings for Linear Agent API preview status, webhook signature verification, replay windows, and idempotency/dedupe expectations.
- [x] 4.5 Update README pointers only if needed to keep README concise and route detailed Linear behavior to docs.

## 5. Verification

- [x] 5.1 Run targeted Linear tool, webhook source, sink, and flow accessor tests.
- [x] 5.2 Run `bun run typecheck` and fix any public type-surface regressions.
- [x] 5.3 Run `bun run build:types` and `bun run check:facade-gate` to ensure the public surface remains Effect-free.
- [x] 5.4 Run `bun run docs:check` after documentation updates.
- [x] 5.5 Run `bun run verify` before marking the change complete.
