import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReviewerPrompts, ReviewerIds, selectReviewers } from "../src/index.ts";

describe("reviewer prompts", () => {
  test("loads the canonical roster in Scala order", async () => {
    const prompts = await loadReviewerPrompts();
    expect(prompts.map((prompt) => prompt.id)).toEqual([...ReviewerIds]);
    expect(selectReviewers(prompts).map((prompt) => prompt.id)).toEqual([
      "code-functionality",
      "readability",
      "test"
    ]);
  });

  test("byte-matches the Scala reviewer prompts", async () => {
    const scalaRoot = join(
      process.cwd(),
      "..",
      "orca",
      "flow",
      "src",
      "main",
      "resources",
      "orca",
      "review",
      "prompts",
      "reviewers"
    );
    const tsRoot = join(process.cwd(), "src", "review", "prompts", "reviewers");
    const firstScalaPrompt = join(scalaRoot, `${ReviewerIds[0]}.md`);

    if (!existsSync(firstScalaPrompt)) {
      console.warn(`Skipping Scala prompt byte-match; missing ${firstScalaPrompt}`);
      return;
    }

    for (const id of ReviewerIds) {
      const scala = await readFile(join(scalaRoot, `${id}.md`), "utf8");
      const ts = await readFile(join(tsRoot, `${id}.md`), "utf8");
      expect(ts).toBe(scala);
    }
  });
});
