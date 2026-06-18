---
title: Tools
description: The FlowContext capability tools — FsTool, GitTool, GitHubTool, LinearTool, CommandTool, TerminalTool, LlmTool — with Result-typed signatures.
---

A flow runs inside a `FlowContext` whose capability tools are reached through the accessor functions `fs()`, `git()`, `gh()`, `linear()`, `terminal()`, `command()`, `llm()`, `plan()`, and `review()` (see [Public API](../api/)). Every tool that can fail is `Result`-typed over `RuntimeError` (see [Runtime Errors](../runtime-errors/)). Signatures are transcribed from `src/tools/` and verified by `bun run docs:symbols`.

## `FsTool`

```ts
interface FsTool {
  readText(path: string): Promise<Result<string, RuntimeError>>;
  writeText(path: string, content: string): Promise<Result<void, RuntimeError>>;
  exists(path: string): Promise<boolean>;
}
```

`readText`/`writeText` return `Err(FileSystemError)` on IO failure. `exists` returns a bare `boolean` — it does not distinguish "missing" from "error" and never returns a `Result`.

## `GitTool`

```ts
interface GitTool {
  status(): Promise<Result<string, RuntimeError>>;
  add(paths: readonly string[]): Promise<Result<void, RuntimeError>>;
  commit(message: string): Promise<Result<QuietProcResult, RuntimeError>>;
}
```

`commit` returns `Err({ _tag: "NothingToCommit" })` when the index is empty — this is a signaled condition, not a crash; callers that treat "nothing to commit" as success should match `_tag === "NothingToCommit"`. `status` returns the `git status --short` output. `QuietProcResult` carries `stdout`, `stderr`, `exitCode`, and `durationMs`.

## `GitHubTool`

```ts
interface PullRequestInput {
  readonly title: string;
  readonly bodyFile: string;
  readonly base?: string;
}

interface GitHubTool {
  createPullRequest(input: PullRequestInput): Promise<Result<QuietProcResult, RuntimeError>>;
}
```

`createPullRequest` shells out to `gh pr create` using `--body-file` (a file path, not inline body). `base` is optional. A non-zero `gh` exit surfaces as `CommandFailed`.

## `LinearTool`

```ts
interface LinearTool {
  fetchIssue(input: { readonly issueId: string }): Promise<Result<LinearIssue | null, RuntimeError>>;
  updateIssue(input: LinearIssueUpdateInput): Promise<Result<LinearIssue, RuntimeError>>;
  createIssueComment(input: { readonly issueId: string; readonly body: string }): Promise<Result<LinearIssueComment, RuntimeError>>;
  createAgentActivity(input: LinearAgentActivityInput): Promise<Result<LinearAgentActivity, RuntimeError>>;
  updateAgentSession(input: LinearAgentSessionUpdateInput): Promise<Result<LinearAgentSession, RuntimeError>>;
  getTeamWorkflowStates(input: { readonly teamId: string }): Promise<Result<readonly LinearWorkflowState[], RuntimeError>>;
}
```

`fetchIssue` returns `null` (not an error) when the issue does not exist. See the [Linear guide](../../guides/linear/) for env vars, webhook verification, and how the source/sink kinds use these methods.

## `CommandTool`

```ts
interface VerificationCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

type VerificationCommandResult =
  | { readonly type: "success"; readonly command: string; readonly stdout: string; readonly stderr: string; readonly exitCode: 0; readonly durationMs: number }
  | { readonly type: "failed"; readonly command: string; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; readonly durationMs: number };

interface CommandTool {
  run(command: VerificationCommand): Promise<VerificationCommandResult>;
}
```

`CommandTool.run` **never throws and never returns a `Result`** — it returns a discriminated `VerificationCommandResult`. Branch on `result.type`: `"success"` (exit `0`) or `"failed"` (non-zero or `null` exit, with captured `stdout`/`stderr`). This is the contract loops rely on for gate verification commands.

## `TerminalTool`

```ts
interface StatusBarState {
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

interface TerminalTool {
  emit(event: OrcaEvent): void;
  lines(): readonly string[];
  status(status: StatusBarState, options?: StatusBarOptions): string;
}
```

`emit` renders an `OrcaEvent` to the in-memory line buffer; `lines()` returns the buffered rendered lines; `status` renders a status-bar line (honoring `NO_COLOR`/`CI`/non-TTY). These are synchronous and side-effect-free beyond the buffer.

## `LlmTool`

```ts
interface LlmTool {
  autonomous<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output, B>,
  ): Conversation<B>;
}
```

`llm().autonomous(backend, request)` is the flow-side entry to an autonomous run — it returns a `Conversation<B>` synchronously (see [Errors and Results](../errors-and-results/) and [Backend Matrix](../backends/)). `awaitResult()` on the returned conversation never rejects.
