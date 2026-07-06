// Archetype: cleanup-sweep
// Walk a set of files; per file: one agent edit turn -> per-file gate -> KEEP if
// green, REVERT if the edit regresses the gate. A generalized, stack-agnostic
// distillation of workflows/ai-slop-cleanup.ts. Each file is independent, so one
// bad file never blocks the rest.
//
// Safety: the default baseline policy requires a clean working tree. With
// explicit accept-dirty, dirty work is snapshotted, stashed, and restored after
// the sweep. Baseline repair changes are protected from per-file reverts.
//
// SLOTS the author skill fills:
//   - FILE_SELECTOR : the git pathspec(s) selecting candidate files
//   - GATE          : detected target-repo verification commands (>=1 test, >=1 lint)
//   - EDIT_BRIEF    : what to change in each file
//   - default backend
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import {
  captureDirtyBaselineSnapshot,
  command,
  flow,
  flowArgs,
  llm,
  resolveBaselinePolicy,
  runBaselineGate,
  selectBackend,
} from "@twelvehart/orca-ts";

interface Cmd {
  readonly command: string;
  readonly args: readonly string[];
}

interface ChangedEntry {
  readonly path: string;
  readonly untracked: boolean;
}

// ── SLOTS ───────────────────────────────────────────────────────────────────
const FILE_SELECTOR: readonly string[] = ["REPLACE_WITH_PATHSPEC"]; // e.g. ["src/**/*.py"]
const GATE: readonly Cmd[] = [
  { command: "REPLACE_WITH_TEST_CMD", args: [] },
  { command: "REPLACE_WITH_LINT_CMD", args: [] },
];
const EDIT_BRIEF = "REPLACE_WITH_EDIT_BRIEF";
const ACCEPTED_DIRTY_SNAPSHOT_KEY = "orca-baselines";

await flow(flowArgs())(async () => {
  const selected = selectBackend({ default: "codex" });
  const baseline = resolveBaselinePolicy({ args: flowArgs() });
  let stashed = false;
  try {
    const snapshotPath =
      baseline.policy === "accept-dirty"
        ? await captureDirtyBaselineSnapshot({ commands: GATE, snapshotDir: await gitPath(ACCEPTED_DIRTY_SNAPSHOT_KEY) })
        : undefined;
    if (snapshotPath !== undefined) {
      console.log(`Accepted dirty baseline snapshot: ${snapshotPath}`);
      stashed = await stashIfDirty();
    }

    await runBaselineGate({
      policy: baseline.policy === "accept-dirty" ? "repair" : baseline.policy,
      commands: GATE,
      repair: async (issues) => {
        const repair = await llm()
          .autonomous(selected.backend, {
            prompt: `The baseline verification gate failed before the cleanup sweep:\n${issues
              .map((i) => i.message)
              .join("\n")}\nFix the baseline. Do not weaken the gate.`,
          })
          .awaitResult();
        if (repair.type !== "success") throw new Error(`baseline repair failed: ${describeOutcome(repair)}`);
        return { usage: repair.result.usage };
      },
    });
    const protectedBaselineEntries = await changedEntries();
    const protectedBaselinePaths = new Set(protectedBaselineEntries.map((entry) => entry.path));

    const files = await listFiles(FILE_SELECTOR);
    console.log(`Sweeping ${String(files.length)} file(s).`);
    const kept = new Set<string>();
    let revertedCount = 0;
    let offTargetCount = 0;

    for (const file of files) {
      if (protectedBaselinePaths.has(file)) {
        console.log(`  ${file}: skipped (changed by baseline repair)`);
        continue;
      }
      const protectedBefore = await protectedBaselineSignature(protectedBaselineEntries);
      const turn = await llm()
        .autonomous(selected.backend, {
          prompt: `Edit exactly one file: ${file}\n${EDIT_BRIEF}\nDo not touch other files. Do not commit.`,
        })
        .awaitResult();
      const protectedAfter = await protectedBaselineSignature(protectedBaselineEntries);
      if (protectedAfter !== protectedBefore) {
        throw new Error(
          `agent modified baseline-protected paths while editing ${file}: ${[...protectedBaselinePaths].sort().join(", ")}`,
        );
      }

      const entries = await changedEntries();
      // Anything changed that is neither the target nor an already-kept file is
      // off-target: revert the whole turn (off-target paths + the target).
      const offTarget = entries.filter((e) => e.path !== file && !kept.has(e.path) && !protectedBaselinePaths.has(e.path));
      if (offTarget.length > 0) {
        await revertPaths([...offTarget, ...entries.filter((e) => e.path === file)]);
        console.log(`  ${file}: off-target edits (${offTarget.map((e) => e.path).join(", ")}) — turn reverted`);
        offTargetCount += 1;
        continue;
      }

      if (turn.type !== "success") {
        console.log(`  ${file}: ${describeOutcome(turn)}`);
        continue;
      }

      if (!entries.some((e) => e.path === file)) {
        console.log(`  ${file}: no change`);
        continue;
      }

      const failure = await runGate(GATE);
      if (failure === undefined) {
        console.log(`  ${file}: kept`);
        kept.add(file);
      } else {
        await revertPaths(entries.filter((e) => e.path === file && !protectedBaselinePaths.has(e.path)));
        console.log(`  ${file}: reverted (gate red)`);
        revertedCount += 1;
      }
    }
    console.log(
      `Sweep done: ${String(kept.size)} kept, ${String(revertedCount)} reverted, ${String(offTargetCount)} off-target.`,
    );
  } finally {
    if (stashed) await restoreStash();
    await selected.shutdown?.();
  }
});

async function listFiles(pathspec: readonly string[]): Promise<string[]> {
  const result = await command().run({ command: "git", args: ["ls-files", ...pathspec] });
  if (result.type !== "success") throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function changedEntries(): Promise<ChangedEntry[]> {
  const result = await command().run({ command: "git", args: ["status", "--porcelain"] });
  if (result.type !== "success") throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ path: line.slice(3).trim(), untracked: line.slice(0, 2) === "??" }));
}

async function protectedBaselineSignature(entries: readonly ChangedEntry[]): Promise<string> {
  if (entries.length === 0) return "";
  const sorted = entries.map((entry) => entry.path).sort();
  const staged = await command().run({ command: "git", args: ["diff", "--staged", "--", ...sorted] });
  if (staged.type !== "success") throw new Error(`git diff --staged failed: ${staged.stderr || staged.stdout}`);
  const unstaged = await command().run({ command: "git", args: ["diff", "--", ...sorted] });
  if (unstaged.type !== "success") throw new Error(`git diff failed: ${unstaged.stderr || unstaged.stdout}`);
  return `${staged.stdout}\n---\n${unstaged.stdout}\n---\n${await untrackedProtectedSignature(entries)}`;
}

async function untrackedProtectedSignature(entries: readonly ChangedEntry[]): Promise<string> {
  const paths = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  if (paths.length === 0) return "";
  const listed = await command().run({ command: "git", args: ["ls-files", "--others", "--exclude-standard", "--", ...paths] });
  if (listed.type !== "success") throw new Error(`git ls-files failed: ${listed.stderr || listed.stdout}`);
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .map((path) => `${path}:${fileSignature(path)}`)
    .join("\n");
}

function fileSignature(path: string): string {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    return createHash("sha256")
      .update(
        readdirSync(path)
          .sort()
          .map((entry) => `${entry}:${fileSignature(`${path}/${entry}`)}`)
          .join("\n"),
      )
      .digest("hex");
  }
  if (!stat.isFile()) return `other:${String(stat.size)}`;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Revert exactly the given paths. The clean-baseline guarantee means restoring a
// tracked path to HEAD only drops this iteration's change; untracked paths the
// agent created are removed. Never touches paths outside this list.
async function revertPaths(entries: readonly ChangedEntry[]): Promise<void> {
  const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
  const untracked = entries.filter((e) => e.untracked).map((e) => e.path);
  if (tracked.length > 0) {
    await command().run({ command: "git", args: ["restore", "--staged", "--worktree", "--", ...tracked] });
  }
  if (untracked.length > 0) {
    await command().run({ command: "git", args: ["clean", "-f", "--", ...untracked] });
  }
}

async function stashIfDirty(): Promise<boolean> {
  const status = await command().run({ command: "git", args: ["status", "--porcelain"] });
  if (status.type !== "success") throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  if (status.stdout.trim() === "") return false;
  const stash = await command().run({
    command: "git",
    args: [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "orca-cleanup-sweep accepted dirty baseline",
    ],
  });
  if (stash.type !== "success") throw new Error(`git stash failed: ${stash.stderr || stash.stdout}`);
  return true;
}

async function restoreStash(): Promise<void> {
  const pop = await command().run({ command: "git", args: ["stash", "pop"] });
  if (pop.type !== "success") {
    console.error(
      `WARNING: could not restore your stashed work automatically (${pop.stderr || pop.stdout}). ` +
        "Your changes are preserved in the git stash — run `git stash list` / `git stash pop` to recover them.",
    );
  }
}

async function gitPath(path: string): Promise<string> {
  const result = await command().run({ command: "git", args: ["rev-parse", "--git-path", path] });
  if (result.type !== "success") throw new Error(`git rev-parse failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
  }
  return undefined;
}

function describeOutcome(outcome: { readonly type: string; readonly error?: unknown; readonly reason?: string }): string {
  if (outcome.type === "failed") return `failed: ${describeUnknown(outcome.error)}`;
  if (outcome.type === "cancelled") return outcome.reason ? `cancelled: ${outcome.reason}` : "cancelled";
  return outcome.type;
}

function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
