import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runQuiet } from "../src/tools/process.ts";
import { expectExitZero, runCliProcess } from "./helpers/cli-process.ts";

// Drives the real `orcats` CLI entrypoint (the bin shim) end-to-end — not parseCliArgs in
// isolation — to lock the shared preflight contract every flow and loop run depends on:
// flow-arg forwarding, --backend → ORCA_BACKEND, the typecheck skip env + warning, and a
// non-zero exit on typecheck failure. The compiled standalone binary is covered separately
// by scripts/smoke-binary.ts; here the bin shim keeps the gate fast and token-free (the probe
// flow never touches a backend).
const repoRoot = resolve(import.meta.dir, "..");
const binShim = resolve(repoRoot, "bin", "orcats");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProbeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "probe.ts"),
    `import { flow, flowArgs } from "@twelvehart/orcats";\n` +
      `await flow()(async () => {\n` +
      `  console.log("ORCA_PROBE " + JSON.stringify({\n` +
      `    args: flowArgs(),\n` +
      `    backend: process.env.ORCA_BACKEND ?? null,\n` +
      `    bunOptions: process.env.BUN_OPTIONS ?? null,\n` +
      `    marker: process.env.ORCATS_TEST_MARKER ?? null,\n` +
      `    skipped: process.env.ORCA_TYPECHECK_SKIPPED ?? null\n` +
      `  }));\n` +
      `});\n`
  );
  return dir;
}

async function runOrca(args: readonly string[], cwd: string, env = process.env) {
  return runQuiet(binShim, args, { cwd, env, timeoutMs: 60_000 });
}

interface Probe {
  readonly args: string[];
  readonly backend: string | null;
  readonly bunOptions: string | null;
  readonly marker: string | null;
  readonly skipped: string | null;
}

function parseProbe(stdout: string): Probe {
  const line = stdout.split("\n").find((entry) => entry.startsWith("ORCA_PROBE "));
  if (line === undefined) {
    throw new Error(`probe output missing ORCA_PROBE line; got ${JSON.stringify(stdout)}`);
  }
  return JSON.parse(line.slice("ORCA_PROBE ".length)) as Probe;
}

describe("CLI preflight (binary entrypoint)", () => {
  test("check validates workflows and loops offline without importing them", async () => {
    const dir = await makeProbeDir("orca-check-valid-");
    const scratch = join(dir, "tmp");
    const marker = join(dir, "imported");
    await mkdir(scratch);
    await writeFile(
      join(dir, "loop.ts"),
      `import { defineLoop } from "@twelvehart/orcats/loop";\nvoid defineLoop;\nawait Bun.write(${JSON.stringify(marker)}, "bad");\n`
    );

    const result = await runOrca(["check", join(dir, "loop.ts")], dir, {
      ...process.env,
      TMPDIR: scratch
    });
    expect(result.isOk(), result.isErr() ? JSON.stringify(result.error) : "").toBe(true);
    expect(result._unsafeUnwrap().stdout).toContain("orcats check: ok");
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(Array.from(new Bun.Glob("*").scanSync(scratch))).toEqual([]);
    expect(await Bun.file(join(dir, "package.json")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "tsconfig.json")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "node_modules")).exists()).toBe(false);
  });

  test("check reports syntax and type failures", async () => {
    const dir = await makeProbeDir("orca-check-invalid-");
    await writeFile(join(dir, "bad.ts"), 'const broken: number = "wrong";\n');
    const result = await runOrca(["check", join(dir, "bad.ts")], dir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error._tag).toBe("CommandFailed");
    if (error._tag === "CommandFailed") {
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toContain("Type 'string' is not assignable to type 'number'");
    }
  });

  test("checks sibling imports and runs the original workflow", async () => {
    const dir = await makeProbeDir("orca-check-sibling-");
    await writeFile(join(dir, "helper.ts"), 'export const payload: string = "SIBLING_PAYLOAD";\n');
    await writeFile(join(dir, "probe.ts"), 'import { payload } from "./helper.ts";\nconsole.log(payload);\n');

    const checked = await runOrca(["check", join(dir, "probe.ts")], dir);
    expect(checked.isOk(), checked.isErr() ? JSON.stringify(checked.error) : "").toBe(true);
    const executed = await runOrca([join(dir, "probe.ts")], dir);
    expect(executed.isOk(), executed.isErr() ? JSON.stringify(executed.error) : "").toBe(true);
    expect(executed._unsafeUnwrap().stdout).toContain("SIBLING_PAYLOAD");
  });

  test("rejects type failures in sibling helpers before executing a workflow", async () => {
    const dir = await makeProbeDir("orca-check-sibling-invalid-");
    await writeFile(join(dir, "helper.ts"), 'export const payload: number = "wrong";\n');
    await writeFile(join(dir, "probe.ts"), 'import { payload } from "./helper.ts";\nconsole.log("MUST_NOT_RUN", payload);\n');

    const result = await runOrca([join(dir, "probe.ts")], dir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    if (error._tag === "CommandFailed") {
      expect(error.stderr).toContain("helper.ts");
      expect(error.stderr).toContain("Type 'string' is not assignable to type 'number'");
      expect(error.stdout).not.toContain("MUST_NOT_RUN");
    }
  });

  test.each(["run", "serve"])("%s checks the actual module for a registered name", async (command) => {
    const dir = await makeProbeDir("orca-check-named-loop-");
    const loopDir = join(dir, ".orca", "loops");
    await mkdir(loopDir, { recursive: true });
    await writeFile(join(loopDir, "different-filename.ts"), `
import { defineLoop, flowArgs, loop, ok, stdout } from "@twelvehart/orcats";
export default defineLoop({
  name: "registered-name",
  source: {
    kind: "manual",
    async start(handler: (event: undefined) => void) {
      const timer = setTimeout(() => handler(undefined), 20);
      return ok({ async stop() { clearTimeout(timer); return ok(undefined); } });
    }
  },
  sink: stdout(),
  async onTrigger() {
    const result = await loop<number>("finish").step("finish", () => 0).measure((state) => state).run(1);
    return result.map((outcome) => ({ outcome, output: "ORCA_PROBE " + JSON.stringify({
      args: flowArgs(), backend: process.env.ORCA_BACKEND ?? null,
      skipped: process.env.ORCA_TYPECHECK_SKIPPED ?? null
    }) }));
  }
});
`);

    const result = await runCliProcess(binShim, [command, "--backend", "codex", "registered-name", "--", "task", "two words"], {
      cwd: dir,
      timeoutMs: 20_000,
      ...(command === "serve" ? { shutdownAfter: { stream: "stdout" as const, pattern: "ORCA_PROBE ", signal: "SIGINT" as const } } : {})
    });
    expectExitZero(result);
    expect(result.stderr).toContain("preflight typecheck passed");
    const probe = parseProbe(result.stdout);
    expect(probe.args).toEqual(["task", "two words"]);
    expect(probe.backend).toBe("codex");
    expect(probe.skipped).toBe(command === "serve" ? "1" : null);
  }, 30_000);

  test.each(["run", "serve"])("%s rejects an invalid named module before importing it", async (command) => {
    const dir = await makeProbeDir("orca-check-named-invalid-");
    const loopDir = join(dir, ".orca", "loops");
    const marker = join(dir, "imported");
    await mkdir(loopDir, { recursive: true });
    await writeFile(join(loopDir, "different-filename.ts"), `
const broken: number = "wrong";
await Bun.write(${JSON.stringify(marker)}, String(broken));
`);

    const result = await runOrca([command, "registered-name"], dir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    if (error._tag === "CommandFailed") {
      expect(error.stderr).toContain("Type 'string' is not assignable to type 'number'");
    }
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("forwards post-`--` task tokens to the flow via flowArgs()", async () => {
    const dir = await makeProbeDir("orca-pf-args-");
    const result = await runOrca(
      ["--no-typecheck", join(dir, "probe.ts"), "--", "hello", "two words", '{"k":"v"}'],
      dir
    );
    expect(result.isOk(), result.isErr() ? JSON.stringify(result.error) : "").toBe(true);
    expect(parseProbe(result._unsafeUnwrap().stdout).args).toEqual(["hello", "two words", '{"k":"v"}']);
  });

  test("forwards an empty flowArgs list when no `--` separator is present", async () => {
    const dir = await makeProbeDir("orca-pf-empty-");
    const result = await runOrca(["--no-typecheck", join(dir, "probe.ts")], dir);
    expect(result.isOk()).toBe(true);
    expect(parseProbe(result._unsafeUnwrap().stdout).args).toEqual([]);
  });

  test("--backend sets ORCA_BACKEND for the flow to read", async () => {
    const dir = await makeProbeDir("orca-pf-backend-");
    const result = await runOrca(["--backend", "codex", "--no-typecheck", join(dir, "probe.ts")], dir);
    expect(result.isOk()).toBe(true);
    expect(parseProbe(result._unsafeUnwrap().stdout).backend).toBe("codex");
  });

  test("--no-typecheck sets ORCA_TYPECHECK_SKIPPED and stays silent (skip-by-flag, not tsc-not-found)", async () => {
    const dir = await makeProbeDir("orca-pf-skip-");
    const result = await runOrca(["--no-typecheck", join(dir, "probe.ts")], dir);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(parseProbe(value.stdout).skipped).toBe("1");
    expect(value.stderr).not.toContain("missing project typecheck setup");
  });

  test("source launcher removes poisoned BUN_OPTIONS and preserves unrelated environment", async () => {
    const dir = await makeProbeDir("orca-pf-env-");
    const result = await runOrca(["--no-typecheck", join(dir, "probe.ts")], dir, {
      ...process.env,
      BUN_OPTIONS: "--preload=/definitely/missing/orcats-preload.ts",
      ORCATS_TEST_MARKER: "preserved"
    });
    expect(result.isOk()).toBe(true);
    const probe = parseProbe(result._unsafeUnwrap().stdout);
    expect(probe.bunOptions).toBeNull();
    expect(probe.marker).toBe("preserved");
  });

  test("checks and runs without target TypeScript setup", async () => {
    const dir = await makeProbeDir("orca-pf-notsc-");
    const result = await runOrca([join(dir, "probe.ts")], dir);
    expect(result.isOk(), result.isErr() ? JSON.stringify(result.error) : "").toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.exitCode).toBe(0);
    expect(value.stderr).toContain("preflight typecheck passed");
    expect(parseProbe(value.stdout).skipped).toBeNull();
  });

  test("exits non-zero before execution when the artifact check fails", async () => {
    const dir = await makeProbeDir("orca-pf-fail-");
    await writeFile(join(dir, "probe.ts"), 'const broken: number = "not a number";\nconsole.log("MUST_NOT_RUN");\n');

    const result = await runOrca([join(dir, "probe.ts")], dir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error._tag).toBe("CommandFailed");
    if (error._tag === "CommandFailed") {
      expect(error.exitCode).toBe(1);
      expect(error.stdout).not.toContain("MUST_NOT_RUN");
    }
  });

  test("prints USAGE (not an error) when no script or command is given", async () => {
    const result = await runOrca([], repoRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stdout).toContain("Usage: orcats");
  });
});
