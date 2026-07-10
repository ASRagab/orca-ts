import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function runResolverScenario(flowPath: string) {
  const embeddedUrl = pathToFileURL(join(import.meta.dir, "..", "src", "cli", "embedded.ts")).href;
  const resolveSource =
    `import { canResolveOrca } from ${JSON.stringify(embeddedUrl)}; ` +
    `process.stdout.write(String(canResolveOrca(process.env.ORCA_TEST_FLOW_PATH ?? "")));`;
  const scenarioSource = `
    import { existsSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { canResolveOrca, ensureOrcaResolvable } from ${JSON.stringify(embeddedUrl)};
    const flowPath = process.env.ORCA_TEST_FLOW_PATH ?? "";
    const before = canResolveOrca(flowPath);
    const ensured = ensureOrcaResolvable(flowPath);
    const shimDir = join(dirname(flowPath), "node_modules", "@twelvehart", "orcats");
    const shimFiles = ["package.json", "index.cjs", "loop.cjs", "model.cjs"]
      .every((file) => existsSync(join(shimDir, file)));
    const resolver = Bun.spawnSync(
      [process.execPath, "--eval", ${JSON.stringify(resolveSource)}],
      {
        env: { ...process.env, ORCA_TEST_FLOW_PATH: flowPath },
        stdout: "pipe",
        stderr: "pipe"
      }
    );
    if (resolver.exitCode !== 0) {
      process.stderr.write(resolver.stderr.toString());
      process.exit(1);
    }
    const after = resolver.stdout.toString() === "true";
    process.stdout.write(JSON.stringify({ before, ensured, shimFiles, after }));
  `;

  return Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      scenarioSource
    ],
    {
      env: { ...process.env, ORCA_TEST_FLOW_PATH: flowPath },
      stdout: "pipe",
      stderr: "pipe"
    }
  );
}

test("installs the embedded fallback when an ancestor package cannot resolve", () => {
  const root = mkdtempSync(join(tmpdir(), "orcats-embedded-resolver-"));
  const packageDir = join(root, "node_modules", "@twelvehart", "orcats");
  const flowPath = join(root, "projects", "nested", "flow.ts");

  try {
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(root, "projects", "nested"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@twelvehart/orcats",
        exports: "./missing.js"
      })
    );
    writeFileSync(flowPath, "");

    const probe = runResolverScenario(flowPath);

    expect(probe.stderr.toString()).toBe("");
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString()).toBe(
      JSON.stringify({ before: false, ensured: true, shimFiles: true, after: true })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
