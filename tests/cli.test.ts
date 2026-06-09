import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.ts";
import { runQuiet } from "../src/tools/process.ts";

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

  test("bin shim invokes the CLI", async () => {
    const result = await runQuiet("bun", ["./bin/orca", "--help"], { cwd: process.cwd() });

    expect(result._unsafeUnwrap().stdout).toContain("Usage: orca");
  });
});
