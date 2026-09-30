import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runQuiet, type QuietProcOptions, type QuietProcResult } from "../src/tools/process.ts";
import { releaseTargetForHost } from "./release-build-options.ts";

const packageJson = await Bun.file("package.json").json() as { version: string };

await mustRun("bun", ["run", "build:binary"]);

const binary = resolve("dist", "orcats");
const help = await mustRun(binary, ["--help"]);
expectIncludes(help.stdout, "Usage: orcats", "compiled binary help output");

const version = await mustRun(binary, ["--version"]);
const expectedVersion = `orcats ${packageJson.version}\n`;
if (version.stdout !== expectedVersion) {
  throw new Error(`compiled binary version mismatch: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(version.stdout)}`);
}

const skillsDir = await mkdtemp(join(tmpdir(), "orcats-skills-binary-smoke-"));
try {
  const fakeBin = join(skillsDir, "bin");
  await mkdir(fakeBin);
  const fakeNpx = join(fakeBin, "npx");
  await writeFile(fakeNpx, "#!/bin/sh\nprintf 'fake-npx %s\\n' \"$*\"\n");
  await chmod(fakeNpx, 0o755);

  const skills = await withEnv(
    { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    () => mustRun(binary, ["skills", "--skill", "orcats-setup", "--agent", "claude-code", "--global", "--yes"], { cwd: skillsDir })
  );
  expectIncludes(
    skills.stdout,
    "fake-npx --yes skills add ASRagab/orca-ts --skill orcats-setup --agent claude-code --global --yes",
    "compiled binary skills delegation",
  );
  if (existsSync(join(skillsDir, "node_modules"))) {
    throw new Error("compiled binary skills command must not initialize the embedded fallback");
  }
} finally {
  await rm(skillsDir, { recursive: true, force: true });
}

const repoFlowDir = join(process.cwd(), ".orca", `binary-smoke-${String(Date.now())}`);
try {
  await mkdir(repoFlowDir, { recursive: true });
  await writeFile(
    join(repoFlowDir, "flow.ts"),
    `import { flow } from "@twelvehart/orcats";
import { manual } from "@twelvehart/orcats/loop";
import { BackendTagSchema } from "@twelvehart/orcats/model";
import * as ts from "typescript";

void manual;
void BackendTagSchema;

await flow()(async () => {
  const child = Bun.spawnSync(["sh", "-c", 'test -z "$BUN_OPTIONS" && printf "%s:unset" "$ORCATS_TEST_MARKER"'], { env: process.env });
  console.log(\`orcats-binary-repo-self-smoke-ok typescript=\${ts.version} env=\${process.env.ORCATS_TEST_MARKER ?? "unset"}:\${process.env.BUN_OPTIONS ?? "unset"} child=\${child.stdout.toString()}\`);
});
`
  );

  const repoFlow = await mustRun(binary, ["--no-typecheck", join(repoFlowDir, "flow.ts")]);
  expectIncludes(
    repoFlow.stdout,
    "orcats-binary-repo-self-smoke-ok typescript=",
    "compiled binary repo workflow output with a project package import",
  );

  const releaseParent = await mkdtemp(
    join(tmpdir(), "orcats-release-binary-smoke-"),
  );
  try {
    const target = releaseTargetForHost();
    const releaseDir = join(releaseParent, "release");
    await mustRun("bun", [
      "run",
      "scripts/build-release-binaries.ts",
      `--only-target=${target}`,
      `--release-dir=${releaseDir}`,
    ]);
    const curl = Bun.which("curl");
    if (curl === null) throw new Error("installer smoke requires curl");
    const downloadBin = join(releaseParent, "download-bin");
    const installDir = join(releaseParent, "installed");
    await mkdir(downloadBin);
    await writeFile(
      join(downloadBin, "curl"),
      '#!/bin/sh\nexec "$ORCATS_SMOKE_CURL" "$1" "$2" "file://$ORCATS_SMOKE_RELEASE_DIR/${3##*/}"\n',
    );
    await chmod(join(downloadBin, "curl"), 0o755);
    await withEnv(
      {
        PATH: `${downloadBin}:${process.env.PATH ?? ""}`,
        ORCA_INSTALL_DIR: installDir,
        ORCA_VERSION: packageJson.version,
        ORCATS_SMOKE_CURL: curl,
        ORCATS_SMOKE_RELEASE_DIR: releaseDir,
        BUN_OPTIONS: "--preload=/definitely/missing/orcats-preload.ts",
      },
      () => mustRun("bash", [resolve("install.sh")], { cwd: releaseParent }),
    );
    const releaseBinary = join(installDir, "orcats");
    const installedFlow = join(releaseParent, "flow.ts");
    await writeFile(join(releaseParent, "helper.ts"), 'export const marker = "orcats-installed-smoke-ok";\n');
    await writeFile(
      installedFlow,
      `import { flow } from "@twelvehart/orcats";
import { marker } from "./helper.ts";
await flow()(async () => {
  const child = Bun.spawnSync(["sh", "-c", 'test -z "$BUN_OPTIONS" && printf "%s:unset" "$ORCATS_TEST_MARKER"'], { env: process.env });
  console.log(\`\${marker} env=\${process.env.ORCATS_TEST_MARKER ?? "unset"}:\${process.env.BUN_OPTIONS ?? "unset"} child=\${child.stdout.toString()}\`);
});
`,
    );
    const checked = await withEnv(
      { ORCA_CHECKER_ASSETS: "" },
      () => mustRun(releaseBinary, ["check", installedFlow], { cwd: releaseParent }),
    );
    expectIncludes(checked.stdout, "orcats check: ok", "installed offline artifact check");
    const releaseFlow = await withEnv(
      {
        BUN_OPTIONS: "--preload=/definitely/missing/orcats-preload.ts",
        ORCA_CHECKER_ASSETS: "",
        ORCATS_TEST_MARKER: "preserved"
      },
      () => mustRun(releaseBinary, [installedFlow], { cwd: releaseParent })
    );
    expectIncludes(
      releaseFlow.stdout,
      "orcats-installed-smoke-ok",
      "installed release workflow with the embedded public package",
    );
    expectIncludes(
      releaseFlow.stdout,
      "env=preserved:unset child=preserved:unset",
      "release launcher environment isolation",
    );
  } finally {
    await rm(releaseParent, { recursive: true, force: true });
  }
} finally {
  await rm(repoFlowDir, { recursive: true, force: true });
}

const tempDir = await mkdtemp(join(tmpdir(), "orcats-binary-smoke-"));
try {
  await writeFile(
    join(tempDir, "flow.ts"),
    `import { flow, currentFlowContext } from "@twelvehart/orcats";
import { manual } from "@twelvehart/orcats/loop";
import { BackendTagSchema } from "@twelvehart/orcats/model";

void manual;
void BackendTagSchema;

await flow()(async () => {
  console.log(\`orcats-binary-smoke-ok \${currentFlowContext().cwd}\`);
});
`
  );

  const flow = await mustRun(binary, ["flow.ts"], { cwd: tempDir });
  expectIncludes(flow.stdout, "orcats-binary-smoke-ok", "compiled binary flow output");
  expectIncludes(flow.stderr, "preflight typecheck passed", "compiled binary artifact check");

  // Regression guard: a stale ORCA_EMBEDDED_RESPAWNED leaked into the environment must NOT
  // make a fresh invocation skip the bootstrap + respawn. The handshake is validated against
  // process.ppid, so a value that is not this parent's pid is treated as stale and ignored.
  const poisoned = await withEnv({ ORCA_EMBEDDED_RESPAWNED: "1" }, () =>
    mustRun(binary, ["flow.ts"], { cwd: tempDir })
  );
  expectIncludes(poisoned.stdout, "orcats-binary-smoke-ok", "compiled binary flow output under stale respawn handshake");
  expectIncludes(poisoned.stderr, "preflight typecheck passed", "compiled binary artifact check under stale respawn handshake");

  const loopDir = join(tempDir, ".orca", "loops");
  await mkdir(loopDir, { recursive: true });
  await writeFile(join(loopDir, "different-filename.ts"), `
import { defineLoop, flowArgs, loop, manual, stdout } from "@twelvehart/orcats";
export default defineLoop({
  name: "named-smoke",
  source: manual(),
  sink: stdout(),
  async onTrigger() {
    const result = await loop<number>("finish").step("finish", () => 0).measure((state) => state).run(1);
    return result.map((outcome) => ({ outcome, output: "named-smoke " + flowArgs().join(" ") }));
  }
});
`);
  const namedLoop = await mustRun(binary, ["run", "named-smoke", "--", "task", "two words"], { cwd: tempDir });
  expectIncludes(namedLoop.stdout, "named-smoke task two words", "compiled binary named loop and task arguments");
  expectIncludes(namedLoop.stderr, "preflight typecheck passed", "compiled binary named loop preflight");
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
        Reflect.deleteProperty(process.env, key);
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
