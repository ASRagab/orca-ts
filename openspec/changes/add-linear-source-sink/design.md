## Context

Orca currently has two integration surfaces that matter here:

- `Source<E>` starts and stops trigger delivery for served loops.
- `Sink<A>` emits final loop output.
- `FlowContext` provides runtime tools used inside flows and loop steps.

Linear has two relevant integration models. Data webhooks can notify Orca about
issue changes for a team or all public teams. Linear Agent Session webhooks are
a newer, native agent model where a delegated or mentioned agent receives a
session event, sends Agent Activities, and can attach PR URLs to the session.
Linear's Agent APIs are currently Developer Preview, so the stable issue-event
path and the agent-session path should be separate public factories.

Primary docs used while shaping this design:

- https://linear.app/developers/graphql
- https://linear.app/developers/webhooks
- https://linear.app/developers/agents
- https://linear.app/developers/agent-interaction
- https://linear.app/developers/agent-best-practices
- https://linear.app/developers/agent-signals

## Goals / Non-Goals

**Goals:**

- Let `orca serve` wait on Linear issue or agent-session webhooks.
- Let loops and flows read/update Linear through a typed runtime tool.
- Let a loop acknowledge work early, triage the Linear ticket, create a PR when
  needed, update Linear with the result, and optionally notify Slack.
- Keep the loop engine unchanged: Linear adapters are ordinary `Source` and
  `Sink` implementations.
- Keep default verification deterministic through injected transports and
  webhook fixtures.

**Non-Goals:**

- No hosted OAuth install flow in this change.
- No automatic Linear webhook registration or public tunnel management.
- No new generic multi-sink abstraction; examples can compose Linear and Slack
  sinks with a small custom sink.
- No broad ticket-router product. Filters stay explicit in the source config.
- No live Linear calls in the default verification gate.

## Decisions

### D1: Use a narrow `LinearTool` over direct GraphQL first

Add `src/tools/linear.ts` with a typed `LinearTool` and injectable transport.
The default transport uses `fetch` against `https://api.linear.app/graphql` and
authenticates with either an API key or OAuth access token. Tool methods cover
only the operations Orca needs: fetch issue/session context, update an issue,
create issue comments, create Agent Activities, update Agent Session plan or
external URLs, and query team workflow states when examples need them.

Alternative considered: depend on `@linear/sdk`. The SDK is useful and Linear
recommends it, but it would add a broad generated surface to a package that is
currently small and shipped as a standalone binary. Direct GraphQL keeps the
runtime dependency surface narrow and all tests injectable. The SDK can still be
adopted later behind the same `LinearTool` interface if it proves valuable.

### D2: Split stable issue events from Agent Session events

Provide two source factories:

- `linearIssueSource()` for data-change webhooks where `type` is `Issue` or
  `Comment`, with filters for team, project, workflow state, labels, actions,
  and actor/app self-events.
- `linearAgentSource()` for Agent Session webhooks where events are scoped to a
  Linear app user and carry `agentSessionId`, prompt context, issue context,
  activities, and prompt signals.

This avoids hiding Agent API preview behavior behind a generic issue source.
Both factories return plain `Source<Linear...Event>` values and are discoverable
without opening sockets until `start()` is called.

### D3: Use a Linear-specific webhook listener

Do not implement Linear on top of the generic `webhook()` source. Linear needs
the raw body, request headers, HMAC verification, replay-window checks, and
different HTTP status behavior for invalid signatures. The Linear source should
accept an injectable listener factory for tests, but the default listener should
verify before calling the loop handler and respond quickly so Linear does not
retry a valid delivery.

### D4: Put progress updates in `LinearTool`, final notifications in sinks

Long-running agent work cannot wait until final `Sink.emit()` to communicate.
Linear's Agent guidance expects early feedback, and implementation loops may
need to send action updates or elicitation prompts before convergence. The loop
body should call `linear().createAgentActivity(...)` or update the session plan
as work progresses. The final sink handles terminal updates such as response,
error, issue comment, status, and PR URL attachment.

### D5: Preserve idempotency fields instead of hiding retries

Linear retries webhook deliveries, and GitHub PR creation is not idempotent by
default. Normalized Linear events SHALL include a stable `dedupeKey` derived
from webhook delivery/session identifiers and the source payload. The source may
drop duplicates observed during one supervisor lifetime, but durable exactly-once
behavior belongs in authored loop state or the existing state store.

### D6: Treat Slack as an existing output, not a Linear feature

The end-to-end example should return one output object with Linear and Slack
payloads. A local composite sink can call `linearAgentSink()` or
`linearIssueSink()` and then `slack()`. This keeps the Linear feature focused and
does not introduce a generic sink combinator before there is a broader need.

## Risks / Trade-offs

- Agent APIs are Developer Preview -> keep `linearAgentSource()` and
  `linearAgentSink()` isolated from the stable issue source and document the
  preview status.
- Webhook retries can duplicate PRs -> expose `dedupeKey`, suppress duplicates
  within a running supervisor, and show durable idempotency in the example.
- Agent Session stop signals imply cancellation -> v1 exposes stop prompt
  events and documents that full session-keyed child cancellation is a follow-up
  serve-supervisor change.
- Token handling can leak secrets -> never log tokens, accept token values from
  options or environment, and test error messages for redaction.
- Linear webhook verification needs raw body -> use a Linear-specific listener
  and fixture tests that fail if parsed JSON is reserialized for verification.
- Direct GraphQL types can drift -> keep method shapes narrow and cover fixtures
  for GraphQL errors and null optional fields.

## Migration Plan

1. Add `LinearTool` and `linear()` accessor with no behavior change for existing
   flows.
2. Add Linear sources/sinks as new exports; no existing source or sink semantics
   change.
3. Add docs and examples showing issue-webhook and agent-session usage.
4. Keep existing flows and loops valid; no breaking migration is required.

Rollback is removing the new exports and docs before release, because no
existing runtime behavior changes are required.

## Open Questions

- Should the first implementation expose Agent Session APIs as public stable
  names or mark them preview in docs and comments?
- Should a later change add session-keyed child cancellation to `serve()` for
  Linear stop signals?
- Should webhook registration remain manual forever, or should Orca eventually
  manage Linear webhook creation for OAuth app installs?
