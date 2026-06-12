import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const tempDir = await mkdtemp(join(tmpdir(), "orca-binary-smoke-"));
try {
  await writeFile(
    join(tempDir, "flow.ts"),
    `import { flow, currentFlowContext } from "orca-ts";\n\nawait flow()(async () => {\n  console.log(\`orca-binary-smoke-ok \${currentFlowContext().cwd}\`);\n});\n`
  );

  const flow = await mustRun(binary, ["flow.ts"], { cwd: tempDir });
  expectIncludes(flow.stdout, "orca-binary-smoke-ok", "compiled binary flow output");
  expectIncludes(flow.stderr, "missing project typecheck setup", "compiled binary typecheck warning");
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

function expectIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`${label} must include ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}
