---
title: Public API
description: Root exports grouped by module — backends, flow context, loops, review, monitoring, and the FlowContext accessors.
---

The package root (`src/index.ts`) re-exports the public runtime surface grouped by module. Signatures are transcribed from `src/` and verified by `bun run docs:symbols`.

```ts
import {
  claude, codex, opencode, pi, selectBackend,
  flow, flowArgs, fs, git, gh, linear, terminal, command, llm, plan, review,
  loop, defineLoop, serve, createSnapshotStore, createSqliteStore,
  fixLoop, reviewAndFixStrategy,
  WorkflowMonitor,
  ok, err, type Result, z,
} from "orca-ts";
```

## Backends

`claude`, `codex`, `opencode`, `pi` construct backends; `selectBackend(options)` resolves the backend synchronously and **throws** on an invalid `ORCA_BACKEND`, returning `SelectedBackend { tag, backend, model?, shutdown? }`. See [Backend Matrix](../backends/).

## Flow context and accessors

A flow runs inside a `FlowContext`. The accessor functions return the current context's capability tools — call them anywhere inside a flow or loop body:

| Accessor | Returns | Purpose |
| --- | --- | --- |
| `fs()` | `FsTool` | Read/write/exists on the working tree. |
| `git()` | `GitTool` | `status`/`add`/`commit` (`commit` → `NothingToCommit` when empty). |
| `gh()` | `GitHubTool` | `createPullRequest`. |
| `linear()` | `LinearTool` | Linear issue/agent/activity operations (see [Linear guide](../../guides/linear/)). |
| `terminal()` | `TerminalTool` | Emit events, status bar, capture lines. |
| `command()` | `CommandTool` | `run` → discriminated `success`/`failed`, never throws. |
| `llm()` | `LlmTool` | `autonomous(backend, request)` → `Conversation`. |
| `plan()` | `PlanTool` | Plan persistence (see `docs/plans.md`). |
| `review()` | `ReviewTool` | Review and fix loops (see `docs/review.md`). |

The full tool interfaces (`FsTool`, `GitTool`, `GitHubTool`, `LinearTool`, `CommandTool`, `TerminalTool`, `LlmTool`) are documented in [Tools](../tools/). `flow()` creates a direct-style flow context; `flowArgs()` reads task tokens passed after CLI `--`.

## Loops

`loop<S>(name)` returns a `LoopBuilder<S>`; `defineLoop()` packages a loop module; `serve()` runs the supervisor. See [Loop API](../loop-api/) and [State Stores](../state-stores/). The loop surface is Effect-free by mandate; Effect never crosses the facade.

## Review and fix

`review().run(options)` runs a review loop; `fixLoop(evaluate, fix, options?)` runs a generic fix loop over fixable issues; `reviewAndFixStrategy(options)` combines both. `runReviewAndFixLoop` and `implementTaskLoop` are deprecated (`ORCA_DEP_LOOP_COLLAPSE`) — migrate to `reviewAndFixStrategy` and `sequentialTaskStrategy`. Full signatures live in `docs/review.md` and `docs/plans.md`.

## Monitoring

`WorkflowMonitor` records a `WorkflowRunLog` (stages, outcomes, failures, summary, progress) and writes it with `writeLog(logDir)`. The log schema and `OutcomeVerdict` values are documented in the [Monitoring And Recovery guide](../../guides/monitoring-recovery/).

## Results and schemas

`ok`, `err`, and `Result` are re-exported from `neverthrow` so flows can build `Result`/`fixLoop` values without a direct neverthrow dependency. `z` is the same Zod export used for structured-output schemas. See [Errors and Results](../errors-and-results/) and [Runtime Errors](../runtime-errors/).

## Subpath imports

Loop authoring can also import from `orca-ts/loop`; model and testing helpers are exposed through `orca-ts/model` and `orca-ts/testing`.

Effect remains behind the loop facade and is not part of the public API.
