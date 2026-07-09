import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectMetadataFailures } from "./package-artifact.ts";

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

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
