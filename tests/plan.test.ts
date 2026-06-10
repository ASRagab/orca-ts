import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { err, ok } from "neverthrow";
import { defaultPlanPath, implementTaskLoop, recoverPlan, writePlan } from "../src/index.ts";

describe("persistent plans", () => {
  test("uses .orca/plan-<hash>.md paths", () => {
    const path = defaultPlanPath("/repo", "build feature");
    expect(path.startsWith(join("/repo", ".orca", "plan-"))).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
  });

  test("writes and recovers plan content", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-plan-"));
    try {
      const written = await writePlan(root, "seed", "# Plan\n");
      expect(written.isOk()).toBe(true);
      const recovered = await recoverPlan(written._unsafeUnwrap());
      expect(recovered._unsafeUnwrap()).toBe("# Plan\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("implements tasks until the first typed failure", async () => {
    const success = await implementTaskLoop(
      [
        { id: "1", description: "one" },
        { id: "2", description: "two" }
      ],
      () => Promise.resolve(ok(undefined))
    );
    expect(success._unsafeUnwrap()).toEqual({ completed: ["1", "2"] });

    const failure = await implementTaskLoop(
      [
        { id: "1", description: "one" },
        { id: "2", description: "two" }
      ],
      (task) =>
        Promise.resolve(task.id === "2" ? err({ _tag: "NothingToCommit" }) : ok(undefined))
    );
    expect(failure.isErr()).toBe(true);
  });
});
