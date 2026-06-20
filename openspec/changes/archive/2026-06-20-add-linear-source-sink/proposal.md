## Why

Orca loops can already run as long-lived supervisors, but they cannot natively
listen to work from Linear or write progress back to Linear. Linear is a natural
front door for autonomous coding work because tickets, delegated agent sessions,
PR links, and human follow-up all live in the same product workflow.

## What Changes

- Add Linear API support for authenticated GraphQL calls needed by Orca flows
  and loops.
- Add Linear issue and agent-session event sources for `defineLoop()` modules.
- Add Linear sinks that update issues, emit agent activities, and attach PR
  URLs or final summaries to the originating Linear context.
- Expose a Linear flow runtime accessor so legacy self-executing flows can
  query and update Linear without pretending Linear is a flow `Source`.
- Add docs and examples for a loop that receives a Linear ticket, triages it,
  creates a PR when code changes are required, updates Linear, and optionally
  emits a Slack notification through the existing Slack sink.
- Keep default verification deterministic by testing against injected Linear
  clients and webhook fixtures, not live Linear credentials.

## Capabilities

### New Capabilities

- `linear-integration`: Linear API client behavior, webhook verification,
  Linear event models, issue updates, agent activities, and PR/session updates.

### Modified Capabilities

- `loop-io`: Add bundled Linear `Source` and `Sink` adapters while preserving
  the existing pluggable seam contract.
- `flow-runtime`: Add a Linear tool/accessor for legacy flows and loop bodies.

## Impact

- Affected code: `src/tools/`, `src/flow/`, `src/loop/io/`, root exports,
  tests, docs, and examples.
- Affected APIs: public `linear()` flow accessor, `LinearTool`, Linear source
  factories, and Linear sink factories.
- Dependencies: may add `@linear/sdk`, or use direct GraphQL over `fetch` if
  the implementation chooses to avoid another runtime dependency.
- External systems: Linear GraphQL API, Linear webhooks, Linear Agent Session
  APIs, GitHub PR creation through existing `gh` support, and Slack through the
  existing Slack sink.
