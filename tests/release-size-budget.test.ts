import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("release validation builds checker assets before enforcing size budgets", async () => {
  const root = resolve(import.meta.dir, "..");
  const fixture = await mkdtemp(join(tmpdir(), "orcats-release-size-"));
  try {
    const packageJson = await Bun.file(join(root, "package.json")).json() as {
      version: string;
      scripts: Record<string, string>;
    };
    packageJson.scripts["build:checker"] = "bun scripts/fixture-checker.ts";
    await mkdir(join(fixture, "scripts"));
    await mkdir(join(fixture, "src", "cli"), { recursive: true });
    await writeFile(join(fixture, "package.json"), JSON.stringify(packageJson));
    for (const path of ["LICENSE", "NOTICE", "README.md", "install.sh", "src/cli/version.ts",
      "scripts/validate-release.ts", "scripts/package-artifact.ts"]) {
      await copyFile(join(root, path), join(fixture, path));
    }
    const baselineBytes = 1_000_000;
    const maxBytes = Math.ceil(baselineBytes * 1.1 / 1024) * 1024;
    const budget = {
      artifact: "npm-package:installed", baselineBytes, maxBytes,
      measuredVersion: packageJson.version, rationale: "isolated checker build regression",
    };
    await writeFile(join(fixture, "scripts", "release-size-baselines.json"),
      JSON.stringify({ artifacts: [budget] }));
    await writeFile(join(fixture, "scripts", "fixture-checker.ts"), `
import { mkdir } from "node:fs/promises";
await mkdir("dist/checker", { recursive: true });
await Bun.write("dist/checker/payload", new Uint8Array(${String(maxBytes + 1)}));
`);

    const result = Bun.spawnSync(["bun", "run", "validate:release"], { cwd: fixture });
    expect(await Bun.file(join(fixture, "dist", "checker", "payload")).exists()).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("distribution artifact npm-package:installed measured");

    budget.maxBytes += 1024;
    await writeFile(join(fixture, "scripts", "release-size-baselines.json"),
      JSON.stringify({ artifacts: [budget] }));
    const excessive = Bun.spawnSync(["bun", "scripts/validate-release.ts"], { cwd: fixture });
    expect(excessive.exitCode).toBe(1);
    expect(excessive.stderr.toString()).toContain("exceeds 110% of baseline");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);
