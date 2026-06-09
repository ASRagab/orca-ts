import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { runReviewAndFixLoop, type ReviewerPrompt } from "../src/index.ts";

describe("review and fix loop", () => {
  test("selects reviewers, collects issues, and runs fixes for fixable findings", async () => {
    const prompts: ReviewerPrompt[] = [
      { id: "code-functionality", prompt: "functionality" },
      { id: "readability", prompt: "readability" },
      { id: "test", prompt: "test" }
    ];
    const fixed: string[] = [];

    const result = await runReviewAndFixLoop({
      loadPrompts: () => Promise.resolve(prompts),
      review: (reviewer) =>
        Promise.resolve(ok([
          {
            reviewer: reviewer.id,
            message: `${reviewer.id} finding`,
            fixable: reviewer.id === "test"
          }
        ])),
      fix: (issues) => {
        fixed.push(...issues.map((issue) => issue.message));
        return Promise.resolve(ok(undefined));
      }
    });

    expect(result._unsafeUnwrap()).toEqual({
      selected: ["code-functionality", "readability", "test"],
      issues: [
        {
          reviewer: "code-functionality",
          message: "code-functionality finding",
          fixable: false
        },
        {
          reviewer: "readability",
          message: "readability finding",
          fixable: false
        },
        {
          reviewer: "test",
          message: "test finding",
          fixable: true
        }
      ],
      fixed: true,
      events: [
        "review:code-functionality:started",
        "review:code-functionality:completed",
        "review:readability:started",
        "review:readability:completed",
        "review:test:started",
        "review:test:completed",
        "fix:started",
        "fix:completed"
      ]
    });
    expect(fixed).toEqual(["test finding"]);
  });
});
