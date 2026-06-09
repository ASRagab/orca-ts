import type { Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import {
  runReviewAndFixLoop,
  type ReviewAndFixOptions,
  type ReviewLoopSummary
} from "./loop.ts";
import type { ReviewerId, ReviewerPrompt } from "./reviewers.ts";

export const DefaultReviewers = ["code-functionality", "readability", "test"] as const;

export interface ReviewTool {
  readonly reviewers: readonly ReviewerId[];
  run(options: ReviewToolRunOptions): Promise<Result<ReviewLoopSummary, RuntimeError>>;
}

export interface ReviewToolOptions {
  readonly reviewers?: readonly ReviewerId[];
}

export interface ReviewToolRunOptions {
  readonly requested?: readonly ReviewerId[];
  readonly loadPrompts?: () => Promise<ReviewerPrompt[]>;
  readonly review: ReviewAndFixOptions["review"];
  readonly fix: ReviewAndFixOptions["fix"];
}

export function createReviewTool(options: ReviewToolOptions = {}): ReviewTool {
  const reviewers = options.reviewers ?? DefaultReviewers;
  return {
    reviewers,
    async run(runOptions) {
      return await runReviewAndFixLoop({
        requested: runOptions.requested ?? reviewers,
        ...(runOptions.loadPrompts === undefined ? {} : { loadPrompts: runOptions.loadPrompts }),
        review: runOptions.review,
        fix: runOptions.fix
      });
    }
  };
}
