import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  captureDirtyBaselineSnapshot,
  resolveBaselinePolicy,
  runBaselineGate,
  type CommandTool,
  type VerificationCommand,
  type VerificationCommandResult,
} from "../src/index.ts";

type CommandHandler = (command: VerificationCommand) => VerificationCommandResult;

describe("baseline policy", () => {
  test("defaults to repair and removes --baseline args", () => {
    expect(resolveBaselinePolicy({ args: ["fix", "it"] })).toEqual({
      policy: "repair",
      args: ["fix", "it"],
      source: "default",
    });
    expect(resolveBaselinePolicy({ args: ["--baseline=strict", "fix", "it"] })).toEqual({
      policy: "strict",
      args: ["fix", "it"],
      source: "args",
    });
    expect(resolveBaselinePolicy({ args: ["--baseline", "accept-dirty"], env: { ORCA_BASELINE_POLICY: "strict" } })).toEqual({
      policy: "accept-dirty",
      args: [],
      source: "args",
    });
  });

  test("reads env policy and rejects unknown values", () => {
    expect(resolveBaselinePolicy({ env: { ORCA_BASELINE_POLICY: "strict" } }).policy).toBe("strict");
    expect(() => resolveBaselinePolicy({ args: ["--baseline=nope"] })).toThrow("Invalid baseline policy");
  });
});

describe("baseline gate", () => {
  test("repairs a red clean baseline before caller work begins", async () => {
    const calls: string[] = [];
    let gateRuns = 0;
    let repairCalls = 0;
    const commandTool = fakeCommandTool((command) => {
      calls.push(render(command));
      if (render(command) === "git status --porcelain=v1") return success(command, "");
      if (render(command) === "bun test") {
        gateRuns += 1;
        return gateRuns === 1 ? failed(command, "red") : success(command, "green");
      }
      throw new Error(`unexpected command: ${render(command)}`);
    });

    const result = await runBaselineGate({
      commands: [{ command: "bun", args: ["test"] }],
      commandTool,
      repair: (issues) => {
        repairCalls += 1;
        expect(issues[0]?.message).toContain("bun test");
        expect(calls).toEqual(["git status --porcelain=v1", "bun test"]);
        return Promise.resolve({ usage: { input: 5, output: 7 } });
      },
    });

    expect(result.status).toBe("repaired");
    expect(result.iterations).toBe(1);
    expect(result.usage).toEqual({ input: 5, output: 7 });
    expect(repairCalls).toBe(1);
    expect(calls).toEqual(["git status --porcelain=v1", "bun test", "bun test"]);
  });

  test("strict fails immediately on red baseline gates", async () => {
    let repairCalls = 0;
    const commandTool = fakeCommandTool((command) => {
      if (render(command) === "git status --porcelain=v1") return success(command, "");
      if (render(command) === "bun test") return failed(command, "red");
      throw new Error(`unexpected command: ${render(command)}`);
    });

    const error = await rejectionError(
      runBaselineGate({
        policy: "strict",
        commands: [{ command: "bun", args: ["test"] }],
        commandTool,
        repair: () => {
          repairCalls += 1;
          return Promise.resolve(undefined);
        },
      }),
    );
    expect(error.message).toContain("strict policy");
    expect(repairCalls).toBe(0);
  });

  test("repair rejects dirty worktrees before running gates", async () => {
    const calls: string[] = [];
    const commandTool = fakeCommandTool((command) => {
      calls.push(render(command));
      if (render(command) === "git status --porcelain=v1") return success(command, " M src/file.ts\n");
      throw new Error(`unexpected command: ${render(command)}`);
    });

    expect((await rejectionError(
      runBaselineGate({
        commands: [{ command: "bun", args: ["test"] }],
        commandTool,
      }),
    )).message).toContain("accept-dirty");
    expect(calls).toEqual(["git status --porcelain=v1"]);
  });

  test("accept-dirty snapshots baseline before repair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-baseline-"));
    const snapshotDir = join(dir, "snapshots");
    const calls: string[] = [];
    let snapshotExistedAtRepair = false;
    let gateRuns = 0;
    const commandTool = fakeCommandTool((command) => {
      calls.push(render(command));
      if (render(command) === "git status --porcelain=v1") return success(command, " M src/file.ts\n?? note.txt\n");
      if (render(command) === "bun test") {
        gateRuns += 1;
        return gateRuns === 1 ? failed(command, "initial red") : success(command, "green");
      }
      if (render(command) === "git diff --staged") return success(command, "staged diff");
      if (render(command) === "git diff") return success(command, "unstaged diff");
      if (render(command) === "git ls-files --others --exclude-standard") return success(command, "note.txt\n");
      throw new Error(`unexpected command: ${render(command)}`);
    });

    try {
      const result = await runBaselineGate({
        policy: "accept-dirty",
        commands: [{ command: "bun", args: ["test"] }],
        commandTool,
        snapshotDir,
        now: () => Date.UTC(2026, 6, 5, 12, 0, 0),
        repair: () => {
          snapshotExistedAtRepair = readdirSync(snapshotDir).length === 1;
          return Promise.resolve({ usage: { input: 3, output: 4, reasoning: 2 } });
        },
      });

      expect(snapshotExistedAtRepair).toBe(true);
      const snapshotPath = result.snapshotPath;
      expect(snapshotPath).toBe(join(snapshotDir, "baseline-2026-07-05T12-00-00-000Z.md"));
      expect(snapshotPath).toBeDefined();
      if (snapshotPath === undefined) throw new Error("snapshot path missing");
      expect(existsSync(snapshotPath)).toBe(true);
      const snapshot = readFileSync(snapshotPath, "utf8");
      expect(snapshot).toContain(" M src/file.ts");
      expect(snapshot).toContain("staged diff");
      expect(snapshot).toContain("unstaged diff");
      expect(snapshot).toContain("note.txt");
      expect(snapshot).toContain("initial red");
      expect(calls).toEqual([
        "git status --porcelain=v1",
        "git diff --staged",
        "git diff",
        "git ls-files --others --exclude-standard",
        "bun test",
        "bun test",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dirty snapshot captures diffs before initial gate commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orca-baseline-snapshot-order-"));
    const snapshotDir = join(dir, "snapshots");
    const calls: string[] = [];
    let gateAlreadyRan = false;
    const commandTool = fakeCommandTool((command) => {
      calls.push(render(command));
      if (render(command) === "git status --porcelain=v1") return success(command, " M src/file.ts\n");
      if (render(command) === "git diff --staged") {
        expect(gateAlreadyRan).toBe(false);
        return success(command, "pre-gate staged");
      }
      if (render(command) === "git diff") {
        expect(gateAlreadyRan).toBe(false);
        return success(command, "pre-gate unstaged");
      }
      if (render(command) === "git ls-files --others --exclude-standard") return success(command, "");
      if (render(command) === "bun test") {
        gateAlreadyRan = true;
        return failed(command, "initial red");
      }
      throw new Error(`unexpected command: ${render(command)}`);
    });

    try {
      const snapshotPath = await captureDirtyBaselineSnapshot({
        commands: [{ command: "bun", args: ["test"] }],
        commandTool,
        snapshotDir,
        now: () => Date.UTC(2026, 6, 5, 12, 0, 0),
      });

      expect(snapshotPath).toBe(join(snapshotDir, "baseline-2026-07-05T12-00-00-000Z.md"));
      expect(calls).toEqual([
        "git status --porcelain=v1",
        "git diff --staged",
        "git diff",
        "git ls-files --others --exclude-standard",
        "bun test",
      ]);
      expect(readFileSync(String(snapshotPath), "utf8")).toContain("pre-gate unstaged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records monitor outcome with usage and snapshot path", async () => {
    const outcomes: unknown[] = [];
    let gateRuns = 0;
    const commandTool = fakeCommandTool((command) => {
      if (render(command) === "git status --porcelain=v1") return success(command, " M src/file.ts\n");
      if (render(command) === "bun test") {
        gateRuns += 1;
        return gateRuns === 1 ? failed(command, "red") : success(command, "green");
      }
      if (render(command) === "git diff --staged") return success(command, "");
      if (render(command) === "git diff") return success(command, "unstaged");
      if (render(command) === "git ls-files --others --exclude-standard") return success(command, "");
      throw new Error(`unexpected command: ${render(command)}`);
    });
    const dir = mkdtempSync(join(tmpdir(), "orca-baseline-monitor-"));

    try {
      const result = await runBaselineGate({
        policy: "accept-dirty",
        commands: [{ command: "bun", args: ["test"] }],
        commandTool,
        snapshotDir: dir,
        now: () => Date.UTC(2026, 6, 5, 12, 0, 0),
        monitor: {
          stage: async (_name, fn) => fn(),
          recordOutcome: (outcome) => outcomes.push(outcome),
          recordFailure: () => undefined,
        },
        repair: () => Promise.resolve({ usage: { input: 8, output: 13 } }),
      });

      expect(outcomes).toEqual([
        expect.objectContaining({
          file: "baseline",
          verdict: "repaired",
          snapshotPath: result.snapshotPath,
          usage: { input: 8, output: 13 },
          validation: [expect.objectContaining({ command: "bun test", status: "passed" })],
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeCommandTool(handler: CommandHandler): CommandTool {
  return { run: (command) => Promise.resolve(handler(command)) };
}

function success(command: VerificationCommand, stdout: string): VerificationCommandResult {
  return {
    type: "success",
    command: render(command),
    stdout,
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  };
}

function failed(command: VerificationCommand, stderr: string): VerificationCommandResult {
  return {
    type: "failed",
    command: render(command),
    stdout: "",
    stderr,
    exitCode: 1,
    durationMs: 1,
  };
}

function render(command: VerificationCommand): string {
  return [command.command, ...(command.args ?? [])].join(" ");
}

async function rejectionError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("promise rejected with a non-Error value");
  }
  throw new Error("expected promise to reject");
}
