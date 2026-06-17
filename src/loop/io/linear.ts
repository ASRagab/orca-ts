import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { err, ok, type Result } from "neverthrow";

import { ioFailed, type RuntimeError } from "../../model/index.ts";
import { createLinearTool, type LinearExternalUrl, type LinearIssueUpdateInput, type LinearTool } from "../../tools/index.ts";
import type { Sink } from "./sink.ts";
import type { Source, SourceSubscription } from "./source.ts";

const DEFAULT_REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

export interface LinearWebhookHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface LinearWebhookRequest {
  readonly method: string;
  readonly url: string;
  readonly rawBody: string;
  readonly headers: LinearWebhookHeaders;
  readonly payload: unknown;
}

export interface LinearWebhookDelivery {
  readonly accepted: boolean;
  readonly status: number;
  readonly error?: RuntimeError;
}

export type LinearWebhookRequestHandler = (
  request: LinearWebhookRequest,
) => Promise<LinearWebhookDelivery>;

export interface LinearWebhookListener {
  close(): Promise<void>;
}

export type LinearWebhookListenerFactory = (
  onRequest: LinearWebhookRequestHandler,
) => Promise<Result<LinearWebhookListener, RuntimeError>>;

export interface LinearWebhookListenerOptions {
  readonly port: number;
  readonly path?: string;
}

export interface LinearWebhookVerificationOptions {
  readonly request: LinearWebhookRequest;
  readonly secret: string;
  readonly now?: () => number;
  readonly replayToleranceMs?: number;
}

export function linearWebhookSignature(secret: string, rawBody: string, timestamp: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyLinearWebhookRequest(
  options: LinearWebhookVerificationOptions,
): Result<void, RuntimeError> {
  const signature = singleHeader(options.request.headers, "linear-signature");
  if (signature === undefined || signature.length === 0) {
    return err(linearSourceFailed("missing Linear-Signature header"));
  }

  const timestamp = singleHeader(options.request.headers, "linear-timestamp");
  if (timestamp === undefined || timestamp.length === 0) {
    return err(linearSourceFailed("missing Linear-Timestamp header"));
  }

  const timestampMs = parseTimestampMs(timestamp);
  if (timestampMs === undefined) {
    return err(linearSourceFailed("invalid Linear-Timestamp header"));
  }

  const tolerance = options.replayToleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
  const now = options.now?.() ?? Date.now();
  if (Math.abs(now - timestampMs) > tolerance) {
    return err(linearSourceFailed("stale Linear webhook timestamp"));
  }

  const actual = normalizeSignature(signature);
  const expected = linearWebhookSignature(options.secret, options.request.rawBody, timestamp);
  if (!safeEqualHex(actual, expected)) {
    return err(linearSourceFailed("invalid Linear webhook signature"));
  }

  return ok(undefined);
}

export function createLinearWebhookListenerFactory(
  options: LinearWebhookListenerOptions,
): LinearWebhookListenerFactory {
  return (onRequest) =>
    new Promise((resolve) => {
      const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        handleIncomingRequest(req, res, options, onRequest);
      });
      server.on("error", (error) => {
        resolve(err(linearSourceFailed(String(error))));
      });
      server.listen(options.port, () => {
        resolve(
          ok({
            close: () =>
              new Promise<void>((done) => {
                server.close(() => {
                  done();
                });
              }),
          }),
        );
      });
    });
}

export interface LinearActor {
  readonly id?: string;
  readonly name?: string;
  readonly email?: string;
  readonly type?: string;
  readonly isApp?: boolean;
}

export interface LinearIssueTriggerEvent {
  readonly kind: "linear.issue";
  readonly webhookType: "Issue" | "Comment";
  readonly action: string;
  readonly issueId: string;
  readonly issueIdentifier?: string;
  readonly issueUrl?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly workflowStateId?: string;
  readonly labelIds: readonly string[];
  readonly actor?: LinearActor;
  readonly dedupeKey: string;
  readonly raw: unknown;
}

export interface LinearAgentIssueContext {
  readonly id?: string;
  readonly identifier?: string;
  readonly url?: string;
  readonly title?: string;
}

export interface LinearAgentPromptContext {
  readonly id?: string;
  readonly body?: string;
  readonly actor?: LinearActor;
}

export interface LinearAgentActivityContext {
  readonly id?: string;
  readonly type?: string;
  readonly body?: string;
}

export type LinearAgentEventType = "session_created" | "session_prompted" | "activity" | "stop";

export interface LinearAgentTriggerEvent {
  readonly kind: "linear.agent";
  readonly eventType: LinearAgentEventType;
  readonly action: string;
  readonly agentSessionId: string;
  readonly issue?: LinearAgentIssueContext;
  readonly prompt?: LinearAgentPromptContext;
  readonly activity?: LinearAgentActivityContext;
  readonly isStopSignal: boolean;
  readonly dedupeKey: string;
  readonly raw: unknown;
}

export interface LinearSourceBaseOptions {
  readonly webhookSecret: string;
  readonly port?: number;
  readonly path?: string;
  readonly listenerFactory?: LinearWebhookListenerFactory;
  readonly replayToleranceMs?: number;
  readonly now?: () => number;
  readonly seenDedupeKeys?: Set<string>;
}

export interface LinearIssueSourceOptions extends LinearSourceBaseOptions {
  readonly teamId?: string;
  readonly teamIds?: readonly string[];
  readonly projectId?: string;
  readonly projectIds?: readonly string[];
  readonly workflowStateId?: string;
  readonly workflowStateIds?: readonly string[];
  readonly labelIds?: readonly string[];
  readonly actions?: readonly string[];
  readonly selfActorId?: string;
  readonly excludeActorIds?: readonly string[];
  readonly excludeSelfActor?: boolean;
}

export interface LinearAgentSourceOptions extends LinearSourceBaseOptions {
  readonly appUserId?: string;
  readonly excludeActorIds?: readonly string[];
}

export function linearIssueSource(options: LinearIssueSourceOptions): Source<LinearIssueTriggerEvent> {
  return linearWebhookSource("linear-issue", options, (request) => normalizeIssueEvent(request, options));
}

export function linearAgentSource(options: LinearAgentSourceOptions): Source<LinearAgentTriggerEvent> {
  return linearWebhookSource("linear-agent", options, (request) => normalizeAgentEvent(request, options));
}

export interface LinearIssueSinkOutput {
  readonly issueId: string;
  readonly finalSummary?: string;
  readonly prUrl?: string;
  readonly commentBody?: string;
  readonly update?: Omit<LinearIssueUpdateInput, "issueId">;
}

export interface LinearIssueSinkOptions {
  readonly tool?: LinearTool;
  readonly commentPrefix?: string;
}

export function linearIssueSink(options: LinearIssueSinkOptions = {}): Sink<LinearIssueSinkOutput> {
  return {
    kind: "linear-issue",
    async emit(output) {
      const tool = options.tool ?? createLinearTool();
      try {
        const comment = renderIssueComment(output, options.commentPrefix);
        if (comment !== undefined) {
          const created = await tool.createIssueComment({ issueId: output.issueId, body: comment });
          if (created.isErr()) return err(created.error);
        }
        if (output.update !== undefined) {
          const updated = await tool.updateIssue({ issueId: output.issueId, ...output.update });
          if (updated.isErr()) return err(updated.error);
        }
        return ok(undefined);
      } catch (error) {
        return err(linearSinkFailed(String(error)));
      }
    },
  };
}

export interface LinearAgentSinkOutput {
  readonly agentSessionId: string;
  readonly responseBody?: string;
  readonly errorBody?: string;
  readonly prUrl?: string;
  readonly plan?: string;
  readonly externalUrls?: readonly LinearExternalUrl[];
}

export interface LinearAgentSinkOptions {
  readonly tool?: LinearTool;
}

export function linearAgentSink(options: LinearAgentSinkOptions = {}): Sink<LinearAgentSinkOutput> {
  return {
    kind: "linear-agent",
    async emit(output) {
      const tool = options.tool ?? createLinearTool();
      try {
        const body = output.errorBody ?? output.responseBody;
        if (body !== undefined) {
          const activity = await tool.createAgentActivity({
            agentSessionId: output.agentSessionId,
            body,
            type: output.errorBody === undefined ? "response" : "error",
          });
          if (activity.isErr()) return err(activity.error);
        }

        const externalUrls = externalUrlsForOutput(output);
        if (output.plan !== undefined || externalUrls.length > 0) {
          const updated = await tool.updateAgentSession({
            agentSessionId: output.agentSessionId,
            ...(output.plan === undefined ? {} : { plan: output.plan }),
            ...(externalUrls.length === 0 ? {} : { externalUrls }),
            ...(output.prUrl === undefined ? {} : { externalUrl: output.prUrl }),
          });
          if (updated.isErr()) return err(updated.error);
        }

        return ok(undefined);
      } catch (error) {
        return err(linearSinkFailed(String(error)));
      }
    },
  };
}

function linearWebhookSource<E>(
  kind: "linear-issue" | "linear-agent",
  options: LinearSourceBaseOptions,
  normalize: (request: LinearWebhookRequest) => E | undefined,
): Source<E> {
  const seen = options.seenDedupeKeys ?? new Set<string>();
  const factory = options.listenerFactory ?? defaultLinearListenerFactory(options);
  return {
    kind,
    async start(handler) {
      if (factory === undefined) {
        return err(linearSourceFailed("Linear source requires a port or listenerFactory"));
      }

      const listener = await factory((request) => {
        const verified = verifyLinearWebhookRequest({
          request,
          secret: options.webhookSecret,
          ...(options.replayToleranceMs === undefined ? {} : { replayToleranceMs: options.replayToleranceMs }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        if (verified.isErr()) {
          return Promise.resolve({ accepted: false, status: 401, error: verified.error });
        }

        const event = normalize(request);
        if (event === undefined) {
          return Promise.resolve({ accepted: false, status: 200 });
        }

        const dedupeKey = "dedupeKey" in Object(event) ? (event as { readonly dedupeKey: string }).dedupeKey : "";
        if (seen.has(dedupeKey)) {
          return Promise.resolve({ accepted: false, status: 200 });
        }
        seen.add(dedupeKey);
        handler(event);
        return Promise.resolve({ accepted: true, status: 200 });
      });

      if (listener.isErr()) {
        return err(listener.error);
      }
      const handle = listener.value;
      const subscription: SourceSubscription = {
        async stop() {
          await handle.close();
          return ok(undefined);
        },
      };
      return ok(subscription);
    },
  };
}

function defaultLinearListenerFactory(options: LinearSourceBaseOptions): LinearWebhookListenerFactory | undefined {
  if (options.port === undefined) return undefined;
  return createLinearWebhookListenerFactory({
    port: options.port,
    ...(options.path === undefined ? {} : { path: options.path }),
  });
}

function handleIncomingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LinearWebhookListenerOptions,
  onRequest: LinearWebhookRequestHandler,
): void {
  const url = req.url ?? "/";
  if (options.path !== undefined && url !== options.path) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    void (async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const parsed = parseJson(rawBody);
      if (parsed.isErr()) {
        res.statusCode = 400;
        res.end("invalid json");
        return;
      }
      const delivery = await onRequest({
        method: req.method ?? "GET",
        url,
        rawBody,
        headers: { ...req.headers },
        payload: parsed.value,
      });
      res.statusCode = delivery.status;
      res.end(delivery.error === undefined ? "ok" : JSON.stringify(delivery.error));
    })();
  });
}

function parseJson(rawBody: string): Result<unknown, RuntimeError> {
  try {
    return ok(JSON.parse(rawBody) as unknown);
  } catch (error) {
    return err(linearSourceFailed(String(error)));
  }
}

function normalizeIssueEvent(
  request: LinearWebhookRequest,
  options: LinearIssueSourceOptions,
): LinearIssueTriggerEvent | undefined {
  const payload = asRecord(request.payload);
  const data = recordField(payload, "data") ?? payload;
  const webhookType = stringField(payload, "type") ?? stringField(data, "type");
  if (webhookType !== "Issue" && webhookType !== "Comment") return undefined;

  const issue = webhookType === "Comment" ? recordField(data, "issue") ?? data : data;
  const issueId = stringField(issue, "id") ?? stringField(data, "issueId");
  if (issueId === undefined) return undefined;

  const action = stringField(payload, "action") ?? stringField(data, "action") ?? "unknown";
  const teamId = stringField(recordField(issue, "team"), "id") ?? stringField(issue, "teamId");
  const projectId = stringField(recordField(issue, "project"), "id") ?? stringField(issue, "projectId");
  const workflowStateId = stringField(recordField(issue, "state"), "id") ?? stringField(issue, "stateId");
  const labelIds = labelsFromIssue(issue);
  const actor = normalizeActor(recordField(payload, "actor") ?? recordField(data, "actor"));

  if (!matchesOne(teamId, optionList(options.teamId, options.teamIds))) return undefined;
  if (!matchesOne(projectId, optionList(options.projectId, options.projectIds))) return undefined;
  if (!matchesOne(workflowStateId, optionList(options.workflowStateId, options.workflowStateIds))) return undefined;
  if (!matchesLabels(labelIds, options.labelIds)) return undefined;
  if (options.actions !== undefined && !options.actions.includes(action)) return undefined;
  if (actorExcluded(actor, options.excludeActorIds, options.excludeSelfActor === true ? options.selfActorId : undefined)) {
    return undefined;
  }

  const issueIdentifier = stringField(issue, "identifier");
  const issueUrl = stringField(issue, "url");
  let event: LinearIssueTriggerEvent = {
    kind: "linear.issue",
    webhookType,
    action,
    issueId,
    labelIds,
    dedupeKey: dedupeKey(request, payload, `${webhookType}:${action}:${issueId}`),
    raw: request.payload,
  };
  if (issueIdentifier !== undefined) event = { ...event, issueIdentifier };
  if (issueUrl !== undefined) event = { ...event, issueUrl };
  if (teamId !== undefined) event = { ...event, teamId };
  if (projectId !== undefined) event = { ...event, projectId };
  if (workflowStateId !== undefined) event = { ...event, workflowStateId };
  if (actor !== undefined) event = { ...event, actor };
  return event;
}

function normalizeAgentEvent(
  request: LinearWebhookRequest,
  options: LinearAgentSourceOptions,
): LinearAgentTriggerEvent | undefined {
  const payload = asRecord(request.payload);
  const data = recordField(payload, "data") ?? payload;
  const session = recordField(data, "agentSession") ?? recordField(payload, "agentSession") ?? data;
  const agentSessionId =
    stringField(data, "agentSessionId") ??
    stringField(payload, "agentSessionId") ??
    stringField(session, "id");
  if (agentSessionId === undefined) return undefined;

  const action = stringField(payload, "action") ?? stringField(data, "action") ?? "unknown";
  const actor = normalizeActor(recordField(payload, "actor") ?? recordField(data, "actor"));
  if (actorExcluded(actor, options.excludeActorIds, options.appUserId)) return undefined;

  const activityRecord = recordField(data, "activity") ?? recordField(data, "agentActivity");
  const promptRecord = recordField(data, "prompt") ?? recordField(payload, "prompt");
  const activity = normalizeActivity(activityRecord);
  const prompt = normalizePrompt(promptRecord, actor);
  const isStopSignal = isStop(action, activity, prompt, data);
  const eventType = agentEventType(action, isStopSignal, activity);
  const issue = normalizeIssueContext(recordField(session, "issue") ?? recordField(data, "issue"));

  let event: LinearAgentTriggerEvent = {
    kind: "linear.agent",
    eventType,
    action,
    agentSessionId,
    isStopSignal,
    dedupeKey: dedupeKey(request, payload, `Agent:${action}:${agentSessionId}`),
    raw: request.payload,
  };
  if (issue !== undefined) event = { ...event, issue };
  if (prompt !== undefined) event = { ...event, prompt };
  if (activity !== undefined) event = { ...event, activity };
  return event;
}

function normalizeIssueContext(record: Readonly<Record<string, unknown>> | undefined): LinearAgentIssueContext | undefined {
  if (record === undefined) return undefined;
  let context: LinearAgentIssueContext = {};
  const id = stringField(record, "id");
  const identifier = stringField(record, "identifier");
  const url = stringField(record, "url");
  const title = stringField(record, "title");
  if (id !== undefined) context = { ...context, id };
  if (identifier !== undefined) context = { ...context, identifier };
  if (url !== undefined) context = { ...context, url };
  if (title !== undefined) context = { ...context, title };
  return Object.keys(context).length === 0 ? undefined : context;
}

function normalizePrompt(
  record: Readonly<Record<string, unknown>> | undefined,
  actor: LinearActor | undefined,
): LinearAgentPromptContext | undefined {
  if (record === undefined) return undefined;
  const body = stringField(record, "body") ?? stringField(record, "content") ?? stringField(record, "text");
  const id = stringField(record, "id");
  let prompt: LinearAgentPromptContext = {};
  if (id !== undefined) prompt = { ...prompt, id };
  if (body !== undefined) prompt = { ...prompt, body };
  if (actor !== undefined) prompt = { ...prompt, actor };
  return Object.keys(prompt).length === 0 ? undefined : prompt;
}

function normalizeActivity(
  record: Readonly<Record<string, unknown>> | undefined,
): LinearAgentActivityContext | undefined {
  if (record === undefined) return undefined;
  const body = stringField(record, "body") ?? stringField(record, "content") ?? stringField(record, "text");
  const id = stringField(record, "id");
  const type = stringField(record, "type");
  let activity: LinearAgentActivityContext = {};
  if (id !== undefined) activity = { ...activity, id };
  if (type !== undefined) activity = { ...activity, type };
  if (body !== undefined) activity = { ...activity, body };
  return Object.keys(activity).length === 0 ? undefined : activity;
}

function normalizeActor(record: Readonly<Record<string, unknown>> | undefined): LinearActor | undefined {
  if (record === undefined) return undefined;
  const id = stringField(record, "id");
  const name = stringField(record, "name");
  const email = stringField(record, "email");
  const type = stringField(record, "type");
  const isApp = booleanField(record, "isApp");
  let actor: LinearActor = {};
  if (id !== undefined) actor = { ...actor, id };
  if (name !== undefined) actor = { ...actor, name };
  if (email !== undefined) actor = { ...actor, email };
  if (type !== undefined) actor = { ...actor, type };
  if (isApp !== undefined) actor = { ...actor, isApp };
  return Object.keys(actor).length === 0 ? undefined : actor;
}

function agentEventType(
  action: string,
  isStopSignal: boolean,
  activity: LinearAgentActivityContext | undefined,
): LinearAgentEventType {
  const lower = action.toLowerCase();
  if (isStopSignal) return "stop";
  if (lower.includes("created") || lower === "create") return "session_created";
  if (lower.includes("prompt")) return "session_prompted";
  if (activity !== undefined) return "activity";
  return "session_prompted";
}

function isStop(
  action: string,
  activity: LinearAgentActivityContext | undefined,
  prompt: LinearAgentPromptContext | undefined,
  data: Readonly<Record<string, unknown>>,
): boolean {
  const lower = [
    action,
    activity?.type,
    activity?.body,
    prompt?.body,
    stringField(data, "signal"),
  ]
    .filter((item): item is string => item !== undefined)
    .join(" ")
    .toLowerCase();
  return lower.includes("stop");
}

function labelsFromIssue(issue: Readonly<Record<string, unknown>>): readonly string[] {
  const labelIds = arrayField(issue, "labelIds")
    .map((item) => (typeof item === "string" ? item : undefined))
    .filter((item): item is string => item !== undefined);
  if (labelIds.length > 0) return labelIds;

  const labels = recordField(issue, "labels");
  const nodes = labels === undefined ? [] : arrayField(labels, "nodes");
  return nodes
    .map((item) => (typeof item === "object" && item !== null ? stringField(item as Record<string, unknown>, "id") : undefined))
    .filter((item): item is string => item !== undefined);
}

function optionList(single: string | undefined, many: readonly string[] | undefined): readonly string[] | undefined {
  if (many !== undefined) return many;
  if (single !== undefined) return [single];
  return undefined;
}

function matchesOne(value: string | undefined, accepted: readonly string[] | undefined): boolean {
  return accepted === undefined || (value !== undefined && accepted.includes(value));
}

function matchesLabels(labelIds: readonly string[], required: readonly string[] | undefined): boolean {
  return required === undefined || required.some((labelId) => labelIds.includes(labelId));
}

function actorExcluded(
  actor: LinearActor | undefined,
  excluded: readonly string[] | undefined,
  selfActorId: string | undefined,
): boolean {
  const actorId = actor?.id;
  if (actorId === undefined) return false;
  if (selfActorId !== undefined && actorId === selfActorId) return true;
  return excluded?.includes(actorId) ?? false;
}

function dedupeKey(
  request: LinearWebhookRequest,
  payload: Readonly<Record<string, unknown>>,
  fallback: string,
): string {
  return (
    singleHeader(request.headers, "linear-delivery") ??
    singleHeader(request.headers, "linear-event-id") ??
    stringField(payload, "webhookId") ??
    stringField(payload, "id") ??
    `${fallback}:${singleHeader(request.headers, "linear-timestamp") ?? request.rawBody}`
  );
}

function renderIssueComment(output: LinearIssueSinkOutput, prefix: string | undefined): string | undefined {
  const pieces = [output.commentBody, output.finalSummary, output.prUrl === undefined ? undefined : `PR: ${output.prUrl}`]
    .filter((item): item is string => item !== undefined && item.length > 0);
  if (pieces.length === 0) return undefined;
  return [prefix, pieces.join("\n\n")].filter((item): item is string => item !== undefined && item.length > 0).join("\n\n");
}

function externalUrlsForOutput(output: LinearAgentSinkOutput): readonly LinearExternalUrl[] {
  const urls: LinearExternalUrl[] = [...(output.externalUrls ?? [])];
  if (output.prUrl !== undefined && !urls.some((entry) => entry.url === output.prUrl)) {
    urls.push({ label: "Pull request", url: output.prUrl });
  }
  return urls;
}

function parseTimestampMs(value: string): number | undefined {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSignature(value: string): string {
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function singleHeader(headers: LinearWebhookHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string");
      return undefined;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function recordField(record: Readonly<Record<string, unknown>> | undefined, key: string): Readonly<Record<string, unknown>> | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayField(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  if (record === undefined) return undefined;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function linearSourceFailed(message: string): RuntimeError {
  return ioFailed("source", "linear", message);
}

function linearSinkFailed(message: string): RuntimeError {
  return ioFailed("sink", "linear", message);
}
