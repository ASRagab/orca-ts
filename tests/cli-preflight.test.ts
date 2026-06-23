import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runQuiet } from "../src/tools/process.ts";

// Drives the real `orca` CLI entrypoint (the bin shim) end-to-end — not parseCliArgs in
// isolation — to lock the shared preflight contract every flow and loop run depends on:
// flow-arg forwarding, --backend → ORCA_BACKEND, the typecheck skip env + warning, and a
// non-zero exit on typecheck failure. The compiled standalone binary is covered separately
// by scripts/smoke-binary.ts; here the bin shim keeps the gate fast and token-free (the probe
// flow never touches a backend).
const repoRoot = resolve(import.meta.dir, "..");
const binShim = resolve(repoRoot, "bin", "orca");
const orcaSrc = resolve(repoRoot, "src", "index.ts");
const repoTsc = resolve(repoRoot, "node_modules", ".bin", "tsc");

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProbeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  // Absolute import keeps the probe cwd-independent; it only reads preflight-set env, never a backend.
  await writeFile(
    join(dir, "probe.ts"),
    `import { flow, flowArgs } from ${JSON.stringify(orcaSrc)};\n` +
      `await flow()(async () => {\n` +
      `  console.log("ORCA_PROBE " + JSON.stringify({\n` +
      `    args: flowArgs(),\n` +
      `    backend: process.env.ORCA_BACKEND ?? null,\n` +
      `    skipped: process.env.ORCA_TYPECHECK_SKIPPED ?? null\n` +
      `  }));\n` +
      `});\n`
  );
  return dir;
}

async function runOrca(args: readonly string[], cwd: string) {
  return runQuiet("bun", [binShim, ...args], { cwd, timeoutMs: 60_000 });
}

interface Probe {
  readonly args: string[];
  readonly backend: string | null;
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
  test("forwards post-`--` task tokens to the flow via flowArgs()", async () => {
    const dir = await makeProbeDir("orca-pf-args-");
    const result = await runOrca(
      ["--no-typecheck", join(dir, "probe.ts"), "--", "hello", "two words", '{"k":"v"}'],
      dir
    );
    expect(result.isOk()).toBe(true);
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

  test("missing tsconfig warns and still runs (tsc-not-found skip, not a crash)", async () => {
    const dir = await makeProbeDir("orca-pf-notsc-");
    const result = await runOrca([join(dir, "probe.ts")], dir);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.exitCode).toBe(0);
    expect(value.stderr).toContain("missing project typecheck setup");
    expect(parseProbe(value.stdout).skipped).toBe("1");
  });

  test("exits non-zero when the project typecheck fails", async () => {
    const dir = await makeProbeDir("orca-pf-fail-");
    // A local tsc shim makes tsc resolution deterministic regardless of $PATH / global installs.
    await mkdir(join(dir, "node_modules", ".bin"), { recursive: true });
    await symlink(repoTsc, join(dir, "node_modules", ".bin", "tsc"));
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, types: [] } })
    );
    await writeFile(join(dir, "bad.ts"), 'const broken: number = "not a number";\nexport {};\n');

    const result = await runOrca([join(dir, "probe.ts")], dir);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error._tag).toBe("CommandFailed");
    if (error._tag === "CommandFailed") {
      expect(error.exitCode).toBe(1);
    }
  });

  test("prints USAGE (not an error) when no script or command is given", async () => {
    const result = await runOrca([], repoRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stdout).toContain("Usage: orca");
  });
});
