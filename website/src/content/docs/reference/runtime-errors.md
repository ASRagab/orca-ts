---
title: Runtime Errors
description: The RuntimeError discriminated union — every _tag variant, its constructor, and which operations produce it.
---

Orca failures flow through a single discriminated union, `RuntimeError`, carried in the `E` channel of every `Result` (see [Errors and Results](../errors-and-results/)). Because the error type is a closed set of tagged variants, agents and humans can pattern-match exhaustively on `error._tag` instead of string-matching messages.

`RuntimeError` is a `z.discriminatedUnion("_tag", ...)` defined in `src/model/schemas.ts`. Its members:

```ts
type RuntimeError =
  | { _tag: "NothingToCommit" }
  | { _tag: "BranchAlreadyExists"; branch: string }
  | { _tag: "PushRejected"; remote?: string; stderr: string }
  | { _tag: "CommandFailed"; command: string; exitCode: number | null; stdout: string; stderr: string }
  | { _tag: "StructuredOutputValidationFailed"; issues: readonly string[]; raw: unknown }
  | { _tag: "UnsupportedFeature"; feature: string; reason: string }
  | { _tag: "BackendFailed"; backend: BackendTag; message: string }
  | { _tag: "TypecheckFailed"; stdout: string; stderr: string; exitCode: number | null }
  | { _tag: "FileSystemError"; path: string; message: string }
  | { _tag: "IoFailed"; seam: "source" | "sink" | "tool"; kind: string; message: string };
```

## Constructors

Five variants have dedicated constructor functions in `src/model/errors.ts`. The remaining five (`NothingToCommit`, `BranchAlreadyExists`, `PushRejected`, `TypecheckFailed`, `FileSystemError`) are constructed inline at their call sites as tagged object literals.

```ts
export function unsupportedFeature(feature: string, reason: string): RuntimeError;
export function backendFailed(backend: BackendTag, message: string): RuntimeError;
export function commandFailed(args: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): RuntimeError;
export function structuredOutputValidationFailed(args: {
  issues: readonly string[];
  raw: unknown;
}): RuntimeError;
export function ioFailed(seam: "source" | "sink" | "tool", kind: string, message: string): RuntimeError;
```

## Which operations produce which tags

This table is the operation→tag map. When you pattern-match a `Result`'s error, the `_tag` tells you what kind of operation failed.

| `_tag` | Produced by | Typical recovery |
| --- | --- | --- |
| `NothingToCommit` | `git.commit()` when the index is empty | Skip the commit; not an error condition for the caller. |
| `BranchAlreadyExists` | `git` branch creation when the branch exists | Reuse the existing branch or pick a new name. |
| `PushRejected` | `git` push rejected by the remote | Rebase or force-with-lease after reviewing the remote. |
| `CommandFailed` | `CommandTool.run()` and shell subprocesses | Inspect `command`/`exitCode`/`stderr`; retry or surface. |
| `StructuredOutputValidationFailed` | Structured-output parsing when the schema rejects | Re-prompt or fall back; `issues` lists the violations. |
| `UnsupportedFeature` | Feature gates that refuse a request (`unsupportedFeature()`) | The request is not supported in this configuration — do not retry as-is. |
| `BackendFailed` | An LLM backend returned a fatal error (`backendFailed()`) | Check `backend`/`message`; may be transient — retry with backoff. |
| `TypecheckFailed` | The typecheck runner after a code change | Read `stderr`, fix the typing errors, re-run. |
| `FileSystemError` | `FsTool`, snapshot store, and file sinks on IO failure | Check `path`/`message`; permissions, missing dir, disk. |
| `IoFailed` | Loop source/sink/tool seams (`ioFailed()`) | `seam` says where (`source`/`sink`/`tool`), `kind` the adapter; often retried by the loop supervisor. |

## Pattern-matching failures

Because `RuntimeError` is discriminated on `_tag`, a `switch` is exhaustive at the type level. Within a flow, errors arrive in the `E` channel of a `Result`; within a loop run, they are wrapped as `LoopRunError = RuntimeError | TerminationContractError` (see [Loop API](../loop-api/)).

```ts
import { git } from "orca";

const result = await git().commit("ship it");
if (result.isErr()) {
  switch (result.error._tag) {
    case "NothingToCommit":
      // not an error for us — nothing staged
      break;
    case "CommandFailed":
      console.error(result.error.stderr);
      break;
    // ...remaining tags — the compiler flags any you miss
  }
}
```

## Side effects and invariants

- `RuntimeError` values are plain data — constructing one does not throw or perform IO. The throw/return boundary is the caller's: tools return `Result<_, RuntimeError>` rather than throwing.
- `_tag` is the discriminant and is stable across versions; the payload fields may grow but existing fields are not renamed without a major version. When matching, branch on `_tag` and read fields inside the matched arm.
- `BackendTag` on `BackendFailed` is one of `claude`, `codex`, `opencode`, `pi` (see [Backend Matrix](../backends/)).
