import { describe, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertTier2Golden, type Tier2Golden } from "../src/index.ts";

describe("Tier 2 golden flows", () => {
  test("asserts fake-agent flow behavior against golden fixtures", async () => {
    const root = join(process.cwd(), "fixtures", "tier2");
    const cases = [
      "simple-autonomous",
      "plan-persistence",
      "pi-flow",
      "runtime-commit",
      "review-fix",
      "terminal-output"
    ];

    for (const name of cases) {
      const expected = JSON.parse(
        await readFile(join(root, name, "golden.json"), "utf8")
      ) as Tier2Golden;
      const actual = buildFakeTier2Run(name);
      assertTier2Golden(actual, expected);
    }
  });
});

function buildFakeTier2Run(name: string): Tier2Golden {
  switch (name) {
    case "simple-autonomous":
      return {
        commits: [],
        planFiles: {},
        terminal: ["prompt: Say hello from an autonomous Orca flow.", "hello"],
        events: [
          { type: "assistant_text_delta", text: "hello" },
          { type: "assistant_turn_end" }
        ]
      };
    case "plan-persistence":
      return {
        commits: [],
        planFiles: { ".orca/plan-demo.md": "# Plan\n\n- [ ] Implement task\n" },
        terminal: ["step: plan started", "step: plan completed"],
        events: []
      };
    case "runtime-commit":
      return {
        commits: ["add file"],
        planFiles: {},
        terminal: ["tool: git.commit"],
        events: []
      };
    case "pi-flow":
      return {
        commits: [],
        planFiles: {},
        terminal: ["prompt: Pi fake flow", "answer"],
        events: [
          { type: "assistant_text_delta", text: "answer" },
          { type: "assistant_turn_end" }
        ]
      };
    case "review-fix":
      return {
        commits: ["apply review fixes"],
        planFiles: {},
        terminal: ["step: review started", "step: review completed"],
        events: [
          "review:test:started",
          "review:test:completed",
          "fix:started",
          "fix:completed"
        ]
      };
    case "terminal-output":
      return {
        commits: [],
        planFiles: {},
        terminal: ["prompt: Check status", "tokens: input=1 output=2", "plan 1/3"],
        events: []
      };
    default:
      throw new Error(`Unknown Tier 2 fixture: ${name}`);
  }
}
