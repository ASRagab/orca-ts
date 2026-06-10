import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import type { ReviewerId, ReviewerPrompt } from "./reviewers.ts";
import { loadReviewerPrompts, selectReviewers } from "./reviewers.ts";

export interface FixLoopSummary {
  readonly iterations: number;
  readonly ignoredIssues: readonly ReviewIssue[];
  readonly converged: boolean;
  readonly events: readonly string[];
}

export async function fixLoop<I extends ReviewIssue>(
  evaluate: () => Promise<Result<readonly I[], RuntimeError>>,
  fix: (issues: readonly I[]) => Promise<Result<void, RuntimeError>>,
  maxIterations = 10,
): Promise<Result<FixLoopSummary, RuntimeError>> {
  const events: string[] = [];
  let iterations = 0;

  for (;;) {
    events.push("evaluate:started");
    const evalResult = await evaluate();
    if (evalResult.isErr()) return err(evalResult.error);
    events.push("evaluate:completed");

    const issues = evalResult.value;
    if (issues.length === 0) {
      return ok({ iterations, ignoredIssues: [], converged: true, events });
    }

    const fixable = issues.filter((i) => i.fixable);
    if (fixable.length === 0) {
      return ok({ iterations, ignoredIssues: [...issues], converged: false, events });
    }

    if (iterations >= maxIterations) {
      return ok({ iterations, ignoredIssues: [...issues], converged: false, events });
    }

    events.push("fix:started");
    const fixResult = await fix(fixable);
    if (fixResult.isErr()) return err(fixResult.error);
    events.push("fix:completed");
    iterations++;
  }
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
