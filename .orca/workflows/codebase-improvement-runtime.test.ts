import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  WorkflowMonitor,
  type ConversationEvent,
} from "@twelvehart/orcats";
import {
  assertPositiveControlEvidence,
  assertRedGateEvidence as assertExactRedGateEvidence,
  awaitBounded,
  awaitExpectedFileChange,
  awaitOneTimeoutRetry,
  awaitToolFreeOutcome,
  awaitWithinDeadline,
  commandFailureMessage,
  ConversationTimeoutError,
  createWorkflowStatusWriter,
  finalizeWorkflowEvidence,
  hasConfirmedExpectedFileChange,
  InvalidReproductionProofError,
  rethrowAfterFinalizationCleanup,
  runTargetAfterPositiveControl,
} from "./codebase-improvement-runtime.ts";

const redTestName = "target regression ORCA_RED:candidate-x";

function assertRedGateEvidence(
  control: Parameters<typeof assertExactRedGateEvidence>[0],
  expectedControlName: string,
  red: Parameters<typeof assertExactRedGateEvidence>[2],
  expectedPattern: string,
): void {
  assertExactRedGateEvidence(
    control,
    expectedControlName,
    red,
    redTestName,
    expectedPattern,
  );
}

interface ManifestEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

interface ManifestRuntime {
  readonly assertGitManifestUnchanged: (
    expected: readonly ManifestEntry[],
    actual: readonly ManifestEntry[],
    label?: string,
  ) => void;
  readonly captureFileContentManifest: (
    paths: readonly string[],
    options: {
      readonly maxTotalBytes: number;
      readonly maxEntries: number;
      readonly maxTotalPathBytes: number;
      readonly remainingMs?: () => number;
      readonly now?: () => number;
      readonly operations?: {
        readonly lstat: (path: string) => Promise<{
          readonly mode: number;
          readonly size: number;
          isFile(): boolean;
          isSymbolicLink(): boolean;
        }>;
        readonly readlink: (path: string) => Promise<Uint8Array>;
        readonly readChunks: (path: string) => AsyncIterable<Uint8Array>;
      };
    },
  ) => Promise<ManifestEntry[]>;
  readonly captureGitWorktreeManifest: (
    paths: readonly string[],
    options: {
      readonly root: string;
      readonly objectFormat: "sha1" | "sha256";
      readonly hashFile: (path: string) => Promise<string>;
      readonly remainingMs?: () => number;
      readonly now?: () => number;
    },
  ) => Promise<ManifestEntry[]>;
  readonly parseGitCommitManifest: (
    value: string,
    expectedPaths: readonly string[],
  ) => ManifestEntry[];
  readonly parseGitIndexManifest: (
    value: string,
    expectedPaths: readonly string[],
  ) => ManifestEntry[];
  readonly parseExactGitPathList: (
    value: string,
    expectedPaths: readonly string[],
    label: string,
  ) => string[];
  readonly withGitManifestGuard: <T>(
    readManifest: () => Promise<readonly ManifestEntry[]>,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

async function manifestRuntime(): Promise<ManifestRuntime> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  for (const name of [
    "assertGitManifestUnchanged",
    "captureFileContentManifest",
    "captureGitWorktreeManifest",
    "parseGitCommitManifest",
    "parseGitIndexManifest",
    "parseExactGitPathList",
    "withGitManifestGuard",
  ]) {
    expect(loaded[name]).toBeFunction();
  }
  return loaded as unknown as ManifestRuntime;
}

async function runGit(
  root: string,
  args: readonly string[],
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(exitCode)}): ${stderr}`,
    );
  }
  return stdout;
}

async function createManifestRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orcats-manifest-repo-"));
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.name", "Orcats Test"]);
  await runGit(root, ["config", "user.email", "orcats@example.invalid"]);
  return root;
}

async function ignoredManifestPaths(root: string): Promise<string[]> {
  const orca = join(root, ".orca");
  const entries = await readdir(orca, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => join(orca, entry.name))
    .sort();
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("runtime guard did not settle")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function redGateLogs() {
  return {
    passed: {
      command: "bun test tests/x.test.ts --test-name-pattern ^control x$",
      status: "passed" as const,
      stdout: bunSingleTestOutput("control x"),
      stderr: "",
    },
    red: {
      command:
        "bun test tests/x.test.ts --test-name-pattern ^target regression ORCA_RED:candidate-x$",
      status: "failed" as const,
      stdout: "",
      stderr: bunSingleFailingTestOutput(redTestName),
    },
  };
}

function bunSingleFailingTestOutput(testName: string): string {
  return [
    "bun test v1.3.14 (0d9b296a)",
    "",
    `(fail) ${testName} [0.20ms]`,
    "",
    " 0 pass",
    " 1 fail",
    " 1 expect() calls",
    "Ran 1 test across 1 file. [1.00ms]",
    "",
  ].join("\n");
}

function bunSingleTestOutput(testName: string): string {
  return [
    "bun test v1.3.14 (0d9b296a)",
    "",
    `(pass) ${testName} [0.10ms]`,
    "",
    " 1 pass",
    " 0 fail",
    " 1 expect() calls",
    "Ran 1 test across 1 file. [1.00ms]",
    "",
  ].join("\n");
}

interface SnapshotOperations {
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly readStatus: () => Promise<string>;
  readonly readDiff: () => Promise<string>;
}

interface ExactSnapshot {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly baselineStatus: string;
  readonly baselineDiff: string;
}

interface SnapshotRuntime {
  readonly captureExactFileSnapshot: (
    path: string,
    operations: SnapshotOperations,
  ) => Promise<ExactSnapshot>;
  readonly restoreExactFileSnapshot: (
    path: string,
    snapshot: ExactSnapshot,
    operations: SnapshotOperations,
  ) => Promise<{
    readonly snapshotSha256: string;
    readonly status: string;
    readonly diff: string;
  }>;
}

async function snapshotRuntime(): Promise<SnapshotRuntime> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const capture = loaded.captureExactFileSnapshot;
  const restore = loaded.restoreExactFileSnapshot;
  expect(capture).toBeFunction();
  expect(restore).toBeFunction();
  if (typeof capture !== "function" || typeof restore !== "function") {
    throw new Error("exact snapshot runtime helpers are missing");
  }
  return {
    captureExactFileSnapshot:
      capture as SnapshotRuntime["captureExactFileSnapshot"],
    restoreExactFileSnapshot:
      restore as SnapshotRuntime["restoreExactFileSnapshot"],
  };
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

async function createSnapshotRepo(): Promise<{
  readonly root: string;
  readonly target: string;
  readonly other: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "orcats-exact-snapshot-"));
  await runGit(root, ["init", "-q"]);
  await runGit(root, ["config", "user.name", "Orcats Test"]);
  await runGit(root, ["config", "user.email", "orcats@example.test"]);
  const target = join(root, "target.bin");
  const other = join(root, "other.txt");
  await Bun.write(target, new Uint8Array([0, 255, 10, 13, 0, 65]));
  await Bun.write(other, "committed\n");
  await runGit(root, ["add", "target.bin", "other.txt"]);
  await runGit(root, ["commit", "-q", "-m", "fixture"]);
  return { root, target, other };
}

function snapshotOperations(root: string): SnapshotOperations {
  return {
    readBytes: async (path) =>
      new Uint8Array(await Bun.file(path).arrayBuffer()),
    writeBytes: async (path, bytes) => {
      await Bun.write(path, bytes);
    },
    readStatus: () =>
      runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    readDiff: () =>
      runGit(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]),
  };
}

test("explicit status writer reports stages and retry attempts without TTY gating", async () => {
  const output: string[] = [];
  const monitor = new WorkflowMonitor("codex", {
    writeStatus: createWorkflowStatusWriter((text) => {
      output.push(text);
    }),
    statusIntervalMs: 0,
  });

  await monitor.stage("scout", async () => {
    await monitor.stage("scout attempt 1", async () => {});
  });

  expect(output.join("")).toContain("orcats | stage scout started\n");
  expect(output.join("")).toContain(
    "orcats | stage scout attempt 1 started\n",
  );
  expect(output.join("")).toContain(
    "orcats | stage scout attempt 1 completed",
  );
  expect(output.join("")).toContain("orcats | stage scout completed");
});

test("commandFailureMessage retains stdout diagnostics and stderr wrappers", () => {
  expect(
    commandFailureMessage({
      command: "bun run lint",
      stdout: "src/cli/main.ts:324 no-unnecessary-condition\n",
      stderr: 'error: script "lint" exited with code 1\n',
    }),
  ).toBe(
    [
      "bun run lint",
      "stdout:\nsrc/cli/main.ts:324 no-unnecessary-condition",
      'stderr:\nerror: script "lint" exited with code 1',
    ].join("\n"),
  );
});

test("assertRedGateEvidence accepts one passing control and expected red", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(passed, "control x", red, "ORCA_RED:candidate-x"),
  ).not.toThrow();
});

test("assertRedGateEvidence requires the marker-bound target itself to fail", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        stdout: [
          "(pass) target regression ORCA_RED:candidate-x [0.10ms]",
          "(fail) unrelated baseline test [0.20ms]",
        ].join("\n"),
        stderr: "1 test failed",
      },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/marker-bound target.*failing Bun test/);
});

test("assertRedGateEvidence rejects a failing marker prefix collision", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        stdout: [
          "(pass) target regression ORCA_RED:candidate-x [0.10ms]",
          "(fail) old regression ORCA_RED:candidate-x-extra [0.20ms]",
        ].join("\n"),
        stderr: "1 test failed",
      },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/marker-bound target.*failing Bun test/);
});

test("baseline positive-control proof requires canonical named Bun evidence", () => {
  const { passed } = redGateLogs();
  expect(() =>
    assertPositiveControlEvidence(passed, "control x"),
  ).not.toThrow();
  expect(() =>
    assertPositiveControlEvidence(
      { ...passed, stdout: "(pass) control x [0.10ms]\n 1 pass" },
      "control x",
    ),
  ).toThrow(/one-test summary/);
});

test("assertRedGateEvidence rejects a failed positive control", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      {
        ...passed,
        status: "failed",
        stderr: "CONTROL_SELECTOR_INVALID ORCA_RED:candidate-x",
      },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/positive control failed/);
  expect(() =>
    assertRedGateEvidence(
      {
        ...passed,
        status: "failed",
        stderr: "CONTROL_SELECTOR_INVALID ORCA_RED:candidate-x",
      },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(InvalidReproductionProofError);
});

test("invalid positive control stops target execution and red persistence", async () => {
  const { passed, red } = redGateLogs();
  const failedControl = {
    ...passed,
    status: "failed" as const,
    stderr: "CONTROL_SELECTOR_INVALID ORCA_RED:candidate-x",
  };
  const validationLogs: Array<typeof failedControl | typeof red> = [];
  let targetCalls = 0;
  let persistedDiffs = 0;

  const executeRedGate = async (): Promise<void> => {
    validationLogs.push(failedControl);
    const target = await runTargetAfterPositiveControl(
      failedControl,
      "control x",
      async () => {
        targetCalls += 1;
        return red;
      },
    );
    validationLogs.push(target);
    assertRedGateEvidence(
      failedControl,
      "control x",
      target,
      "ORCA_RED:candidate-x",
    );
    persistedDiffs += 1;
  };

  await expect(executeRedGate()).rejects.toThrow(
    /positive control failed before implementation:[\s\S]*CONTROL_SELECTOR_INVALID/,
  );
  expect(targetCalls).toBe(0);
  expect(validationLogs).toEqual([failedControl]);
  expect(persistedDiffs).toBe(0);
});

test("assertRedGateEvidence rejects an unexpectedly passing red gate", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      { ...red, status: "passed" },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/unexpectedly passed/);
});

test("assertRedGateEvidence requires the expected red pattern", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      red,
      redTestName,
      "ORCA_RED:candidate-y",
    ),
  ).toThrow(/without expected pattern/);
  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      red,
      redTestName,
      "ORCA_RED:candidate-y",
    ),
  ).toThrow(InvalidReproductionProofError);
});

test("assertRedGateEvidence fails closed on a timed-out target command", () => {
  const { passed, red } = redGateLogs();
  let caught: unknown;

  try {
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        exitCode: null,
        stderr: "Command timed out after 5000ms",
      },
      "ORCA_RED:candidate-x",
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(InvalidReproductionProofError);
  expect(String(caught)).toContain("timed out");
});

test("signal-killed positive control is operational and cannot trigger fallback", async () => {
  const { passed } = redGateLogs();
  let targetCalls = 0;
  let caught: unknown;

  try {
    await runTargetAfterPositiveControl(
      {
        ...passed,
        status: "failed",
        exitCode: null,
        stderr: "Killed: 9",
      },
      "control x",
      async () => {
        targetCalls += 1;
        return "target";
      },
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(InvalidReproductionProofError);
  expect(String(caught)).toContain("terminated without an exit code");
  expect(targetCalls).toBe(0);
});

test("signal-killed target command is operational and cannot trigger fallback", () => {
  const { passed, red } = redGateLogs();
  let caught: unknown;

  try {
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        exitCode: null,
        stderr: "ORCA_RED:candidate-x\nKilled: 9",
      },
      "ORCA_RED:candidate-x",
    );
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(InvalidReproductionProofError);
  expect(String(caught)).toContain("terminated without an exit code");
});

test("exact snapshot restores raw bytes and the complete git baseline", async () => {
  const api = await snapshotRuntime();
  const fixture = await createSnapshotRepo();
  try {
    await Bun.write(fixture.other, "baseline dirty\n");
    await Bun.write(join(fixture.root, "untracked.txt"), "baseline untracked\n");
    const operations = snapshotOperations(fixture.root);
    const snapshot = await api.captureExactFileSnapshot(
      fixture.target,
      operations,
    );

    await Bun.write(fixture.target, new Uint8Array([9, 8, 7]));
    const restored = await api.restoreExactFileSnapshot(
      fixture.target,
      snapshot,
      operations,
    );

    expect(
      Array.from(new Uint8Array(await Bun.file(fixture.target).arrayBuffer())),
    ).toEqual(Array.from(snapshot.bytes));
    expect(restored.snapshotSha256).toBe(snapshot.sha256);
    expect(restored.status).toBe(snapshot.baselineStatus);
    expect(restored.diff).toBe(snapshot.baselineDiff);
    expect(await operations.readStatus()).toBe(snapshot.baselineStatus);
    expect(await operations.readDiff()).toBe(snapshot.baselineDiff);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact snapshot rejects a whole-tree restoration mismatch", async () => {
  const api = await snapshotRuntime();
  const fixture = await createSnapshotRepo();
  try {
    const operations = snapshotOperations(fixture.root);
    const snapshot = await api.captureExactFileSnapshot(
      fixture.target,
      operations,
    );
    await Bun.write(fixture.target, new Uint8Array([9, 8, 7]));
    await Bun.write(fixture.other, "off-target change\n");

    await expect(
      api.restoreExactFileSnapshot(fixture.target, snapshot, operations),
    ).rejects.toThrow(/exact restoration verification failed/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact snapshot rejects a status-only untracked mismatch", async () => {
  const api = await snapshotRuntime();
  const fixture = await createSnapshotRepo();
  try {
    const operations = snapshotOperations(fixture.root);
    const snapshot = await api.captureExactFileSnapshot(
      fixture.target,
      operations,
    );
    await Bun.write(fixture.target, new Uint8Array([9, 8, 7]));
    await Bun.write(join(fixture.root, "status-only.txt"), "untracked\n");

    await expect(
      api.restoreExactFileSnapshot(fixture.target, snapshot, operations),
    ).rejects.toThrow(/exact restoration verification failed/);
    expect(await operations.readDiff()).toBe(snapshot.baselineDiff);
    expect(await operations.readStatus()).not.toBe(snapshot.baselineStatus);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact snapshot rejects a diff-only tracked mismatch", async () => {
  const api = await snapshotRuntime();
  const fixture = await createSnapshotRepo();
  try {
    await Bun.write(fixture.other, "baseline dirty\n");
    const operations = snapshotOperations(fixture.root);
    const snapshot = await api.captureExactFileSnapshot(
      fixture.target,
      operations,
    );
    await Bun.write(fixture.target, new Uint8Array([9, 8, 7]));
    await Bun.write(fixture.other, "different dirty bytes\n");

    await expect(
      api.restoreExactFileSnapshot(fixture.target, snapshot, operations),
    ).rejects.toThrow(/exact restoration verification failed/);
    expect(await operations.readStatus()).toBe(snapshot.baselineStatus);
    expect(await operations.readDiff()).not.toBe(snapshot.baselineDiff);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("exact snapshot rejects corrupt restored bytes by hash", async () => {
  const api = await snapshotRuntime();
  const fixture = await createSnapshotRepo();
  try {
    const operations = snapshotOperations(fixture.root);
    const snapshot = await api.captureExactFileSnapshot(
      fixture.target,
      operations,
    );
    await Bun.write(fixture.target, new Uint8Array([9, 8, 7]));
    const corruptingOperations: SnapshotOperations = {
      ...operations,
      writeBytes: async (path) => {
        await Bun.write(path, new Uint8Array([1, 2, 3]));
      },
    };

    await expect(
      api.restoreExactFileSnapshot(
        fixture.target,
        snapshot,
        corruptingOperations,
      ),
    ).rejects.toThrow(/restored snapshot hash mismatch/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("assertRedGateEvidence treats the canonical marker punctuation literally", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(passed, "control x", red, "ORCA_RED:candidate-x"),
  ).not.toThrow();
});

test("assertRedGateEvidence treats regex metacharacters in the exact name literally", () => {
  const { passed, red } = redGateLogs();
  const exactName =
    "target [regression] (exact)? ORCA_RED:candidate-x \\ path";

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: bunSingleFailingTestOutput(exactName) },
      exactName,
      "ORCA_RED:candidate-x",
    ),
  ).not.toThrow();
});

test("assertRedGateEvidence requires the exact case-sensitive target name", () => {
  const { passed, red } = redGateLogs();
  const wrongCaseName = redTestName.toUpperCase();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: bunSingleFailingTestOutput(wrongCaseName) },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/exact target|reporter/i);
});

test("assertRedGateEvidence rejects a regex-only marker match", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      red,
      redTestName,
      "ORCA_RED:candidate-y",
    ),
  ).toThrow(/without expected pattern/);
});

test("assertRedGateEvidence rejects generic unrelated SyntaxError output", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      red,
      "error",
    ),
  ).toThrow(/expected failure pattern|generic/i);
});

test("assertRedGateEvidence requires a canonical one-test failing Bun summary", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: `(fail) ${redTestName} [0.20ms]` },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/Bun one-test failing summary/);
});

test("assertRedGateEvidence rejects every noncanonical failing-summary field", () => {
  const { passed, red } = redGateLogs();
  const canonical = bunSingleFailingTestOutput(redTestName);
  const mutations = [
    canonical.replace(
      "bun test v1.3.14 (0d9b296a)",
      "bun test latest (0d9b296a)",
    ),
    canonical.replace(" 0 pass", " 1 pass"),
    canonical.replace(" 1 fail", " 2 fail"),
    canonical.replace(" 1 expect() calls", " 0 expect() calls"),
    canonical.replace(
      "Ran 1 test across 1 file. [1.00ms]",
      "Ran 2 tests across 1 file. [1.00ms]",
    ),
    `${canonical}bun test v1.3.15 (1d9b296b)\n`,
    `${canonical} 0 pass\n`,
    `${canonical} 1 pass\n`,
    `${canonical} 2 fail\n`,
    `${canonical} 0 expect() calls\n`,
    `${canonical}Ran 2 tests across 1 file. [2.00ms]\n`,
  ];

  for (const stderr of mutations) {
    expect(() =>
      assertRedGateEvidence(
        passed,
        "control x",
        { ...red, stderr },
        "ORCA_RED:candidate-x",
      ),
    ).toThrow(/Bun one-test failing summary/);
  }
});

test("assertRedGateEvidence rejects duplicate reporter records", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        stderr: `${bunSingleFailingTestOutput(redTestName)}(fail) ${redTestName} [0.30ms]\n`,
      },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/exactly one Bun reporter record/);
});

test("assertRedGateEvidence rejects a pass plus an unrelated marker-bearing fail", () => {
  const { passed, red } = redGateLogs();
  const forged = bunSingleFailingTestOutput(redTestName).replace(
    `(fail) ${redTestName} [0.20ms]`,
    [
      `(pass) ${redTestName} [0.10ms]`,
      `(fail) unrelated ${redTestName} [0.20ms]`,
    ].join("\n"),
  );

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: forged },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/exactly one Bun reporter record/);
});

test("assertRedGateEvidence rejects a reporter name with the exact target as a prefix", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      passed,
      "control x",
      {
        ...red,
        stderr: bunSingleFailingTestOutput(`${redTestName} extra`),
      },
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/exact target|reporter/i);
});

test("assertRedGateEvidence rejects skip or todo records beside the target fail", () => {
  const { passed, red } = redGateLogs();

  for (const status of ["skip", "todo"] as const) {
    expect(() =>
      assertRedGateEvidence(
        passed,
        "control x",
        {
          ...red,
          stderr: bunSingleFailingTestOutput(redTestName).replace(
            `(fail) ${redTestName} [0.20ms]`,
            [
              `(${status}) unrelated [0.10ms]`,
              `(fail) ${redTestName} [0.20ms]`,
            ].join("\n"),
          ),
        },
        "ORCA_RED:candidate-x",
      ),
    ).toThrow(/exactly one Bun reporter record/);
  }
});

test("assertRedGateEvidence requires the marker inside the exact target name", () => {
  const { passed, red } = redGateLogs();
  const unboundName = "target regression";

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: bunSingleFailingTestOutput(unboundName) },
      unboundName,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/without expected pattern/);
});

test("assertRedGateEvidence rejects line-separator injection in the target name", () => {
  const { passed, red } = redGateLogs();
  const injectedName = "target\u2028(fail) injected ORCA_RED:candidate-x";

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      { ...red, stderr: bunSingleFailingTestOutput(injectedName) },
      injectedName,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/single-line|control character/i);
});

test("assertRedGateEvidence rejects newline injection in the expected marker", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertExactRedGateEvidence(
      passed,
      "control x",
      red,
      redTestName,
      "ORCA_RED:candidate-x\n(fail) injected",
    ),
  ).toThrow(/single-line|control character/i);
});

test("assertRedGateEvidence requires exactly one passing control", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      { ...passed, stdout: "1 pass\n" },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/exactly one passing positive control/);
});

test("assertRedGateEvidence rejects a skipped or todo control", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      { ...passed, stdout: "(skip) control x\n" },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/positive control.*skip|todo/);
});

test("positive control rejects a forgeable pass marker without Bun summary", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      { ...passed, stdout: "(pass) control x [0.10ms]\n" },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/Bun one-test summary/);
});

test("positive control rejects a partial Bun summary", () => {
  const { passed, red } = redGateLogs();

  expect(() =>
    assertRedGateEvidence(
      {
        ...passed,
        stdout: [
          "bun test v1.3.14 (0d9b296a)",
          "(pass) control x [0.10ms]",
          " 1 pass",
          " 0 fail",
        ].join("\n"),
      },
      "control x",
      red,
      "ORCA_RED:candidate-x",
    ),
  ).toThrow(/Bun one-test summary/);
});

const semanticControlSource = [
  'import { expect, test } from "bun:test";',
  'import { calculate } from "../src/x.ts";',
  'test("control x", () => {',
  '  const actual = calculate("known-good");',
  '  expect(actual).toBe("expected");',
  '});',
  "",
].join("\n");

const semanticControlOptions = {
  expectedTestName: "control x",
  testPath: "tests/x.test.ts",
  allowedProductionPaths: ["src/x.ts"],
  candidateRedMarker: "ORCA_RED:candidate-x",
} as const;

type SemanticPositiveControl = (
  source: string,
  options: typeof semanticControlOptions & {
    readonly baselineSource?: string;
  },
  ) => {
    readonly sourceSha256: string;
    readonly productionPath: string;
    readonly candidateRedTestName?: string;
  };

async function semanticPositiveControlRuntime(): Promise<SemanticPositiveControl> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  expect(loaded.assertSemanticPositiveControl).toBeFunction();
  if (typeof loaded.assertSemanticPositiveControl !== "function") {
    throw new Error("assertSemanticPositiveControl runtime helper is missing");
  }
  return loaded.assertSemanticPositiveControl as SemanticPositiveControl;
}

interface MatcherProofRuntime {
  readonly preloadSource: string;
  readonly args: (args: readonly string[], preloadPath: string) => string[];
}

async function matcherProofRuntime(): Promise<MatcherProofRuntime> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  expect(loaded.MATCHER_PROOF_PRELOAD_SOURCE).toBeString();
  expect(loaded.matcherProofArgs).toBeFunction();
  if (
    typeof loaded.MATCHER_PROOF_PRELOAD_SOURCE !== "string" ||
    typeof loaded.matcherProofArgs !== "function"
  ) {
    throw new Error("matcher proof runtime helpers are missing");
  }
  return {
    preloadSource: loaded.MATCHER_PROOF_PRELOAD_SOURCE,
    args: loaded.matcherProofArgs as MatcherProofRuntime["args"],
  };
}

type Utf8SourceDecoder = (bytes: Uint8Array, label: string) => string;

async function utf8SourceDecoderRuntime(): Promise<Utf8SourceDecoder> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  expect(loaded.decodeUtf8Source).toBeFunction();
  if (typeof loaded.decodeUtf8Source !== "function") {
    throw new Error("decodeUtf8Source runtime helper is missing");
  }
  return loaded.decodeUtf8Source as Utf8SourceDecoder;
}

test("semantic positive control returns an exact source fingerprint", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const evidence = assertSemanticPositiveControl(
    semanticControlSource,
    semanticControlOptions,
  );

  expect(evidence).toEqual({
    sourceSha256: createHash("sha256")
      .update(semanticControlSource)
      .digest("hex"),
    productionPath: "src/x.ts",
  });
});

test("semantic positive control requires the exact named top-level test", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const nested = semanticControlSource.replace(
    'test("control x", () => {',
    'test("wrapper", () => {\n  test("control x", () => {',
  ).replace("\n});\n", "\n  });\n});\n");

  expect(() =>
    assertSemanticPositiveControl(nested, semanticControlOptions),
  ).toThrow(/exact top-level test/);
});

test("semantic positive control requires a direct allowed production import", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const disallowed = semanticControlSource.replace(
    'from "../src/x.ts"',
    'from "../src/other.ts"',
  );

  expect(() =>
    assertSemanticPositiveControl(disallowed, semanticControlOptions),
  ).toThrow(/allowed production path/);
});

test("semantic positive control rejects a tautology with fake Bun output", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const tautology = semanticControlSource.replace(
    '  const actual = calculate("known-good");\n  expect(actual).toBe("expected");',
    [
      '  calculate("known-good");',
      '  console.log("(pass) control x [0.10ms]\\n 1 pass");',
      "  expect(true).toBe(true);",
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(tautology, semanticControlOptions),
  ).toThrow(/production call result.*expect/);
});

test("semantic positive control requires a production-bound Bun matcher", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const bareExpect = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    ["  expect(actual);", "  expect(true).toBe(true);"].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(bareExpect, semanticControlOptions),
  ).toThrow(/production call result.*genuine Bun matcher/);
});

test("semantic positive control rejects unreachable production matchers", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();

  for (const abruptCompletion of [
    "  return;",
    '  throw new Error("stop");',
  ]) {
    const unreachableMatcher = semanticControlSource.replace(
      '  expect(actual).toBe("expected");',
      [
        "  expect(true).toBe(true);",
        abruptCompletion,
        '  expect(actual).toBe("expected");',
      ].join("\n"),
    );

    expect(() =>
      assertSemanticPositiveControl(
        unreachableMatcher,
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*reachable.*matcher/);
  }
});

test("semantic positive control rejects matchers after labeled breaks", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const simpleBreak = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    [
      "  expect(true).toBe(true);",
      "  stop: {",
      "    break stop;",
      '    expect(actual).toBe("expected");',
      "  }",
    ].join("\n"),
  );
  const nestedBreak = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    [
      "  expect(true).toBe(true);",
      "  outer: {",
      "    inner: {",
      "      break outer;",
      '      expect(actual).toBe("expected");',
      "    }",
      '    expect(actual).toBe("expected");',
      "  }",
    ].join("\n"),
  );

  for (const source of [simpleBreak, nestedBreak]) {
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/production call result.*reachable.*matcher/);
  }

  const reachableAfterBreak = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    [
      "  stop: {",
      "    break stop;",
      '    expect(actual).toBe("unreachable");',
      "  }",
      '  expect(actual).toBe("expected");',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(reachableAfterBreak, semanticControlOptions),
  ).not.toThrow();
});

test("semantic positive control rejects matchers in optional chains", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  for (const shortCircuitedMatcher of [
    '  (undefined as any)?.(expect(actual).toBe("expected"));',
    '  (undefined as any)?.[expect(actual).toBe("expected")];',
  ]) {
    const source = semanticControlSource.replace(
      '  expect(actual).toBe("expected");',
      ["  expect(true).toBe(true);", shortCircuitedMatcher].join("\n"),
    );
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/production call result.*reachable.*matcher/);
  }

  const optionalNamedProductionCall = semanticControlSource.replace(
    'calculate("known-good")',
    'calculate?.("known-good")',
  );
  const optionalNamespaceProductionCall = semanticControlSource
    .replace(
      'import { calculate } from "../src/x.ts";',
      'import * as api from "../src/x.ts";',
    )
    .replace('calculate("known-good")', 'api.calculate?.("known-good")');
  for (const source of [
    optionalNamedProductionCall,
    optionalNamespaceProductionCall,
  ]) {
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/production call result.*reachable.*matcher/);
  }

  const reachableAfterOptionalCall = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    [
      '  (undefined as any)?.(expect("ignored").toBe("ignored"));',
      '  expect(actual).toBe("expected");',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(
      reachableAfterOptionalCall,
      semanticControlOptions,
    ),
  ).toThrow(/production call result.*reachable.*matcher/);
});

test("semantic positive control accepts supported matcher chains", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  for (const assertion of [
    'expect(actual).toBe("expected")',
    'expect(actual.value).toBe("expected")',
    'expect(actual["value"]).toBe("expected")',
    'expect(actual).not.toBe("unexpected")',
    'expect(actual).resolves.toBe("expected")',
    'expect(actual).rejects.toThrow("expected")',
    'expect(actual)["not"]["toBe"]("unexpected")',
  ]) {
    const source = semanticControlSource.replace(
      'expect(actual).toBe("expected")',
      assertion,
    );
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).not.toThrow();
  }
});

test("semantic positive control rejects self-fulfilling matcher arguments", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    semanticControlSource.replace(causalBody, lines.join("\n"));
  const selfFulfillingBodies = [
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toBe(actual);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  const alias = actual;",
      "  expect(actual).toBe(alias);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toEqual([actual]);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toEqual({ value: actual });",
    ],
    [
      '  const actual = calculate("known-good");',
      "  const undefined = actual;",
      "  expect(actual).toBe(undefined);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toBe(actual.value);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toSatisfy(() => true);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  const predicate = () => true;",
      "  expect(actual).toSatisfy(predicate);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  function predicate() { return true; }",
      "  expect(actual).toSatisfy(predicate);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toBe(expected());",
    ],
  ] as const;

  for (const lines of selfFulfillingBodies) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*matcher/);
  }

  for (const lines of [
    [
      '  const actual = calculate("known-good");',
      '  const expected = "expected";',
      "  expect(actual).toBe(expected);",
    ],
    [
      '  const actual = calculate("known-good");',
      "  expect(actual).toBeDefined();",
    ],
  ] as const) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).not.toThrow();
  }
});

test("semantic positive control rejects effectful matcher argument bindings", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const proxyBackedExpectation = semanticControlSource.replace(
    causalBody,
    [
      "  const allowed = new Proxy([], {",
      "    get(target, property, receiver) {",
      '      if (property === "includes") return () => true;',
      "      return Reflect.get(target, property, receiver);",
      "    },",
      "  });",
      '  const actual = calculate("known-good");',
      "  expect(actual).toEqual(allowed);",
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(
      proxyBackedExpectation,
      semanticControlOptions,
    ),
  ).toThrow(/production call result.*matcher/);
});

test("semantic positive control accepts recursively passive const matcher argument bindings", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const literalExpectation = semanticControlSource.replace(
    causalBody,
    [
      '  const expected = "expected";',
      "  const expectedAlias = expected;",
      '  const actual = calculate("known-good");',
      "  expect(actual).toBe(expectedAlias);",
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(literalExpectation, semanticControlOptions),
  ).not.toThrow();
});

test("matcher arguments reject mutable aggregate const bindings", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const source = semanticControlSource.replace(
    [
      '  const actual = calculate("known-good");',
      '  expect(actual).toBe("expected");',
    ].join("\n"),
    [
      "  const allowed: unknown[] = [];",
      '  const seed = calculate("known-good");',
      "  allowed[0] = seed;",
      '  const actual = calculate("known-good");',
      "  expect(actual).toEqual(allowed);",
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(source, semanticControlOptions),
  ).toThrow(/production call result.*matcher/);
});

test("matcher arguments reject const container bindings", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const source = semanticControlSource.replace(
    [
      '  const actual = calculate("known-good");',
      '  expect(actual).toBe("expected");',
    ].join("\n"),
    [
      '  const allowed = ["expected"];',
      '  const actual = calculate("known-good");',
      "  expect(actual).toEqual(allowed);",
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(source, semanticControlOptions),
  ).toThrow(/production call result.*matcher/);
});

test("matcher allowlist rejects prototype-dependent toBeOneOf", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const source = semanticControlSource.replace(
    [
      '  const actual = calculate("known-good");',
      '  expect(actual).toBe("expected");',
    ].join("\n"),
    [
      "  Array.prototype.includes = () => true;",
      '  const actual = calculate("known-good");',
      '  expect(actual).toBeOneOf(["wrong"]);',
    ].join("\n"),
  );

  expect(() =>
    assertSemanticPositiveControl(source, semanticControlOptions),
  ).toThrow(/production call result.*matcher/);
});

test("matcher proof rejects expect.extend overrides", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const extension = [
    "{",
    "  toBe() {",
    '    return { pass: true, message: () => "forged" };',
    "  },",
    "}",
  ].join("\n");
  const overrides = [
    `expect.extend(${extension});`,
    `const localExpect = expect;\nlocalExpect.extend(${extension});`,
    `const { extend } = expect;\nextend(${extension});`,
    `expect["extend"](${extension});`,
  ];

  for (const override of overrides) {
    const source = semanticControlSource.replace(
      causalBody,
      [
        override,
        '  const actual = calculate("known-good");',
        '  expect(actual).toBe("impossible");',
      ].join("\n"),
    );
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/mutate.*expect|production call result.*matcher/);
  }

  const topLevelOverride = semanticControlSource.replace(
    'test("control x", () => {',
    [
      `expect.extend(${extension});`,
      'test("control x", () => {',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(topLevelOverride, semanticControlOptions),
  ).toThrow(/mutate.*expect|production call result.*matcher/);

  const alternateBindings = [
    semanticControlSource
      .replace(
        'import { expect, test } from "bun:test";',
        [
          'import { expect, test } from "bun:test";',
          'import { expect as otherExpect } from "bun:test";',
        ].join("\n"),
      )
      .replace(
        causalBody,
        [
          `  otherExpect.extend(${extension});`,
          '  const actual = calculate("known-good");',
          '  expect(actual).toBe("impossible");',
        ].join("\n"),
      ),
    semanticControlSource
      .replace(
        'import { expect, test } from "bun:test";',
        [
          'import { expect, test } from "bun:test";',
          'import * as bunTest from "bun:test";',
        ].join("\n"),
      )
      .replace(
        causalBody,
        [
          `  bunTest.expect.extend(${extension});`,
          '  const actual = calculate("known-good");',
          '  expect(actual).toBe("impossible");',
        ].join("\n"),
      ),
    semanticControlSource
      .replace(
        'test("control x", () => {',
        'test("control x", async () => {',
      )
      .replace(
        causalBody,
        [
          '  const bunTest = await import("bun:test");',
          `  bunTest.expect.extend(${extension});`,
          '  const actual = calculate("known-good");',
          '  expect(actual).toBe("impossible");',
        ].join("\n"),
      ),
  ];
  for (const source of alternateBindings) {
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/mutate.*expect|production call result.*matcher/);
  }
});

test("matcher proof rejects escaped assertion objects", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  for (const escape of [
    [
      "  const assertion = expect(null);",
      "  const proto = Object.getPrototypeOf(assertion);",
    ],
    ["  const proto = expect(null).__proto__;"],
  ] as const) {
    const source = semanticControlSource.replace(
      causalBody,
      [
        ...escape,
        "  proto.toBe = () => undefined;",
        '  const actual = calculate("known-good");',
        '  expect(actual).toBe("impossible");',
      ].join("\n"),
    );
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/mutate.*expect|production call result.*matcher/);
  }

  const staticPrototype = semanticControlSource.replace(
    causalBody,
    [
      "  expect.prototype.toBe = () => undefined;",
      '  const actual = calculate("known-good");',
      '  expect(actual).toBe("impossible");',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(staticPrototype, semanticControlOptions),
  ).toThrow(/mutate.*expect|production call result.*matcher/);
});

test("matcher proof preload freezes Bun matcher state", async () => {
  const runtime = await matcherProofRuntime();
  const root = await mkdtemp(join(tmpdir(), "orca-matcher-proof-"));
  const preloadPath = join(root, "preload.ts");
  await writeFile(preloadPath, runtime.preloadSource, { mode: 0o600 });
  expect(runtime.args(["test", "tests/x.test.ts"], preloadPath)).toEqual([
    "--preload",
    preloadPath,
    "test",
    "tests/x.test.ts",
  ]);

  const mutations = [
    'import { expect } from "bun:test"; expect.extend({ toBe() { return { pass: true, message: () => "forged" }; } });',
    'import { expect } from "bun:test"; expect.prototype.toBe = () => undefined;',
    'const expect = Bun.jest(import.meta.path).expect; expect.extend({ toBe() { return { pass: true, message: () => "forged" }; } });',
    'const bunTest = await import("bun:" + "test"); bunTest.expect.prototype.toBe = () => undefined;',
  ];

  try {
    for (const mutation of mutations) {
      const process = Bun.spawn(
        ["bun", "--preload", preloadPath, "-e", mutation],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(await process.exited).not.toBe(0);
      await new Response(process.stdout).text();
      await new Response(process.stderr).text();
    }
    const valid = Bun.spawn(
      [
        "bun",
        "--preload",
        preloadPath,
        "-e",
        'import { expect } from "bun:test"; expect("actual").toBe("actual");',
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(await valid.exited).toBe(0);
    await new Response(valid.stdout).text();
    await new Response(valid.stderr).text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("matcher arguments accept passive object literals", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const source = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    '  expect(actual).toEqual({ value: "expected" });',
  );

  expect(() =>
    assertSemanticPositiveControl(source, semanticControlOptions),
  ).not.toThrow();
});

test("matcher arguments accept global undefined", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const source = semanticControlSource.replace(
    '  expect(actual).toBe("expected");',
    "  expect(actual).toBe(undefined);",
  );

  expect(() =>
    assertSemanticPositiveControl(source, semanticControlOptions),
  ).not.toThrow();
});

test("semantic positive control rejects callbacks passed to production", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    semanticControlSource.replace(causalBody, lines.join("\n"));

  for (const lines of [
    [
      '  let actual = calculate("known-good");',
      '  calculate(() => { actual = "expected"; });',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const mutate = () => { actual = "expected"; };',
      "  calculate(mutate);",
      '  expect(actual).toBe("expected");',
    ],
    [
      "  function mutate() { actual = \"expected\"; }",
      '  let actual = calculate("known-good");',
      "  calculate(mutate);",
      '  expect(actual).toBe("expected");',
    ],
  ] as const) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*matcher/);
  }
});

test("later production calls accept only proven primitive arguments", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    semanticControlSource.replace(causalBody, lines.join("\n"));
  const unsafeBodies = [
    [
      '  let actual = calculate("known-good");',
      '  calculate({ value: "next" });',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  calculate(["next"]);',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  calculate(() => { actual = "expected"; });',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  const container = { get value() { return "next"; } };',
      '  let actual = calculate("known-good");',
      "  calculate(container);",
      '  expect(actual).toBe("expected");',
    ],
    [
      "  const unknownArgument = getUnknownArgument();",
      '  let actual = calculate("known-good");',
      "  calculate(unknownArgument);",
      '  expect(actual).toBe("expected");',
    ],
  ] as const;

  for (const lines of unsafeBodies) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*matcher/);
  }

  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  const seed = "next";',
        "  const alias = seed;",
        '  let actual = calculate({ callback: () => "first" });',
        '  calculate("literal");',
        "  calculate(alias);",
        '  expect(actual).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).not.toThrow();
});

test("semantic positive control observes awaited production results", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const asyncSource = semanticControlSource.replace(
    'test("control x", () => {',
    'test("control x", async () => {',
  );
  const namedDeclaration = asyncSource.replace(
    'calculate("known-good")',
    'await calculate("known-good")',
  );
  const namespaceDeclaration = namedDeclaration
    .replace(
      'import { calculate } from "../src/x.ts";',
      'import * as api from "../src/x.ts";',
    )
    .replace('await calculate("known-good")', 'await api.calculate("known-good")');
  const namedMatcher = asyncSource.replace(
    '  const actual = calculate("known-good");\n  expect(actual).toBe("expected");',
    '  expect(await calculate("known-good")).toBe("expected");',
  );
  const namespaceMatcher = namedMatcher
    .replace(
      'import { calculate } from "../src/x.ts";',
      'import * as api from "../src/x.ts";',
    )
    .replace('await calculate("known-good")', 'await api.calculate("known-good")');

  for (const source of [
    namedDeclaration,
    namespaceDeclaration,
    namedMatcher,
    namespaceMatcher,
  ]) {
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).not.toThrow();
  }

  for (const source of [
    namedDeclaration.replace("await calculate(", "await calculate?.("),
    namespaceMatcher.replace("await api.calculate(", "await api.calculate?.("),
  ]) {
    expect(() =>
      assertSemanticPositiveControl(source, semanticControlOptions),
    ).toThrow(/production call result.*matcher/);
  }
});

test("semantic positive control rejects discarded production results", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalAssertion =
    '  const actual = calculate("known-good");\n  expect(actual).toBe("expected");';
  const discardedAssertions = [
    '  expect([calculate("known-good"), "expected"][1]).toBe("expected");',
    '  expect((calculate("known-good"), "expected")).toBe("expected");',
    '  expect(true ? "expected" : calculate("known-good")).toBe("expected");',
    '  expect(({ real: calculate("known-good"), shown: "expected" }).shown).toBe("expected");',
  ];

  for (const assertion of discardedAssertions) {
    const discarded = semanticControlSource.replace(causalAssertion, assertion);
    expect(discarded).not.toBe(semanticControlSource);
    expect(() =>
      assertSemanticPositiveControl(discarded, semanticControlOptions),
    ).toThrow(/production call result.*expect/);
  }
});

test("semantic positive control permits only one additive top-level test", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource.replace(
    'test("control x", () => {',
    [
      'const fixture = "original";',
      'test("unrelated", () => {',
      '  expect(fixture).toBe("original");',
      '});',
      'test("control x", () => {',
    ].join("\n"),
  );
  const targetTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const additive = `${baseline}${targetTest}`;
  const options = { ...semanticControlOptions, baselineSource: baseline };

  const evidence = assertSemanticPositiveControl(additive, options);
  expect(evidence.candidateRedTestName).toBe(
    "target regression ORCA_RED:candidate-x",
  );

  for (const invalid of [
    additive.replace(
      'const fixture = "original";',
      'const fixture = "changed";',
    ),
    additive.replace(
      'expect(fixture).toBe("original")',
      'expect(fixture).toBe("changed")',
    ),
    `${additive}${targetTest.replace("target regression", "second target")}`,
  ]) {
    expect(invalid).not.toBe(additive);
    expect(() => assertSemanticPositiveControl(invalid, options)).toThrow(
      /exactly one additive top-level test/,
    );
  }
});

test("additive RED test names reject every control and line-separator code point", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource;
  const unsafeCodePoints = [
    ...Array.from({ length: 0x20 }, (_, index) => index),
    ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
    0x2028,
    0x2029,
  ];

  for (const codePoint of unsafeCodePoints) {
    const escaped = `\\u${codePoint.toString(16).padStart(4, "0")}`;
    const targetTest = [
      `test("target ${escaped} ORCA_RED:candidate-x", () => {`,
      '  const actual = calculate("defect");',
      '  expect(actual).toBe("expected");',
      '});',
      "",
    ].join("\n");

    expect(() =>
      assertSemanticPositiveControl(`${baseline}${targetTest}`, {
        ...semanticControlOptions,
        baselineSource: baseline,
      }),
    ).toThrow(/single-line|control character/i);
  }
});

test("additive RED marker must be absent from the baseline", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const oldMarkerTest = [
    'test("old regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("old-defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const targetTest = oldMarkerTest
    .replace("old regression", "target regression")
    .replace("old-defect", "new-defect");
  const baseline = `${semanticControlSource}${oldMarkerTest}`;

  expect(() =>
    assertSemanticPositiveControl(`${baseline}${targetTest}`, {
      ...semanticControlOptions,
      baselineSource: baseline,
    }),
  ).toThrow(/candidate RED marker.*absent from baseline/);
});

test("additive RED test must have one marker-bound causal assertion", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource;
  const validTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const options = { ...semanticControlOptions, baselineSource: baseline };

  expect(() =>
    assertSemanticPositiveControl(`${baseline}${validTest}`, options),
  ).not.toThrow();

  const invalidTests = [
    validTest.replace(" ORCA_RED:candidate-x", ""),
    validTest.replace(
      '  const actual = calculate("defect");\n  expect(actual).toBe("expected");',
      '  throw new Error("ORCA_RED:candidate-x");',
    ),
    validTest.replace(
      '  const actual = calculate("defect");\n  expect(actual).toBe("expected");',
      '  expect("ORCA_RED:candidate-x").toBe("different");',
    ),
    validTest.replace(
      '  expect(actual).toBe("expected");',
      '  expect(actual).toBe("expected");\n  expect(false).toBe(true);',
    ),
    validTest.replace(
      '  expect(actual).toBe("expected");',
      '  fail("ORCA_RED:candidate-x");\n  expect(actual).toBe("expected");',
    ),
    validTest.replace(
      '  const actual = calculate("defect");',
      '  const actual = calculate((() => { throw new Error("ORCA_RED:candidate-x"); })());',
    ),
    validTest.replace(
      '  const actual = calculate("defect");',
      '  const actual = calculate(fail("ORCA_RED:candidate-x"));',
    ),
  ];

  for (const invalidTest of invalidTests) {
    expect(invalidTest).not.toBe(validTest);
    expect(() =>
      assertSemanticPositiveControl(`${baseline}${invalidTest}`, options),
    ).toThrow(/candidate RED test/);
  }
});

test("additive RED test requires a genuine Bun matcher invocation", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource;
  const validTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const options = { ...semanticControlOptions, baselineSource: baseline };

  for (const assertion of [
    "expect(actual).not();",
    "expect(actual).resolves();",
    'expect(actual)["rejects"]();',
    "expect(actual).toBogus();",
    "expect(actual).bogus.toBe(\"expected\");",
    'expect(actual)["bogus"]["toBe"]("expected");',
  ]) {
    const mutant = validTest.replace(
      'expect(actual).toBe("expected");',
      assertion,
    );
    expect(mutant).not.toBe(validTest);
    expect(() =>
      assertSemanticPositiveControl(`${baseline}${mutant}`, options),
    ).toThrow(/genuine Bun matcher/);
  }

  for (const assertion of [
    'expect(actual).not.toBe("unexpected");',
    'expect(actual)["not"]["toBe"]("unexpected");',
    'expect(actual).resolves.toBe("expected");',
    'expect(actual).rejects.toThrow("expected");',
  ]) {
    const genuine = validTest.replace(
      'expect(actual).toBe("expected");',
      assertion,
    );
    expect(() =>
      assertSemanticPositiveControl(`${baseline}${genuine}`, options),
    ).not.toThrow();
  }
});

test("additive RED test must use the positive control production entrypoint", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource.replace(
    "import { calculate }",
    "import { alternate, calculate }",
  );
  const targetTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = alternate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");

  expect(() =>
    assertSemanticPositiveControl(`${baseline}${targetTest}`, {
      ...semanticControlOptions,
      baselineSource: baseline,
    }),
  ).toThrow(/same production entrypoint/);

  const namespaceBaseline = semanticControlSource
    .replace(
      'import { calculate } from "../src/x.ts";',
      'import * as api from "../src/x.ts";',
    )
    .replace('calculate("known-good")', 'api.calculate("known-good")');
  expect(() =>
    assertSemanticPositiveControl(
      `${namespaceBaseline}${targetTest.replace("alternate", "api.alternate")}`,
      {
        ...semanticControlOptions,
        baselineSource: namespaceBaseline,
      },
    ),
  ).toThrow(/same production entrypoint/);

  const aliasedBaseline = semanticControlSource
    .replace(
      'import { calculate } from "../src/x.ts";',
      'import { calculate as controlCalculate, calculate as redCalculate } from "../src/x.ts";',
    )
    .replace('calculate("known-good")', 'controlCalculate("known-good")');
  expect(() =>
    assertSemanticPositiveControl(
      `${aliasedBaseline}${targetTest.replace("alternate", "redCalculate")}`,
      {
        ...semanticControlOptions,
        baselineSource: aliasedBaseline,
      },
    ),
  ).not.toThrow();
});

test("semantic positive control preserves lexical production taint", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource
    .replace(
      "import { calculate }",
      "import { alternate, calculate }",
    )
    .replace(
      '  const actual = calculate("known-good");',
      [
        '  const actual = calculate("known-good");',
        '  { const actual = alternate("nested"); }',
      ].join("\n"),
    );
  const alternateRed = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = alternate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const options = { ...semanticControlOptions, baselineSource: baseline };

  expect(() =>
    assertSemanticPositiveControl(`${baseline}${alternateRed}`, options),
  ).toThrow(/same production entrypoint/);
  expect(() =>
    assertSemanticPositiveControl(
      `${baseline}${alternateRed.replace("alternate", "calculate")}`,
      options,
    ),
  ).not.toThrow();

  const importShadow = semanticControlSource.replace(
    '  const actual = calculate("known-good");',
    [
      "  {",
      '    const calculate = () => "nested";',
      "    calculate();",
      "  }",
      '  const actual = calculate("known-good");',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(importShadow, semanticControlOptions),
  ).not.toThrow();

  const alternateControl = semanticControlSource.replace(
    "import { calculate }",
    "import { alternate, calculate }",
  );
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    alternateControl.replace(causalBody, lines.join("\n"));

  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  let actual = "placeholder";',
        '  actual = calculate("known-good");',
        '  expect(actual).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).not.toThrow();
  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  let actual = calculate("known-good");',
        '  actual = "expected";',
        '  expect(actual).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).toThrow(/production call result.*expect/);
  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  const { value = "forged" } = calculate("known-good");',
        '  expect(value).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).toThrow(/production call result.*expect|ambiguous/);
  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  let actual = calculate("known-good");',
        "  const mutate = () => {",
        '    actual = alternate("nested");',
        "  };",
        '  expect(actual).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).not.toThrow();

  const ambiguousWrites = [
    [
      '  let actual = calculate("known-good");',
      "  if (process.env.ORCA_BRANCH) {",
      '    actual = alternate("branch");',
      "  }",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  for (const value of ["loop"]) {',
      "    actual = alternate(value);",
      "  }",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      "  switch (process.env.ORCA_BRANCH) {",
      '    case "alternate":',
      '      actual = alternate("switch");',
      "      break;",
      "  }",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      "  try {",
      '    actual = alternate("try");',
      "  } catch {",
      '    actual = calculate("catch");',
      "  }",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  actual ||= alternate("compound");',
      '  expect(actual).toBe("expected");',
    ],
  ] as const;
  for (const lines of ambiguousWrites) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*expect|ambiguous/);
  }
});

test("semantic positive control rejects writes nested in evaluated setup", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    semanticControlSource.replace(causalBody, lines.join("\n"));
  const forgedBodies = [
    [
      '  let actual = calculate("known-good");',
      '  let ignored = "before";',
      '  ignored = (actual = "expected");',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const ignored = String((actual = "expected"));',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const ignored = { [actual = "expected"]: true };',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const ignored = `${(actual = "expected")}`;',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const [ignored = (actual = "expected")] = [];',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const { [actual = "expected"]: ignored } = {};',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      "  const ignored = process.env.ORCA_BRANCH",
      '    ? (actual = "expected")',
      '    : "unchanged";',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const ignored = ((value = (actual = "expected")) => value)();',
      '  expect(actual).toBe("expected");',
    ],
  ] as const;

  for (const lines of forgedBodies) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*expect/);
  }

  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  const actual = calculate("known-good");',
        '  const label = "pure";',
        '  const alias = actual;',
        '  expect(alias).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).not.toThrow();
});

test("semantic positive control rejects unproved evaluated behavior", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const causalBody = [
    '  const actual = calculate("known-good");',
    '  expect(actual).toBe("expected");',
  ].join("\n");
  const replaceCausalBody = (lines: readonly string[]): string =>
    semanticControlSource.replace(causalBody, lines.join("\n"));
  const unsafeBodies = [
    [
      "  function mutate() {",
      '    actual = "expected";',
      "  }",
      '  let actual = calculate("known-good");',
      "  mutate();",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  const mutate = () => { actual = "expected"; };',
      "  mutate();",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  (() => { actual = "expected"; })();',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  const actor = { mutate() { actual = "expected"; } };',
      '  let actual = calculate("known-good");',
      "  actor.mutate();",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  class Mutator { constructor() { actual = "expected"; } }',
      '  let actual = calculate("known-good");',
      "  new Mutator();",
      '  expect(actual).toBe("expected");',
    ],
    [
      '  const actor = { get value() { actual = "expected"; return 1; } };',
      '  let actual = calculate("known-good");',
      "  const ignored = actor.value;",
      '  expect(actual).toBe("expected");',
    ],
    [
      "  const values = [1];",
      '  let actual = calculate("known-good");',
      '  values.forEach(() => { actual = "expected"; });',
      '  expect(actual).toBe("expected");',
    ],
    [
      '  let actual = calculate("known-good");',
      '  class Mutator { static { actual = "expected"; } }',
      '  expect(actual).toBe("expected");',
    ],
  ] as const;

  for (const lines of unsafeBodies) {
    expect(() =>
      assertSemanticPositiveControl(
        replaceCausalBody(lines),
        semanticControlOptions,
      ),
    ).toThrow(/production call result.*expect/);
  }

  expect(() =>
    assertSemanticPositiveControl(
      replaceCausalBody([
        '  let actual = calculate("known-good");',
        '  function deferred() { actual = "later"; }',
        '  const alsoDeferred = () => { actual = "later"; };',
        '  expect(actual).toBe("expected");',
      ]),
      semanticControlOptions,
    ),
  ).not.toThrow();
});

test("additive RED rejects a nested literal overwrite", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource;
  const forgedTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  let actual = calculate("defect");',
    '  const ignored = (actual = "expected");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const validTest = forgedTest.replace(
    '  const ignored = (actual = "expected");',
    '  const ignored = "pure";\n  const alias = actual;',
  ).replace("expect(actual)", "expect(alias)");
  const selfFulfillingTest = forgedTest.replace(
    '  const ignored = (actual = "expected");',
    "  const alias = actual;",
  ).replace('toBe("expected")', "toBe(alias)");
  const options = { ...semanticControlOptions, baselineSource: baseline };

  expect(() =>
    assertSemanticPositiveControl(`${baseline}${forgedTest}`, options),
  ).toThrow(/candidate RED test.*causally production-bound/);
  expect(() =>
    assertSemanticPositiveControl(`${baseline}${selfFulfillingTest}`, options),
  ).toThrow(/candidate RED test.*causally production-bound/);
  expect(() =>
    assertSemanticPositiveControl(`${baseline}${validTest}`, options),
  ).not.toThrow();
});

test("additive RED proof rejects non-test bytes and disabling directives", async () => {
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const baseline = semanticControlSource;
  const targetTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("defect");',
    '  expect(actual).toBe("expected");',
    '});',
    "",
  ].join("\n");
  const options = { ...semanticControlOptions, baselineSource: baseline };

  const safeDirectiveSpellings = targetTest.replace(
    '  const actual = calculate("defect");',
    [
      '  const directiveText = "eslint-disable @ts-nocheck @ts-ignore @ts-expect-error";',
      "  /* ordinary rationale */",
      '  const actual = calculate("defect");',
    ].join("\n"),
  );
  expect(() =>
    assertSemanticPositiveControl(
      `${baseline} \n\t${safeDirectiveSpellings}\n\t`,
      options,
    ),
  ).not.toThrow();
  expect(() =>
    assertSemanticPositiveControl(
      baseline.replace(
        'test("control x", () => {',
        ` \n\t${targetTest}\ntest("control x", () => {`,
      ),
      options,
    ),
  ).not.toThrow();

  for (const source of [
    `/* eslint-disable */\n${baseline}${targetTest}`,
    `// @ts-nocheck\n${baseline}${targetTest}`,
    `\n${baseline}${targetTest}`,
    `${baseline}${targetTest}/* eslint-disable */\n`,
    `${baseline}${targetTest.replace(
      '  const actual = calculate("defect");',
      '  /* eslint-disable */\n  const actual = calculate("defect");',
    )}`,
    `${baseline}${targetTest.replace(
      '  const actual = calculate("defect");',
      '  // @ts-nocheck\n  const actual = calculate("defect");',
    )}`,
    `${baseline}${targetTest.replace(
      '  const actual = calculate("defect");',
      '  // @ts-ignore\n  const actual = calculate("defect");',
    )}`,
    `${baseline}${targetTest.replace(
      '  const actual = calculate("defect");',
      '  // @ts-expect-error\n  const actual = calculate("defect");',
    )}`,
    `${baseline}// ordinary leading comment\n${targetTest}`,
  ]) {
    expect(() => assertSemanticPositiveControl(source, options)).toThrow(
      /exactly one additive top-level test|disabling directive/,
    );
  }
});

test("lossless UTF-8 source decoding preserves BOM for additive proof", async () => {
  const decodeUtf8Source = await utf8SourceDecoderRuntime();
  const assertSemanticPositiveControl = await semanticPositiveControlRuntime();
  const encodedBaseline = new TextEncoder().encode(semanticControlSource);
  const baselineBytes = new Uint8Array(encodedBaseline.length + 3);
  baselineBytes.set([0xef, 0xbb, 0xbf]);
  baselineBytes.set(encodedBaseline, 3);
  const baselineSource = decodeUtf8Source(baselineBytes, "baseline test source");
  const targetTest = [
    'test("target regression ORCA_RED:candidate-x", () => {',
    '  const actual = calculate("defect");',
    '  expect(actual).toBe("expected");',
    "});",
    "",
  ].join("\n");

  expect(baselineSource.charCodeAt(0)).toBe(0xfeff);
  expect(() =>
    assertSemanticPositiveControl(`${semanticControlSource}${targetTest}`, {
      ...semanticControlOptions,
      baselineSource,
    }),
  ).toThrow(/exactly one additive top-level test/);
  expect(() =>
    decodeUtf8Source(new Uint8Array([0xff]), "invalid test source"),
  ).toThrow(/invalid test source.*valid UTF-8/);
});

test("awaitBounded rejects by deadline without leaking cancellation rejection", async () => {
  const cancellationError = new Error("subprocess did not exit after SIGKILL");
  const cancellationReasons: string[] = [];
  const unhandled: unknown[] = [];
  let settleOutcome!: (value: { readonly type: "cancelled" }) => void;
  const outcome = new Promise<{ readonly type: "cancelled" }>((resolve) => {
    settleOutcome = resolve;
  });
  const recordUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", recordUnhandled);
  try {
    await expect(
      settleWithin(
        awaitBounded(
          {
            awaitResult: () => outcome,
            cancel: async (reason) => {
              cancellationReasons.push(reason ?? "");
              await Bun.sleep(10);
              settleOutcome({ type: "cancelled" });
              throw cancellationError;
            },
          },
          5,
          "reproduce",
          50,
        ),
        100,
      ),
    ).rejects.toThrow("reproduce exceeded 5ms");
    await Bun.sleep(20);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }

  expect(cancellationReasons).toEqual(["reproduce exceeded 5ms"]);
  expect(unhandled).toEqual([]);
});

test("awaitBounded waits for timeout cancellation to finish before rejecting", async () => {
  const writes: string[] = [];
  let settleOutcome!: (value: { readonly type: "cancelled"; readonly reason: string }) => void;
  const outcome = new Promise<{ readonly type: "cancelled"; readonly reason: string }>(
    (resolve) => {
      settleOutcome = resolve;
    },
  );
  const conversation = {
    awaitResult: () => outcome,
    async cancel(reason = ""): Promise<void> {
      await Bun.sleep(20);
      writes.push("writer stopped");
      settleOutcome({ type: "cancelled", reason });
    },
  };

  await expect(
    settleWithin(awaitBounded(conversation, 5, "implement", 50), 100),
  ).rejects.toThrow("implement exceeded 5ms");
  expect(writes).toEqual(["writer stopped"]);
  await Bun.sleep(30);
  expect(writes).toEqual(["writer stopped"]);
});

test("awaitBounded rejects after resolved cancellation reaches terminal outcome", async () => {
  let settleOutcome!: (value: { readonly type: "cancelled" }) => void;
  const outcome = new Promise<{ readonly type: "cancelled" }>((resolve) => {
    settleOutcome = resolve;
  });
  await expect(
    settleWithin(
      awaitBounded(
        {
          awaitResult: () => outcome,
          async cancel(): Promise<void> {
            settleOutcome({ type: "cancelled" });
          },
        },
        5,
        "review",
        50,
      ),
      100,
    ),
  ).rejects.toThrow("review exceeded 5ms");
});

test("awaitBounded bounds hung cancellation with the settlement reserve", async () => {
  await expect(
    settleWithin(
      awaitBounded(
        {
          awaitResult: () => new Promise<never>(() => {}),
          cancel: () => new Promise<void>(() => {}),
        },
        5,
        "review",
        10,
      ),
      100,
    ),
  ).rejects.toThrow("review cancellation did not settle within 10ms");
});

test("awaitBounded rejects settlement that synchronously blocks past its reserve", async () => {
  let settleOutcome!: (value: { readonly type: "cancelled" }) => void;
  const outcome = new Promise<{ readonly type: "cancelled" }>((resolve) => {
    settleOutcome = resolve;
  });

  await expect(
    awaitBounded(
      {
        awaitResult: () => outcome,
        async cancel(): Promise<void> {
          const blockedUntil = Date.now() + 25;
          while (Date.now() < blockedUntil) {}
          settleOutcome({ type: "cancelled" });
        },
      },
      1,
      "blocked cancellation",
      5,
    ),
  ).rejects.toThrow(
    "blocked cancellation cancellation did not settle within 5ms",
  );
});

test("awaitBounded clears timeout after a timely outcome", async () => {
  let cancelCount = 0;
  const result = await awaitBounded(
    {
      async awaitResult(): Promise<string> {
        return "success";
      },
      async cancel(): Promise<void> {
        cancelCount += 1;
      },
    },
    5,
    "review",
  );
  await Bun.sleep(10);

  expect(result).toBe("success");
  expect(cancelCount).toBe(0);
});

test("awaitBounded times out terminal success after synchronous event-loop blocking", async () => {
  let cancelCount = 0;
  let spinCount = 0;
  let thrown: unknown;

  try {
    await awaitBounded(
      {
        async awaitResult(): Promise<string> {
          const blockedUntil = Date.now() + 25;
          while (Date.now() < blockedUntil) spinCount += 1;
          return "late success";
        },
        async cancel(): Promise<void> {
          cancelCount += 1;
        },
      },
      5,
      "blocked success",
      50,
    );
  } catch (error) {
    thrown = error;
  }

  expect(spinCount).toBeGreaterThan(0);
  expect(cancelCount).toBe(0);
  expect(thrown).toBeInstanceOf(ConversationTimeoutError);
  const timeout = thrown as ConversationTimeoutError;
  expect(timeout.message).toBe("blocked success exceeded 5ms");
  expect(timeout.terminal?.status).toBe("fulfilled");
  if (timeout.terminal?.status === "fulfilled") {
    expect(timeout.terminal.value).toBe("late success");
  }
});

test("awaitBounded owns late terminal rejection without cancelling a settled run", async () => {
  const terminalError = new Error("late backend rejection");
  let cancelCount = 0;
  let thrown: unknown;

  try {
    await awaitBounded(
      {
        async awaitResult(): Promise<string> {
          const blockedUntil = Date.now() + 25;
          let spins = 0;
          while (Date.now() < blockedUntil) spins += 1;
          if (spins === 0) throw new Error("clock did not advance");
          throw terminalError;
        },
        async cancel(): Promise<void> {
          cancelCount += 1;
        },
      },
      5,
      "blocked rejection",
      50,
    );
  } catch (error) {
    thrown = error;
  }

  expect(cancelCount).toBe(0);
  expect(thrown).toBeInstanceOf(ConversationTimeoutError);
  const timeout = thrown as ConversationTimeoutError;
  expect(timeout.message).toBe("blocked rejection exceeded 5ms");
  expect(timeout.terminal?.status).toBe("rejected");
  if (timeout.terminal?.status === "rejected") {
    expect(timeout.terminal.reason).toBe(terminalError);
  }
});

test("awaitBounded treats exact deadline equality as timeout", async () => {
  let clockMs = 0;
  let cancelCount = 0;

  await expect(
    awaitBounded(
      {
        async awaitResult(): Promise<string> {
          clockMs = 5;
          return "equal deadline";
        },
        async cancel(): Promise<void> {
          cancelCount += 1;
        },
      },
      5,
      "equal deadline",
      50,
      () => clockMs,
    ),
  ).rejects.toThrow("equal deadline exceeded 5ms");
  expect(cancelCount).toBe(0);
});

test("conversation timeout allocation reserves terminal settlement", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const reserveConversationTimeouts = runtime.reserveConversationTimeouts;
  expect(reserveConversationTimeouts).toBeFunction();
  if (typeof reserveConversationTimeouts !== "function") return;

  expect(reserveConversationTimeouts(80, 40, 5, "scout")).toEqual({
    activeTimeoutMs: 40,
    settlementTimeoutMs: 5,
  });
  expect(reserveConversationTimeouts(35, 40, 5, "scout")).toEqual({
    activeTimeoutMs: 30,
    settlementTimeoutMs: 5,
  });
  expect(() =>
    reserveConversationTimeouts(1, 40, 5, "scout"),
  ).toThrow("sla-overrun before scout conversation");
});

test("awaitOneTimeoutRetry retries one exact attempt timeout", async () => {
  const seen: Array<{
    attempt: number;
    timeoutMs: number;
    settlementTimeoutMs: number;
    label: string;
  }> = [];
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      seen.push(attempt);
      if (attempt.attempt === 1) {
        return {
          type: "cancelled",
          reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
        } as const;
      }
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
    },
  );

  expect(seen).toEqual([
    {
      attempt: 1,
      timeoutMs: 40,
      settlementTimeoutMs: 5,
      label: "scout attempt 1",
    },
    {
      attempt: 2,
      timeoutMs: 40,
      settlementTimeoutMs: 5,
      label: "scout attempt 2",
    },
  ]);
  expect(result.outcome).toEqual({ type: "success" });
  expect(result.attempts.map(({ attempt, timedOut }) => ({ attempt, timedOut })))
    .toEqual([
      { attempt: 1, timedOut: true },
      { attempt: 2, timedOut: false },
    ]);
});

test("awaitOneTimeoutRetry retries a real settled awaitBounded timeout", async () => {
  const calls: number[] = [];
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      calls.push(attempt.attempt);
      if (attempt.attempt === 2) {
        return await awaitBounded(
          {
            async awaitResult() {
              return { type: "success" as const };
            },
            async cancel(): Promise<void> {
              throw new Error("timely outcome must not cancel");
            },
          },
          attempt.timeoutMs,
          attempt.label,
          20,
        );
      }
      let settleOutcome!: (value: {
        readonly type: "cancelled";
        readonly reason: string;
        readonly result: { readonly usage: { readonly input: 2; readonly output: 1 } };
      }) => void;
      const outcome = new Promise<{
        readonly type: "cancelled";
        readonly reason: string;
        readonly result: { readonly usage: { readonly input: 2; readonly output: 1 } };
      }>((resolve) => {
        settleOutcome = resolve;
      });
      return await awaitBounded(
        {
          awaitResult: () => outcome,
          async cancel(reason = ""): Promise<void> {
            await Bun.sleep(1);
            settleOutcome({
              type: "cancelled",
              reason,
              result: { usage: { input: 2, output: 1 } },
            });
          },
        },
        attempt.timeoutMs,
        attempt.label,
        20,
      );
    },
    {
      stage: "scout",
      totalTimeoutMs: 100,
      attemptTimeoutMs: 10,
      settlementTimeoutMs: 5,
    },
  );

  expect(calls).toEqual([1, 2]);
  expect(result.outcome).toEqual({ type: "success" });
  expect(result.attempts.map((attempt) => attempt.timedOut)).toEqual([
    true,
    false,
  ]);
  expect(result.attempts[0]?.terminal?.status).toBe("fulfilled");
  if (result.attempts[0]?.terminal?.status === "fulfilled") {
    expect(result.attempts[0].terminal.usage).toEqual({ input: 2, output: 1 });
  }
});

test("awaitOneTimeoutRetry keeps rejected terminal evidence JSON-safe", async () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      if (attempt.attempt === 1) {
        throw new ConversationTimeoutError(
          attempt.label,
          attempt.timeoutMs,
          {
            status: "rejected",
            reason: cyclic,
            completedAtMs: 0,
          },
        );
      }
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
    },
  );

  expect(() => JSON.stringify(result.attempts)).not.toThrow();
  expect(result.attempts[0]?.terminal).toEqual({
    status: "rejected",
    completedAtMs: 0,
    reason: "[object Object]",
  });
});

test("awaitOneTimeoutRetry returns a final cancelled outcome after two real timeouts", async () => {
  let calls = 0;
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      calls += 1;
      let settleOutcome!: (value: {
        readonly type: "cancelled";
        readonly reason: string;
      }) => void;
      const outcome = new Promise<{
        readonly type: "cancelled";
        readonly reason: string;
      }>((resolve) => {
        settleOutcome = resolve;
      });
      return await awaitBounded(
        {
          awaitResult: () => outcome,
          async cancel(reason = ""): Promise<void> {
            settleOutcome({ type: "cancelled", reason });
          },
        },
        attempt.timeoutMs,
        attempt.label,
        20,
      );
    },
    {
      stage: "scout",
      totalTimeoutMs: 100,
      attemptTimeoutMs: 10,
      settlementTimeoutMs: 5,
    },
  );

  expect(calls).toBe(2);
  expect(result.outcome).toEqual({
    type: "cancelled",
    reason: "scout attempt 2 exceeded 10ms",
  });
  expect(result.attempts.map((attempt) => attempt.timedOut)).toEqual([
    true,
    true,
  ]);
});

for (const terminal of [
  { type: "cancelled", reason: "operator cancelled" },
  { type: "failed", reason: "backend unavailable" },
] as const) {
  test(`awaitOneTimeoutRetry does not retry ${terminal.type} without its exact timeout`, async () => {
    let calls = 0;
    const result = await awaitOneTimeoutRetry(
      async () => {
        calls += 1;
        return terminal;
      },
      {
        stage: "scout",
        totalTimeoutMs: 80,
        attemptTimeoutMs: 40,
        settlementTimeoutMs: 5,
      },
    );

    expect(calls).toBe(1);
    expect(result.outcome).toEqual(terminal);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.timedOut).toBe(false);
  });
}

test("awaitOneTimeoutRetry stops after a second exact timeout", async () => {
  let calls = 0;
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      calls += 1;
      return {
        type: "cancelled",
        reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
      } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
    },
  );

  expect(calls).toBe(2);
  expect(result.outcome.type).toBe("cancelled");
  expect(result.attempts.map((attempt) => attempt.timedOut)).toEqual([
    true,
    true,
  ]);
});

test("awaitOneTimeoutRetry gives the retry only the remaining total budget", async () => {
  let clockMs = 0;
  const seenTimeouts: number[] = [];
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      seenTimeouts.push(attempt.timeoutMs);
      if (attempt.attempt === 1) {
        clockMs = 45;
        return {
          type: "cancelled",
          reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
        } as const;
      }
      clockMs = 50;
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockMs,
    },
  );

  expect(seenTimeouts).toEqual([40, 30]);
  expect(result.outcome).toEqual({ type: "success" });
  expect(result.attempts.map((attempt) => attempt.durationMs)).toEqual([
    45,
    5,
  ]);
});

test("awaitOneTimeoutRetry converts overdue first success into an exact timeout", async () => {
  let clockMs = 0;
  const seenTimeouts: number[] = [];
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      seenTimeouts.push(attempt.timeoutMs);
      if (attempt.attempt === 1) {
        clockMs = 40;
        return {
          type: "success",
          result: { usage: { input: 3, output: 2 } },
        } as const;
      }
      clockMs = 50;
      return {
        type: "success",
        result: { usage: { input: 5, output: 4 } },
      } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockMs,
    },
  );

  expect(seenTimeouts).toEqual([40, 35]);
  expect(result.outcome).toEqual({
    type: "success",
    result: { usage: { input: 5, output: 4 } },
  });
  expect(result.attempts).toEqual([
    {
      attempt: 1,
      timeoutMs: 40,
      settlementTimeoutMs: 5,
      label: "scout attempt 1",
      durationMs: 40,
      outcomeType: "cancelled",
      timedOut: true,
      terminal: {
        status: "fulfilled",
        completedAtMs: 40,
        outcomeType: "success",
        usage: { input: 3, output: 2 },
      },
    },
    {
      attempt: 2,
      timeoutMs: 35,
      settlementTimeoutMs: 5,
      label: "scout attempt 2",
      durationMs: 10,
      outcomeType: "success",
      timedOut: false,
    },
  ]);
});

test("awaitOneTimeoutRetry never accepts overdue second or total-deadline success", async () => {
  let clockMs = 0;
  let calls = 0;
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      calls += 1;
      if (attempt.attempt === 1) {
        clockMs = 41;
        return {
          type: "cancelled",
          reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
        } as const;
      }
      clockMs = 81;
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockMs,
    },
  );

  expect(calls).toBe(2);
  expect(result.outcome).toEqual({
    type: "cancelled",
    reason: "scout attempt 2 exceeded 34ms",
  });
  expect(result.attempts.map((attempt) => attempt.timedOut)).toEqual([
    true,
    true,
  ]);
});

test("awaitOneTimeoutRetry makes no second call at zero total remainder", async () => {
  let clockMs = 0;
  let calls = 0;
  const result = await awaitOneTimeoutRetry(
    async () => {
      calls += 1;
      clockMs = 80;
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockMs,
    },
  );

  expect(calls).toBe(1);
  expect(result.outcome).toEqual({
    type: "cancelled",
    reason: "scout attempt 1 exceeded 40ms",
  });
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]?.timedOut).toBe(true);
});

test("awaitOneTimeoutRetry snapshots one remainder for retry allocation", async () => {
  const clockReads = [0, 0, 0, 40, 78, 78, 79];
  let calls = 0;

  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      calls += 1;
      if (attempt.attempt === 1) {
        return {
          type: "cancelled",
          reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
        } as const;
      }
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockReads.shift() ?? 79,
    },
  );

  expect(calls).toBe(2);
  expect(result.outcome).toEqual({
    type: "cancelled",
    reason: "scout attempt 2 exceeded 35ms",
  });
});

test("awaitOneTimeoutRetry reserves settlement inside the shared total budget", async () => {
  let clockMs = 0;
  const seen: Array<{
    readonly timeoutMs: number;
    readonly settlementTimeoutMs: number;
  }> = [];
  const result = await awaitOneTimeoutRetry(
    async (attempt) => {
      seen.push({
        timeoutMs: attempt.timeoutMs,
        settlementTimeoutMs: attempt.settlementTimeoutMs,
      });
      if (attempt.attempt === 1) {
        clockMs = 45;
        return {
          type: "cancelled",
          reason: `${attempt.label} exceeded ${String(attempt.timeoutMs)}ms`,
        } as const;
      }
      clockMs = 50;
      return { type: "success" } as const;
    },
    {
      stage: "scout",
      totalTimeoutMs: 80,
      attemptTimeoutMs: 40,
      settlementTimeoutMs: 5,
      now: () => clockMs,
    },
  );

  expect(seen).toEqual([
    { timeoutMs: 40, settlementTimeoutMs: 5 },
    { timeoutMs: 30, settlementTimeoutMs: 5 },
  ]);
  expect(result.outcome).toEqual({ type: "success" });
});

test("awaitWithinDeadline rejects a delayed operation at shared remainder", async () => {
  let operationSettled = false;
  const guarded = awaitWithinDeadline(
    "filesystem read",
    () => 10,
    async () => {
      await Bun.sleep(50);
      operationSettled = true;
      return "late";
    },
  );

  await expect(guarded).rejects.toThrow(
    "filesystem read exceeded shared deadline after 10ms",
  );
  expect(operationSettled).toBe(false);
  await Bun.sleep(60);
});

test("awaitWithinDeadline succeeds timely and clears its warning timer", async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearCount = 0;
  const observedClearTimeout: typeof clearTimeout = (timer) => {
    clearCount += 1;
    originalClearTimeout(timer);
  };
  globalThis.clearTimeout = observedClearTimeout;
  try {
    const result = await awaitWithinDeadline(
      "git status",
      () => 20,
      async () => "clean",
    );
    expect(result).toBe("clean");
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
  expect(clearCount).toBe(1);
});

test("awaitWithinDeadline rejects synchronous late success", async () => {
  await expect(
    awaitWithinDeadline("blocked read", () => 5, async () => {
      const blockedUntil = Date.now() + 25;
      let spins = 0;
      while (Date.now() < blockedUntil) spins += 1;
      if (spins === 0) throw new Error("clock did not advance");
      return "late success";
    }),
  ).rejects.toThrow("blocked read exceeded shared deadline after 5ms");
});

test("awaitWithinDeadline preserves late rejection as timeout cause", async () => {
  const operationError = new Error("late read rejection");
  let thrown: unknown;
  try {
    await awaitWithinDeadline("blocked rejection", () => 5, async () => {
      const blockedUntil = Date.now() + 25;
      let spins = 0;
      while (Date.now() < blockedUntil) spins += 1;
      if (spins === 0) throw new Error("clock did not advance");
      throw operationError;
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(
    "blocked rejection exceeded shared deadline after 5ms",
  );
  expect((thrown as Error).cause).toBe(operationError);
});

test("awaitWithinDeadline rejects a 5,001 ms delayed CI poll wake", async () => {
  let clockMs = 0;
  let releaseWake: (() => void) | undefined;
  const delayedWake = new Promise<void>((resolve) => {
    releaseWake = resolve;
  });
  const guarded = awaitWithinDeadline(
    "CI poll interval",
    () => 5_001,
    async () => {
      await delayedWake;
      return "late wake";
    },
    () => clockMs,
  );

  clockMs = 5_001;
  releaseWake?.();

  await expect(guarded).rejects.toThrow(
    "CI poll interval exceeded shared deadline after 5001ms",
  );
});

test("awaitWithinDeadline does not rebase a dynamic absolute remainder", async () => {
  let clockMs = 1;
  const guarded = awaitWithinDeadline(
    "absolute cutoff",
    () => 10 - clockMs,
    async () => {
      clockMs = 10;
      return "at cutoff";
    },
    () => {
      if (clockMs === 1) clockMs = 2;
      return clockMs;
    },
  );

  await expect(guarded).rejects.toThrow(
    "absolute cutoff exceeded shared deadline",
  );
});

test("awaitWithinDeadline rejects equality and accepts strict timely completion", async () => {
  let clockMs = 0;
  await expect(
    awaitWithinDeadline(
      "equal completion",
      () => 5,
      async () => {
        clockMs = 5;
        return "equal";
      },
      () => clockMs,
    ),
  ).rejects.toThrow("equal completion exceeded shared deadline after 5ms");

  clockMs = 0;
  const timely = await awaitWithinDeadline(
    "timely completion",
    () => 5,
    async () => {
      clockMs = 4;
      return "timely";
    },
    () => clockMs,
  );
  expect(timely).toBe("timely");
});

test("terminal gather status cannot commit evidence after deadline overrun", async () => {
  const evidence: string[] = [];
  await expect(
    (async () => {
      const status = await awaitWithinDeadline(
        "terminal gather status",
        () => 5,
        async () => {
          const blockedUntil = Date.now() + 25;
          let spins = 0;
          while (Date.now() < blockedUntil) spins += 1;
          if (spins === 0) throw new Error("clock did not advance");
          return "clean";
        },
      );
      evidence.push(status);
    })(),
  ).rejects.toThrow(
    "terminal gather status exceeded shared deadline after 5ms",
  );
  expect(evidence).toEqual([]);
});

test("awaitWithinDeadline rejects a non-positive shared remainder", async () => {
  let called = false;
  await expect(
    awaitWithinDeadline("evidence hash", () => 0, async () => {
      called = true;
    }),
  ).rejects.toThrow("evidence hash exceeded shared deadline after 0ms");
  expect(called).toBe(false);
});

test("post-persistence budget assertion rejects an exhausted remainder", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const assertRemainingBudget = runtime.assertRemainingBudget;
  expect(assertRemainingBudget).toBeFunction();
  if (typeof assertRemainingBudget !== "function") {
    throw new Error("assertRemainingBudget runtime helper is missing");
  }
  const assertBudget = assertRemainingBudget as (
    remainingMs: number,
    operation: string,
  ) => void;

  expect(() => assertBudget(0, "red diff persistence")).toThrow(
    "sla-overrun after red diff persistence",
  );
  expect(() => assertBudget(1, "red diff persistence")).not.toThrow();
});

for (const eventType of [
  "assistant_tool_call",
  "tool_result",
] as const) {
  test(`awaitToolFreeOutcome rejects ${eventType} concurrently`, async () => {
    const event: ConversationEvent =
      eventType === "assistant_tool_call"
        ? {
            type: "assistant_tool_call",
            id: "tool-1",
            name: "read",
            input: { path: "src/a.ts" },
          }
        : {
            type: "tool_result",
            toolCallId: "tool-1",
            output: "unexpected",
            isError: false,
          };
    let cancelCount = 0;
    let settleOutcome!: (value: string) => void;
    const outcome = new Promise<string>((resolve) => {
      settleOutcome = resolve;
    });
    const conversation = {
      async *events(): AsyncIterable<ConversationEvent> {
        yield event;
      },
      async cancel(): Promise<void> {
        cancelCount += 1;
        settleOutcome("cancelled");
      },
    };

    const guarded = awaitToolFreeOutcome(conversation, () => outcome);
    await expect(settleWithin(guarded, 100)).rejects.toThrow(
      `scout attempted tool use: ${eventType}`,
    );
    expect(cancelCount).toBe(1);
  });
}

test("awaitToolFreeOutcome stops its event drain when terminal settles", async () => {
  let closeCalls = 0;
  const iterator: AsyncIterator<ConversationEvent> = {
    next: () => new Promise<never>(() => {}),
    return: () => {
      closeCalls += 1;
      return new Promise<never>(() => {});
    },
  };
  const conversation = {
    events(): AsyncIterable<ConversationEvent> {
      return {
        [Symbol.asyncIterator]: () => iterator,
      };
    },
    async cancel(): Promise<void> {
      throw new Error("tool-free terminal must not cancel");
    },
  };

  await expect(
    settleWithin(
      awaitToolFreeOutcome(conversation, async () => "completed"),
      100,
    ),
  ).resolves.toBe("completed");
  expect(closeCalls).toBe(1);
});

test("awaitToolFreeOutcome preserves an observed violation while closing", async () => {
  const terminal = Promise.withResolvers<string>();
  let nextCalls = 0;
  let closeCalls = 0;
  const iterator: AsyncIterator<ConversationEvent> = {
    next: () => {
      nextCalls += 1;
      if (nextCalls === 1) {
        return Promise.resolve({
          done: false,
          value: {
            type: "assistant_tool_call",
            id: "tool-1",
            name: "read",
            input: { path: "src/a.ts" },
          },
        });
      }
      return new Promise<never>(() => {});
    },
    return: () => {
      closeCalls += 1;
      return new Promise<never>(() => {});
    },
  };
  const conversation = {
    events(): AsyncIterable<ConversationEvent> {
      return {
        [Symbol.asyncIterator]: () => iterator,
      };
    },
    async cancel(): Promise<void> {
      terminal.resolve("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitToolFreeOutcome(conversation, () => terminal.promise),
      100,
    ),
  ).rejects.toThrow("scout attempted tool use: assistant_tool_call");
  expect(closeCalls).toBe(1);
});

function expectedFileChange(
  id: string,
  path: string,
): ConversationEvent {
  return {
    type: "assistant_tool_call",
    id,
    name: "file_change",
    input: { path },
  };
}

function fileChangeResult(
  toolCallId: string,
  isError = false,
): ConversationEvent {
  return {
    type: "tool_result",
    toolCallId,
    output: "applied",
    ...(isError ? { isError: true } : {}),
  };
}

test("awaitExpectedFileChange stops its event drain when terminal settles", async () => {
  let closeCalls = 0;
  const iterator: AsyncIterator<ConversationEvent> = {
    next: () => new Promise<never>(() => {}),
    return: () => {
      closeCalls += 1;
      return new Promise<never>(() => {});
    },
  };
  const conversation = {
    events(): AsyncIterable<ConversationEvent> {
      return {
        [Symbol.asyncIterator]: () => iterator,
      };
    },
    async cancel(): Promise<void> {
      throw new Error("terminal completion must not cancel");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        async () => "completed",
      ),
      100,
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "none",
    outcome: "completed",
  });
  expect(closeCalls).toBe(1);
});

test("awaitExpectedFileChange preserves an observed scope violation while closing", async () => {
  const terminal = Promise.withResolvers<string>();
  let nextCalls = 0;
  let closeCalls = 0;
  const iterator: AsyncIterator<ConversationEvent> = {
    next: () => {
      nextCalls += 1;
      if (nextCalls === 1) {
        return Promise.resolve({
          done: false,
          value: expectedFileChange("change-1", "src/off-target.ts"),
        });
      }
      return new Promise<never>(() => {});
    },
    return: () => {
      closeCalls += 1;
      return new Promise<never>(() => {});
    },
  };
  const conversation = {
    events(): AsyncIterable<ConversationEvent> {
      return {
        [Symbol.asyncIterator]: () => iterator,
      };
    },
    async cancel(): Promise<void> {
      terminal.resolve("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => terminal.promise,
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: src/off-target.ts");
  expect(closeCalls).toBe(1);
});

test("awaitExpectedFileChange continues after an applied edit and returns terminal success", async () => {
  const terminalSuccess = {
    type: "success",
    result: {
      backend: "codex",
      sessionId: "session-1",
      output: "regression test added",
      usage: { input: 11, output: 7 },
    },
  } as const;
  const terminal = Promise.withResolvers<typeof terminalSuccess>();
  let continuedAfterEdit = false;
  let cancelCount = 0;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1");
      continuedAfterEdit = true;
      terminal.resolve(terminalSuccess);
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  const result = await settleWithin(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      () => terminal.promise,
    ),
    100,
  );

  expect(cancelCount).toBe(0);
  expect(continuedAfterEdit).toBe(true);
  expect(result).toEqual({
    expectedFileChangeState: "applied",
    outcome: terminalSuccess,
  });
});

test("awaitExpectedFileChange exposes terminal failure after an applied edit", async () => {
  const terminalFailure = {
    type: "failed",
    error: {
      _tag: "BackendFailed",
      backend: "codex",
      message: "reproduction failed after editing",
    },
  } as const;
  let cancelCount = 0;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => terminalFailure,
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "applied",
    outcome: terminalFailure,
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange waits for terminal outcome after the matching applied result", async () => {
  let cancelCount = 0;
  const outcome = Promise.resolve("completed");
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "applied",
    outcome: "completed",
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange accepts Codex changes for the expected path", async () => {
  let cancelCount = 0;
  const outcome = Promise.resolve("completed");
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield {
        type: "assistant_tool_call",
        id: "change-1",
        name: "file_change",
        input: {
          changes: [
            {
              path: resolve("tests/a.test.ts"),
              kind: "update",
              diff: "@@ -1 +1 @@",
            },
          ],
        },
      };
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "applied",
    outcome: "completed",
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange preserves legacy path with metadata changes", async () => {
  let cancelCount = 0;
  const outcome = Promise.resolve("completed");
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield {
        type: "assistant_tool_call",
        id: "change-1",
        name: "file_change",
        input: {
          path: "tests/a.test.ts",
          changes: [{ op: "replace", line: 1 }],
        },
      };
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "applied",
    outcome: "completed",
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange rejects mixed Codex change paths", async () => {
  let cancelCount = 0;
  let settleOutcome!: (value: string) => void;
  const outcome = new Promise<string>((resolveOutcome) => {
    settleOutcome = resolveOutcome;
  });
  const offTargetPath = resolve("src/off-target.ts");
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield {
        type: "assistant_tool_call",
        id: "change-1",
        name: "file_change",
        input: {
          changes: [
            {
              path: resolve("tests/a.test.ts"),
              kind: "update",
              diff: "@@ -1 +1 @@",
            },
            {
              path: offTargetPath,
              kind: "update",
              diff: "@@ -1 +1 @@",
            },
          ],
        },
      };
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
      settleOutcome("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).rejects.toThrow(`unexpected file change: ${offTargetPath}`);
  expect(cancelCount).toBe(1);
});

test("awaitExpectedFileChange checks top-level and nested paths together", async () => {
  let settleOutcome!: (value: string) => void;
  const outcome = new Promise<string>((resolveOutcome) => {
    settleOutcome = resolveOutcome;
  });
  const offTargetPath = resolve("src/off-target.ts");
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield {
        type: "assistant_tool_call",
        id: "change-1",
        name: "file_change",
        input: {
          path: "tests/a.test.ts",
          changes: [
            {
              path: offTargetPath,
              kind: "update",
              diff: "@@ -1 +1 @@",
            },
          ],
        },
      };
    },
    async cancel(): Promise<void> {
      settleOutcome("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).rejects.toThrow(`unexpected file change: ${offTargetPath}`);
});

test("awaitExpectedFileChange rejects patch text without structured paths", async () => {
  let cancelCount = 0;
  let settleOutcome!: (value: string) => void;
  const outcome = new Promise<string>((resolveOutcome) => {
    settleOutcome = resolveOutcome;
  });
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield {
        type: "assistant_tool_call",
        id: "change-1",
        name: "file_change",
        input: {
          patch: `*** Update File: ${resolve("tests/a.test.ts")}`,
        },
      };
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
      settleOutcome("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: <unknown>");
  expect(cancelCount).toBe(1);
});

for (const [label, input] of [
  ["empty changes", { changes: [] }],
  ["non-array changes", { changes: "tests/a.test.ts" }],
  ["non-object change", { changes: [null] }],
  ["missing change path", { changes: [{ kind: "update" }] }],
  ["non-string change path", { changes: [{ path: 42 }] }],
  [
    "partly path-bearing changes",
    { changes: [{ path: "tests/a.test.ts" }, { kind: "update" }] },
  ],
] as const) {
  test(`awaitExpectedFileChange rejects ${label}`, async () => {
    let settleOutcome!: (value: string) => void;
    const outcome = new Promise<string>((resolveOutcome) => {
      settleOutcome = resolveOutcome;
    });
    const conversation = {
      async *events(): AsyncIterable<ConversationEvent> {
        yield {
          type: "assistant_tool_call",
          id: "change-1",
          name: "file_change",
          input,
        };
      },
      async cancel(): Promise<void> {
        settleOutcome("cancelled");
      },
    };

    await expect(
      settleWithin(
        awaitExpectedFileChange(
          conversation,
          "tests/a.test.ts",
          () => outcome,
        ),
        100,
      ),
    ).rejects.toThrow("unexpected file change: <unknown>");
  });
}

test("awaitExpectedFileChange rejects an off-target file change", async () => {
  let cancelCount = 0;
  let settleOutcome!: (value: string) => void;
  const outcome = new Promise<string>((resolve) => {
    settleOutcome = resolve;
  });
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "src/off-target.ts");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
      settleOutcome("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: src/off-target.ts");
  expect(cancelCount).toBe(1);
});

test("awaitExpectedFileChange observes terminal settlement before surfacing scope failure", async () => {
  const terminal = Promise.withResolvers<string>();
  let terminalObserved = false;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "src/off-target.ts");
    },
    async cancel(): Promise<void> {
      setTimeout(() => terminal.resolve("cancelled"), 5);
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        async () => {
          const outcome = await terminal.promise;
          terminalObserved = true;
          return outcome;
        },
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: src/off-target.ts");
  expect(terminalObserved).toBe(true);
});

test("awaitExpectedFileChange preserves terminal fallback without events", async () => {
  let cancelCount = 0;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {},
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "none",
    outcome: "success",
  });
  expect(cancelCount).toBe(0);
});

test("terminal-only exact Git change is proof but unconfirmed events are not", () => {
  expect(
    hasConfirmedExpectedFileChange(
      "none",
      ["tests/a.test.ts"],
      "tests/a.test.ts",
    ),
  ).toBe(true);
  expect(
    hasConfirmedExpectedFileChange(
      "applied",
      ["tests/a.test.ts"],
      "tests/a.test.ts",
    ),
  ).toBe(true);
  expect(
    hasConfirmedExpectedFileChange(
      "unconfirmed",
      ["tests/a.test.ts"],
      "tests/a.test.ts",
    ),
  ).toBe(false);
  expect(
    hasConfirmedExpectedFileChange("none", [], "tests/a.test.ts"),
  ).toBe(false);
});

test("awaitExpectedFileChange does not accept a started change", async () => {
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
    },
    async cancel(): Promise<void> {
      throw new Error("started change must not cancel");
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "unconfirmed",
    outcome: "success",
  });
});

test("awaitExpectedFileChange requires the matching tool-result ID", async () => {
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-2");
    },
    async cancel(): Promise<void> {
      throw new Error("unmatched result must not cancel");
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "unconfirmed",
    outcome: "success",
  });
});

test("awaitExpectedFileChange rejects a failed matching tool result", async () => {
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1", true);
    },
    async cancel(): Promise<void> {
      throw new Error("failed result must not cancel");
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "unconfirmed",
    outcome: "success",
  });
});

test("awaitExpectedFileChange rejects queued off-target work after success", async () => {
  let cancelCount = 0;
  let settleOutcome!: (value: string) => void;
  const outcome = new Promise<string>((resolve) => {
    settleOutcome = resolve;
  });
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1");
      yield expectedFileChange("change-2", "src/off-target.ts");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
      settleOutcome("cancelled");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        () => outcome,
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: src/off-target.ts");
  expect(cancelCount).toBe(1);
});

test("awaitExpectedFileChange retains every expected call ID", async () => {
  let cancelCount = 0;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield expectedFileChange("change-2", "tests/a.test.ts");
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "applied",
    outcome: "success",
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange consumes an ID on its failed result", async () => {
  let cancelCount = 0;
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "tests/a.test.ts");
      yield fileChangeResult("change-1", true);
      yield fileChangeResult("change-1");
    },
    async cancel(): Promise<void> {
      cancelCount += 1;
    },
  };

  await expect(
    awaitExpectedFileChange(
      conversation,
      "tests/a.test.ts",
      async () => "success",
    ),
  ).resolves.toEqual({
    expectedFileChangeState: "unconfirmed",
    outcome: "success",
  });
  expect(cancelCount).toBe(0);
});

test("awaitExpectedFileChange preserves off-target error when cancel rejects", async () => {
  const conversation = {
    async *events(): AsyncIterable<ConversationEvent> {
      yield expectedFileChange("change-1", "src/off-target.ts");
    },
    async cancel(): Promise<void> {
      throw new Error("subprocess did not exit after SIGKILL");
    },
  };

  await expect(
    settleWithin(
      awaitExpectedFileChange(
        conversation,
        "tests/a.test.ts",
        async () => "terminal failure",
      ),
      100,
    ),
  ).rejects.toThrow("unexpected file change: src/off-target.ts");
});

test("finalization shuts down once before artifacts and one terminal report", async () => {
  const events: string[] = [];

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
      },
    },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          events.push("issue ledger");
        },
      },
      {
        label: "monitor",
        run: async () => {
          events.push("monitor");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(events).toEqual(["shutdown", "issue ledger", "monitor", "report"]);
  expect(errors).toEqual([]);
});

test("finalization rejects a synchronous shutdown that returns after the absolute deadline", async () => {
  const events: string[] = [];
  const deadlineAt = Date.now() + 10;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => deadlineAt - Date.now(),
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
        while (Date.now() <= deadlineAt + 10) {
          // Deliberately block the timer queue past the shared absolute deadline.
        }
      },
    },
    artifacts: [
      {
        label: "monitor",
        run: async () => {
          events.push("monitor");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(events).toEqual(["shutdown", "failure state"]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toMatch(
    /^shutdown failed: shutdown exceeded shared deadline after \d+ms$/,
  );
});

test("publication commit owns the terminal deadline decision after its rename boundary", async () => {
  let remaining = 100;
  let target: { readonly sla: "passed" | "failed" } | undefined;
  const events: string[] = [];

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => remaining,
    shutdown: {
      label: "shutdown",
      run: async () => {
        remaining = 5;
      },
    },
    artifacts: [],
    report: {
      label: "report",
      run: async (context) => {
        const remainingAtReport = context.remainingMs();
        events.push("report prepared");
        const commit = context.commitPublication();
        events.push("publication committed");
        target = { sla: remainingAtReport > 0 ? "passed" : "failed" };
        remaining = 0;
        events.push("clock expired");
        return commit;
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(target).toEqual({ sla: "passed" });
  expect(events).toEqual([
    "report prepared",
    "publication committed",
    "clock expired",
  ]);
  expect(errors).toEqual([]);
});

test("finalization cleanup preserves the primary failure when cleanup also fails", () => {
  const primary = new Error("rename failed after publication commit");
  const cleanup = new Error("temporary cleanup failed");
  let thrown: unknown;

  try {
    rethrowAfterFinalizationCleanup(
      primary,
      () => {
        throw cleanup;
      },
      "report publication",
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AggregateError);
  const aggregate = thrown as AggregateError;
  expect(aggregate.errors).toEqual([primary, cleanup]);
  expect(aggregate.cause).toBe(primary);
  expect(aggregate.message.startsWith(primary.message)).toBe(true);
  expect(aggregate.message).toContain(cleanup.message);
});

test("finalization cleanup rethrows the same primary failure after cleanup succeeds", () => {
  const primary = new Error("temporary write failed");
  let cleanupCalls = 0;
  let thrown: unknown;

  try {
    rethrowAfterFinalizationCleanup(
      primary,
      () => {
        cleanupCalls += 1;
      },
      "monitor publication",
    );
  } catch (error) {
    thrown = error;
  }

  expect(cleanupCalls).toBe(1);
  expect(thrown).toBe(primary);
});

test("publication commit rejects expiry before rename and leaves no target", async () => {
  let remaining = 100;
  let target: { readonly sla: "passed" | "failed" } | undefined;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => remaining,
    shutdown: {
      label: "shutdown",
      run: async () => {
        remaining = 5;
      },
    },
    artifacts: [],
    report: {
      label: "report",
      run: async (context) => {
        const remainingAtReport = context.remainingMs();
        remaining = 0;
        const commit = context.commitPublication();
        target = { sla: remainingAtReport > 0 ? "passed" : "failed" };
        return commit;
      },
    },
    enterFailureState: () => {},
  });

  expect(target).toBeUndefined();
  expect(errors.map((error) => error.message)).toEqual([
    "report failed: report exceeded shared deadline after 5ms",
  ]);
});

test("shutdown timeout aborts its context and blocks all evidence publication", async () => {
  const events: string[] = [];
  const shutdown = Promise.withResolvers<void>();
  let shutdownSettled = false;
  let receivedAbort = false;

  const errors = await settleWithin(
    finalizeWorkflowEvidence({
      bodyFailed: false,
      remainingMs: () => 10,
      shutdown: {
        label: "shutdown",
        run: async (context) => {
          events.push("shutdown started");
          context.signal.addEventListener(
            "abort",
            () => {
              receivedAbort = true;
            },
            { once: true },
          );
          await shutdown.promise;
          shutdownSettled = true;
          events.push("shutdown settled");
        },
      },
      artifacts: [
        {
          label: "monitor",
          run: async () => {
            events.push("monitor");
          },
        },
      ],
      report: {
        label: "report",
        run: async () => {
          events.push("report");
        },
      },
      enterFailureState: () => {
        events.push("failure state");
      },
    }),
    100,
  );

  expect(receivedAbort).toBe(true);
  expect(shutdownSettled).toBe(false);
  expect(events).toEqual(["shutdown started", "failure state"]);
  expect(errors.map((error) => error.message)).toEqual([
    "shutdown failed: shutdown exceeded shared deadline after 10ms",
  ]);

  shutdown.resolve();
  await shutdown.promise;
  await Bun.sleep(0);
  expect(events).toEqual([
    "shutdown started",
    "failure state",
    "shutdown settled",
  ]);
});

test("terminal report starts only after asynchronous shutdown settlement", async () => {
  const events: string[] = [];
  const shutdown = Promise.withResolvers<void>();

  const finalization = finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown started");
        await shutdown.promise;
        events.push("shutdown settled");
      },
    },
    artifacts: [],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  await Bun.sleep(0);
  expect(events).toEqual(["shutdown started"]);
  shutdown.resolve();
  await expect(finalization).resolves.toEqual([]);
  expect(events).toEqual(["shutdown started", "shutdown settled", "report"]);
});

test("shutdown failure enters failure state before artifacts and report", async () => {
  const events: string[] = [];

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
        throw new Error("close failed");
      },
    },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          events.push("issue ledger");
        },
      },
      {
        label: "monitor",
        run: async () => {
          events.push("monitor");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
      },
    },
    enterFailureState: (failures) => {
      events.push(`failure state: ${failures[0]?.message ?? "missing"}`);
    },
  });

  expect(events).toEqual([
    "shutdown",
    "failure state: shutdown failed: close failed",
    "issue ledger",
    "monitor",
    "report",
  ]);
  expect(errors.map((error) => error.message)).toEqual([
    "shutdown failed: close failed",
  ]);
});

test("artifact failure retries artifacts before one terminal report", async () => {
  const events: string[] = [];
  let monitorCalls = 0;
  let reportCalls = 0;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
      },
    },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          events.push("issue ledger");
        },
      },
      {
        label: "monitor",
        run: async () => {
          monitorCalls += 1;
          events.push(`monitor ${String(monitorCalls)}`);
          if (monitorCalls === 1) throw new Error("disk full");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        reportCalls += 1;
        events.push(`report ${String(reportCalls)}`);
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(events).toEqual([
    "shutdown",
    "issue ledger",
    "monitor 1",
    "failure state",
    "issue ledger",
    "monitor 2",
    "report 1",
  ]);
  expect(reportCalls).toBe(1);
  expect(errors.map((error) => error.message)).toEqual([
    "monitor failed: disk full",
  ]);
});

test("terminal report failure republishes the failure issue and monitor", async () => {
  const events: string[] = [];
  let issueCalls = 0;
  let monitorCalls = 0;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: { label: "shutdown", run: async () => events.push("shutdown") },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          issueCalls += 1;
          events.push(`issue ledger ${String(issueCalls)}`);
        },
      },
      {
        label: "monitor",
        run: async () => {
          monitorCalls += 1;
          events.push(`monitor ${String(monitorCalls)}`);
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
        throw new Error("disk full");
      },
    },
    enterFailureState: (failures) => {
      events.push(`failure state: ${failures.at(-1)?.message ?? "missing"}`);
    },
  });

  expect(events).toEqual([
    "shutdown",
    "issue ledger 1",
    "monitor 1",
    "report",
    "failure state: report failed: disk full",
    "issue ledger 2",
    "monitor 2",
  ]);
  expect(errors.map((error) => error.message)).toEqual([
    "report failed: disk full",
  ]);
});

test("failed body attempts each artifact and terminal report once", async () => {
  const events: string[] = [];

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: true,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
        throw new Error("close failed");
      },
    },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          events.push("issue ledger");
          throw new Error("ledger failed");
        },
      },
      {
        label: "monitor",
        run: async () => {
          events.push("monitor");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        events.push("report");
        throw new Error("report failed");
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(events).toEqual(["shutdown", "issue ledger", "monitor", "report"]);
  expect(errors.map((error) => error.message)).toEqual([
    "shutdown failed: close failed",
    "issue ledger failed: ledger failed",
    "report failed: report failed",
  ]);
});

test("finalizer errors stay action ordered without repeated shutdown or report", async () => {
  const events: string[] = [];
  let issueCalls = 0;
  let reportCalls = 0;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 1_000,
    shutdown: {
      label: "shutdown",
      run: async () => {
        events.push("shutdown");
        throw new Error("close failed");
      },
    },
    artifacts: [
      {
        label: "issue ledger",
        run: async () => {
          issueCalls += 1;
          events.push(`issue ledger ${String(issueCalls)}`);
          throw new Error(`ledger ${String(issueCalls)}`);
        },
      },
      {
        label: "monitor",
        run: async () => {
          events.push("monitor");
        },
      },
    ],
    report: {
      label: "report",
      run: async () => {
        reportCalls += 1;
        events.push(`report ${String(reportCalls)}`);
        throw new Error("report failed");
      },
    },
    enterFailureState: () => {
      events.push("failure state");
    },
  });

  expect(events).toEqual([
    "shutdown",
    "failure state",
    "issue ledger 1",
    "monitor",
    "issue ledger 2",
    "monitor",
    "report 1",
    "issue ledger 3",
    "monitor",
  ]);
  expect(events.filter((event) => event === "shutdown")).toHaveLength(1);
  expect(reportCalls).toBe(1);
  expect(errors.map((error) => error.message)).toEqual([
    "shutdown failed: close failed",
    "issue ledger failed: ledger 1",
    "issue ledger failed: ledger 2",
    "report failed: report failed",
    "issue ledger failed: ledger 3",
  ]);
});

test("finalization bounds shutdown and stops evidence when it cannot settle", async () => {
  const events: string[] = [];
  let issueCalls = 0;
  let monitorCalls = 0;
  let reportCalls = 0;
  let remainingCalls = 0;

  const errors = await settleWithin(
    finalizeWorkflowEvidence({
      bodyFailed: false,
      remainingMs: () => {
        remainingCalls += 1;
        return 10;
      },
      shutdown: {
        label: "shutdown",
        run: () => {
          events.push("shutdown");
          return new Promise<never>(() => {});
        },
      },
      artifacts: [
        {
          label: "issue ledger",
          run: () => {
            issueCalls += 1;
            events.push(`issue ledger ${String(issueCalls)}`);
            return new Promise<never>(() => {});
          },
        },
        {
          label: "monitor",
          run: async () => {
            monitorCalls += 1;
            events.push(`monitor ${String(monitorCalls)}`);
          },
        },
      ],
      report: {
        label: "report",
        run: async () => {
          reportCalls += 1;
          events.push(`report ${String(reportCalls)}`);
        },
      },
      enterFailureState: () => {
        events.push("failure state");
      },
    }),
    500,
  );

  expect(events).toEqual(["shutdown", "failure state"]);
  expect(remainingCalls).toBe(1);
  expect(errors.map((error) => error.message)).toEqual([
    "shutdown failed: shutdown exceeded shared deadline after 10ms",
  ]);
});

test("timed-out first artifact attempt becomes stale before retry", async () => {
  const publications: string[] = [];
  const staleStates: Array<{ readonly aborted: boolean; readonly current: boolean }> = [];

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 10,
    shutdown: { label: "shutdown", run: async () => {} },
    artifacts: [
      {
        label: "monitor",
        run: async (context) => {
          if (context.attempt === 1) {
            await Bun.sleep(30);
            staleStates.push({
              aborted: context.signal.aborted,
              current: context.isCurrent(),
            });
          }
          if (!context.signal.aborted && context.isCurrent()) {
            publications.push(`attempt ${String(context.attempt)}`);
          }
        },
      },
    ],
    report: { label: "report", run: async () => {} },
    enterFailureState: () => {},
  });

  await Bun.sleep(40);
  expect(publications).toEqual(["attempt 2"]);
  expect(staleStates).toEqual([{ aborted: true, current: false }]);
  expect(errors.map((error) => error.message)).toEqual([
    "monitor failed: monitor exceeded shared deadline after 10ms",
  ]);
});

test("timed-out terminal report is aborted and never retried", async () => {
  let reportCalls = 0;
  let latePublication = false;
  let lateState: { readonly aborted: boolean; readonly current: boolean } | undefined;

  const errors = await finalizeWorkflowEvidence({
    bodyFailed: false,
    remainingMs: () => 10,
    shutdown: { label: "shutdown", run: async () => {} },
    artifacts: [],
    report: {
      label: "report",
      run: async (context) => {
        reportCalls += 1;
        await Bun.sleep(30);
        lateState = {
          aborted: context.signal.aborted,
          current: context.isCurrent(),
        };
        if (!context.signal.aborted && context.isCurrent()) latePublication = true;
      },
    },
    enterFailureState: () => {},
  });

  await Bun.sleep(40);
  expect(reportCalls).toBe(1);
  expect(latePublication).toBe(false);
  expect(lateState).toEqual({ aborted: true, current: false });
  expect(errors.map((error) => error.message)).toEqual([
    "report failed: report exceeded shared deadline after 10ms",
  ]);
});

test("terminal report timeout preserves failure-artifact reserve", async () => {
  const startedAt = Date.now();
  const events: string[] = [];
  let artifactCalls = 0;

  const errors = await settleWithin(
    finalizeWorkflowEvidence({
      bodyFailed: false,
      remainingMs: () => Math.max(0, 40 - (Date.now() - startedAt)),
      failureArtifactReserveMs: 20,
      shutdown: { label: "shutdown", run: async () => {} },
      artifacts: [
        {
          label: "monitor",
          run: async () => {
            artifactCalls += 1;
            events.push(`artifact ${String(artifactCalls)}`);
          },
        },
      ],
      report: {
        label: "report",
        run: () => {
          events.push("report");
          return new Promise<never>(() => {});
        },
      },
      enterFailureState: () => events.push("failure state"),
    }),
    100,
  );

  expect(events).toEqual([
    "artifact 1",
    "report",
    "failure state",
    "artifact 2",
  ]);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toStartWith(
    "report failed: report exceeded shared deadline after ",
  );
});

test("required command execution rejects a failed verification result", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const runRequiredCommand = runtime.runRequiredCommand;
  expect(runRequiredCommand).toBeFunction();
  if (typeof runRequiredCommand !== "function") return;
  const tool = {
    run: async () => ({
      type: "failed" as const,
      command: "bun run verify",
      stdout: "",
      stderr: "verify exploded",
      exitCode: 1,
      durationMs: 7,
    }),
  };
  await expect(
    runRequiredCommand(tool, "bun", ["run", "verify"], 1_000),
  ).rejects.toThrow("bun run verify failed\nverify exploded");
});

test("required command execution returns complete passing evidence", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const runRequiredCommand = runtime.runRequiredCommand;
  expect(runRequiredCommand).toBeFunction();
  if (typeof runRequiredCommand !== "function") return;
  const tool = {
    run: async () => ({
      type: "success" as const,
      command: "git status --short",
      stdout: "clean\n",
      stderr: "",
      exitCode: 0 as const,
      durationMs: 3,
    }),
  };
  expect(
    await runRequiredCommand(tool, "git", ["status", "--short"], 1_000),
  ).toEqual({
    command: "git status --short",
    status: "passed",
    stdout: "clean\n",
    stderr: "",
    exitCode: 0,
    durationMs: 3,
  });
});

test("remaining timeout clamps every operation to shared budget", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const remainingTimeout = runtime.remainingTimeout;
  expect(remainingTimeout).toBeFunction();
  if (typeof remainingTimeout !== "function") return;
  expect(remainingTimeout(30_000, 1_250, "git diff")).toBe(1_250);
  expect(remainingTimeout(500, 1_250, "git diff")).toBe(500);
  expect(() => remainingTimeout(30_000, 0, "git diff")).toThrow(
    "sla-overrun before git diff",
  );
});

test("targeted gate issues expose every failed command and no passing command", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const gateIssuesFromLogs = runtime.gateIssuesFromLogs;
  expect(gateIssuesFromLogs).toBeFunction();
  if (typeof gateIssuesFromLogs !== "function") return;
  const issues = gateIssuesFromLogs([
    {
      command: "bun test tests/x.test.ts",
      status: "failed",
      stdout: "",
      stderr: "one regression",
      exitCode: 1,
      durationMs: 4,
    },
    {
      command: "bun run lint",
      status: "passed",
      stdout: "clean",
      stderr: "",
      exitCode: 0,
      durationMs: 5,
    },
    {
      command: "bun run typecheck",
      status: "failed",
      stdout: "src/x.ts:1:1 type mismatch",
      stderr: "",
      exitCode: 2,
      durationMs: 6,
    },
  ]);
  expect(issues).toEqual([
    {
      message: "bun test tests/x.test.ts\nstderr:\none regression",
      fixable: true,
    },
    {
      message:
        "bun run typecheck\nstdout:\nsrc/x.ts:1:1 type mismatch",
      fixable: true,
    },
  ]);
});

test("git manifest comparator rejects every structural tree change", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const assertGitManifestUnchanged = runtime.assertGitManifestUnchanged;
  expect(assertGitManifestUnchanged).toBeFunction();
  if (typeof assertGitManifestUnchanged !== "function") return;

  const baseline = [
    { path: "src/a.ts", mode: "100644", oid: "a".repeat(40) },
    { path: "tests/a.test.ts", mode: "100644", oid: "b".repeat(40) },
  ];
  expect(() =>
    assertGitManifestUnchanged(
      baseline,
      baseline.map((entry) => ({ ...entry })),
    ),
  ).not.toThrow();

  for (const actual of [
    [
      { ...baseline[0], oid: "c".repeat(40) },
      baseline[1],
    ],
    [
      { ...baseline[0], mode: "100755" },
      baseline[1],
    ],
    [baseline[0]],
    [
      ...baseline,
      { path: "src/extra.ts", mode: "100644", oid: "d".repeat(40) },
    ],
  ]) {
    expect(() => assertGitManifestUnchanged(baseline, actual)).toThrow(
      /manifest/i,
    );
  }
});

test("git manifest guard checks after a successful operation", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const withGitManifestGuard = runtime.withGitManifestGuard;
  expect(withGitManifestGuard).toBeFunction();
  if (typeof withGitManifestGuard !== "function") return;

  const baseline = [
    { path: "src/a.ts", mode: "100644", oid: "a".repeat(40) },
  ];
  let current = baseline;
  let reads = 0;
  await expect(
    withGitManifestGuard(
      async () => {
        reads += 1;
        return current;
      },
      async () => {
        current = [{ ...baseline[0], oid: "b".repeat(40) }];
        return "completed";
      },
    ),
  ).rejects.toThrow(/manifest/i);
  expect(reads).toBe(2);
});

test("git manifest guard checks after a thrown operation", async () => {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const withGitManifestGuard = runtime.withGitManifestGuard;
  expect(withGitManifestGuard).toBeFunction();
  if (typeof withGitManifestGuard !== "function") return;

  const baseline = [
    { path: "src/a.ts", mode: "100644", oid: "a".repeat(40) },
  ];
  let current = baseline;
  let reads = 0;
  await expect(
    withGitManifestGuard(
      async () => {
        reads += 1;
        return current;
      },
      async () => {
        current = [{ ...baseline[0], mode: "100755" }];
        throw new Error("operation failed");
      },
    ),
  ).rejects.toThrow(/manifest/i);
  expect(reads).toBe(2);
});

test("git manifest guard checks after a synchronous throw", async () => {
  const runtime = await manifestRuntime();
  const baseline = [
    { path: "src/a.ts", mode: "100644", oid: "a".repeat(40) },
  ];
  let current = baseline;
  let reads = 0;
  await expect(
    runtime.withGitManifestGuard(
      async () => {
        reads += 1;
        return current;
      },
      () => {
        current = [{ ...baseline[0]!, oid: "b".repeat(40) }];
        throw new Error("synchronous operation failure");
      },
    ),
  ).rejects.toThrow(/manifest/i);
  expect(reads).toBe(2);
});

test("real ignored manifests reject byte, mode, add, delete, and symlink changes", async () => {
  const runtime = await manifestRuntime();
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (root: string) => Promise<void>;
  }> = [
    {
      name: "byte",
      mutate: async (root) => {
        await Bun.write(join(root, ".orca", "control"), "changed\n");
      },
    },
    {
      name: "mode",
      mutate: async (root) => {
        await chmod(join(root, ".orca", "control"), 0o755);
      },
    },
    {
      name: "addition",
      mutate: async (root) => {
        await Bun.write(join(root, ".orca", "added"), "added\n");
      },
    },
    {
      name: "deletion",
      mutate: async (root) => {
        await unlink(join(root, ".orca", "control"));
      },
    },
    {
      name: "symlink",
      mutate: async (root) => {
        const link = join(root, ".orca", "control-link");
        await unlink(link);
        await symlink("target-b", link);
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `orcats-ignored-${scenario.name}-`));
    try {
      await mkdir(join(root, ".orca"), { recursive: true });
      await Bun.write(join(root, ".orca", "control"), "original\n");
      await Bun.write(join(root, ".orca", "target-a"), "same bytes\n");
      await Bun.write(join(root, ".orca", "target-b"), "same bytes\n");
      await symlink("target-a", join(root, ".orca", "control-link"));
      const baseline = await runtime.captureFileContentManifest(
        await ignoredManifestPaths(root),
        {
          maxTotalBytes: 1_024,
          maxEntries: 16,
          maxTotalPathBytes: 4_096,
        },
      );

      await scenario.mutate(root);
      const actual = await runtime.captureFileContentManifest(
        await ignoredManifestPaths(root),
        {
          maxTotalBytes: 1_024,
          maxEntries: 16,
          maxTotalPathBytes: 4_096,
        },
      );
      expect(() =>
        runtime.assertGitManifestUnchanged(
          baseline,
          actual,
          `${scenario.name} ignored manifest`,
        ),
      ).toThrow(/manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("real ignored manifest guard checks successful and failed operations", async () => {
  const runtime = await manifestRuntime();
  for (const operationFails of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "orcats-ignored-guard-"));
    try {
      await mkdir(join(root, ".orca"), { recursive: true });
      const control = join(root, ".orca", "control");
      await Bun.write(control, "original\n");
      const readManifest = async () =>
        await runtime.captureFileContentManifest(
          await ignoredManifestPaths(root),
          {
            maxTotalBytes: 1_024,
            maxEntries: 16,
            maxTotalPathBytes: 4_096,
          },
        );
      await expect(
        runtime.withGitManifestGuard(readManifest, async () => {
          await Bun.write(control, "changed\n");
          if (operationFails) throw new Error("operation failed");
          return "completed";
        }),
      ).rejects.toThrow(/manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("file content manifest fails closed on byte cap and deadline", async () => {
  const runtime = await manifestRuntime();
  const root = await mkdtemp(join(tmpdir(), "orcats-manifest-bounds-"));
  try {
    const path = join(root, "large-control");
    await Bun.write(path, "0123456789");
    await expect(
      runtime.captureFileContentManifest([path], {
        maxTotalBytes: 4,
        maxEntries: 1,
        maxTotalPathBytes: 4_096,
      }),
    ).rejects.toThrow(/byte limit/i);

    let checks = 0;
    await expect(
      runtime.captureFileContentManifest([path], {
        maxTotalBytes: 1_024,
        maxEntries: 1,
        maxTotalPathBytes: 4_096,
        remainingMs: () => (checks++ === 0 ? 1 : 0),
      }),
    ).rejects.toThrow(/deadline/i);

    await expect(
      runtime.captureFileContentManifest([path, `${path}-two`], {
        maxTotalBytes: 1_024,
        maxEntries: 1,
        maxTotalPathBytes: 4_096,
      }),
    ).rejects.toThrow(/entry limit/i);
    await expect(
      runtime.captureFileContentManifest([path], {
        maxTotalBytes: 1_024,
        maxEntries: 1,
        maxTotalPathBytes: 1,
      }),
    ).rejects.toThrow(/path byte limit/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file content manifest deadline bounds a stalled filesystem operation", async () => {
  const runtime = await manifestRuntime();
  const stalled = new Promise<never>(() => undefined);
  const startedAt = Date.now();
  await expect(
    runtime.captureFileContentManifest([".orca/control"], {
      maxTotalBytes: 1_024,
      maxEntries: 1,
      maxTotalPathBytes: 4_096,
      remainingMs: () => 10,
      operations: {
        lstat: async () => await stalled,
        readlink: async () => new Uint8Array(),
        readChunks: async function* () {
          yield new Uint8Array();
        },
      },
    }),
  ).rejects.toThrow(/deadline/i);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

test("worktree manifest rejects synchronous late hash success and rejection", async () => {
  const runtime = await manifestRuntime();
  const root = await mkdtemp(join(tmpdir(), "orcats-worktree-deadline-"));
  const path = "candidate.ts";
  await Bun.write(join(root, path), "candidate\n");
  try {
    for (const rejectOperation of [false, true]) {
      const operationError = new Error("late hash rejection");
      let thrown: unknown;
      try {
        await runtime.captureGitWorktreeManifest([path], {
          root,
          objectFormat: "sha1",
          remainingMs: () => 50,
          hashFile: async () => {
            const blockedUntil = Date.now() + 75;
            let spins = 0;
            while (Date.now() < blockedUntil) spins += 1;
            if (spins === 0) throw new Error("clock did not advance");
            if (rejectOperation) throw operationError;
            return "a".repeat(40);
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(
        "content manifest exceeded deadline during candidate file hash",
      );
      if (rejectOperation) expect((thrown as Error).cause).toBe(operationError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree manifest rejects exact operation deadline equality", async () => {
  const runtime = await manifestRuntime();
  const root = await mkdtemp(join(tmpdir(), "orcats-worktree-equality-"));
  const path = "candidate.ts";
  await Bun.write(join(root, path), "candidate\n");
  let clockMs = 0;
  try {
    await expect(
      runtime.captureGitWorktreeManifest([path], {
        root,
        objectFormat: "sha1",
        remainingMs: () => 5,
        now: () => clockMs,
        hashFile: async () => {
          clockMs = 5;
          return "a".repeat(40);
        },
      }),
    ).rejects.toThrow(
      "content manifest exceeded deadline during candidate file hash",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime parsers require exact index and commit blob path sets", async () => {
  const runtime = await manifestRuntime();
  const oidA = "a".repeat(40);
  const oidB = "b".repeat(40);
  const paths = ["src/a.ts", "tests/a.test.ts"];
  expect(
    runtime.parseGitIndexManifest(
      `100644 ${oidA} 0\tsrc/a.ts\u0000100755 ${oidB} 0\ttests/a.test.ts\0`,
      paths,
    ),
  ).toEqual([
    { path: "src/a.ts", mode: "100644", oid: oidA },
    { path: "tests/a.test.ts", mode: "100755", oid: oidB },
  ]);
  expect(
    runtime.parseGitCommitManifest(
      `100644 blob ${oidA}\tsrc/a.ts\u0000100755 blob ${oidB}\ttests/a.test.ts\0`,
      paths,
    ),
  ).toEqual([
    { path: "src/a.ts", mode: "100644", oid: oidA },
    { path: "tests/a.test.ts", mode: "100755", oid: oidB },
  ]);

  for (const invalid of [
    () =>
      runtime.parseGitIndexManifest(
        `100644 ${oidA} 1\tsrc/a.ts\0`,
        ["src/a.ts"],
      ),
    () =>
      runtime.parseGitIndexManifest(
        `100644 ${oidA} 0\tsrc/a.ts\u0000100644 ${oidB} 0\tsrc/a.ts\0`,
        ["src/a.ts"],
      ),
    () =>
      runtime.parseGitCommitManifest(
        `040000 tree ${oidA}\tsrc\0`,
        ["src"],
      ),
    () =>
      runtime.parseGitCommitManifest(
        `100644 blob ${oidA}\tsrc/a.ts\0`,
        paths,
      ),
    () =>
      runtime.parseGitIndexManifest(
        `100644 ${"c".repeat(41)} 0\tsrc/a.ts\0`,
        ["src/a.ts"],
      ),
    () =>
      runtime.parseGitIndexManifest(
        `\u0000100644 ${oidA} 0\tsrc/a.ts\0`,
        ["src/a.ts"],
      ),
    () =>
      runtime.parseGitCommitManifest(
        `100644 blob ${oidA}\tsrc/a.ts\0\0`,
        ["src/a.ts"],
      ),
  ]) {
    expect(invalid).toThrow(/manifest|invalid/i);
  }

  expect(
    runtime.parseGitIndexManifest(
      `100644 ${oidA} 0\ta.ts\u0000100644 ${oidB} 0\tB.ts\0`,
      ["B.ts", "a.ts"],
    ).map((entry) => entry.path),
  ).toEqual(["B.ts", "a.ts"]);
  expect(
    runtime.parseExactGitPathList(
      "a.ts\0B.ts\0",
      ["B.ts", "a.ts"],
      "candidate",
    ),
  ).toEqual(["B.ts", "a.ts"]);
  for (const malformed of ["\0a.ts\0", "a.ts\0\0", "a.ts", ""]) {
    expect(() =>
      runtime.parseExactGitPathList(
        malformed,
        ["a.ts"],
        "candidate",
      ),
    ).toThrow(/invalid|paths changed/i);
  }
});

test("real Git manifests preserve symlink bytes and reject divergent trees before push", async () => {
  const runtime = await manifestRuntime();
  const root = await createManifestRepository();
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await Bun.write(join(root, "src", "target.txt"), "target contents\n");
    await Bun.write(join(root, "src", "value.txt"), "verified\n");
    await symlink("target.txt", join(root, "src", "link"));
    await runGit(root, ["add", "--", "src"]);
    await runGit(root, ["commit", "--quiet", "-m", "baseline"]);

    const objectFormat = (await runGit(root, [
      "rev-parse",
      "--show-object-format",
    ])).trim();
    expect(["sha1", "sha256"]).toContain(objectFormat);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") return;
    const captureWorktree = async (paths: readonly string[]) =>
      await runtime.captureGitWorktreeManifest(paths, {
        root,
        objectFormat,
        hashFile: async (path) =>
          (
            await runGit(root, ["hash-object", `--path=${path}`, "--", path])
          ).trim(),
      });
    const allPaths = ["src/link", "src/value.txt"];
    const verified = await captureWorktree(allPaths);
    const index = runtime.parseGitIndexManifest(
      await runGit(root, ["ls-files", "--stage", "-z", "--", ...allPaths]),
      allPaths,
    );
    const committed = runtime.parseGitCommitManifest(
      await runGit(root, [
        "ls-tree",
        "-rz",
        "--full-tree",
        "HEAD",
        "--",
        ...allPaths,
      ]),
      allPaths,
    );
    expect(verified).toEqual(index);
    expect(verified).toEqual(committed);
    expect(() =>
      runtime.assertGitManifestUnchanged(verified, index, "symlink index"),
    ).not.toThrow();
    expect(() =>
      runtime.assertGitManifestUnchanged(verified, committed, "symlink commit"),
    ).not.toThrow();

    await Bun.write(join(root, "src", "value.txt"), "worktree drift\n");
    const driftedWorktree = await captureWorktree(allPaths);
    expect(() =>
      runtime.assertGitManifestUnchanged(
        verified,
        driftedWorktree,
        "worktree drift",
      ),
    ).toThrow(/manifest/i);

    await runGit(root, ["add", "--", "src/value.txt"]);
    const driftedIndex = runtime.parseGitIndexManifest(
      await runGit(root, ["ls-files", "--stage", "-z", "--", ...allPaths]),
      allPaths,
    );
    expect(() =>
      runtime.assertGitManifestUnchanged(verified, driftedIndex, "index drift"),
    ).toThrow(/manifest/i);

    expect(driftedWorktree).toEqual(driftedIndex);

    const hook = join(root, ".git", "hooks", "pre-commit");
    await Bun.write(
      hook,
      [
        "#!/bin/sh",
        "printf 'hook-added\\n' > hook-added.txt",
        "git add -- hook-added.txt",
      ].join("\n"),
    );
    await chmod(hook, 0o755);

    await runGit(root, ["commit", "--quiet", "-m", "drift"]);
    let pushCalls = 0;
    await expect(
      (async () => {
        const committedPaths = await runGit(root, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          "HEAD",
        ]);
        runtime.parseExactGitPathList(
          committedPaths,
          allPaths,
          "committed candidate",
        );
        const driftedCommit = runtime.parseGitCommitManifest(
          await runGit(root, [
            "ls-tree",
            "-rz",
            "--full-tree",
            "HEAD",
            "--",
            ...allPaths,
          ]),
          allPaths,
        );
        runtime.assertGitManifestUnchanged(
          driftedWorktree,
          driftedCommit,
          "candidate commit",
        );
        pushCalls += 1;
      })(),
    ).rejects.toThrow(/paths changed/i);
    expect(pushCalls).toBe(0);

    const driftedCommit = runtime.parseGitCommitManifest(
      await runGit(root, [
        "ls-tree",
        "-rz",
        "--full-tree",
        "HEAD",
        "--",
        ...allPaths,
      ]),
      allPaths,
    );
    expect(() =>
      runtime.assertGitManifestUnchanged(verified, driftedCommit, "commit drift"),
    ).toThrow(/manifest/i);
    expect(driftedWorktree).toEqual(driftedCommit);
    expect(() =>
      runtime.assertGitManifestUnchanged(
        driftedWorktree,
        driftedCommit,
        "candidate commit",
      ),
    ).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

interface ScopedScoutTestConversation<T> {
  readonly label: string;
  run(
    activeRemaining: () => number,
    settlementRemaining: () => number,
  ): Promise<T>;
  cancel(reason: string): void | Promise<void>;
}

interface ScopedScoutTestRecord<T> {
  readonly scopeIndex: number;
  readonly label: string;
  readonly status: string;
  readonly terminal?: {
    readonly status: "fulfilled" | "rejected";
    readonly value?: unknown;
    readonly completedAtMs: number;
  };
  readonly cancellation?: {
    readonly requestedAtMs: number;
    readonly reason: string;
    readonly rejection?: string;
    readonly settlementTimedOut?: boolean;
  };
}

interface ScopedScoutTestRuntime {
  readonly runScopedScoutFanout: <T>(options: {
    readonly conversations: readonly ScopedScoutTestConversation<T>[];
    readonly modelAllocationMs: number;
    readonly settlementReserveMs: number;
    readonly quorum: number;
    readonly accept: (value: T) => boolean;
    readonly validateAccepted?: (
      value: T,
      scopeIndex: number,
    ) => readonly string[];
    readonly now?: () => number;
  }) => Promise<{
    readonly modelStartedAtMs: number;
    readonly deadlineAtMs: number;
    readonly records: readonly ScopedScoutTestRecord<T>[];
    readonly accepted: readonly { readonly scopeIndex: number; readonly value: T }[];
  }>;
  readonly finalizeScopedScoutRecords: (options: {
    readonly records: readonly ScopedScoutTestRecord<unknown>[];
    readonly validate: (
      value: unknown,
      record: ScopedScoutTestRecord<unknown>,
    ) => readonly string[];
    readonly persistScopeRecord: (
      record: ScopedScoutTestRecord<unknown>,
    ) => void | Promise<void>;
    readonly recordTerminalUsage?: (
      record: ScopedScoutTestRecord<unknown>,
    ) => void | Promise<void>;
    readonly recordReportSummary: () => void | Promise<void>;
    readonly recordLedgerSummary: () => void | Promise<void>;
  }) => Promise<unknown>;
}

async function scopedScoutRuntime(): Promise<ScopedScoutTestRuntime | undefined> {
  const loaded = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  expect(loaded.runScopedScoutFanout).toBeFunction();
  expect(loaded.finalizeScopedScoutRecords).toBeFunction();
  if (
    typeof loaded.runScopedScoutFanout !== "function" ||
    typeof loaded.finalizeScopedScoutRecords !== "function"
  ) {
    return undefined;
  }
  return loaded as unknown as ScopedScoutTestRuntime;
}

async function flushScopedScoutTurns(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("scoped fanout starts every scope before a result and shares one model deadline", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  let clockMs = 0;
  const started: string[] = [];
  const limits: Array<{
    readonly activeRemainingMs: number;
    readonly settlementRemainingMs: number;
  }> = [];
  const deferred = [
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
  ];
  const resultPromise = runtime.runScopedScoutFanout({
    conversations: deferred.map((pending, scopeIndex) => ({
      label: `scope ${String(scopeIndex)}`,
      async run(activeRemaining, settlementRemaining): Promise<string> {
        started.push(`scope ${String(scopeIndex)}`);
        limits.push({
          activeRemainingMs: activeRemaining(),
          settlementRemainingMs: settlementRemaining(),
        });
        return await pending.promise;
      },
      cancel(): void {},
    })),
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 5,
    accept: () => true,
    now: () => clockMs,
  });

  await flushScopedScoutTurns();
  expect(started).toEqual(["scope 0", "scope 1", "scope 2", "scope 3"]);
  expect(limits).toEqual([
    { activeRemainingMs: 115_000, settlementRemainingMs: 5_000 },
    { activeRemainingMs: 115_000, settlementRemainingMs: 5_000 },
    { activeRemainingMs: 115_000, settlementRemainingMs: 5_000 },
    { activeRemainingMs: 115_000, settlementRemainingMs: 5_000 },
  ]);

  for (const [scopeIndex, pending] of deferred.entries()) {
    pending.resolve(`candidate ${String(scopeIndex)}`);
  }
  const result = await resultPromise;
  expect(result.modelStartedAtMs).toBe(0);
  expect(result.deadlineAtMs).toBe(120_000);
  expect(result.accepted.map((record) => record.scopeIndex)).toEqual([
    0, 1, 2, 3,
  ]);
});

test("shared model deadline subtracts settlement reserve and stops exact-boundary work", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;

  let beforeClockMs = 0;
  const beforeLimits: Array<{
    readonly active: number;
    readonly settlement: number;
  }> = [];
  const beforeDeadline = await runtime.runScopedScoutFanout({
    conversations: [0, 1].map((scopeIndex) => ({
      label: `before ${String(scopeIndex)}`,
      async run(activeRemaining, settlementRemaining): Promise<string> {
        beforeLimits.push({
          active: activeRemaining(),
          settlement: settlementRemaining(),
        });
        if (scopeIndex === 0) beforeClockMs = 119_999;
        return "not accepted";
      },
      cancel(): void {},
    })),
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: () => false,
    now: () => beforeClockMs,
  });
  expect(beforeLimits).toEqual([
    { active: 115_000, settlement: 5_000 },
    { active: 0, settlement: 1 },
  ]);
  expect(beforeDeadline.records.map((record) => record.status)).toEqual([
    "invalid",
    "invalid",
  ]);

  let exactClockMs = 0;
  const exactStarts: string[] = [];
  const exactCancels: string[] = [];
  const exactDeadline = await runtime.runScopedScoutFanout({
    conversations: [0, 1].map((scopeIndex) => ({
      label: `exact ${String(scopeIndex)}`,
      async run(): Promise<string> {
        exactStarts.push(`exact ${String(scopeIndex)}`);
        exactClockMs = 120_000;
        return "late";
      },
      cancel(reason): void {
        exactCancels.push(reason);
      },
    })),
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: () => true,
    now: () => exactClockMs,
  });
  expect(exactStarts).toEqual(["exact 0"]);
  expect(exactCancels).toEqual([]);
  expect(exactDeadline.records.map((record) => record.status)).toEqual([
    "timed_out",
    "timed_out",
  ]);
});

test("scoped fanout retains a valid sibling beside invalid timeout and failure records", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  let clockMs = 0;
  const valid = Promise.withResolvers<string>();
  const invalid = Promise.withResolvers<string>();
  const failure = Promise.withResolvers<string>();
  const timeout = Promise.withResolvers<string>();
  const resultPromise = runtime.runScopedScoutFanout({
    conversations: [
      {
        label: "valid",
        run: async () => await valid.promise,
        cancel(): void {},
      },
      {
        label: "invalid",
        run: async () => await invalid.promise,
        cancel(): void {},
      },
      {
        label: "failure",
        run: async () => await failure.promise,
        cancel(): void {},
      },
      {
        label: "timeout",
        run: async () => await timeout.promise,
        cancel(): void {},
      },
    ],
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: (value) => value === "valid",
    now: () => clockMs,
  });

  valid.resolve("valid");
  await flushScopedScoutTurns();
  invalid.resolve("invalid");
  await flushScopedScoutTurns();
  failure.reject(new Error("backend failed"));
  await flushScopedScoutTurns();
  clockMs = 120_000;
  timeout.resolve("late");

  const result = await resultPromise;
  expect(result.accepted).toEqual([{ scopeIndex: 0, value: "valid" }]);
  expect(result.records.map((record) => record.status)).toEqual([
    "accepted",
    "invalid",
    "failed",
    "timed_out",
  ]);
});

test("scoped fanout counts only fully validated candidates toward quorum", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  const fourth = Promise.withResolvers<string>();
  const cancellations: string[] = [];
  const resultPromise = runtime.runScopedScoutFanout({
    conversations: [
      ...[0, 1, 2].map((scopeIndex) => ({
        label: `invalid candidate ${String(scopeIndex)}`,
        async run(): Promise<string> {
          return `candidate ${String(scopeIndex)}`;
        },
        cancel(reason): void {
          cancellations.push(`invalid ${String(scopeIndex)}: ${reason}`);
        },
      })),
      {
        label: "fourth valid candidate",
        async run(): Promise<string> {
          return await fourth.promise;
        },
        cancel(reason): void {
          cancellations.push(`fourth: ${reason}`);
        },
      },
    ],
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: (value) => value.startsWith("candidate"),
    validateAccepted: (_value, scopeIndex) =>
      scopeIndex < 3 ? ["source/test/profile/evidence validation failed"] : [],
  });

  await flushScopedScoutTurns();
  fourth.resolve("candidate 3");
  const result = await settleWithin(resultPromise, 100);

  expect(cancellations).toEqual([]);
  expect(result.accepted.map((record) => record.scopeIndex)).toEqual([3]);
  expect(result.records.map((record) => record.status)).toEqual([
    "invalid",
    "invalid",
    "invalid",
    "accepted",
  ]);
  for (const record of result.records.slice(0, 3)) {
    expect(record.validationIssues).toEqual([
      "source/test/profile/evidence validation failed",
    ]);
  }
});

test("scoped fanout quorum cancels each pending scope once and drains cancellation rejection", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  const pending = Promise.withResolvers<string>();
  const cancels: string[] = [];
  const resultPromise = runtime.runScopedScoutFanout({
    conversations: [
      ...[0, 1, 2].map((scopeIndex) => ({
        label: `accepted ${String(scopeIndex)}`,
        async run(): Promise<string> {
          return `accepted ${String(scopeIndex)}`;
        },
        cancel(): void {},
      })),
      {
        label: "pending",
        async run(): Promise<string> {
          return await pending.promise;
        },
        cancel(reason): Promise<void> {
          cancels.push(reason);
          pending.resolve("cancelled sibling");
          return Promise.reject(new Error("cancel transport failed"));
        },
      },
    ],
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: (value) => value.startsWith("accepted"),
  });

  const result = await settleWithin(resultPromise, 100);
  expect(cancels).toHaveLength(1);
  expect(result.accepted.map((record) => record.scopeIndex)).toEqual([0, 1, 2]);
  expect(result.records[3]?.status).toBe("cancelled");
  expect(result.records[3]?.cancellation?.rejection).toContain(
    "cancel transport failed",
  );
});

test("scoped fanout quorum does not start a cancellation that crosses the shared deadline", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  let armDeadlineRace = false;
  let deadlineReadCount = 0;
  let clockMs = 0;
  const cancellations: string[] = [];
  const cancellationStartedAtMs: number[] = [];
  const result = await runtime.runScopedScoutFanout({
    conversations: [
      ...[0, 1, 2].map((scopeIndex) => ({
        label: `accepted ${String(scopeIndex)}`,
        async run(): Promise<string> {
          return `accepted ${String(scopeIndex)}`;
        },
        cancel(): void {},
      })),
      {
        label: "pending",
        async run(): Promise<string> {
          return await new Promise<string>(() => {});
        },
        cancel(): void {
          cancellations.push("pending");
          cancellationStartedAtMs.push(clockMs);
        },
      },
    ],
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: (value) => {
      if (value === "accepted 2") armDeadlineRace = true;
      return value.startsWith("accepted");
    },
    now: () => {
      if (!armDeadlineRace) return 0;
      deadlineReadCount += 1;
      clockMs = deadlineReadCount <= 2 ? 119_999 : 120_000;
      return clockMs;
    },
  });

  expect(cancellations).toEqual(["pending"]);
  expect(cancellationStartedAtMs).toEqual([119_999]);
  expect(result.records[3]?.status).toBe("timed_out");
  expect(result.records[3]?.cancellation?.requestedAtMs).toBe(119_999);
});

test("scoped fanout quorum does not start settlement at the shared deadline", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  let cancellationRequested = false;
  let postCancellationNowReads = 0;
  const timerDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timerDelays.push(Number(args[1] ?? 0));
    return originalSetTimeout(...args);
  }) as typeof setTimeout;
  try {
    const result = await runtime.runScopedScoutFanout({
      conversations: [
        ...[0, 1, 2].map((scopeIndex) => ({
          label: `accepted ${String(scopeIndex)}`,
          async run(): Promise<string> {
            return `accepted ${String(scopeIndex)}`;
          },
          cancel(): void {},
        })),
        {
          label: "pending",
          async run(): Promise<string> {
            return await new Promise<string>(() => {});
          },
          cancel(): Promise<void> {
            cancellationRequested = true;
            return new Promise<void>(() => {});
          },
        },
      ],
      modelAllocationMs: 120_000,
      settlementReserveMs: 5_000,
      quorum: 3,
      accept: (value) => value.startsWith("accepted"),
      now: () => {
        if (!cancellationRequested) return 0;
        postCancellationNowReads += 1;
        return postCancellationNowReads <= 3 ? 119_999 : 120_000;
      },
    });

    expect(timerDelays.slice(-2)).toEqual([1, 1]);
    expect(result.records.map((record) => record.status)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "timed_out",
    ]);
    expect(result.records[3]?.cancellation).toMatchObject({
      requestedAtMs: 0,
      settlementTimedOut: true,
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("scoped fanout quorum does not start a later cancellation at the exact shared deadline", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  let clockMs = 0;
  const accepted = [
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
  ];
  const firstPending = Promise.withResolvers<string>();
  const secondPending = Promise.withResolvers<string>();
  const cancellations: string[] = [];
  const resultPromise = runtime.runScopedScoutFanout({
    conversations: [
      ...accepted.map((pending, scopeIndex) => ({
        label: `accepted ${String(scopeIndex)}`,
        async run(): Promise<string> {
          return await pending.promise;
        },
        cancel(): void {},
      })),
      {
        label: "first pending",
        async run(): Promise<string> {
          return await firstPending.promise;
        },
        cancel(): void {
          cancellations.push("first pending");
          clockMs = 120_000;
        },
      },
      {
        label: "later pending",
        async run(): Promise<string> {
          return await secondPending.promise;
        },
        cancel(): void {
          cancellations.push("later pending");
        },
      },
    ],
    modelAllocationMs: 120_000,
    settlementReserveMs: 5_000,
    quorum: 3,
    accept: (value) => value.startsWith("accepted"),
    now: () => clockMs,
  });

  for (const [scopeIndex, pending] of accepted.entries()) {
    pending.resolve(`accepted ${String(scopeIndex)}`);
    await flushScopedScoutTurns();
  }

  const result = await resultPromise;
  expect(cancellations).toEqual(["first pending"]);
  expect(result.records.map((record) => record.status)).toEqual([
    "accepted",
    "accepted",
    "accepted",
    "timed_out",
    "timed_out",
  ]);
  expect(result.records[3]?.cancellation?.reason).toContain("quorum reached");
  expect(result.records[4]?.cancellation).toBeUndefined();
});

test("scoped fanout finalization persists zero-valid scope evidence before summaries and typed error", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  const order: string[] = [];
  let thrown: unknown;
  try {
    await runtime.finalizeScopedScoutRecords({
      records: [
        {
          scopeIndex: 1,
          label: "scope one",
          status: "invalid",
        },
        {
          scopeIndex: 0,
          label: "scope zero",
          status: "failed",
        },
      ],
      validate: () => [],
      persistScopeRecord: (record) => {
        order.push(`scope ${String(record.scopeIndex)}`);
      },
      recordReportSummary: () => {
        order.push("report");
      },
      recordLedgerSummary: () => {
        order.push("ledger");
      },
    });
  } catch (error) {
    thrown = error;
  }
  expect(order).toEqual(["scope 0", "scope 1", "report", "ledger"]);
  expect((thrown as Error | undefined)?.name).toBe(
    "NoSuitableScoutCandidateError",
  );
});

test("scoped fanout finalization records terminal usage once in pair order before aggregation", async () => {
  const runtime = await scopedScoutRuntime();
  if (runtime === undefined) return;
  const order: string[] = [];
  const candidate = (id: string) => {
    const sourcePath = `src/scoped/${id}.ts`;
    const testPath = `tests/scoped-${id}.test.ts`;
    return {
      status: "candidate" as const,
      candidate: {
        id,
        title: `fix: preserve ${id} diagnostics`,
        problem: "The scoped command drops a diagnostic.",
        evidence: [`${sourcePath}:1 evidence`, `${testPath}:1 evidence`],
        allowedPaths: [sourcePath, testPath],
        testPath,
        targetedTestArgs: ["test", testPath],
        expectedFailurePattern: `ORCA_RED:${id}`,
        implementationBrief: "Preserve the diagnostic.",
        expectedMinutes: 10,
        risk: "low" as const,
      },
      selectedControl: {
        candidateId: id,
        brief: "A known-good scoped behavior.",
        testName: `preserves ${id} baseline`,
        productionPath: sourcePath,
      },
    };
  };
  const result = (await runtime.finalizeScopedScoutRecords({
    records: [
      {
        scopeIndex: 1,
        label: "scope one",
        status: "accepted",
        terminal: {
          status: "fulfilled",
          value: candidate("scope-one"),
          completedAtMs: 2,
        },
      },
      {
        scopeIndex: 0,
        label: "scope zero",
        status: "accepted",
        terminal: {
          status: "fulfilled",
          value: candidate("scope-zero"),
          completedAtMs: 1,
        },
      },
    ],
    validate: (_value, record) =>
      record.scopeIndex === 1 ? ["tracked path mismatch"] : [],
    recordTerminalUsage: (record: ScopedScoutTestRecord<unknown>) => {
      order.push(`usage ${String(record.scopeIndex)}`);
    },
    persistScopeRecord: (record) => {
      order.push(`scope ${String(record.scopeIndex)}`);
    },
    recordReportSummary: () => {
      order.push("report");
    },
    recordLedgerSummary: () => {
      order.push("ledger");
    },
  })) as {
    readonly candidates: readonly { readonly id: string }[];
  };

  expect(order).toEqual([
    "usage 0",
    "scope 0",
    "usage 1",
    "scope 1",
    "report",
    "ledger",
  ]);
  expect(result.candidates.map((item) => item.id)).toEqual(["scope-zero"]);
});
