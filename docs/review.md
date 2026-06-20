# Review Automation

Reviewer prompts are copied verbatim from the Scala oracle and tested for byte parity. Signatures below are transcribed from `src/review/` and verified by `bun run docs:symbols`.

The canonical reviewer order is `code-functionality`, `test`, `readability`, `code-structure`, `simplicity`, `performance`, `security`, `scala-fp`. The default minimal reviewer set is `code-functionality`, `readability`, and `test`.

Flow authors use the review module through `review().run(...)`. The module owns prompt loading, reviewer selection, review-loop events, fixable issue filtering, and fix execution order behind the flow review seam.

## `ReviewTool`

```ts
type ReviewerId =
  | "code-functionality"
  | "test"
  | "readability"
  | "code-structure"
  | "simplicity"
  | "performance"
  | "security"
  | "scala-fp";

const DefaultReviewers = ["code-functionality", "readability", "test"] as const;

interface ReviewTool {
  readonly reviewers: readonly ReviewerId[];
  run(options: ReviewToolRunOptions): Promise<Result<ReviewLoopSummary, RuntimeError>>;
}

interface ReviewToolRunOptions {
  readonly requested?: readonly ReviewerId[];
  readonly loadPrompts?: () => Promise<ReviewerPrompt[]>;
  readonly review: ReviewAndFixOptions["review"];
  readonly fix: ReviewAndFixOptions["fix"];
}
```

`review()` returns a `ReviewTool` whose `reviewers` default to `DefaultReviewers`. `run(options)` runs one review pass then a fix pass; `requested` overrides the reviewer selection, `loadPrompts` overrides prompt loading (defaults to the shipped prompts), and `review`/`fix` are the caller-supplied review and fix callbacks.

## `reviewAndFixStrategy`

```ts
interface ReviewAndFixOptions {
  readonly requested?: readonly ReviewerId[];
  readonly loadPrompts?: () => Promise<ReviewerPrompt[]>;
  readonly review: (reviewer: ReviewerPrompt) => Promise<Result<readonly ReviewIssue[], RuntimeError>>;
  readonly fix: (issues: readonly ReviewIssue[]) => Promise<Result<void, RuntimeError>>;
  readonly parallel?: boolean;
}

async function reviewAndFixStrategy(
  options: ReviewAndFixOptions,
): Promise<Result<ReviewLoopSummary, RuntimeError>>;
```

The review-and-fix `.until()` strategy runs over loop execution: one review pass collects issues, then the loop execution interface drives the fixable-issue count to zero. A two-phase state runs reviewers exactly once and applies the fix at most once. `fixLoop` remains public for direct convergence callers and delegates its generic recurrence through the same loop execution path.

### Result shapes

```ts
interface ReviewIssue {
  readonly reviewer: ReviewerId;
  readonly message: string;
  readonly fixable: boolean;
}

interface ReviewLoopSummary {
  readonly selected: readonly ReviewerId[];
  readonly issues: readonly ReviewIssue[];
  readonly fixed: boolean;
  readonly events: readonly string[];
}
```

`fixed` is `true` when a fix was applied; `issues` is the de-duplicated issue list (`reviewer::message` keyed). `selected` is the reviewer set that actually ran.

## `fixLoop`

`fixLoop` is the generic convergence primitive: iterate `evaluate → action → fix` until the state converges or a guard fires. It has two overloads.

**Generic-state overload** (kept for direct callers and implemented over loop execution):

```ts
function fixLoop<State, Action extends FixLoopAction = FixLoopAction>(
  options: GenericFixLoopOptions<State, Action>,
): Promise<Result<GenericFixLoopSummary<State>, RuntimeError>>;
```

**Issue-list overload** (kept for direct review callers):

```ts
function fixLoop<I extends { readonly fixable: boolean }>(
  evaluate: () => Promise<Result<readonly I[], RuntimeError>>,
  fix: (issues: readonly I[]) => Promise<FixLoopFixOutcome>,
  options?: number | FixLoopOptions<I>,
): Promise<Result<FixLoopSummary<I>, RuntimeError>>;
```

The third argument accepts a bare iteration count for backward compatibility or a full `FixLoopOptions<I>` (`maxIterations`, `wallClockMs`, `tokenBudget`, `stalled`, `fingerprint`, `now`). The action fingerprint guard hashes `{identity, inputs}` over a sliding window, so repeated commands and A→B→A oscillation trip the same `stuck` guard.

`FixLoopSummary<I>` carries `iterations`, `ignoredIssues`, `converged`, `stop` (a `FixLoopStop` reason), `events`, and optional `tokenUsage`. The `stop` reason aligns with the loop stop reasons in [loops](loops.md).

## Deprecated: `runReviewAndFixLoop`

```ts
function runReviewAndFixLoop(
  options: ReviewAndFixOptions,
): Promise<Result<ReviewLoopSummary, RuntimeError>>;
```

`runReviewAndFixLoop` is a compatibility wrapper that delegates to `reviewAndFixStrategy` and emits a runtime `DeprecationWarning` with code `ORCA_DEP_LOOP_COLLAPSE`. Migrate to `reviewAndFixStrategy`. The `ORCA_DEP_LOOP_COLLAPSE` code is a deprecation-warning identifier (not an environment variable you set); the same code covers `implementTaskLoop` in [plans](plans.md).
