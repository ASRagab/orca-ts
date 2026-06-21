// Archetype: cleanup-sweep
// Walk a set of files; per file: one agent edit turn -> per-file gate -> KEEP if
// green, REVERT if the edit regresses the gate. A generalized, stack-agnostic
// distillation of workflows/ai-slop-cleanup.ts. Each file is independent, so one
// bad file never blocks the rest.
//
// Safety: requires a clean working tree at start (so a revert only ever drops
// the iteration's own change, never your work), and reverts any off-target file
// the agent touches outside the file it was asked to edit.
//
// SLOTS the author skill fills:
//   - FILE_SELECTOR : the git pathspec(s) selecting candidate files
//   - GATE          : detected target-repo verification commands (>=1 test, >=1 lint)
//   - EDIT_BRIEF    : what to change in each file
//   - default backend
import { command, flow, flowArgs, llm, selectBackend } from "@twelvehart/orca-ts";

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

await flow(flowArgs())(async () => {
  const selected = selectBackend({ default: "codex" });
  try {
    if ((await changedEntries()).length > 0) {
      throw new Error("working tree is not clean — commit or stash your changes before sweeping");
    }
    if ((await runGate(GATE)) !== undefined) {
      throw new Error("baseline gate is already red — fix that before sweeping");
    }

    const files = await listFiles(FILE_SELECTOR);
    console.log(`Sweeping ${String(files.length)} file(s).`);
    const kept = new Set<string>();
    let revertedCount = 0;
    let offTargetCount = 0;

    for (const file of files) {
      const turn = await llm()
        .autonomous(selected.backend, {
          prompt: `Edit exactly one file: ${file}\n${EDIT_BRIEF}\nDo not touch other files. Do not commit.`,
        })
        .awaitResult();

      const entries = await changedEntries();
      // Anything changed that is neither the target nor an already-kept file is
      // off-target: revert the whole turn (off-target paths + the target).
      const offTarget = entries.filter((e) => e.path !== file && !kept.has(e.path));
      if (offTarget.length > 0) {
        await revertPaths([...offTarget, ...entries.filter((e) => e.path === file)]);
        console.log(`  ${file}: off-target edits (${offTarget.map((e) => e.path).join(", ")}) — turn reverted`);
        offTargetCount += 1;
        continue;
      }

      if (turn.type !== "success" || !entries.some((e) => e.path === file)) {
        console.log(`  ${file}: no change`);
        continue;
      }

      const failure = await runGate(GATE);
      if (failure === undefined) {
        console.log(`  ${file}: kept`);
        kept.add(file);
      } else {
        await revertPaths(entries.filter((e) => e.path === file));
        console.log(`  ${file}: reverted (gate red)`);
        revertedCount += 1;
      }
    }
    console.log(
      `Sweep done: ${String(kept.size)} kept, ${String(revertedCount)} reverted, ${String(offTargetCount)} off-target.`,
    );
  } finally {
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

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
  }
  return undefined;
}
