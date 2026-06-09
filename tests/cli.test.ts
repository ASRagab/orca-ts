import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.ts";

describe("CLI args", () => {
  test("parses backend, script, and typecheck flags", () => {
    expect(parseCliArgs(["--backend", "claude", "--no-typecheck", "flow.ts"])).toEqual({
      backend: "claude",
      script: "flow.ts",
      skipTypecheck: true,
      help: false
    });
  });

  test("parses backend equals form", () => {
    expect(parseCliArgs(["--backend=codex", "flow.ts"])).toEqual({
      backend: "codex",
      script: "flow.ts",
      skipTypecheck: false,
      help: false
    });
  });
});
