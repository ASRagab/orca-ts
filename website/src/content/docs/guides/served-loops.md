---
title: Served Loops
description: Host a loop trigger, isolate each firing in a child process, and pass trigger events via ORCA_LOOP_EVENT.
---

`defineLoop()` packages a source, sink, and one-shot runner into a loop module. Signatures are transcribed from `src/loop/serve.ts` and verified by `bun run docs:symbols`.

```ts
import { defineLoop, manual, stdout } from "orca-ts";

export default defineLoop({
  name: "example",
  source: manual<void>(),
  sink: stdout(),
  onTrigger: async () => {
    // Run one loop firing here.
  }
});
```

## Types

```ts
function defineLoop<E = unknown, A = unknown, S = unknown>(
  config: LoopConfig<E, A, S>,
): LoopDefinition<E, A, S>;

interface LoopDefinition<E = unknown, A = unknown, S = unknown> {
  readonly name: string;
  readonly source: Source<E>;
  readonly sink: Sink<A>;
  run(event: E): Promise<Result<LoopOutcome<S>, LoopRunError>>;
}

interface LoopEmission<A = unknown, S = unknown> {
  readonly outcome: LoopOutcome<S>;
  readonly output: A;
}
```

`defineLoop` takes a `LoopConfig` (name, source, sink, and an `onTrigger` that maps a trigger event `E` to a `LoopEmission`). The returned `LoopDefinition` exposes `run(event)` for a single firing. `LoopOutcome<S>` and `LoopRunError` are documented on the [Loop API](../../reference/loop-api/) reference.

## Discovery, run, serve

Discovery is import-only. `orca loops` must not start a source, backend, or sink:

```bash
orca loops
```

Run one firing:

```bash
ORCA_LOOP_EVENT='{}' orca run example
```

Serve a trigger:

```bash
orca serve example
```

### `ORCA_LOOP_EVENT` payload

`orca run` reads the trigger event from the `ORCA_LOOP_EVENT` environment variable. The value is a JSON-encoded trigger event. orca parses it as JSON; if parsing fails it falls back to the raw string; if the variable is unset, no event is delivered. The event type is the loop source's `E` — for `manual<void>()` it is ignored, for Linear sources it is the normalized Linear trigger event, for `queue`/`watch` it is the queued/watched payload.

`ORCA_LOOP_EVENT` belongs to the shared firing contract between the CLI and served children. Source and Sink adapters should not read it directly or depend on supervisor internals; they should consume only the public trigger event and emitted output.

```bash
# A JSON object trigger event
ORCA_LOOP_EVENT='{"issueId":"LIN-123"}' orca run linear-issue-triage
```

## Supervisor isolation

```ts
interface ServeOptions { /* supervisor config: concurrency, restart policy, etc. */ }

interface Supervisor {
  children(): readonly ChildHandle[];
  stop(): Promise<Result<void, RuntimeError>>;
}

async function serve(
  definition: LoopDefinition,
  options?: ServeOptions,
): Promise<Result<Supervisor, RuntimeError>>;
```

`orca serve` owns the trigger and spawns a child process per firing. One child crash does not take down the supervisor or sibling firings — `serve()` returns a `Supervisor` whose `children()` lists live firings and whose `stop()` tears them down. `serve()` itself returns `Result<Supervisor, RuntimeError>`; a failure to start the supervisor (e.g. a port clash on a webhook source) surfaces as `Err(RuntimeError)` rather than throwing. `orca run` and served children use the same firing path for event decode, `definition.run(event)`, sink emission, diagnostics, and stop-reason exit-code mapping.

## Source and sink kinds

Built-in source kinds: `manual`, `cron`, `watch`, `webhook`, `queue`, `linear-issue`, `linear-agent`.

Built-in sink kinds: `pr`, `file`, `slack`, `queue`, `stdout`, `linear-issue`, `linear-agent`.

The `linear-issue` and `linear-agent` kinds are provided by `linearIssueSource` / `linearAgentSource` / `linearIssueSink` / `linearAgentSink`. See the [Linear guide](../linear/) for env vars and webhook verification.
