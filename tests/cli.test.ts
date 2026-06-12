import { describe, expect, mock, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.ts";
import { runQuiet } from "../src/tools/process.ts";

describe("CLI args", () => {
  test("parses backend, script, and typecheck flags", () => {
    expect(parseCliArgs(["--backend", "claude", "--no-typecheck", "flow.ts"])).toEqual({
      backend: "claude",
      script: "flow.ts",
      skipTypecheck: true,
      help: false,
      version: false
    });
  });

  test("parses backend equals form", () => {
    expect(parseCliArgs(["--backend=codex", "flow.ts"])).toEqual({
      backend: "codex",
      script: "flow.ts",
      skipTypecheck: false,
      help: false,
      version: false
    });
  });


  test("parses version flag", () => {
    expect(parseCliArgs(["--version"])).toEqual({
      skipTypecheck: false,
      help: false,
      version: true
    });
  });
  test("bin shim invokes the CLI", async () => {
    const result = await runQuiet("bun", ["./bin/orca", "--help"], { cwd: process.cwd() });

    expect(result._unsafeUnwrap().stdout).toContain("Usage: orca");
  });

  test("bin shim prints the version", async () => {
    const result = await runQuiet("bun", ["./bin/orca", "--version"], { cwd: process.cwd() });

    expect(result._unsafeUnwrap().stdout).toStartWith("orca ");
  });

  test("help and version return before embedded fallback is loaded", async () => {
    let embeddedLoaded = false;
    await mock.module("../src/cli/embedded.ts", () => {
      embeddedLoaded = true;
      return {
        ensureOrcaResolvable: () => {
          throw new Error("embedded fallback should not load for cheap CLI paths");
        }
      };
    });

    const originalLog = console.log;
    console.log = mock(() => undefined);
    try {
      const { main } = await import("../src/cli/main.ts");
      await main(["--help"]);
      await main(["--version"]);
    } finally {
      console.log = originalLog;
    }

    expect(embeddedLoaded).toBe(false);
  });
});
