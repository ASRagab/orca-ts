import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectMetadataFailures } from "./package-artifact.ts";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  license?: string;
  private?: boolean;
  publishConfig?: Record<string, string>;
  types?: string;
  files?: string[];
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};
const versionSource = await readFile(join(root, "src", "cli", "version.ts"), "utf8");

const failures: string[] = collectMetadataFailures(packageJson);

const versionMatch = /ORCA_VERSION = "([^"]+)"/.exec(versionSource);
if (!versionMatch) {
  failures.push("src/cli/version.ts must export ORCA_VERSION as a string literal");
} else if (packageJson.version !== versionMatch[1]) {
  failures.push("package.json version must match src/cli/version.ts ORCA_VERSION");
}

if (!packageJson.bin?.["orcats"]) {
  failures.push("package.json must expose bin.orcats");
}

if (!packageJson.exports?.["."]) {
  failures.push("package.json must expose the public package root");
}

if (!packageJson.scripts?.["build:binary"]) {
  failures.push("package.json must include build:binary");
} else if (!packageJson.scripts["build:binary"].includes("--compile-autoload-package-json")) {
  failures.push("build:binary must enable runtime package.json loading");
}

if (!packageJson.scripts?.["build:release"]) {
  failures.push("package.json must include build:release");
}

if (!packageJson.scripts?.["smoke:package"]) {
  failures.push("package.json must include smoke:package");
}

if (!packageJson.scripts?.["validate:package"]) {
  failures.push("package.json must include validate:package");
}

for (const path of ["LICENSE", "NOTICE", "README.md", "install.sh"]) {
  try {
    await access(join(root, path));
  } catch {
    failures.push(`${path} is missing`);
  }
}

// Distribution size budgets: every artifact records a measured baseline and a
// fixed maximum capped at 110% of that baseline rounded up to the next KiB.
// Validation fails malformed budgets, an excessive allowance, or a measured
// artifact above its maximum.
interface SizeBudget {
  readonly artifact?: unknown;
  readonly baselineBytes?: unknown;
  readonly maxBytes?: unknown;
  readonly measuredVersion?: unknown;
  readonly rationale?: unknown;
}

function allowedMaxBytes(baselineBytes: number): number {
  return Math.ceil((baselineBytes * 1.1) / 1024) * 1024;
}

function measuredNpmPackageBytes(): { compressed: number; installed: number } | undefined {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  const entry: unknown = Array.isArray(parsed)
    ? (parsed as unknown[])[0]
    : (parsed as Record<string, unknown>)[packageJson.name ?? ""];
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as { size?: unknown; unpackedSize?: unknown };
  if (typeof record.size !== "number" || typeof record.unpackedSize !== "number") return undefined;
  return { compressed: record.size, installed: record.unpackedSize };
}

const baselinesRaw = await readFile(join(root, "scripts", "release-size-baselines.json"), "utf8");
const baselines = JSON.parse(baselinesRaw) as { artifacts?: SizeBudget[] };
const budgets = baselines.artifacts ?? [];
if (budgets.length === 0) {
  failures.push("release-size-baselines.json must record at least one artifact budget");
}

const npmMeasurement = measuredNpmPackageBytes();
if (npmMeasurement === undefined) {
  failures.push("could not measure npm package size via `npm pack --dry-run --json`");
}

for (const budget of budgets) {
  const id = typeof budget.artifact === "string" ? budget.artifact : "<unknown>";
  if (typeof budget.artifact !== "string" || budget.artifact.length === 0) {
    failures.push("size budget is missing artifact identity");
  }
  if (typeof budget.baselineBytes !== "number" || !Number.isSafeInteger(budget.baselineBytes) || budget.baselineBytes <= 0) {
    failures.push(`size budget ${id} is missing a positive baselineBytes`);
  }
  if (typeof budget.maxBytes !== "number" || !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes <= 0) {
    failures.push(`size budget ${id} is missing a positive maxBytes`);
  }
  if (typeof budget.measuredVersion !== "string" || budget.measuredVersion.length === 0) {
    failures.push(`size budget ${id} is missing measuredVersion`);
  }
  if (typeof budget.rationale !== "string" || budget.rationale.trim().length === 0) {
    failures.push(`size budget ${id} is missing a non-empty rationale`);
  }
  if (
    typeof budget.baselineBytes === "number" && budget.baselineBytes > 0 &&
    typeof budget.maxBytes === "number" && budget.maxBytes > 0
  ) {
    const allowed = allowedMaxBytes(budget.baselineBytes);
    if (budget.maxBytes > allowed) {
      failures.push(
        `size budget ${id} maximum ${String(budget.maxBytes)} exceeds 110% of baseline rounded up to the next KiB (${String(allowed)})`,
      );
    }
    if (npmMeasurement !== undefined) {
      const measured =
        id === "npm-package:compressed" ? npmMeasurement.compressed :
        id === "npm-package:installed" ? npmMeasurement.installed :
        undefined;
      if (measured !== undefined && measured > budget.maxBytes) {
        failures.push(
          `distribution artifact ${id} measured ${String(measured)} bytes, above its maximum ${String(budget.maxBytes)}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
