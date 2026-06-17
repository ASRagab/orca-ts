import { watch as fsWatch } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { err, ok, type Result } from "neverthrow";

import { ioFailed, unsupportedFeature, type RuntimeError } from "../../model/index.ts";

// Source = the loop-level trigger boundary (spec loop-io, design D8). A Source subscribes a
// handler to trigger events and returns a stop handle; the `serve` supervisor (L11) owns the
// long-lived process that drives Sources. A custom trigger implements only `Source` — no engine
// change. All failures surface as `err(RuntimeError)`; a Source never throws across `start`/`stop`.

/** Bundled source kinds. A custom trigger reuses the closest kind or its own structural object. */
export type SourceKind = "manual" | "cron" | "watch" | "webhook" | "queue" | "linear-issue" | "linear-agent";

/** Handle returned by a started Source so the supervisor can stop the trigger. */
export interface SourceSubscription {
  stop(): Promise<Result<void, RuntimeError>>;
}

/** A loop trigger — the only loop-level entry boundary. */
export interface Source<E = unknown> {
  readonly kind: SourceKind;
  start(handler: (event: E) => void): Promise<Result<SourceSubscription, RuntimeError>>;
}

/** A started Source returns this so teardown is a plain `Result`-typed call. */
function subscription(stop: () => void): SourceSubscription {
  return {
    stop() {
      stop();
      return Promise.resolve(ok(undefined));
    },
  };
}

// --- manual: in-memory trigger; `fire(event)` pushes to the started handler. No real IO. ---

export interface ManualSource<E = void> extends Source<E> {
  readonly kind: "manual";
  /** Push a trigger event to the started handler. No-op until started / after stop. */
  fire(event: E): void;
  /** Whether a handler is currently subscribed. */
  isStarted(): boolean;
}

export function manual<E = void>(): ManualSource<E> {
  let handler: ((event: E) => void) | undefined;
  return {
    kind: "manual",
    isStarted: () => handler !== undefined,
    fire(event) {
      handler?.(event);
    },
    start(h) {
      handler = h;
      return Promise.resolve(ok(subscription(() => {
        handler = undefined;
      })));
    },
  };
}

// --- cron: cadence-driven trigger. The serve supervisor (design D8) owns cron-expression ---
// --- parsing + scheduling and supplies the scheduler; tests supply a fake. Unbound = err. ---

/** Schedules `fire` on the loop's cadence and returns a cancel handle. */
export type CronScheduler = (fire: () => void) => () => void;

export function cron(expression: string, scheduler?: CronScheduler): Source<void> {
  return {
    kind: "cron",
    start(handler) {
      if (scheduler === undefined) {
        return Promise.resolve(
          err(
            unsupportedFeature(
              "cron",
              `no scheduler bound for "${expression}"; the serve supervisor (L11) owns cron scheduling`,
            ),
          ),
        );
      }
      const cancel = scheduler(() => {
        handler();
      });
      return Promise.resolve(ok(subscription(cancel)));
    },
  };
}

// --- watch: filesystem trigger over node:fs watch; the watcher factory is injectable so tests ---
// --- exercise the adapter without real fs IO. ---

export interface WatchEvent {
  readonly eventType: string;
  readonly filename: string | null;
  /** The watched path that produced the event. */
  readonly path: string;
}

/** Opens a watcher on `path`, invoking `onEvent` per change; returns a close handle. */
export type WatcherFactory = (
  path: string,
  onEvent: (eventType: string, filename: string | null) => void,
) => { close(): void };

const defaultWatcherFactory: WatcherFactory = (path, onEvent) => {
  const watcher = fsWatch(path, (eventType, filename) => {
    onEvent(eventType, filename);
  });
  return {
    close: () => {
      watcher.close();
    },
  };
};

export interface WatchOptions {
  readonly paths: readonly string[];
  readonly watcherFactory?: WatcherFactory;
}

export function watch(options: WatchOptions): Source<WatchEvent> {
  const factory = options.watcherFactory ?? defaultWatcherFactory;
  return {
    kind: "watch",
    start(handler) {
      const watchers: { close(): void }[] = [];
      try {
        for (const path of options.paths) {
          watchers.push(
            factory(path, (eventType, filename) => {
              handler({ eventType, filename, path });
            }),
          );
        }
      } catch (error) {
        for (const watcher of watchers) {
          watcher.close();
        }
        return Promise.resolve(err(ioFailed("source", "watch", String(error))));
      }
      return Promise.resolve(
        ok(
          subscription(() => {
            for (const watcher of watchers) {
              watcher.close();
            }
          }),
        ),
      );
    },
  };
}

// --- webhook: inbound-HTTP trigger over a node:http server; the listener factory is injectable ---
// --- so tests exercise the adapter without binding a real socket. ---

export interface WebhookEvent {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

/** Starts a listener that invokes `onRequest` per inbound request and returns a close handle. */
export type ListenerFactory = (
  onRequest: (event: WebhookEvent) => void,
) => Promise<Result<{ close(): Promise<void> }, RuntimeError>>;

export interface WebhookOptions {
  readonly port: number;
  /** Only requests to this path fire the handler; default: any path. */
  readonly path?: string;
  readonly listenerFactory?: ListenerFactory;
}

function defaultListenerFactory(port: number, path: string | undefined): ListenerFactory {
  return (onRequest) =>
    new Promise((resolve) => {
      const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const url = req.url ?? "/";
          if (path === undefined || url === path) {
            onRequest({ method: req.method ?? "GET", url, body: Buffer.concat(chunks).toString("utf8") });
          }
          res.statusCode = 200;
          res.end();
        });
      });
      server.on("error", (error) => {
        resolve(err(ioFailed("source", "webhook", String(error))));
      });
      server.listen(port, () => {
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

export function webhook(options: WebhookOptions): Source<WebhookEvent> {
  const factory = options.listenerFactory ?? defaultListenerFactory(options.port, options.path);
  return {
    kind: "webhook",
    async start(handler) {
      const listener = await factory(handler);
      if (listener.isErr()) {
        return err(listener.error);
      }
      const handle = listener.value;
      return ok({
        async stop() {
          await handle.close();
          return ok(undefined);
        },
      });
    },
  };
}

// --- queue: broker-backed trigger. There is no in-repo broker, so the consumer is injected ---
// --- (the bundled Source is the seam adapter). Exported as `queueSource` because the Sink also ---
// --- ships a `queue`; the two factories cannot share a bare name across the io surface. ---

export interface QueueConsumer<E> {
  /** Subscribe to messages, delivering each; resolves to an unsubscribe handle. */
  subscribe(deliver: (message: E) => void): Promise<Result<() => void, RuntimeError>>;
}

export interface QueueSourceOptions<E> {
  readonly consumer: QueueConsumer<E>;
}

export function queueSource<E = unknown>(options: QueueSourceOptions<E>): Source<E> {
  return {
    kind: "queue",
    async start(handler) {
      const subscribed = await options.consumer.subscribe(handler);
      if (subscribed.isErr()) {
        return err(subscribed.error);
      }
      return ok(subscription(subscribed.value));
    },
  };
}
