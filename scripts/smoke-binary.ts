import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runQuiet, type QuietProcOptions, type QuietProcResult } from "../src/tools/process.ts";

const packageJson = await Bun.file("package.json").json() as { version: string };

await mustRun("bun", ["run", "build:binary"]);

const binary = resolve("dist", "orca");
const help = await mustRun(binary, ["--help"]);
expectIncludes(help.stdout, "Usage: orca", "compiled binary help output");

const version = await mustRun(binary, ["--version"]);
const expectedVersion = `orca ${packageJson.version}\n`;
if (version.stdout !== expectedVersion) {
  throw new Error(`compiled binary version mismatch: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(version.stdout)}`);
}

const repoFlowDir = join(process.cwd(), ".orca", `binary-smoke-${String(Date.now())}`);
try {
  await mkdir(repoFlowDir, { recursive: true });
  await writeFile(
    join(repoFlowDir, "flow.ts"),
    `import { flow } from "@twelvehart/orca-ts";
import { manual } from "@twelvehart/orca-ts/loop";
import { BackendTagSchema } from "@twelvehart/orca-ts/model";

void manual;
void BackendTagSchema;

await flow()(async () => {
  console.log("orca-binary-repo-self-smoke-ok");
});
`
  );

  const repoFlow = await mustRun(binary, ["--no-typecheck", join(repoFlowDir, "flow.ts")]);
  expectIncludes(repoFlow.stdout, "orca-binary-repo-self-smoke-ok", "compiled binary repo workflow output");
} finally {
  await rm(repoFlowDir, { recursive: true, force: true });
}

const tempDir = await mkdtemp(join(tmpdir(), "orca-binary-smoke-"));
try {
  await writeFile(
    join(tempDir, "flow.ts"),
    `import { flow, currentFlowContext } from "@twelvehart/orca-ts";
import { manual } from "@twelvehart/orca-ts/loop";
import { BackendTagSchema } from "@twelvehart/orca-ts/model";

void manual;
void BackendTagSchema;

await flow()(async () => {
  console.log(\`orca-binary-smoke-ok \${currentFlowContext().cwd}\`);
});
`
  );
  await writeFile(
    join(tempDir, "legacy-flow.ts"),
    `import { flow } from "orca-ts";
import { manual } from "orca-ts/loop";
import { BackendTagSchema } from "orca-ts/model";

void manual;
void BackendTagSchema;

await flow()(async () => {
  console.log("orca-binary-legacy-smoke-ok");
});
`
  );

  const flow = await mustRun(binary, ["flow.ts"], { cwd: tempDir });
  expectIncludes(flow.stdout, "orca-binary-smoke-ok", "compiled binary flow output");
  expectIncludes(flow.stderr, "missing project typecheck setup", "compiled binary typecheck warning");

  const legacyFlow = await mustRun(binary, ["legacy-flow.ts"], { cwd: tempDir });
  expectIncludes(legacyFlow.stdout, "orca-binary-legacy-smoke-ok", "compiled binary legacy flow output");
  expectIncludes(legacyFlow.stderr, "missing project typecheck setup", "compiled binary legacy typecheck warning");

  // Regression guard: a stale ORCA_EMBEDDED_RESPAWNED leaked into the environment must NOT
  // make a fresh invocation skip the bootstrap + respawn. The handshake is validated against
  // process.ppid, so a value that is not this parent's pid is treated as stale and ignored.
  const poisoned = await withEnv({ ORCA_EMBEDDED_RESPAWNED: "1" }, () =>
    mustRun(binary, ["flow.ts"], { cwd: tempDir })
  );
  expectIncludes(poisoned.stdout, "orca-binary-smoke-ok", "compiled binary flow output under stale respawn handshake");
  expectIncludes(poisoned.stderr, "missing project typecheck setup", "compiled binary typecheck warning under stale respawn handshake");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function mustRun(
  command: string,
  args: readonly string[],
  options: QuietProcOptions = {}
): Promise<QuietProcResult> {
  const result = await runQuiet(command, args, options);
  if (result.isErr()) {
    throw new Error(`command failed: ${command} ${args.join(" ")}\n${JSON.stringify(result.error)}`);
  }

  return result.value;
}

async function withEnv<T>(overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function expectIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${label} must include ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}
