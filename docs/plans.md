# Plans

Persistent plan helpers write `.orca/plan-<hash>.md` files from deterministic input hashes, so a crashed autonomous run can recover the same plan and continue. Signatures below are transcribed from `src/plan/persistent.ts` and `src/flow/context.ts` and verified by `bun run docs:symbols`.

The default v1 loop is autonomous: create or recover a plan, implement tasks in order, persist progress, and let the runtime own repository commits. `Plan.interactive` is intentionally unsupported in v1 because live answers cannot be replayed after a crash.

## `PlanTool`

Flows reach plan persistence through the `plan()` accessor, which returns a `PlanTool`:

```ts
interface PlanTool {
  readonly defaultPath: typeof defaultPlanPath;
  readonly write: typeof writePlan;
  readonly recover: typeof recoverPlan;
  readonly implementTaskLoop: typeof implementTaskLoop;
  interactive(): never;
}
```

`interactive()` throws `Plan.interactive is intentionally unsupported in v1` — it exists to make the unsupported surface explicit rather than silently absent. Do not call it.

## Path and hash

```ts
function planHash(input: string): string;
function defaultPlanPath(root: string, input: string): string;
```

`planHash` returns the first 12 hex characters of the SHA-256 of `input`. `defaultPlanPath` returns `<root>/.orca/plan-<planHash(input)>.md`. The hash is deterministic over the plan input, so the same input always maps to the same plan file.

## Write and recover

```ts
async function writePlan(
  root: string,
  input: string,
  content: string,
  fsTool?: FsTool,
): Promise<Result<string, RuntimeError>>;

async function recoverPlan(
  path: string,
  fsTool?: FsTool,
): Promise<Result<string, RuntimeError>>;
```

`writePlan` writes `content` to `defaultPlanPath(root, input)` and returns the path on success. `recoverPlan` reads a plan file by `path`. Both are `Result`-typed over `RuntimeError`; a missing or unreadable file surfaces as `FileSystemError` (see the website [Runtime Errors](../website/src/content/docs/reference/runtime-errors.md) reference). The optional `fsTool` defaults to the real filesystem tool and is injectable for tests.

## Sequential task strategy

```ts
interface PlanTask {
  readonly id: string;
  readonly description: string;
}

interface PlanLoopResult {
  readonly completed: readonly string[];
}

async function sequentialTaskStrategy(
  tasks: readonly PlanTask[],
  implement: (task: PlanTask) => Promise<Result<void, RuntimeError>>,
): Promise<Result<PlanLoopResult, RuntimeError>>;
```

`sequentialTaskStrategy` drives the pending-task count to zero through loop execution, implementing one task per cycle and stopping at the first typed failure. On success it returns `{ completed }` — the IDs of tasks that ran. On the first `implement` failure it returns `Err(RuntimeError)`; later tasks are not attempted.

## Deprecated: `implementTaskLoop`

```ts
function implementTaskLoop(
  tasks: readonly PlanTask[],
  implement: (task: PlanTask) => Promise<Result<void, RuntimeError>>,
): Promise<Result<PlanLoopResult, RuntimeError>>;
```

`implementTaskLoop` is a compatibility wrapper that delegates to `sequentialTaskStrategy` and emits a runtime `DeprecationWarning` with code `ORCA_DEP_LOOP_COLLAPSE`. It is kept for one release so existing callers stay lint-clean; migrate to `sequentialTaskStrategy`. The `ORCA_DEP_LOOP_COLLAPSE` code is a deprecation-warning identifier (not an environment variable you set) — it appears in `process.emitWarning` and in warning filters.
