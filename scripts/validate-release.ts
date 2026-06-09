import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  license?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

const failures: string[] = [];

if (packageJson.license !== "Apache-2.0") {
  failures.push("package.json license must be Apache-2.0");
}

if (!packageJson.bin?.["orca"]) {
  failures.push("package.json must expose bin.orca");
}

if (!packageJson.exports?.["."]) {
  failures.push("package.json must expose the public package root");
}

if (!packageJson.scripts?.["build:binary"]) {
  failures.push("package.json must include build:binary");
}

for (const path of ["LICENSE", "NOTICE", "README.md"]) {
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
