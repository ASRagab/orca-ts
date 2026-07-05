import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runQuiet } from "../src/tools/process.ts";

// Keeps the bundled skill flow templates from drifting out of the runtime API:
// every template under skills/**/assets/templates/ must typecheck against the
// in-repo @twelvehart/orca-ts package (resolved via package self-reference in
// tsconfig.skill-templates.json). Mirrors the Scala orca-flow recipes test.

const TEMPLATES_DIR = "skills/orca-ts-author/assets/templates";
const EXPECTED_ARCHETYPES = [
  "single-change",
  "persistent-multitask",
  "issue-to-pr",
  "bugfix",
  "cleanup-sweep",
  "multi-backend-compare",
] as const;

describe("skill flow templates", () => {
  test("one template exists per archetype", () => {
    const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".ts"));
    for (const archetype of EXPECTED_ARCHETYPES) {
      expect(files).toContain(`${archetype}.ts`);
    }
  });

  test("all templates typecheck against @twelvehart/orca-ts", async () => {
    const tsc = join("node_modules", ".bin", "tsc");
    const result = await runQuiet(tsc, ["--noEmit", "-p", "tsconfig.skill-templates.json"]);
    if (result.isErr()) {
      const error = result.error;
      const detail =
        error._tag === "CommandFailed" ? `${error.stdout}\n${error.stderr}` : JSON.stringify(error);
      throw new Error(`skill templates failed typecheck:\n${detail}`);
    }
    expect(result.value.exitCode).toBe(0);
  }, 120_000);

  test("issue-to-pr preserves baseline repair output before main PR work", () => {
    const text = readFileSync(join(TEMPLATES_DIR, "issue-to-pr.ts"), "utf8");
    const snapshotIndex = text.indexOf(
      "captureDirtyBaselineSnapshot({ commands: GATE, snapshotDir: await gitPath(ACCEPTED_DIRTY_SNAPSHOT_KEY) })",
    );
    const stashIndex = text.indexOf("stashed = await stashIfDirty()");
    const gateIndex = text.indexOf("await runBaselineGate({");
    const branchIndex = text.indexOf("await ensureFeatureBranch()");

    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(stashIndex).toBeGreaterThan(snapshotIndex);
    expect(gateIndex).toBeGreaterThan(stashIndex);
    expect(branchIndex).toBeGreaterThan(gateIndex);
    expect(text).toContain('policy: baseline.policy === "accept-dirty" ? "repair" : baseline.policy');
    expect(text).toContain('ACCEPTED_DIRTY_SNAPSHOT_KEY = "orca-baselines"');
    expect(text).toContain('git", args: ["rev-parse", "--git-path", path]');
  });

  test("cleanup-sweep protects baseline repair paths during per-file edits", () => {
    const text = readFileSync(join(TEMPLATES_DIR, "cleanup-sweep.ts"), "utf8");

    expect(text).toContain("protectedBaselineSignature(protectedBaselineEntries)");
    expect(text).toContain("untrackedProtectedSignature");
    expect(text).toContain("readdirSync(path)");
    expect(text).toContain("protectedAfter !== protectedBefore");
    expect(text).toContain("baseline-protected paths");
    expect(text).toContain("stashed = await stashIfDirty()");
    expect(text).toContain('ACCEPTED_DIRTY_SNAPSHOT_KEY = "orca-baselines"');
    expect(text).toContain('git", args: ["rev-parse", "--git-path", path]');
    expect(text).not.toContain("baselineDirtyPaths");
  });
});

// Each skill installs as a self-contained directory via `npx skills`, so scripts
// used by more than one skill are bundled into each skill's own scripts/ dir.
// These groups MUST stay byte-identical — otherwise an installed skill silently
// runs a stale copy. The fix when this fails is to re-copy the canonical script,
// never to let the copies diverge.
const DUPLICATED_SCRIPTS: ReadonlyArray<readonly [string, ...string[]]> = [
  ["skills/orca-ts-author/scripts/orca-run.sh", "skills/orca-ts-flow/scripts/orca-run.sh"],
  ["skills/orca-ts-setup/scripts/orca-doctor.sh", "skills/orca-ts-flow/scripts/orca-doctor.sh"],
];

describe("bundled skill scripts", () => {
  for (const group of DUPLICATED_SCRIPTS) {
    const [canonical, ...copies] = group;
    test(`${canonical} copies stay byte-identical`, () => {
      const expected = readFileSync(canonical, "utf8");
      for (const copy of copies) {
        expect(readFileSync(copy, "utf8")).toBe(expected);
      }
    });
  }
});

// install.sh is the source of truth for the default install directory. The
// setup script's fallback resolver and every doc example must agree with it,
// otherwise users get steered at a dir that isn't on PATH (the bug that
// motivated the ~/.local/bin switch). These files must reference the canonical
// default and must NOT carry a stale `$HOME/bin` install-dir example.
const CANONICAL_INSTALL_DIR = "$HOME/.local/bin";
const INSTALL_DIR_DOCS: ReadonlyArray<string> = [
  "install.sh",
  "skills/orca-ts-setup/scripts/orca-setup.sh",
  "skills/orca-ts-setup/SKILL.md",
  "README.md",
  "docs/distribution.md",
];
const INSTALL_SCRIPT_URL_DOCS: ReadonlyArray<string> = [
  "README.md",
  "docs/distribution.md",
  "docs/release.md",
];

describe("install dir default agreement", () => {
  for (const path of INSTALL_DIR_DOCS) {
    test(`${path} references ${CANONICAL_INSTALL_DIR} and not stale $HOME/bin`, () => {
      const text = readFileSync(path, "utf8");
      expect(text).toContain(CANONICAL_INSTALL_DIR);
      // Match a literal `$HOME/bin` used as an install dir (followed by a
      // quote or slash boundary), without flagging `$HOME/.local/bin`.
      expect(text).not.toMatch(/\$HOME\/bin(?=["/\s])/);
    });
  }
});

describe("release installer documentation", () => {
  test("install.sh accepts plain or v-prefixed ORCA_VERSION values", () => {
    const text = readFileSync("install.sh", "utf8");

    expect(text).toContain('version="${ORCA_VERSION#v}"');
  });

  for (const path of INSTALL_SCRIPT_URL_DOCS) {
    test(`${path} uses release installer assets instead of main branch script`, () => {
      const text = readFileSync(path, "utf8");

      expect(text).not.toContain("raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh");
      expect(text).toContain("github.com/ASRagab/orca-ts/releases/");
    });
  }
});
