import { err, ok, type Result } from "neverthrow";
import {
  makeFingerprintStuckDetector,
  type FingerprintAction,
  type FingerprintDetectorOptions,
  type TokenUsageSummary,
} from "../loop/termination.ts";
import { executeLoop, type LoopExecutionStop } from "../loop/execution.ts";

import type { RuntimeError } from "../model/index.ts";
import type { ReviewerId, ReviewerPrompt } from "./reviewers.ts";
import { loadReviewerPrompts, selectReviewers } from "./reviewers.ts";

export type {
  FingerprintAction,
  FingerprintDetectorOptions,
  TokenUsageSummary,
} from "../loop/termination.ts";

/** Why the loop stopped. `converged` is the only success; the rest are
 * non-convergence reasons that map onto a `regressed` verdict. */
export type FixLoopStop = "converged" | "unfixable" | "stuck" | "timeout" | "ceiling" | "budget-exhausted";

export type FixLoopFixOutcome = Result<unknown, RuntimeError>;

export interface FixLoopSummary<I extends { readonly fixable: boolean } = ReviewIssue> {
  readonly iterations: number;
  readonly ignoredIssues: readonly I[];
  readonly converged: boolean;
  readonly stop: FixLoopStop;
  readonly events: readonly string[];
  readonly tokenUsage?: TokenUsageSummary;
}

export type IssueFingerprint<I extends { readonly fixable: boolean }> =
  | ((issues: readonly I[]) => FingerprintAction | undefined)
  | (Omit<FingerprintDetectorOptions<readonly I[]>, "project"> & {
      readonly project: (issues: readonly I[]) => FingerprintAction | undefined;
    });

export interface FixLoopOptions<I extends { readonly fixable: boolean }> {
  /** High sanity ceiling on fix iterations — a seatbelt, not the policy. */
  readonly maxIterations?: number;
  /** Wall-clock backstop in ms across the whole loop. */
  readonly wallClockMs?: number;
  /** Optional token budget across fix cycles that report backend usage. */
  readonly tokenBudget?: number;
  /** Stateful no-progress detector, owned by the caller. Called with the
   * current round's issues before each fix; returning `true` stops the loop as
   * `stuck`. Preserved for callers that already own their signature state. */
  readonly stalled?: (issues: readonly I[]) => boolean;
  /** Configured issue-list projection into the shared fingerprint primitive. */
  readonly fingerprint?: IssueFingerprint<I>;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

export type FixLoopAction = FingerprintAction;

export interface GenericFixLoopSummary<State> {
  readonly iterations: number;
  readonly converged: boolean;
  readonly stop: FixLoopStop;
  readonly lastEvaluation: State;
  readonly events: readonly string[];
  readonly tokenUsage?: TokenUsageSummary;
}

export interface GenericFixLoopOptions<State, Action extends FixLoopAction = FixLoopAction> {
  readonly evaluate: () => Promise<Result<State, RuntimeError>>;
  readonly converged: (state: State) => boolean;
  readonly nextAction: (state: State) => Action | undefined;
  readonly fix: (action: Action, state: State) => Promise<FixLoopFixOutcome>;
  /** High sanity ceiling on fix iterations — a seatbelt, not the policy. */
  readonly maxIterations?: number;
  /** Wall-clock backstop in ms across the whole loop. */
  readonly wallClockMs?: number;
  /** Optional token budget across fix cycles that report backend usage. */
  readonly tokenBudget?: number;
  /** Additional caller-owned stop predicate. The built-in fingerprint guard is
   * still the default stuck detector for generic actions. */
  readonly stalled?: (state: State, action: Action) => boolean;
  /** Generic actions are fingerprinted by `{identity, inputs}` by default. */
  readonly fingerprint?: false | Omit<FingerprintDetectorOptions<{ readonly state: State; readonly action: Action }>, "project">;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number;
}

interface IssueFixAction<I extends { readonly fixable: boolean }> extends FixLoopAction {
  readonly fixable: readonly I[];
}

/** Generic convergence primitive: iterate `evaluate → action → fix` until the
 * state converges or one guard fires. The action fingerprint guard hashes
 * `{identity, inputs}` over a sliding window, so repeated commands and A→B→A
 * oscillation use the same primitive. */
export function fixLoop<State, Action extends FixLoopAction = FixLoopAction>(
  options: GenericFixLoopOptions<State, Action>
): Promise<Result<GenericFixLoopSummary<State>, RuntimeError>>;

/** Issue-list overload kept for current review callers. The third argument
 * accepts a bare iteration count for backward compatibility or a full
 * {@link FixLoopOptions}. */
export function fixLoop<I extends { readonly fixable: boolean }>(
  evaluate: () => Promise<Result<readonly I[], RuntimeError>>,
  fix: (issues: readonly I[]) => Promise<FixLoopFixOutcome>,
  options?: number | FixLoopOptions<I>,
): Promise<Result<FixLoopSummary<I>, RuntimeError>>;

export async function fixLoop<State, Action extends FixLoopAction, I extends { readonly fixable: boolean }>(
  first: GenericFixLoopOptions<State, Action> | (() => Promise<Result<readonly I[], RuntimeError>>),
  second?: (issues: readonly I[]) => Promise<FixLoopFixOutcome>,
  options: number | FixLoopOptions<I> = {},
): Promise<Result<GenericFixLoopSummary<State> | FixLoopSummary<I>, RuntimeError>> {
  if (typeof first !== "function") {
    return runGenericFixLoop(first);
  }

  if (second === undefined) {
    throw new TypeError("fixLoop issue-list overload requires a fix function");
  }

  return runIssueFixLoop(first, second, options);
}

async function runIssueFixLoop<I extends { readonly fixable: boolean }>(
  evaluate: () => Promise<Result<readonly I[], RuntimeError>>,
  fix: (issues: readonly I[]) => Promise<FixLoopFixOutcome>,
  options: number | FixLoopOptions<I>,
): Promise<Result<FixLoopSummary<I>, RuntimeError>> {
  const opts = typeof options === "number" ? { maxIterations: options } : options;
  const fingerprintStalled = issueFingerprintDetector(opts.fingerprint);
  const loop = await runGenericFixLoop<readonly I[], IssueFixAction<I>>({
    evaluate,
    converged: (issues) => issues.length === 0,
    nextAction: (issues) => {
      const fixable = issues.filter((issue) => issue.fixable);
      if (fixable.length === 0) {
        return undefined;
      }
      return { identity: "fix-issues", inputs: fixable, fixable };
    },
    fix: (action) => fix(action.fixable),
    ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
    ...(opts.wallClockMs === undefined ? {} : { wallClockMs: opts.wallClockMs }),
    ...(opts.tokenBudget === undefined ? {} : { tokenBudget: opts.tokenBudget }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    fingerprint: false,
    stalled: (issues) => Boolean(opts.stalled?.(issues) || fingerprintStalled?.(issues)),
  });

  if (loop.isErr()) {
    return err(loop.error);
  }

  const summary = loop.value;
  return ok({
    iterations: summary.iterations,
    ignoredIssues: summary.converged ? [] : [...summary.lastEvaluation],
    converged: summary.converged,
    stop: summary.stop,
    events: summary.events,
    ...(summary.tokenUsage === undefined ? {} : { tokenUsage: summary.tokenUsage }),
  });
}

async function runGenericFixLoop<State, Action extends FixLoopAction>(
  options: GenericFixLoopOptions<State, Action>
): Promise<Result<GenericFixLoopSummary<State>, RuntimeError>> {
  const loop = await executeLoop<State, Action>({
    evaluate: options.evaluate,
    converged: options.converged,
    nextAction: options.nextAction,
    execute: (action, state) => options.fix(action, state),
    maxIterations: options.maxIterations ?? 10,
    ...(options.wallClockMs === undefined ? {} : { wallClockMs: options.wallClockMs }),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.stalled === undefined ? {} : { stalled: options.stalled }),
    fingerprint: options.fingerprint ?? {},
  });

  if (loop.isErr()) {
    return err(loop.error);
  }
  const summary = loop.value;
  return ok({
    iterations: summary.iterations,
    converged: summary.converged,
    stop: toFixLoopStop(summary.stop),
    lastEvaluation: summary.lastEvaluation,
    events: summary.events,
    ...(summary.tokenUsage === undefined ? {} : { tokenUsage: summary.tokenUsage }),
  });
}

function issueFingerprintDetector<I extends { readonly fixable: boolean }>(
  fingerprint: IssueFingerprint<I> | undefined,
): ((issues: readonly I[]) => boolean) | undefined {
  if (fingerprint === undefined) {
    return undefined;
  }

  if (typeof fingerprint === "function") {
    return makeFingerprintStuckDetector({ project: fingerprint });
  }

  return makeFingerprintStuckDetector({
    project: fingerprint.project,
    ...(fingerprint.windowSize === undefined ? {} : { windowSize: fingerprint.windowSize }),
    ...(fingerprint.repeatThreshold === undefined ? {} : { repeatThreshold: fingerprint.repeatThreshold }),
  });
}

function toFixLoopStop(stop: LoopExecutionStop): FixLoopStop {
  if (stop === "cancelled") {
    return "timeout";
  }
  return stop;
}

export interface ReviewIssue {
  readonly reviewer: ReviewerId;
  readonly message: string;
  readonly fixable: boolean;
}

export interface ReviewTurn {
  readonly reviewer: ReviewerId;
  readonly issues: readonly ReviewIssue[];
}

export interface ReviewLoopSummary {
  readonly selected: readonly ReviewerId[];
  readonly issues: readonly ReviewIssue[];
  readonly fixed: boolean;
  readonly events: readonly string[];
}

export async function runReviewersParallel<I extends ReviewIssue>(
  reviewers: readonly ReviewerPrompt[],
  review: (reviewer: ReviewerPrompt) => Promise<Result<readonly I[], RuntimeError>>,
): Promise<Result<readonly I[], RuntimeError>> {
  const results = await Promise.all(reviewers.map((r) => review(r)));
  const issues: I[] = [];
  for (const result of results) {
    if (result.isErr()) return err(result.error);
    issues.push(...result.value);
  }
  const seen = new Set<string>();
  return ok(
    issues.filter((issue) => {
      const key = `${issue.reviewer}::${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export interface ReviewAndFixOptions {
  readonly requested?: readonly ReviewerId[];
  readonly loadPrompts?: () => Promise<ReviewerPrompt[]>;
  readonly review: (reviewer: ReviewerPrompt) => Promise<Result<readonly ReviewIssue[], RuntimeError>>;
  readonly fix: (issues: readonly ReviewIssue[]) => Promise<Result<void, RuntimeError>>;
  readonly parallel?: boolean;
}

/** Review-and-fix `.until()` strategy over loop execution (design D7):
 * one review pass collects issues, then loop execution drives the fixable-issue count
 * to zero. A two-phase state runs reviewers exactly once and applies the fix at
 * most once, reproducing the single-pass review/fix behavior. */
export async function reviewAndFixStrategy(
  options: ReviewAndFixOptions
): Promise<Result<ReviewLoopSummary, RuntimeError>> {
  const prompts = await (options.loadPrompts ?? loadReviewerPrompts)();
  const selected = selectReviewers(prompts, options.requested);
  const events: string[] = [];

  let issues: readonly ReviewIssue[] = [];
  let fixable: readonly ReviewIssue[] = [];
  let phase: "review" | "fixed" = "review";
  let fixed = false;

  const loop = await executeLoop<{ readonly fixableRemaining: number }>({
    evaluate: async () => {
      if (phase === "review") {
        const reviewed = await runReviewPhase(selected, options, events);
        if (reviewed.isErr()) return err(reviewed.error);
        issues = reviewed.value;
        fixable = issues.filter((issue) => issue.fixable);
      }
      return ok({ fixableRemaining: phase === "review" ? fixable.length : 0 });
    },
    converged: (state) => state.fixableRemaining === 0,
    nextAction: (state) => (state.fixableRemaining === 0 ? undefined : REVIEW_FIX_ACTION),
    execute: async () => {
      events.push("fix:started");
      const result = await options.fix(fixable);
      if (result.isErr()) return err(result.error);
      events.push("fix:completed");
      fixed = true;
      phase = "fixed";
      return ok({});
    },
    fingerprint: false,
    maxIterations: 1,
  });

  if (loop.isErr()) {
    return err(loop.error);
  }

  return ok({
    selected: selected.map((reviewer) => reviewer.id),
    issues,
    fixed,
    events,
  });
}

const REVIEW_FIX_ACTION: FixLoopAction = { identity: "review-fix", inputs: null };

/** One review pass — parallel dispatch or sequential per-reviewer — recording the
 * same domain events the loop has always emitted. */
async function runReviewPhase(
  selected: readonly ReviewerPrompt[],
  options: ReviewAndFixOptions,
  events: string[]
): Promise<Result<readonly ReviewIssue[], RuntimeError>> {
  if (options.parallel) {
    events.push("review:parallel:started");
    const result = await runReviewersParallel(selected, options.review);
    if (result.isErr()) return err(result.error);
    events.push("review:parallel:completed");
    return ok(result.value);
  }

  const collected: ReviewIssue[] = [];
  for (const reviewer of selected) {
    events.push(`review:${reviewer.id}:started`);
    const result = await options.review(reviewer);
    if (result.isErr()) return err(result.error);
    collected.push(...result.value);
    events.push(`review:${reviewer.id}:completed`);
  }
  return ok(collected);
}

/** Deprecated compatibility wrapper kept for one release (design D7): delegates to
 * `reviewAndFixStrategy` and emits a runtime DeprecationWarning. Not tagged
 * `@deprecated` so existing callers still using it for this release stay lint-clean. */
export function runReviewAndFixLoop(
  options: ReviewAndFixOptions
): Promise<Result<ReviewLoopSummary, RuntimeError>> {
  emitDeprecation("runReviewAndFixLoop", "reviewAndFixStrategy");
  return reviewAndFixStrategy(options);
}

function emitDeprecation(name: string, replacement: string): void {
  process.emitWarning(
    `${name}() is deprecated and will be removed in a future release; migrate to ${replacement}().`,
    { type: "DeprecationWarning", code: "ORCA_DEP_LOOP_COLLAPSE" }
  );
}
