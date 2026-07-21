import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PackageName = "@twelvehart/orcats";

export interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly private?: boolean;
  readonly types?: string;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly publishConfig?: {
    readonly access?: string;
    readonly registry?: string;
  };
  readonly scripts?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

export interface PackFile {
  readonly path: string;
}

export interface PackManifest {
  readonly name?: string;
  readonly version?: string;
  readonly filename?: string;
  readonly files?: readonly PackFile[];
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const ExpectedFiles = [
  "bin/orcats",
  "dist/**/*.d.ts",
  "dist/**/*.d.ts.map",
  "src/**/*.ts",
  "README.md",
  "LICENSE",
  "NOTICE"
] as const;

const ExpectedExports = {
  ".": { types: "./dist/index.d.ts", default: "./src/index.ts" },
  "./loop": { types: "./dist/loop/index.d.ts", default: "./src/loop/index.ts" },
  "./model": { types: "./dist/model/index.d.ts", default: "./src/model/index.ts" },
  "./testing": { types: "./dist/test-utils/index.d.ts", default: "./src/test-utils/index.ts" },
  "./package.json": { default: "./package.json" }
} as const;

const RequiredPackedFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "bin/orcats",
  "src/index.ts",
  "src/loop/index.ts",
  "src/model/index.ts",
  "src/test-utils/index.ts",
  "dist/index.d.ts",
  "dist/index.d.ts.map",
  "dist/loop/index.d.ts",
  "dist/loop/index.d.ts.map",
  "dist/model/index.d.ts",
  "dist/model/index.d.ts.map",
  "dist/test-utils/index.d.ts",
  "dist/test-utils/index.d.ts.map"
] as const;

const ForbiddenPackedPathPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\.github\//, ".github workflow files must not publish"],
  [/^\.orca\//, "local .orca workflow files must not publish"],
  [/^tests\//, "tests must not publish"],
  [/^fixtures\//, "fixtures must not publish"],
  [/^website\//, "website files must not publish"],
  [/^openspec\//, "OpenSpec files must not publish"],
  [/^dist\/release\//, "release artifacts must not publish"],
  [/^dist\/orcats$/, "compiled release binary must not publish through npm"],
  [/\.tar\.gz$/, "release tarballs must not publish"],
  [/\.tgz$/, "package tarballs must not publish"],
  [/(^|\/)node_modules\//, "node_modules must not publish"],
  [/(^|\/)\.tsbuildinfo$/, "TypeScript build info must not publish"],
  [/(^|\/)\.DS_Store$/, "macOS metadata must not publish"]
];

export function readPackageJson(root = process.cwd()): PackageJson {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
}

export function runCommand(command: string, args: readonly string[], cwd = process.cwd()): CommandResult {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: ${[command, ...args].join(" ")}\n${result.stdout}${result.stderr}`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export function npmPackJson(args: readonly string[] = [], cwd = process.cwd()): PackManifest {
  const result = runCommand("npm", ["pack", "--json", ...args], cwd);
  return parseNpmPackJson(result.stdout);
}

export function parseNpmPackJson(stdout: string): PackManifest {
  const parsed = JSON.parse(stdout) as unknown;
  const manifest: unknown = Array.isArray(parsed)
    ? parsed[0]
    : isRecord(parsed)
      ? Object.values(parsed)[0]
      : undefined;
  if (manifest === undefined) {
    throw new Error("npm pack --json returned no package manifest");
  }
  return manifest as PackManifest;
}

export function collectMetadataFailures(packageJson: PackageJson): string[] {
  const failures: string[] = [];

  if (packageJson.name !== PackageName) {
    failures.push(`package.json name must be ${PackageName}`);
  }
  if (packageJson.version === undefined || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
    failures.push("package.json version must be plain semver x.y.z");
  }
  if (packageJson.license !== "Apache-2.0") {
    failures.push("package.json license must be Apache-2.0");
  }
  if (packageJson.private !== undefined) {
    failures.push("package.json must not set private for npm publication");
  }
  if (packageJson.types !== "./dist/index.d.ts") {
    failures.push("package.json types must point at ./dist/index.d.ts");
  }
  if (packageJson.publishConfig?.access !== "public") {
    failures.push("package.json publishConfig.access must be public");
  }
  if (packageJson.publishConfig?.registry !== "https://registry.npmjs.org/") {
    failures.push("package.json publishConfig.registry must be https://registry.npmjs.org/");
  }
  if (packageJson.bin?.orcats !== "bin/orcats") {
    failures.push("package.json must expose bin.orcats as bin/orcats");
  }

  for (const [specifier, expected] of Object.entries(ExpectedExports)) {
    const actual = packageJson.exports?.[specifier];
    if (!isRecord(actual)) {
      failures.push(`package.json exports.${specifier} must be an object`);
      continue;
    }
    for (const [condition, value] of Object.entries(expected)) {
      if (actual[condition] !== value) {
        failures.push(`package.json exports.${specifier}.${condition} must be ${value}`);
      }
    }
  }

  const actualFiles = packageJson.files ?? [];
  for (const expectedFile of ExpectedFiles) {
    if (!actualFiles.includes(expectedFile)) {
      failures.push(`package.json files must include ${expectedFile}`);
    }
  }
  for (const actualFile of actualFiles) {
    if (!ExpectedFiles.includes(actualFile as typeof ExpectedFiles[number])) {
      failures.push(`package.json files contains unexpected entry ${actualFile}`);
    }
  }

  return failures;
}

export function collectPackFailures(manifest: PackManifest): string[] {
  const failures: string[] = [];
  if (manifest.name !== PackageName) {
    failures.push(`npm pack name must be ${PackageName}`);
  }
  const packedPaths = new Set((manifest.files ?? []).map((file) => file.path));

  for (const required of RequiredPackedFiles) {
    if (!packedPaths.has(required)) {
      failures.push(`npm package must include ${required}`);
    }
  }
  if (![...packedPaths].some((path) => path.startsWith("src/"))) {
    failures.push("npm package must include runtime source under src/");
  }
  if (![...packedPaths].some((path) => path.startsWith("dist/") && path.endsWith(".d.ts"))) {
    failures.push("npm package must include generated declarations under dist/");
  }
  if (![...packedPaths].some((path) => path.startsWith("dist/") && path.endsWith(".d.ts.map"))) {
    failures.push("npm package must include declaration maps under dist/");
  }

  for (const path of packedPaths) {
    for (const [pattern, reason] of ForbiddenPackedPathPatterns) {
      if (pattern.test(path)) {
        failures.push(`${reason}: ${path}`);
      }
    }
  }

  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
