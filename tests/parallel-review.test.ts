import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import {
  runReviewersParallel,
  runReviewAndFixLoop,
  type ReviewerPrompt,
  type ReviewIssue,
} from "../src/index.ts";

const prompt = (id: "code-functionality" | "readability" | "test"): ReviewerPrompt => ({
  id,
  prompt: `${id} prompt`,
});

const issue = (reviewer: ReviewIssue["reviewer"], message: string, fixable = true): ReviewIssue => ({
  reviewer,
  message,
  fixable,
});

describe("runReviewersParallel", () => {
  test("invokes all reviewers concurrently", async () => {
    const started: string[] = [];
    const completed: string[] = [];

    const reviewers = [prompt("code-functionality"), prompt("readability")];
    const result = await runReviewersParallel(reviewers, async (reviewer) => {
      started.push(reviewer.id);
      await new Promise((r) => setTimeout(r, reviewer.id === "code-functionality" ? 20 : 0));
      completed.push(reviewer.id);
      return ok([]);
    });

    expect(result.isOk()).toBe(true);
    // readability starts before code-functionality completes → concurrent
    expect(started).toContain("readability");
    expect(started).toContain("code-functionality");
    // code-functionality finishes last (it sleeps longer)
    expect(completed[completed.length - 1]).toBe("code-functionality");
  });

  test("flattens issues from all reviewers", async () => {
    const reviewers = [prompt("code-functionality"), prompt("readability")];
    const result = await runReviewersParallel(reviewers, (reviewer) =>
      Promise.resolve(ok([issue(reviewer.id, `${reviewer.id} finding`)]))
    );
    const issues = result._unsafeUnwrap();
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.reviewer)).toContain("code-functionality");
    expect(issues.map((i) => i.reviewer)).toContain("readability");
  });

  test("deduplicates issues by (reviewer, message)", async () => {
    const reviewers = [prompt("code-functionality"), prompt("readability")];
    const result = await runReviewersParallel(reviewers, (reviewer) =>
      Promise.resolve(ok([
        issue(reviewer.id, "duplicate finding"),
        issue(reviewer.id, "duplicate finding"),
        issue(reviewer.id, "unique finding"),
      ]))
    );
    const issues = result._unsafeUnwrap();
    const cfIssues = issues.filter((i) => i.reviewer === "code-functionality");
    expect(cfIssues).toHaveLength(2); // "duplicate finding" deduped to 1, "unique finding" = 1
    expect(cfIssues.map((i) => i.message)).toContain("duplicate finding");
    expect(cfIssues.map((i) => i.message)).toContain("unique finding");
  });

  test("same message from different reviewers is not deduplicated", async () => {
    const reviewers = [prompt("code-functionality"), prompt("readability")];
    const result = await runReviewersParallel(reviewers, (reviewer) =>
      Promise.resolve(ok([issue(reviewer.id, "same finding")]))
    );
    const issues = result._unsafeUnwrap();
    expect(issues).toHaveLength(2); // different reviewer IDs → different keys
  });

  test("propagates first error - all reviewers still ran", async () => {
    const ran: string[] = [];
    const error = { _tag: "CommandFailed" as const, command: "review", exitCode: 1, stdout: "", stderr: "fail" };
    const reviewers = [prompt("code-functionality"), prompt("readability")];
    const result = await runReviewersParallel(reviewers, (reviewer) => {
      ran.push(reviewer.id);
      return reviewer.id === "code-functionality"
        ? Promise.resolve(err(error))
        : Promise.resolve(ok([]));
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()._tag).toBe("CommandFailed");
    // both reviewers ran (Promise.all doesn't cancel)
    expect(ran).toHaveLength(2);
    expect(ran).toContain("code-functionality");
    expect(ran).toContain("readability");
  });
});

describe("runReviewAndFixLoop with parallel option", () => {
  const prompts: ReviewerPrompt[] = [
    prompt("code-functionality"),
    prompt("readability"),
    prompt("test"),
  ];

  test("parallel: true uses concurrent reviewer dispatch", async () => {
    const started: string[] = [];
    const result = await runReviewAndFixLoop({
      loadPrompts: () => Promise.resolve(prompts),
      parallel: true,
      review: async (reviewer) => {
        started.push(reviewer.id);
        await new Promise((r) => setTimeout(r, reviewer.id === "code-functionality" ? 15 : 0));
        return ok([]);
      },
      fix: () => Promise.resolve(ok(undefined)),
    });
    expect(result.isOk()).toBe(true);
    // all three start before the slow one finishes
    expect(started).toHaveLength(3);
    expect(result._unsafeUnwrap().events).toEqual([
      "review:parallel:started",
      "review:parallel:completed",
    ]);
  });

  test("parallel: false (default) runs sequentially", async () => {
    const result = await runReviewAndFixLoop({
      loadPrompts: () => Promise.resolve(prompts),
      review: (reviewer) => Promise.resolve(ok([issue(reviewer.id, `${reviewer.id} issue`)])),
      fix: () => Promise.resolve(ok(undefined)),
    });
    const events = result._unsafeUnwrap().events;
    expect(events[0]).toBe("review:code-functionality:started");
    expect(events[1]).toBe("review:code-functionality:completed");
    expect(events[2]).toBe("review:readability:started");
  });

  test("parallel mode collects and fixes issues from all reviewers", async () => {
    const fixed: ReviewIssue[] = [];
    const result = await runReviewAndFixLoop({
      loadPrompts: () => Promise.resolve(prompts),
      parallel: true,
      review: (reviewer) =>
        Promise.resolve(ok([issue(reviewer.id, `${reviewer.id} issue`, true)])),
      fix: (issues) => {
        fixed.push(...issues);
        return Promise.resolve(ok(undefined));
      },
    });
    expect(result._unsafeUnwrap().fixed).toBe(true);
    expect(fixed).toHaveLength(3);
  });
});
