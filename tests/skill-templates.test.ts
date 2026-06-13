import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runQuiet } from "../src/tools/process.ts";

// Keeps the bundled skill flow templates from drifting out of the runtime API:
// every template under skills/**/assets/templates/ must typecheck against the
// in-repo orca-ts (resolved via package self-reference in
// tsconfig.skill-templates.json). Mirrors the Scala orca-flow recipes test.

const TEMPLATES_DIR = "skills/_shared/assets/templates";
const EXPECTED_ARCHETYPES = [
  "single-change",
  "persistent-multitask",
  "issue-to-pr",
  "bugfix",
  "cleanup-sweep",
  "multi-backend-compare",
] as const;

describe("skill flow templates", () => {
  test("one template exists per archetype", () => {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".ts"));
    for (const archetype of EXPECTED_ARCHETYPES) {
      expect(files).toContain(`${archetype}.ts`);
    }
  });

  test("all templates typecheck against orca-ts", async () => {
    const tsc = join("node_modules", ".bin", "tsc");
    const result = await runQuiet(tsc, ["--noEmit", "-p", "tsconfig.skill-templates.json"]);
    if (result.isErr()) {
      const error = result.error;
      const detail =
        error._tag === "CommandFailed" ? `${error.stdout}\n${error.stderr}` : JSON.stringify(error);
      throw new Error(`skill templates failed typecheck:\n${detail}`);
    }
    expect(result.value.exitCode).toBe(0);
  }, 120_000);
});
