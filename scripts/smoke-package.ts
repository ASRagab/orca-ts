import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PackageName,
  collectMetadataFailures,
  collectPackFailures,
  npmPackJson,
  readPackageJson,
  runCommand
} from "./package-artifact.ts";

const root = process.cwd();
const packageJson = readPackageJson(root);

runCommand("bun", ["run", "build:types"], root);

const tempDir = await mkdtemp(join(tmpdir(), "orca-package-smoke-"));
try {
  const packDir = join(tempDir, "pack");
  const projectDir = join(tempDir, "project");
  await mkdir(packDir, { recursive: true });
  await mkdir(join(projectDir, "src"), { recursive: true });

  const manifest = npmPackJson(["--pack-destination", packDir], root);
  const failures = [
    ...collectMetadataFailures(packageJson),
    ...collectPackFailures(manifest)
  ];
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  if (manifest.filename === undefined) {
    throw new Error("npm pack did not report a tarball filename");
  }

  await writeFile(
    join(projectDir, "package.json"),
    `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [PackageName]: `file:${join(packDir, manifest.filename)}`
      },
      devDependencies: {
        typescript: packageJson.devDependencies?.typescript ?? "^5.9.0",
        "@types/bun": packageJson.devDependencies?.["@types/bun"] ?? "^1.3.0"
      }
    }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        exactOptionalPropertyTypes: true,
        lib: ["ES2023"],
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2023",
        types: ["bun-types"],
        verbatimModuleSyntax: true
      },
      include: ["src/**/*.ts"]
    }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "src", "imports.ts"),
    `import { flow, flowArgs, ok, runBaselineGate, z, type Result } from "${PackageName}";
import { defineLoop, manual, stdout } from "${PackageName}/loop";
import { BackendTagSchema, orThrow, type RuntimeError } from "${PackageName}/model";
import { fakeBackend } from "${PackageName}/testing";

const schema = z.object({ ready: z.boolean() });
const result: Result<string, RuntimeError> = ok("ready");
const baselineOptions: Parameters<typeof runBaselineGate>[0] = {
  commands: [],
  repair: async () => {}
};
orThrow(result);
void flow;
void flowArgs;
void schema;
void BackendTagSchema;
void defineLoop;
void manual;
void stdout;
void fakeBackend;
void baselineOptions;
`
  );

  runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--fund=false"], projectDir);
  runCommand("npx", ["--no-install", "tsc", "--noEmit"], projectDir);

  const version = runCommand(join(projectDir, "node_modules", ".bin", "orcats"), ["--version"], projectDir);
  const expectedVersion = `orcats ${packageJson.version ?? ""}\n`;
  if (version.stdout !== expectedVersion) {
    throw new Error(`orcats --version mismatch: expected ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(version.stdout)}`);
  }

  const fakeBin = join(tempDir, "bin");
  await mkdir(fakeBin);
  const fakeNpx = join(fakeBin, "npx");
  await writeFile(fakeNpx, "#!/bin/sh\nprintf 'fake-npx %s\\n' \"$*\"\n");
  await chmod(fakeNpx, 0o755);
  const skills = runCommand(
    join(projectDir, "node_modules", ".bin", "orcats"),
    ["skills", "--list"],
    projectDir,
    { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
  );
  if (skills.stdout !== "fake-npx skills add ASRagab/orca-ts --list\n") {
    throw new Error(`installed package skills delegation mismatch: ${JSON.stringify(skills.stdout)}`);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
