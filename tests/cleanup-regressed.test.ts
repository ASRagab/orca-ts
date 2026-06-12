import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow, type LlmBackend, type SelectedBackend } from "../src/index.ts";
import {
  cleanupFile,
  type CleanupAgentResult,
  type CommandRunSummary,
  type CommandSpec,
  type FileCleanupOutcome
} from "../workflows/ai-slop-cleanup.ts";

const ORIGINAL_CONTENT = `export const x = 1;\n`;

type AskAgentFn = (
  selected: SelectedBackend,
  args: {
    readonly filePath: string;
    readonly trackedFiles: readonly string[];
    readonly baselineDiff: string;
    readonly validationPlan: readonly CommandSpec[];
    readonly allowedExtras: readonly string[];
    readonly repairFailure?: readonly CommandRunSummary[];
  }
) => Promise<CleanupAgentResult>;

function makeSelected(): SelectedBackend {
  return {
    tag: "codex",
    backend: { tag: "codex", autonomous: () => { throw new Error("not used"); } } as LlmBackend
  };
}

describe("cleanupFile regressed-on-non-convergence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-regressed-"));
    execSync("git init -b main", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email ci@test.local", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name CI", { cwd: tmpDir, stdio: "pipe" });
    execSync("mkdir -p src", { cwd: tmpDir });
    writeFileSync(join(tmpDir, "src", "dummy.ts"), ORIGINAL_CONTENT);
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    execSync(`rm -rf "${tmpDir}"`);
  });

  test("reverts the change and returns regressed:stuck when the gate never goes green", async () => {
    // The agent edits the file identically every round. Validation (`bun run
    // typecheck`/`lint` in a scriptless repo) fails the same way each time, so
    // the no-progress signature trips and the change is reverted.
    const mockAskAgent: AskAgentFn = () => {
      writeFileSync(join(tmpDir, "src", "dummy.ts"), `export const x = 2;\n`);
      return Promise.resolve({
        path: "src/dummy.ts",
        changed: true,
        smellsRemoved: ["noise"],
        validationHint: "n/a",
        risk: "low"
      });
    };

    const runInFlow = flow<FileCleanupOutcome>([], { cwd: tmpDir });
    const result = await runInFlow(() =>
      cleanupFile("src/dummy.ts", ["src/dummy.ts"], new Set<string>(), makeSelected(), mockAskAgent)
    );

    expect(result.verdict).toBe("regressed");
    expect(result.regressedReason).toBe("stuck");
    expect(result.changedFiles.length).toBe(0);
    expect(readFileSync(join(tmpDir, "src", "dummy.ts"), "utf8")).toBe(ORIGINAL_CONTENT);
    expect(execSync("git status --short", { cwd: tmpDir }).toString().trim()).toBe("");
  }, 30_000);
});
