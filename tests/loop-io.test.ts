import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";

import {
  cron,
  file,
  ioFailed,
  loop,
  manual,
  queueSink,
  queueSource,
  slack,
  stdout,
  watch,
  webhook,
  type CronScheduler,
  type ListenerFactory,
  type LoopOutcome,
  type Sink,
  type Source,
  type WatcherFactory,
  type WatchEvent,
  type WebhookEvent,
} from "../src/index.ts";
import { createFakeLlmTool, fakeBackend, fakeSink, fakeSource } from "../src/test-utils/index.ts";

// L09 acceptance (spec loop-io, tasks 8.1-8.4): Source = the only loop-level trigger boundary,
// Sink = the only loop-level output boundary. A bundled source fires a run; a sink emit failure
// is an `err(RuntimeError)`; a custom Source/Sink integrates with no loop-engine change; and the
// whole loop runs end to end against fake Source + fake Sink + fake FlowContext with no real IO.

interface Countdown {
  readonly n: number;
}
const countdownVariant = { measure: (state: Countdown) => state.n };
const decrement = (state: Countdown): Countdown => ({ n: state.n - 1 });

describe("Source — pluggable triggers (task 8.1)", () => {
  test("a bundled source fires a loop run", async () => {
    const source = manual();
    const runs: Promise<void>[] = [];
    let outcome: LoopOutcome<Countdown> | undefined;

    const started = await source.start(() => {
      runs.push(
        (async () => {
          const result = await loop<Countdown>("on-trigger")
            .step("decrement", decrement)
            .until(countdownVariant)
            .run({ n: 3 });
          outcome = result._unsafeUnwrap();
        })(),
      );
    });
    expect(started.isOk()).toBe(true);

    // No run before the trigger fires.
    expect(outcome).toBeUndefined();
    source.fire();
    await Promise.all(runs);

    expect(outcome?.stopReason).toBe("converged");
    expect(outcome?.state.n).toBe(0);

    const subscription = started._unsafeUnwrap();
    expect((await subscription.stop()).isOk()).toBe(true);
    expect(source.isStarted()).toBe(false);
  });

  test("a custom Source integrates with no loop-engine change", async () => {
    // A plain object implementing the interface — the loop accepts it identically.
    let fire: (() => void) | undefined;
    const custom: Source<void> = {
      kind: "manual",
      start(handler) {
        fire = handler;
        return Promise.resolve(ok({ stop: () => Promise.resolve(ok(undefined)) }));
      },
    };

    let fired = false;
    await custom.start(() => {
      fired = true;
    });
    fire?.();
    expect(fired).toBe(true);
  });

  test("cron is unbound until the serve supervisor provides a scheduler", async () => {
    const unbound = await cron("*/5 * * * *").start(() => undefined);
    expect(unbound.isErr()).toBe(true);
    expect(unbound._unsafeUnwrapErr()._tag).toBe("UnsupportedFeature");

    let tick: (() => void) | undefined;
    let cancelled = false;
    const scheduler: CronScheduler = (fire) => {
      tick = fire;
      return () => {
        cancelled = true;
      };
    };
    let fires = 0;
    const started = await cron("*/5 * * * *", scheduler).start(() => {
      fires += 1;
    });
    expect(started.isOk()).toBe(true);
    tick?.();
    tick?.();
    expect(fires).toBe(2);
    await started._unsafeUnwrap().stop();
    expect(cancelled).toBe(true);
  });

  test("watch adapts a watcher to the Source seam (injected factory, no real fs IO)", async () => {
    let emit: ((eventType: string, filename: string | null) => void) | undefined;
    let closed = false;
    const watcherFactory: WatcherFactory = (path, onEvent) => {
      void path;
      emit = onEvent;
      return { close: () => { closed = true; } };
    };

    const events: WatchEvent[] = [];
    const started = await watch({ paths: ["src"], watcherFactory }).start((event) => {
      events.push(event);
    });
    expect(started.isOk()).toBe(true);
    emit?.("change", "a.ts");
    expect(events).toEqual([{ eventType: "change", filename: "a.ts", path: "src" }]);
    await started._unsafeUnwrap().stop();
    expect(closed).toBe(true);
  });

  test("webhook adapts an inbound listener to the Source seam (injected factory, no real socket)", async () => {
    let deliver: ((event: WebhookEvent) => void) | undefined;
    let closed = false;
    const listenerFactory: ListenerFactory = (onRequest) => {
      deliver = onRequest;
      return Promise.resolve(ok({ close: () => { closed = true; return Promise.resolve(); } }));
    };

    const received: WebhookEvent[] = [];
    const started = await webhook({ port: 0, listenerFactory }).start((event) => {
      received.push(event);
    });
    expect(started.isOk()).toBe(true);
    deliver?.({ method: "POST", url: "/hook", body: "{}" });
    expect(received).toEqual([{ method: "POST", url: "/hook", body: "{}" }]);
    await started._unsafeUnwrap().stop();
    expect(closed).toBe(true);
  });

  test("queueSource delegates to an injected consumer", async () => {
    let deliver: ((message: string) => void) | undefined;
    const source = queueSource<string>({
      consumer: {
        subscribe(received) {
          deliver = received;
          return Promise.resolve(ok(() => undefined));
        },
      },
    });
    const messages: string[] = [];
    const started = await source.start((message) => messages.push(message));
    expect(started.isOk()).toBe(true);
    deliver?.("job-1");
    expect(messages).toEqual(["job-1"]);
  });
});

describe("Sink — pluggable outputs (task 8.2)", () => {
  test("file sink writes the rendered output (round-trips through a temp dir)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-io-"));
    try {
      const path = join(dir, "nested", "out.json");
      const sink: Sink<{ answer: number }> = file({ path });
      const emitted = await sink.emit({ answer: 42 });
      expect(emitted.isOk()).toBe(true);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ answer: 42 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stdout sink renders to an injected writer", async () => {
    const lines: string[] = [];
    const sink = stdout<string>({ write: (text) => lines.push(text) });
    expect((await sink.emit("done")).isOk()).toBe(true);
    expect(lines).toEqual(["done\n"]);
  });

  test("a sink emit failure surfaces as err(RuntimeError), not a throw", async () => {
    const sink = fakeSink<string>({ failWith: ioFailed("sink", "stdout", "boom") });
    const emitted = await sink.emit("anything");
    expect(emitted.isErr()).toBe(true);
    const error = emitted._unsafeUnwrapErr();
    expect(error._tag).toBe("IoFailed");
    expect(sink.emitted()).toEqual([]);
  });

  test("slack sink maps a failing post to err(RuntimeError)", async () => {
    const sink = slack<string>({
      webhookUrl: "https://hooks.invalid/x",
      post: () => Promise.resolve(err(ioFailed("sink", "slack", "slack webhook returned HTTP 500"))),
    });
    const emitted = await sink.emit("hello");
    expect(emitted.isErr()).toBe(true);
    expect(emitted._unsafeUnwrapErr()._tag).toBe("IoFailed");
  });

  test("queueSink delegates to an injected producer", async () => {
    const pushed: string[] = [];
    const sink = queueSink<string>({
      producer: {
        push(message) {
          pushed.push(message);
          return Promise.resolve(ok(undefined));
        },
      },
    });
    expect((await sink.emit("job-1")).isOk()).toBe(true);
    expect(pushed).toEqual(["job-1"]);
  });
});

describe("Source + Sink are the loop's trigger/output seams (task 8.4)", () => {
  test("the whole loop runs end to end against fake Source + fake Sink + fake FlowContext", async () => {
    // Fakes only: an in-memory trigger, an in-memory capturing sink, and a fake LLM backend via
    // the flow-context override. No real trigger, output, backend, filesystem, git, or command IO.
    const backend = fakeBackend(["work", "work"]);
    const llm = createFakeLlmTool(backend);

    const source = fakeSource();
    const sink = fakeSink<string>();

    const runs: Promise<void>[] = [];
    const started = await source.start(() => {
      runs.push(
        (async () => {
          const result = await loop<Countdown>("fakes-e2e")
            .reason(backend, { prompt: "advance the work" })
            .step("decrement", decrement)
            .until(countdownVariant)
            .run({ n: 2 }, { overrides: { llm } });
          const outcome = result._unsafeUnwrap();
          // On convergence, emit the loop result to the sink — the only output boundary.
          await sink.emit(`converged after ${String(outcome.iterations)} iterations`);
        })(),
      );
    });
    expect(started.isOk()).toBe(true);

    source.fire();
    await Promise.all(runs);

    // The fake sink captured the emitted output, and the backend was driven only via the fake.
    expect(sink.emitted()).toEqual(["converged after 2 iterations"]);
    expect(backend.calls.length).toBe(2);

    await started._unsafeUnwrap().stop();
    expect(source.isStarted()).toBe(false);
  });
});
