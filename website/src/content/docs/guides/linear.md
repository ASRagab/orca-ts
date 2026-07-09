---
title: Linear Integration
description: Use Linear as a trigger source and output sink for served loops — env vars, webhook verification, sources, sinks, and Slack composition.
---

Orca can use Linear as both a trigger and an output target for served loops. Use the Linear adapters when a ticket or Agent Session should start work and Linear should receive progress, final summaries, errors, or PR links. The `linear-issue` and `linear-agent` source/sink kinds are listed on the [Loop API](../../reference/loop-api/) reference.

## Environment

The default `linear()` runtime tool reads these variables:

| Variable | Purpose |
| --- | --- |
| `LINEAR_ACCESS_TOKEN` | OAuth bearer token. Preferred when present. |
| `LINEAR_API_KEY` | Personal Linear API key fallback. |
| `LINEAR_WEBHOOK_SECRET` | Shared secret for webhook signature verification. |
| `LINEAR_DONE_STATE_ID` | Optional workflow state id for examples that move an issue to done. |
| `SLACK_WEBHOOK_URL` | Optional Slack webhook when composing Linear and Slack sinks. |

Default verification does not require these variables. Tests and checked examples use injected transports and fake tools.

## Manual Webhook Setup

Webhook registration is manual in this release.

1. Create a Linear webhook for the Orca endpoint you will serve.
2. Store the Linear webhook secret as `LINEAR_WEBHOOK_SECRET`.
3. Configure the loop source with the same path and port you expose to Linear.
4. Run the loop with `orcats serve`.

Linear requests are verified before delivery. Verification uses the exact raw body, `Linear-Signature`, `Linear-Timestamp`, a timing-safe comparison, and the configured replay window. Do not parse and reserialize the JSON body before verification; that changes the signed bytes and must be rejected.

## Issue Source

Use `linearIssueSource()` for stable issue and comment webhooks.

```ts
import { defineLoop, linearIssueSink, linearIssueSource, ok } from "@twelvehart/orcats";

export default defineLoop({
  name: "linear-issue-triage",
  source: linearIssueSource({
    webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? "",
    port: 3210,
    path: "/linear",
    teamId: "team-id",
    actions: ["create", "update"],
    excludeSelfActor: true,
    selfActorId: "linear-app-user-id",
  }),
  sink: linearIssueSink(),
  onTrigger: async (event) =>
    ok({
      outcome: { state: event, stopReason: "converged", iterations: 0 },
      output: {
        issueId: event.issueId,
        finalSummary: `Handled ${event.issueIdentifier ?? event.issueId}`,
      },
    }),
});
```

Issue events include `issueId`, optional identifier and URL, team/project/state ids, label ids, actor metadata, the raw payload, and a stable `dedupeKey`. Filters can match team, project, workflow state, labels, actions, and self actors. The source suppresses duplicate `dedupeKey` values during one supervisor lifetime.

## Agent Session Source

Use `linearAgentSource()` for Linear Agent Sessions. Linear's Agent APIs are Developer Preview, so keep this path isolated from stable issue webhook flows and expect Linear's API details to evolve.

Agent events normalize created sessions, prompted sessions, activity content, related issue context, stop signals, raw payload, and `dedupeKey`.

```ts
import { linear, linearAgentSink, linearAgentSource } from "@twelvehart/orcats";

const source = linearAgentSource({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? "",
  port: 3210,
  path: "/linear-agent",
});

const sink = linearAgentSink();

await linear().createAgentActivity({
  agentSessionId: "session-id",
  type: "action",
  body: "Orca started work.",
});
```

Use `linear()` for intermediate Agent Activities or plan updates inside the loop body. Use `linearAgentSink()` for terminal responses, final errors, plan state, and external URLs such as PR links. The `LinearTool` interface these call is documented on the [Tools](../../reference/tools/) reference page.

## Sinks And Slack Composition

`linearIssueSink()` can create issue comments, update supported issue fields, and include a final summary or PR URL. `linearAgentSink()` can create terminal Agent Activities and update Agent Session URLs or plan text.

Slack remains a separate sink. Compose it locally when a workflow needs both Linear and Slack:

```ts
import { err, linearIssueSink, ok, slack, type Sink } from "@twelvehart/orcats";

const sink: Sink<{ linear: { issueId: string; finalSummary: string }; slack?: string }> = {
  kind: "linear-issue",
  async emit(output) {
    const linearResult = await linearIssueSink().emit(output.linear);
    if (linearResult.isErr()) return err(linearResult.error);
    if (output.slack === undefined) return ok(undefined);
    return slack<string>({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? "" }).emit(output.slack);
  },
};
```

See the [Examples](../../reference/examples/) page for `examples/linear-ticket-triage.ts` — a checked example that uses a Linear ticket source, sends an early progress comment, runs a deterministic triage loop, emits a final Linear update, and composes an optional Slack notification without live credentials.

## Reliability Notes

- Agent Session support is preview because Linear marks Agent APIs as Developer Preview.
- Webhook verification depends on the raw body. Middleware that only exposes a parsed object is not enough.
- The replay window defaults to five minutes. Use `replayToleranceMs` only when your clock and delivery path require a different bound.
- `dedupeKey` is exposed for authored idempotency. The source only suppresses duplicates in memory for one running supervisor; durable exactly-once behavior belongs in loop state or a state store.
- Token values are redacted from Linear transport failures. Avoid logging raw transport requests in custom transports.
