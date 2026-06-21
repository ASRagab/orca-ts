// Archetype: issue-to-pr
// Implement work from a prompt (or a GitHub issue reference), converge the
// verification gate, then commit, push, and open a pull request.
//
// Safety: the workflow isolates its own changes. Any pre-existing uncommitted
// work is auto-stashed up front and restored at the end, so only
// workflow-produced changes are committed; it never commits/pushes directly on
// the base branch (it cuts a feature branch first).
//
// SLOTS the author skill fills:
//   - GATE      : detected target-repo verification commands (>=1 test, >=1 lint)
//   - PR_TITLE  : the pull request title
//   - BASE      : the base branch
//   - default backend
//
// Usage: orca .orca/workflows/<name>.ts -- "<task prompt or owner/repo#123>"
import { command, fixLoop, flow, flowArgs, fs, gh, llm, ok, selectBackend } from "@twelvehart/orca-ts";

interface Cmd {
  readonly command: string;
  readonly args: readonly string[];
}

// ── VERIFICATION GATE — replace with THIS repo's real commands ──────────────
const GATE: readonly Cmd[] = [
  { command: "REPLACE_WITH_TEST_CMD", args: [] },
  { command: "REPLACE_WITH_LINT_CMD", args: [] },
];

const PR_TITLE = "REPLACE_WITH_PR_TITLE";
const BASE = "main";
const PR_BODY_PATH = ".orca/issue-to-pr-body.md";

interface GateIssue {
  readonly message: string;
  readonly fixable: true;
}

await flow(flowArgs())(async () => {
  const task = flowArgs().join(" ") || "REPLACE_WITH_TASK";
  const selected = selectBackend({ default: "claude" });

  // Isolate pre-existing uncommitted work so we only commit workflow changes.
  const stashed = await stashIfDirty();
  try {
    await ensureFeatureBranch();

    const impl = await llm()
      .autonomous(selected.backend, { prompt: `Implement the following and keep the change focused:\n${task}` })
      .awaitResult();
    if (impl.type !== "success") throw new Error(`implementation failed: ${impl.type}`);

    const seen = new Set<string>();
    const loop = await fixLoop<GateIssue>(
      async () => {
        const failure = await runGate(GATE);
        return ok(failure ? [{ message: failure, fixable: true as const }] : []);
      },
      async (issues) => {
        const repair = await llm()
          .autonomous(selected.backend, {
            prompt: `The verification gate failed:\n${issues.map((i) => i.message).join("\n")}\nFix it.`,
          })
          .awaitResult();
        if (repair.type !== "success") throw new Error(`repair failed: ${repair.type}`);
        return ok(undefined);
      },
      { maxIterations: 8, wallClockMs: 10 * 60_000, stalled: (i) => stalled(seen, i) },
    );
    if (loop.isErr() || !loop.value.converged) {
      const why = loop.isErr() ? JSON.stringify(loop.error) : loop.value.stop;
      throw new Error(`gate did not converge (${why}); not opening a PR`);
    }

    await runRequired({ command: "git", args: ["add", "-A"] });
    await runRequired({ command: "git", args: ["commit", "-m", PR_TITLE] });
    await runRequired({ command: "git", args: ["push", "-u", "origin", "HEAD"] });

    const body = `## Summary\n\n${task}\n\n## Verification\n\nAll gates green: ${GATE.map(
      (c) => `\`${c.command} ${c.args.join(" ")}\``,
    ).join(", ")}.\n`;
    const written = await fs().writeText(PR_BODY_PATH, body);
    if (written.isErr()) throw new Error(`failed to write PR body: ${JSON.stringify(written.error)}`);

    const pr = await gh().createPullRequest({ title: PR_TITLE, bodyFile: PR_BODY_PATH, base: BASE });
    if (pr.isErr()) throw new Error(`gh pr create failed: ${JSON.stringify(pr.error)}`);
    console.log("Pull request opened.");
  } finally {
    if (stashed) await restoreStash();
    await selected.shutdown?.();
  }
});

// Stash any pre-existing changes (tracked + untracked) so the workflow commits
// only its own work. Returns true if a stash was created.
async function stashIfDirty(): Promise<boolean> {
  const status = await command().run({ command: "git", args: ["status", "--porcelain"] });
  if (status.type !== "success") throw new Error(`git status failed: ${status.stderr || status.stdout}`);
  if (status.stdout.trim() === "") return false;
  await runRequired({
    command: "git",
    args: ["stash", "push", "--include-untracked", "-m", "orca-issue-to-pr autostash"],
  });
  return true;
}

// Restore the auto-stashed work. A pop conflict is surfaced (not swallowed) and
// the stash is left intact so the user can resolve it.
async function restoreStash(): Promise<void> {
  const pop = await command().run({ command: "git", args: ["stash", "pop"] });
  if (pop.type !== "success") {
    console.error(
      `WARNING: could not restore your stashed work automatically (${pop.stderr || pop.stdout}). ` +
        "Your changes are preserved in the git stash — run `git stash list` / `git stash pop` to recover them.",
    );
  }
}

// Never commit/push on the base branch: cut a feature branch when needed.
async function ensureFeatureBranch(): Promise<void> {
  const head = await command().run({ command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] });
  if (head.type !== "success") throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
  if (head.stdout.trim() !== BASE) return;
  await runRequired({ command: "git", args: ["switch", "-c", `orca/${slugify(PR_TITLE)}`] });
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "workflow";
}

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
  }
  return undefined;
}

async function runRequired(spec: Cmd): Promise<void> {
  const result = await command().run({ command: spec.command, args: spec.args });
  if (result.type !== "success") {
    throw new Error(`command failed: ${spec.command} ${spec.args.join(" ")}\n${result.stderr || result.stdout}`);
  }
}

function stalled(seen: Set<string>, issues: readonly GateIssue[]): boolean {
  const signature = issues
    .map((i) => i.message.replace(/\d+/g, "#").replace(/\/[^\s:]+/g, "/PATH"))
    .sort()
    .join("\n");
  if (seen.has(signature)) return true;
  seen.add(signature);
  return false;
}
