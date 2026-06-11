import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow, type LlmBackend } from "../src/index.ts";
import {
  cleanupFile,
  type CleanupAgentResult,
  type FileCleanupOutcome,
  type SelectedBackend
} from "../workflows/ai-slop-cleanup.ts";

const ORIGINAL_CONTENT = `export const x = 1;\n`;
const SENTINEL = `// DIRTY — agent wrote this before throwing\n`;

type AskAgentFn = (
  selected: SelectedBackend,
  args: {
    readonly filePath: string;
    readonly trackedFiles: readonly string[];
    readonly baselineDiff: string;
    readonly validationPlan: readonly import("../workflows/ai-slop-cleanup.ts").CommandSpec[];
    readonly allowedExtras: readonly string[];
    readonly repairFailure?: readonly import("../workflows/ai-slop-cleanup.ts").CommandRunSummary[];
  }
) => Promise<CleanupAgentResult>;

function makeSelected(): SelectedBackend {
  return {
    tag: "codex",
    backend: { tag: "codex", autonomous: () => { throw new Error("not used"); } } as LlmBackend
  };
}

describe("cleanupFile revert-on-failure", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orca-revert-test-"));
    execSync("git init -b main", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.email ci@test.local", { cwd: tmpDir, stdio: "pipe" });
    execSync("git config user.name CI", { cwd: tmpDir, stdio: "pipe" });
    execSync("mkdir -p src", { cwd: tmpDir });
    filePath = join(tmpDir, "src", "dummy.ts");
    writeFileSync(filePath, ORIGINAL_CONTENT);
    execSync("git add .", { cwd: tmpDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    execSync(`rm -rf "${tmpDir}"`);
  });

  test("restores edited file and returns skipped when askAgent throws after editing", async () => {
    const mockAskAgent: AskAgentFn = (_selected, args) => {
      writeFileSync(args.filePath, SENTINEL);
      return Promise.reject(new Error("mock agent failure"));
    };

    const runInFlow = flow<FileCleanupOutcome>([], { cwd: tmpDir });
    const result = await runInFlow(() =>
      cleanupFile(filePath, [filePath], new Set<string>(), makeSelected(), mockAskAgent)
    );

    expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL_CONTENT);

    const gitStatus = execSync("git status --short", { cwd: tmpDir }).toString().trim();
    expect(gitStatus).toBe("");

    expect(result.skippedFiles.length).toBe(1);
    expect(result.skippedFiles[0]?.reason).toContain("mock agent failure");
    expect(result.changedFiles.length).toBe(0);
  });

  test("returns skipped when askAgent throws without editing the file", async () => {
    const mockAskAgent: AskAgentFn = () => Promise.reject(new Error("agent never started"));

    const runInFlow = flow<FileCleanupOutcome>([], { cwd: tmpDir });
    const result = await runInFlow(() =>
      cleanupFile(filePath, [filePath], new Set<string>(), makeSelected(), mockAskAgent)
    );

    expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL_CONTENT);
    expect(result.skippedFiles.length).toBe(1);
    expect(result.changedFiles.length).toBe(0);
  });
});
