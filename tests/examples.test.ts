import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

describe("examples", () => {
  test("ports supported non-interactive examples", async () => {
    const examples = await readdir(join(process.cwd(), "examples"));
    expect(examples.filter((name) => name.endsWith(".ts")).sort()).toEqual([
      "epic.ts",
      "implement-enhanced.ts",
      "implement.ts",
      "issue-pr-bugfix.ts",
      "issue-pr.ts",
      "loop-fanout.ts",
      "loop-gated-task.ts",
      "loop-persisted-state.ts",
      "loop-served-trigger.ts",
      "loop-single-cycle.ts",
      "multi-backend-compare.ts",
    ]);
  });

  test("does not present interactive v1 examples", async () => {
    const examples = await readdir(join(process.cwd(), "examples"));
    expect(examples.some((name) => name.includes("interactive"))).toBe(false);

    for (const name of examples.filter((entry) => entry.endsWith(".ts"))) {
      const content = await readFile(join(process.cwd(), "examples", name), "utf8");
      expect(content).not.toContain("ask_user");
      expect(content).not.toContain("Plan.interactive");
    }
  });
});
