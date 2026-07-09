import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "../model/index.ts";

export type RunEvent =
  | RunStartedEvent
  | RunHeartbeatEvent
  | RunFinishedEvent
  | PreflightEvent
  | StageEvent
  | AgentActivityEvent
  | CycleProgressEvent
  | OutcomeEvent
  | FailureEvent
  | ArtifactEvent;

export interface RunStartedEvent {
  readonly type: "run_started";
  readonly runId?: string;
  readonly label?: string;
  readonly backend?: string;
}

export interface RunHeartbeatEvent {
  readonly type: "run_heartbeat";
  readonly label?: string;
  readonly elapsedMs?: number;
}

export interface RunFinishedEvent {
  readonly type: "run_finished";
  readonly label?: string;
  readonly status: "success" | "failed";
  readonly stopReason?: string;
  readonly iterations?: number;
  readonly error?: string;
}

export interface PreflightEvent {
  readonly type: "preflight";
  readonly name: string;
  readonly status: "started" | "passed" | "failed" | "skipped";
  readonly reason?: string;
}

export interface StageEvent {
  readonly type: "stage";
  readonly name: string;
  readonly status: "started" | "running" | "completed" | "failed";
  readonly durationMs?: number;
  readonly message?: string;
}

export interface AgentActivityEvent {
  readonly type: "agent_activity";
  readonly activity: "started" | "tool_use" | "tool_result" | "assistant_summary" | "usage";
  readonly backend?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly usage?: Usage;
}

export interface CycleBranchEvent {
  readonly id: string;
  readonly status: string;
  readonly usage?: Usage | "unknown";
}

export interface CycleContextPressureEvent {
  readonly offloadCount: number;
  readonly compactionStages: readonly string[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly observationCount: number;
}

export interface CycleProgressEvent {
  readonly type: "cycle_progress";
  readonly iteration: number;
  readonly measure?: number;
  readonly delta?: number;
  readonly stopStatus?: string;
  readonly usage?: Usage | "unknown";
  readonly branches?: readonly CycleBranchEvent[];
  readonly contextPressure?: CycleContextPressureEvent;
}

export interface OutcomeEvent {
  readonly type: "outcome";
  readonly file: string;
  readonly verdict: string;
  readonly durationMs?: number;
  readonly reason?: string;
}

export interface FailureEvent {
  readonly type: "failure";
  readonly file: string;
  readonly category?: string;
  readonly durationMs?: number;
  readonly message: string;
}

export interface ArtifactEvent {
  readonly type: "artifact";
  readonly artifact: string;
  readonly path: string;
  readonly label?: string;
}

export interface RunEventSink {
  handle(event: RunEvent): void | Promise<void>;
}

export interface RunReporter {
  emit(event: RunEvent): void;
  events(): readonly RunEvent[];
  flush(): Promise<void>;
}

export interface RunReporterOptions {
  readonly sinks?: readonly RunEventSink[];
}

export interface RunNarrator {
  summarize(events: readonly RunEvent[]): string | Promise<string>;
}

export interface RunPresenterOptions {
  readonly env?: Record<string, string | undefined>;
  readonly isTTY?: boolean;
  readonly narration?: "disabled" | "enabled";
  readonly narrator?: RunNarrator;
  readonly writeDiagnostic?: (text: string) => void;
  readonly writeOutput?: (text: string) => void;
}

const reporterStorage = new AsyncLocalStorage<RunReporter>();
const reporterStack: RunReporter[] = [];

export function activeRunReporter(): RunReporter | undefined {
  return reporterStorage.getStore() ?? reporterStack.at(-1);
}

export async function withRunReporter<T>(
  reporter: RunReporter | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (reporter === undefined) {
    return await fn();
  }
  reporterStack.push(reporter);
  try {
    return await reporterStorage.run(reporter, async () => await fn());
  } finally {
    reporterStack.pop();
  }
}

export function createRunReporter(options: RunReporterOptions = {}): RunReporter {
  const events: RunEvent[] = [];
  const pending: Promise<void>[] = [];
  const sinks = options.sinks ?? [];

  return {
    emit(event) {
      events.push(event);
      for (const sink of sinks) {
        try {
          const result = sink.handle(event);
          if (result instanceof Promise) {
            pending.push(result.then(() => undefined, () => undefined));
          }
        } catch {
          continue;
        }
      }
    },
    events() {
      return [...events];
    },
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}

export function createRunPresenter(options: RunPresenterOptions = {}): RunEventSink {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stderr.isTTY === true;
  const writeDiagnostic =
    options.writeDiagnostic ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const recent: RunEvent[] = [];

  return {
    async handle(event) {
      recent.push(event);
      writeDiagnostic(`${formatRunEvent(event, { env, isTTY })}\n`);

      if (options.narration !== "enabled" || options.narrator === undefined || env.CI) {
        return;
      }

      try {
        const summary = await options.narrator.summarize([...recent]);
        if (summary.trim().length > 0) {
          writeDiagnostic(`${prefix({ env, isTTY })} narrator: ${summary.trim()}\n`);
        }
      } catch (error) {
        writeDiagnostic(`${prefix({ env, isTTY })} narration unavailable: ${describeError(error)}\n`);
      }
    },
  };
}

export function formatRunEvent(
  event: RunEvent,
  options: Pick<RunPresenterOptions, "env" | "isTTY"> = {},
): string {
  const head = prefix(options);
  switch (event.type) {
    case "run_started": {
      const label = event.label ?? event.runId ?? "run";
      const backend = event.backend === undefined ? "" : ` (backend=${event.backend})`;
      return `${head} run started: ${label}${backend}`;
    }
    case "run_heartbeat":
      return `${head} run active: ${event.label ?? "work"}${durationSuffix(event.elapsedMs)}`;
    case "run_finished": {
      const label = event.label ?? "run";
      if (event.status === "failed") {
        return `${head} failed: ${label}${event.error === undefined ? "" : `: ${event.error}`}`;
      }
      const reason = event.stopReason === undefined ? "completed" : `stopped (${event.stopReason})`;
      const iterations = event.iterations === undefined ? "" : ` after ${String(event.iterations)} iteration(s)`;
      return `${head} done: ${label} ${reason}${iterations}`;
    }
    case "preflight":
      return `${head} preflight ${event.name} ${event.status}${event.reason === undefined ? "" : `: ${event.reason}`}`;
    case "stage":
      return `${head} stage ${event.name} ${event.status}${durationSuffix(event.durationMs)}${event.message === undefined ? "" : `: ${event.message}`}`;
    case "agent_activity":
      return formatAgentActivity(head, event);
    case "cycle_progress":
      return formatCycleProgress(head, event);
    case "outcome":
      return `${head} outcome ${event.file} ${event.verdict}${durationSuffix(event.durationMs)}${event.reason === undefined ? "" : `: ${event.reason}`}`;
    case "failure":
      return `${head} failure ${event.file}${event.category === undefined ? "" : ` ${event.category}`}${durationSuffix(event.durationMs)}: ${event.message}`;
    case "artifact":
      return `${head} artifact ${event.label ?? event.artifact}: ${event.path}`;
  }
}

function formatAgentActivity(head: string, event: AgentActivityEvent): string {
  const actor = event.backend === undefined ? "agent" : `agent ${event.backend}`;
  switch (event.activity) {
    case "started":
      return `${head} ${actor} started`;
    case "tool_use":
      return `${head} ${actor} tool ${event.name ?? "unknown"}`;
    case "tool_result":
      return `${head} ${actor} tool result ${event.name ?? "unknown"}${event.summary === undefined ? "" : `: ${event.summary}`}`;
    case "assistant_summary":
      return `${head} ${actor}: ${event.summary ?? ""}`.trimEnd();
    case "usage":
      return `${head} ${actor} usage${event.usage === undefined ? "" : ` ${formatUsage(event.usage)}`}`;
  }
}

function formatCycleProgress(head: string, event: CycleProgressEvent): string {
  const fields = [`cycle ${String(event.iteration)}`];
  if (event.measure !== undefined) fields.push(`measure=${String(event.measure)}`);
  if (event.delta !== undefined) fields.push(`delta=${String(event.delta)}`);
  if (event.stopStatus !== undefined) fields.push(`stop=${event.stopStatus}`);
  if (event.usage !== undefined && event.usage !== "unknown") fields.push(formatUsage(event.usage));
  if (event.usage === "unknown") fields.push("usage=unknown");
  if (event.contextPressure !== undefined) {
    fields.push(`context=${String(event.contextPressure.tokensBefore)}->${String(event.contextPressure.tokensAfter)}`);
  }
  return `${head} ${fields.join(" ")}`;
}

function prefix(options: Pick<RunPresenterOptions, "env" | "isTTY"> = {}): string {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stderr.isTTY === true;
  if (isTTY && !env.NO_COLOR && !env.CI) {
    return "\u001b[36morca\u001b[0m |";
  }
  return "orcats |";
}

function durationSuffix(ms: number | undefined): string {
  return ms === undefined ? "" : ` (${formatDuration(ms)})`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${String(ms)}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

function formatUsage(usage: Usage): string {
  const reasoning = usage.reasoning === undefined ? "" : ` reasoning=${String(usage.reasoning)}`;
  return `usage=input=${String(usage.input)} output=${String(usage.output)}${reasoning}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
