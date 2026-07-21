---
title: Errors and Results
description: The Result, Outcome, and Conversation types — how Orcats returns values, signals failure, and surfaces an autonomous run's terminal state.
---

Orca's result-returning operations represent expected failures as `Result` values rather than thrown exceptions. Asynchronous lifecycle methods keep promise semantics: public `cancel()` resolves after successful cleanup and rejects when cleanup fails. Every autonomous run resolves to an `Outcome`, and a live run is observed through a `Conversation`. These three types are the contract every flow and loop builds on. Signatures below are transcribed from `src/` and verified by `bun run docs:symbols`.

## `Result<T, E>`

Re-exported from [`neverthrow`](https://github.com/supermacro/neverthrow) as `ok`, `err`, and the `Result` type (see `src/index.ts`). Flows build `Result` values without taking a direct neverthrow dependency.

```ts
export { err, ok } from "neverthrow";
export type { Result } from "neverthrow";
```

A `Result<T, E>` is either `Ok<T>` or `Err<E>`. The methods Orcats flows actually use:

| Member | Signature | Behavior |
| --- | --- | --- |
| `isOk()` | `() => this is Ok<T, E>` | `true` when the value is present. |
| `isErr()` | `() => this is Err<T, E>` | `true` when the error is present. |
| `map()` | `<U>(f: (value: T) => U) => Result<U, E>` | Transform the ok value; errors pass through. |
| `mapErr()` | `<F>(f: (error: E) => F) => Result<T, F>` | Transform the error; ok values pass through. |
| `match()` | `<A>(ok: (value: T) => A, err: (error: E) => A) => A` | Branch on ok/err and return a value of the same type from both arms. |
| `unwrapOr()` | `(fallback: T) => T` | Return the value or the fallback. |
| `.value` | `T` | Available on `Ok` (narrowed by `isOk()`). |
| `.error` | `E` | Available on `Err` (narrowed by `isErr()`). |

The error channel `E` for Orcats's own tools is `RuntimeError` (see [Runtime Errors](../runtime-errors/)). `src/model/result.ts` also exports an `orThrow(result)` helper that unwraps an ok value or throws the error — use it only at boundaries where a `Result` must become a thrown exception.

### Example

```ts
import { git } from "@twelvehart/orcats";

const result = await git().add(["src/index.ts"]);
if (result.isErr()) {
  // result.error is a RuntimeError here
  console.error(result.error._tag);
  process.exit(1);
}
// result.value is void here
```

## `Outcome<B>`

The terminal state of one autonomous run. Defined in `src/conversation/conversation.ts`:

```ts
type Outcome<B extends BackendTag = BackendTag> =
  | { readonly type: "success"; readonly result: BackendResult<B> }
  | { readonly type: "cancelled"; readonly reason?: string }
  | { readonly type: "failed"; readonly error: RuntimeError };
```

**`awaitResult()` never rejects.** A `Conversation`'s `awaitResult()` returns `Promise<Outcome<B>>` that always resolves — failures arrive as `{ type: "failed", error }`, never as a rejected promise. This is the single most important contract for callers: you do not need a `try/catch` around `awaitResult()`; you pattern-match the `type` instead.

| `type` | Payload | Meaning |
| --- | --- | --- |
| `success` | `result: BackendResult<B>` | The run completed and produced a result. |
| `cancelled` | `reason?: string` | The run was cancelled (via `cancel()` or signal). `reason` is optional. |
| `failed` | `error: RuntimeError` | The run failed; `error` is a `RuntimeError` (see [Runtime Errors](../runtime-errors/)). |

### Example

```ts
import { claude } from "@twelvehart/orcats";

const convo = claude().autonomous({ prompt: "fix the failing test" });
const outcome = await convo.awaitResult(); // never throws
switch (outcome.type) {
  case "success":
    console.log("done", outcome.result);
    break;
  case "cancelled":
    console.log("cancelled:", outcome.reason ?? "(no reason)");
    break;
  case "failed":
    console.error("failed:", outcome.error._tag);
    break;
}
```

## `Conversation<B>`

A handle on one autonomous run, returned by `LlmBackend.autonomous()` (see [Backend Matrix](../backends/)). Defined in `src/conversation/conversation.ts`:

```ts
interface Conversation<B extends BackendTag = BackendTag> {
  readonly backend: B;
  readonly canAskUser: boolean;
  readonly signal: AbortSignal;
  events(): AsyncIterable<ConversationEvent>;
  awaitResult(): Promise<Outcome<B>>;
  cancel(reason?: string): Promise<void>;
}
```

| Member | Kind | Behavior |
| --- | --- | --- |
| `backend` | `readonly B` | The backend tag running this conversation (`claude`/`codex`/`opencode`/`pi`). |
| `canAskUser` | `readonly boolean` | Whether the run may ask the user for input. `false` in autonomous/served contexts. |
| `signal` | `readonly AbortSignal` | Aborts when `cancel()` is requested. Backend timeouts fail without aborting this signal. |
| `events()` | `() => AsyncIterable<ConversationEvent>` | Streams incremental events (token/tool/usage). `for await` to consume. |
| `awaitResult()` | `() => Promise<Outcome<B>>` | Resolves to the terminal `Outcome`. **Never rejects.** |
| `cancel(reason?)` | `(reason?: string) => Promise<void>` | Requests cancellation; resolves when cleanup succeeds and rejects if cleanup fails. |

### Side effects and invariants

- Successful cancellation resolves `cancel()` after the backend stops, then `awaitResult()` resolves to `{ type: "cancelled", reason }`. If cancellation cleanup fails, the shared `cancel()` promise rejects with the cleanup error and `awaitResult()` resolves to a typed `BackendFailed` outcome only after final cleanup and settlement release.
- `events()` is a stream: consume it with `for await`, or ignore it and call `awaitResult()` directly. The stream ends when the run reaches its outcome.
- A backend timeout stops the transport and resolves `awaitResult()` to `{ type: "failed", error }`; it does not abort the conversation's `signal`. The signal aborts only when `cancel()` is requested.

## Where these appear elsewhere

- `RuntimeError` variants and constructors: [Runtime Errors](../runtime-errors/).
- How loops wrap errors as `LoopRunError = RuntimeError | TerminationContractError`: [Loop API](../loop-api/).
- How state-store methods are `Result`-typed over `RuntimeError`: [State Stores](../state-stores/).
