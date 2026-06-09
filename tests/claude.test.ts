import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectClaudeStreamJson } from "../src/index.ts";

describe("Claude stream-json Tier 1 fixtures", () => {
  test("maps scripted streams to canonical events and outcomes", async () => {
    const root = join(process.cwd(), "fixtures", "tier1", "claude");
    const cases = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(cases).toEqual([
      "result-error-after-delta",
      "text-delta-success",
      "tool-use-full-turn-success"
    ]);

    for (const name of cases) {
      const dir = join(root, name);
      const input = (await readFile(join(dir, "input.jsonl"), "utf8"))
        .trim()
        .split("\n");
      const expectedEvents = JSON.parse(await readFile(join(dir, "events.json"), "utf8")) as unknown;
      const expectedOutcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as unknown;

      const actual = await collectClaudeStreamJson(input);
      expect(actual.events as unknown).toEqual(expectedEvents);
      expect(actual.outcome as unknown).toEqual(expectedOutcome);
    }
  });
});
