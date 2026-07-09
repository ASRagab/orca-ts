import { describe, expect, mock, test } from "bun:test";
import { parseCliArgs } from "../src/cli/args.ts";
import { extractFlowArgs, flowArgs } from "../src/flow/args.ts";
import { runQuiet } from "../src/tools/process.ts";

describe("CLI args", () => {
  test("parses backend, script, and typecheck flags", () => {
    expect(parseCliArgs(["--backend", "claude", "--no-typecheck", "flow.ts"])).toEqual({
      backend: "claude",
      script: "flow.ts",
      skipTypecheck: true,
      help: false,
      version: false,
      flowArgs: []
    });
  });

  test("parses backend equals form", () => {
    expect(parseCliArgs(["--backend=codex", "flow.ts"])).toEqual({
      backend: "codex",
      script: "flow.ts",
      skipTypecheck: false,
      help: false,
      version: false,
      flowArgs: []
    });
  });


  test("parses version flag", () => {
    expect(parseCliArgs(["--version"])).toEqual({
      skipTypecheck: false,
      help: false,
      version: true,
      flowArgs: []
    });
  });

  test("captures task tokens after -- as flowArgs", () => {
    expect(parseCliArgs(["flow.ts", "--backend", "codex", "--", "fix", "the", "bug"])).toEqual({
      script: "flow.ts",
      backend: "codex",
      skipTypecheck: false,
      help: false,
      version: false,
      flowArgs: ["fix", "the", "bug"]
    });
  });
  test("bin shim invokes the CLI", async () => {
    const result = await runQuiet("bun", ["./bin/orcats", "--help"], { cwd: process.cwd() });

    expect(result._unsafeUnwrap().stdout).toContain("Usage: orcats");
  });

  test("bin shim prints the version", async () => {
    const result = await runQuiet("bun", ["./bin/orcats", "--version"], { cwd: process.cwd() });

    expect(result._unsafeUnwrap().stdout).toStartWith("orcats ");
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

describe("flow args", () => {
  test("extractFlowArgs returns tokens after the -- separator", () => {
    expect(extractFlowArgs(["foo.ts", "--backend", "codex", "--", "fix", "the", "bug"])).toEqual([
      "fix",
      "the",
      "bug"
    ]);
  });

  test("extractFlowArgs is empty when no -- separator is present", () => {
    expect(extractFlowArgs(["foo.ts", "--backend", "codex"])).toEqual([]);
  });

  test("flowArgs prefers the ORCA_FLOW_ARGS env channel", () => {
    const previous = process.env.ORCA_FLOW_ARGS;
    process.env.ORCA_FLOW_ARGS = JSON.stringify(["alpha", "beta"]);
    try {
      expect(flowArgs()).toEqual(["alpha", "beta"]);
    } finally {
      if (previous === undefined) delete process.env.ORCA_FLOW_ARGS;
      else process.env.ORCA_FLOW_ARGS = previous;
    }
  });

  test("flowArgs falls back to argv when the env channel is unset", () => {
    const previousEnv = process.env.ORCA_FLOW_ARGS;
    const previousArgv = process.argv;
    delete process.env.ORCA_FLOW_ARGS;
    process.argv = ["bun", "flow.ts", "--", "x", "y"];
    try {
      expect(flowArgs()).toEqual(["x", "y"]);
    } finally {
      process.argv = previousArgv;
      if (previousEnv !== undefined) process.env.ORCA_FLOW_ARGS = previousEnv;
    }
  });
});
