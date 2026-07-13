import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  expectExitZero,
  expectNoOrcaDiagnosticsOnStdout,
  expectOrderedStderr,
  expectProcessExited,
  expectStderrContainsDiagnostics,
  formatCliProcessEvidence,
  runCliProcess,
} from "./helpers/cli-process.ts";

const repoRoot = process.cwd();
const apiPath = join(repoRoot, "src", "index.ts");
const repoHealthLoopPath = join(repoRoot, "tests", "fixtures", "repo-health-loop.ts");

async function createDisposableTargetRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-output-target-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "orca-output-target",
        private: true,
        scripts: {
          typecheck: "bun --version",
          test: "bun --version",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, "index.ts"), "export const ok = true;\n");

  expectExitZero(await runCliProcess("git", ["init", "-q"], { cwd: root }));
  expectExitZero(await runCliProcess("git", ["config", "user.email", "orca@example.test"], { cwd: root }));
  expectExitZero(await runCliProcess("git", ["config", "user.name", "Orca Test"], { cwd: root }));
  expectExitZero(await runCliProcess("git", ["add", "."], { cwd: root }));
  expectExitZero(await runCliProcess("git", ["commit", "-qm", "initial"], { cwd: root }));

  return root;
}

async function gitStatus(root: string): Promise<string> {
  const status = await runCliProcess("git", ["status", "--short"], { cwd: root });
  expectExitZero(status);
  return status.stdout;
}

async function runCliWithThrownValue(expression: string) {
  const root = await mkdtemp(join(tmpdir(), "orca-output-thrown-value-"));
  const flowPath = join(root, "failing-flow.ts");
  await writeFile(flowPath, `throw ${expression};\n`);

  try {
    return await runCliProcess("bun", ["./bin/orcats", "--no-typecheck", flowPath], {
      cwd: repoRoot,
      timeoutMs: 5_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectFailedRunDiagnosticContains(
  result: Awaited<ReturnType<typeof runCliWithThrownValue>>,
  expectedError: string,
): void {
  expect(result.exitCode).not.toBe(0);
  const diagnostic = result.stderr
    .split("\n")
    .find((line) => line.startsWith("orcats | failed:"));
  if (diagnostic === undefined || !diagnostic.includes(expectedError)) {
    throw new Error(
      `Expected stderr failed-run diagnostic to contain an error value such as "${expectedError}", but the emitted diagnostic omits the error field/value.\n${formatCliProcessEvidence(result)}`,
    );
  }
}

test("control cli-thrown-undefined-diagnostic", async () => {
  const result = await runCliWithThrownValue('new Error("boom")');

  expectFailedRunDiagnosticContains(result, "boom");
});

test("cli reports the error value when a flow throws undefined", async () => {
  const result = await runCliWithThrownValue("undefined");

  expectFailedRunDiagnosticContains(result, "undefined");
});

describe("CLI run-output validation", () => {
  test("process harness exposes captured evidence for failing commands", async () => {
    const result = await runCliProcess("bun", [
      "-e",
      "console.log('payload'); console.error('diagnostic'); process.exit(7);",
    ]);

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("payload\n");
    expect(result.stderr).toBe("diagnostic\n");
    expect(result.signal).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(() => {
      expectExitZero(result);
    }).toThrow(/exitCode: 7/);
    expect(formatCliProcessEvidence(result)).toContain("stdout:\npayload");
    expect(formatCliProcessEvidence(result)).toContain("stderr:\ndiagnostic");
  });

  test("process harness times out, escalates, and leaves no process running", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-output-hung-"));
    const flowPath = join(root, "hung-flow.ts");
    await writeFile(
      flowPath,
      `process.on("SIGTERM", () => {});
await new Promise(() => undefined);
`,
    );

    try {
      const result = await runCliProcess("bun", ["./bin/orcats", "--no-typecheck", flowPath], {
        cwd: repoRoot,
        forceKillAfterMs: 50,
        timeoutMs: 500,
      });

      expect(result.timedOut).toBe(true);
      expect(result.forceKilled).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expectProcessExited(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("orcats run separates stdout payloads from stderr diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-output-run-"));
    const loopPath = join(root, "stdout-loop.ts");
    await writeFile(
      loopPath,
      `import { defineLoop, loop, manual, stdout } from ${JSON.stringify(apiPath)};

export default defineLoop({
  name: "stdout-loop",
  source: manual(),
  sink: stdout(),
  async onTrigger() {
    const result = await loop("stdout-loop")
      .step("finish", () => 0)
      .measure((state) => state)
      .run(1);
    return result.map((outcome) => ({ outcome, output: "payload" }));
  },
});
`,
    );

    try {
      const result = await runCliProcess("bun", ["./bin/orcats", "run", "--no-typecheck", loopPath], {
        cwd: repoRoot,
        timeoutMs: 5_000,
      });

      expectExitZero(result);
      expect(result.stdout).toBe("payload\n");
      expectNoOrcaDiagnosticsOnStdout(result);
      expectStderrContainsDiagnostics(result, ["preflight", "run started", "cycle", "done"]);
      expectOrderedStderr(result, ["preflight", "run started", "cycle", "done"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("repo health loop emits read-only report on stdout and progress on stderr", async () => {
    const target = await createDisposableTargetRepo();
    const before = await gitStatus(target);

    try {
      const result = await runCliProcess("bun", ["./bin/orcats", "run", "--no-typecheck", repoHealthLoopPath], {
        cwd: repoRoot,
        env: { ORCA_VALIDATE_TARGET_REPO: target },
        timeoutMs: 10_000,
      });
      const after = await gitStatus(target);
      const report = JSON.parse(result.stdout) as {
        readonly target: string;
        readonly scripts: readonly string[];
        readonly checks: readonly { name: string; status: string }[];
      };

      expectExitZero(result);
      expect(after).toBe(before);
      expect(report.target).toBe(target);
      expect(report.scripts).toEqual(["test", "typecheck"]);
      const checks = report.checks.map(({ name, status }) => ({ name, status }));
      expect(checks).toContainEqual({ name: "git-status", status: "passed" });
      expect(checks).toContainEqual({ name: "typecheck", status: "passed" });
      expect(checks).toContainEqual({ name: "test", status: "passed" });
      expectNoOrcaDiagnosticsOnStdout(result);
      expectStderrContainsDiagnostics(result, [
        "stage discover-scripts",
        "stage git-status",
        "stage typecheck",
        "stage test",
        "cycle",
        "done",
      ]);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("orcats serve exposes child output and stops cleanly after SIGINT", async () => {
    const target = await createDisposableTargetRepo();
    const before = await gitStatus(target);

    try {
      const result = await runCliProcess("bun", ["./bin/orcats", "serve", "--no-typecheck", repoHealthLoopPath], {
        cwd: repoRoot,
        env: { ORCA_VALIDATE_TARGET_REPO: target },
        shutdownAfter: { stream: "stdout", pattern: /"checkedAt": "deterministic"/, signal: "SIGINT" },
        timeoutMs: 10_000,
      });
      const after = await gitStatus(target);

      expectExitZero(result);
      expect(after).toBe(before);
      expect(result.stdout).toContain("\"checkedAt\": \"deterministic\"");
      expect(result.stderr).toContain('orcats: serving loop "repo-health"');
      expectStderrContainsDiagnostics(result, ["preflight", "run started", "stage", "cycle", "done"]);
      expectNoOrcaDiagnosticsOnStdout(result);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
