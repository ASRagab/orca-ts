import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import {
  linearAgentSource,
  linearIssueSource,
  linearWebhookSignature,
  type LinearAgentTriggerEvent,
  type LinearIssueTriggerEvent,
  type LinearWebhookDelivery,
  type LinearWebhookListenerFactory,
  type LinearWebhookRequest,
  type LinearWebhookRequestHandler,
  type Source,
} from "../src/index.ts";

const SECRET = "linear_webhook_secret";
const NOW = 1_700_000_000_000;
const TIMESTAMP = String(NOW);

interface CapturedListener {
  readonly factory: LinearWebhookListenerFactory;
  deliver(request: LinearWebhookRequest): Promise<LinearWebhookDelivery>;
  readonly closed: () => boolean;
}

function capturedListener(): CapturedListener {
  let handler: LinearWebhookRequestHandler | undefined;
  let closed = false;
  return {
    factory(onRequest) {
      handler = onRequest;
      return Promise.resolve(ok({ close: () => { closed = true; return Promise.resolve(); } }));
    },
    deliver(request) {
      if (handler === undefined) throw new Error("listener was not started");
      return handler(request);
    },
    closed: () => closed,
  };
}

function signedRequest(
  payload: unknown,
  overrides: {
    readonly rawBody?: string;
    readonly signature?: string;
    readonly timestamp?: string;
    readonly delivery?: string;
  } = {},
): LinearWebhookRequest {
  const rawBody = overrides.rawBody ?? JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? TIMESTAMP;
  const signature = overrides.signature ?? linearWebhookSignature(SECRET, rawBody, timestamp);
  return {
    method: "POST",
    url: "/linear",
    rawBody,
    payload,
    headers: {
      "Linear-Signature": signature,
      "Linear-Timestamp": timestamp,
      "Linear-Delivery": overrides.delivery ?? "delivery-1",
    },
  };
}

describe("Linear webhook sources", () => {
  test("valid signed issue webhook delivers one normalized event", async () => {
    const listener = capturedListener();
    const source = linearIssueSource({
      webhookSecret: SECRET,
      listenerFactory: listener.factory,
      now: () => NOW,
      teamId: "team-1",
      projectId: "project-1",
    });
    const events: LinearIssueTriggerEvent[] = [];

    const started = await source.start((event) => events.push(event));
    const delivery = await listener.deliver(
      signedRequest({
        type: "Issue",
        action: "update",
        actor: { id: "user-1", name: "Ada" },
        data: {
          id: "issue-1",
          identifier: "ENG-1",
          url: "https://linear.app/acme/issue/ENG-1",
          team: { id: "team-1", key: "ENG" },
          project: { id: "project-1", name: "Roadmap" },
          state: { id: "state-1", name: "Todo" },
          labels: { nodes: [{ id: "label-1" }] },
        },
      }),
    );

    expect(delivery).toEqual({ accepted: true, status: 200 });
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error("expected one event");
    expect(event).toMatchObject({
      kind: "linear.issue",
      webhookType: "Issue",
      action: "update",
      issueId: "issue-1",
      issueIdentifier: "ENG-1",
      issueUrl: "https://linear.app/acme/issue/ENG-1",
      teamId: "team-1",
      projectId: "project-1",
      workflowStateId: "state-1",
      actor: { id: "user-1", name: "Ada" },
      dedupeKey: "delivery-1",
    });
    expect(event.labelIds).toEqual(["label-1"]);

    await started._unsafeUnwrap().stop();
    expect(listener.closed()).toBe(true);
  });

  test("invalid signatures, missing signatures, stale timestamps, and reserialized bodies do not deliver", async () => {
    const listener = capturedListener();
    const source = linearIssueSource({
      webhookSecret: SECRET,
      listenerFactory: listener.factory,
      now: () => NOW,
    });
    const events: LinearIssueTriggerEvent[] = [];
    await source.start((event) => events.push(event));
    const payload = { type: "Issue", action: "update", data: { id: "issue-1" } };
    const rawBody = JSON.stringify(payload);

    const invalid = await listener.deliver(signedRequest(payload, { signature: "0".repeat(64) }));
    const missing = await listener.deliver({
      ...signedRequest(payload),
      headers: { "Linear-Timestamp": TIMESTAMP },
    });
    const stale = await listener.deliver(signedRequest(payload, { timestamp: String(NOW - 600_000) }));
    const reserialized = await listener.deliver({
      ...signedRequest(payload, { rawBody }),
      rawBody: JSON.stringify(payload, null, 2),
    });

    expect(invalid.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(reserialized.status).toBe(401);
    expect(events).toEqual([]);
  });

  test("issue source filters non-matching events, excludes self actors, and suppresses duplicates", async () => {
    const listener = capturedListener();
    const source: Source<LinearIssueTriggerEvent> = linearIssueSource({
      webhookSecret: SECRET,
      listenerFactory: listener.factory,
      now: () => NOW,
      teamId: "team-1",
      labelIds: ["label-1"],
      actions: ["update"],
      selfActorId: "app-1",
      excludeSelfActor: true,
    });
    const events: LinearIssueTriggerEvent[] = [];
    await source.start((event) => events.push(event));

    await listener.deliver(
      signedRequest({
        type: "Issue",
        action: "update",
        actor: { id: "app-1" },
        data: { id: "issue-1", team: { id: "team-1" }, labels: { nodes: [{ id: "label-1" }] } },
      }),
    );
    await listener.deliver(
      signedRequest({
        type: "Issue",
        action: "update",
        actor: { id: "user-1" },
        data: { id: "issue-2", team: { id: "team-2" }, labels: { nodes: [{ id: "label-1" }] } },
      }),
    );

    const matching = {
      type: "Issue",
      action: "update",
      actor: { id: "user-1" },
      data: { id: "issue-3", team: { id: "team-1" }, labels: { nodes: [{ id: "label-1" }] } },
    };
    await listener.deliver(signedRequest(matching, { timestamp: TIMESTAMP }));
    await listener.deliver(signedRequest(matching, { timestamp: TIMESTAMP }));

    expect(events.map((event) => event.issueId)).toEqual(["issue-3"]);
  });

  test("agent source normalizes created, prompted, and stop events", async () => {
    const listener = capturedListener();
    const source = linearAgentSource({
      webhookSecret: SECRET,
      listenerFactory: listener.factory,
      now: () => NOW,
    });
    const events: LinearAgentTriggerEvent[] = [];
    await source.start((event) => events.push(event));

    await listener.deliver(
      signedRequest({
        action: "created",
        data: {
          agentSession: {
            id: "session-1",
            issue: { id: "issue-1", identifier: "ENG-1", title: "Fix it" },
          },
          prompt: { id: "prompt-1", body: "Please triage this" },
        },
      }),
    );
    await listener.deliver(
      signedRequest(
        {
          action: "prompted",
          data: {
            agentSessionId: "session-2",
            prompt: { id: "prompt-2", body: "stop this run" },
          },
        },
        { timestamp: String(NOW + 1_000), delivery: "delivery-2" },
      ),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "linear.agent",
      eventType: "session_created",
      agentSessionId: "session-1",
      prompt: { id: "prompt-1", body: "Please triage this" },
      issue: { id: "issue-1", identifier: "ENG-1" },
      isStopSignal: false,
    });
    expect(events[1]).toMatchObject({
      kind: "linear.agent",
      eventType: "stop",
      agentSessionId: "session-2",
      isStopSignal: true,
    });
  });
});
