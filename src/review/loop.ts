import { err, ok, type Result } from "neverthrow";
import {
  makeFingerprintStuckDetector,
  TokenBudgetCounter,
  type FingerprintAction,
  type FingerprintDetectorOptions,
  type TokenUsageSummary,
} from "../loop/termination.ts";

import type { RuntimeError, Usage } from "../model/index.ts";
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

export interface FixLoopCycleReport {
  readonly usage?: Usage;
}

export type FixLoopFixResult = FixLoopCycleReport | undefined;
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
  const maxIterations = options.maxIterations ?? 10;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const events: string[] = [];
  const budget = new TokenBudgetCounter(options.tokenBudget);
  const fingerprintStalled = genericFingerprintDetector(options.fingerprint);
  let iterations = 0;

  for (;;) {
    events.push("evaluate:started");
    const evalResult = await options.evaluate();
    if (evalResult.isErr()) return err(evalResult.error);
    events.push("evaluate:completed");

    const state = evalResult.value;
    if (options.converged(state)) {
      return ok(genericSummary(state, iterations, "converged", events, budget));
    }

    const action = options.nextAction(state);
    if (action === undefined) {
      return ok(genericSummary(state, iterations, "unfixable", events, budget));
    }

    if (options.stalled?.(state, action) || fingerprintStalled?.({ state, action })) {
      events.push("no-progress");
      return ok(genericSummary(state, iterations, "stuck", events, budget));
    }

    if (iterations >= maxIterations) {
      return ok(genericSummary(state, iterations, "ceiling", events, budget));
    }

    if (options.wallClockMs !== undefined && now() - startedAt >= options.wallClockMs) {
      return ok(genericSummary(state, iterations, "timeout", events, budget));
    }

    events.push("fix:started");
    const fixResult = await options.fix(action, state);
    if (fixResult.isErr()) return err(fixResult.error);
    events.push("fix:completed");
    iterations++;

    const usage = usageFromFixResult(fixResult.value);
    budget.record(usage);
    if (budget.exhausted) {
      events.push("budget:exhausted");
      return ok(genericSummary(state, iterations, "budget-exhausted", events, budget));
    }
  }
}

function genericSummary<State>(
  state: State,
  iterations: number,
  stop: FixLoopStop,
  events: readonly string[],
  budget: TokenBudgetCounter,
): GenericFixLoopSummary<State> {
  return {
    iterations,
    converged: stop === "converged",
    stop,
    lastEvaluation: state,
    events,
    ...(budget.shouldReport ? { tokenUsage: budget.summary() } : {}),
  };
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

function genericFingerprintDetector<State, Action extends FixLoopAction>(
  fingerprint: GenericFixLoopOptions<State, Action>["fingerprint"],
): ((value: { readonly state: State; readonly action: Action }) => boolean) | undefined {
  if (fingerprint === false) {
    return undefined;
  }

  return makeFingerprintStuckDetector({
    project: ({ action }) => action,
    ...(fingerprint?.windowSize === undefined ? {} : { windowSize: fingerprint.windowSize }),
    ...(fingerprint?.repeatThreshold === undefined ? {} : { repeatThreshold: fingerprint.repeatThreshold }),
  });
}

function usageFromFixResult(result: unknown): Usage | undefined {
  if (typeof result !== "object" || result === null || !("usage" in result)) {
    return undefined;
  }

  const usage = result.usage;
  if (typeof usage !== "object" || usage === null || !("input" in usage) || !("output" in usage)) {
    return undefined;
  }

  const input = usage.input;
  const output = usage.output;
  const reasoning = "reasoning" in usage ? usage.reasoning : undefined;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isInteger(input) ||
    !Number.isInteger(output) ||
    (reasoning !== undefined && (typeof reasoning !== "number" || !Number.isInteger(reasoning)))
  ) {
    return undefined;
  }

  return reasoning === undefined
    ? { input, output }
    : { input, output, reasoning };
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

export async function runReviewAndFixLoop(
  options: ReviewAndFixOptions
): Promise<Result<ReviewLoopSummary, RuntimeError>> {
  const prompts = await (options.loadPrompts ?? loadReviewerPrompts)();
  const selected = selectReviewers(prompts, options.requested);
  const events: string[] = [];

  let issues: readonly ReviewIssue[];

  if (options.parallel) {
    events.push("review:parallel:started");
    const result = await runReviewersParallel(selected, options.review);
    if (result.isErr()) return err(result.error);
    issues = result.value;
    events.push("review:parallel:completed");
  } else {
    const collected: ReviewIssue[] = [];
    for (const reviewer of selected) {
      events.push(`review:${reviewer.id}:started`);
      const result = await options.review(reviewer);
      if (result.isErr()) {
        return err(result.error);
      }
      collected.push(...result.value);
      events.push(`review:${reviewer.id}:completed`);
    }
    issues = collected;
  }

  const fixable = issues.filter((issue) => issue.fixable);
  if (fixable.length === 0) {
    return ok({
      selected: selected.map((reviewer) => reviewer.id),
      issues,
      fixed: false,
      events
    });
  }

  events.push("fix:started");
  const fixed = await options.fix(fixable);
  if (fixed.isErr()) {
    return err(fixed.error);
  }
  events.push("fix:completed");

  return ok({
    selected: selected.map((reviewer) => reviewer.id),
    issues,
    fixed: true,
    events
  });
}
