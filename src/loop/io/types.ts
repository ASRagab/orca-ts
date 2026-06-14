import type { Result } from "neverthrow";

// Source = trigger boundary, Sink = output boundary (specs loop-io, design D8).
// Bundled implementations and test fakes land in L09 (tasks 8.1-8.4). Types only here.

/** Bundled source kinds (TODO L09): manual | cron | watch | webhook | queue. */
export type SourceKind = "manual" | "cron" | "watch" | "webhook" | "queue";

/** Handle returned by a started Source so the supervisor can stop the trigger. */
export interface SourceSubscription {
  stop(): Promise<Result<void, Error>>;
}

/** A loop trigger. The only loop-level entry boundary. TODO(L09, task 8.1). */
export interface Source<E = unknown> {
  readonly kind: SourceKind;
  start(handler: (event: E) => void): Promise<Result<SourceSubscription, Error>>;
}

/** Bundled sink kinds (TODO L09): pr | file | slack | queue | stdout. */
export type SinkKind = "pr" | "file" | "slack" | "queue" | "stdout";

/** A loop output. The only loop-level emit boundary; Result-typed. TODO(L09, task 8.2). */
export interface Sink<A = unknown> {
  readonly kind: SinkKind;
  emit(output: A): Promise<Result<void, Error>>;
}
