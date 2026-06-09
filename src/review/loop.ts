import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import type { ReviewerId, ReviewerPrompt } from "./reviewers.ts";
import { loadReviewerPrompts, selectReviewers } from "./reviewers.ts";

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

export interface ReviewAndFixOptions {
  readonly requested?: readonly ReviewerId[];
  readonly loadPrompts?: () => Promise<ReviewerPrompt[]>;
  readonly review: (reviewer: ReviewerPrompt) => Promise<Result<readonly ReviewIssue[], RuntimeError>>;
  readonly fix: (issues: readonly ReviewIssue[]) => Promise<Result<void, RuntimeError>>;
}

export async function runReviewAndFixLoop(
  options: ReviewAndFixOptions
): Promise<Result<ReviewLoopSummary, RuntimeError>> {
  const prompts = await (options.loadPrompts ?? loadReviewerPrompts)();
  const selected = selectReviewers(prompts, options.requested);
  const issues: ReviewIssue[] = [];
  const events: string[] = [];

  for (const reviewer of selected) {
    events.push(`review:${reviewer.id}:started`);
    const result = await options.review(reviewer);
    if (result.isErr()) {
      return err(result.error);
    }
    issues.push(...result.value);
    events.push(`review:${reviewer.id}:completed`);
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
