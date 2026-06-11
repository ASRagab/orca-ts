/**
 * Tier-3 real-agent eval runner.
 *
 * For each selected backend, check out a fixed base commit into its own git
 * worktree, run the cleanup flow there in `--eval` mode (no commit, no PR — only
 * a verdict log), then discard the worktree. All run logs land in one central
 * directory, which `summarize-run` aggregates into a cross-backend
 * convergence-cost matrix.
 *
 * The flow is invoked from THIS checkout (so it has the eval feature) but with
 * `cwd` set to the worktree, so git operations and validation target the
 * base-SHA tree. Backends run sequentially: opencode drives a shared
 * `opencode serve`, so parallel worktrees would contend on its port — serial
 * execution also keeps real-agent spend and rate-limit pressure predictable.
 *
 * Usage:
 *   bun scripts/eval-backends.ts [--base <ref>] [--backends codex,claude,opencode,pi]
 *                                [--max-files N] [--start-group <group>]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BACKENDS = ["codex", "claude", "opencode", "pi"] as const;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readFlag(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function git(args: readonly string[], cwd = repoRoot): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function main(argv: readonly string[]): void {
  const baseRef = readFlag(argv, "--base") ?? "HEAD";
  const baseSha = git(["rev-parse", baseRef]);
  const backends = (readFlag(argv, "--backends")?.split(",") ?? [...DEFAULT_BACKENDS])
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const maxFiles = readFlag(argv, "--max-files") ?? "3";
  const startGroup = readFlag(argv, "--start-group");
  const runId = String(Date.now());
  const centralDir = join(repoRoot, ".orca", "eval", runId);

  console.log(`Eval base: ${baseRef} (${baseSha.slice(0, 12)})`);
  console.log(`Backends : ${backends.join(", ")}`);
  console.log(`Logs     : ${centralDir}\n`);

  for (const backend of backends) {
    const worktree = mkdtempSync(join(tmpdir(), `orca-eval-${backend}-`));
    // The cleanup flow refuses to run on detached HEAD, so the worktree gets a
    // named (throwaway) branch off the pinned base.
    const branch = `orca-eval-${backend}-${runId}`;
    console.log(`\n=== ${backend} ===`);
    try {
      git(["worktree", "add", "--force", "-b", branch, worktree, baseSha]);
      // A fresh worktree has no node_modules; the flow's baseline validation runs
      // lint/typecheck/test there, so deps must be installed or the eval aborts
      // before any agent call.
      console.log("  installing dependencies…");
      const install = spawnSync("bun", ["install", "--frozen-lockfile"], {
        cwd: worktree,
        stdio: "inherit",
        env: process.env
      });
      if (install.status !== 0) {
        console.warn(`  ${backend}: bun install failed (status ${String(install.status)}) — skipping.`);
        continue;
      }
      const flowArgs = [
        join(repoRoot, "workflows", "ai-slop-cleanup.ts"),
        "--eval",
        "--no-publish",
        `--max-files=${maxFiles}`,
        ...(startGroup ? [`--start-group=${startGroup}`] : [])
      ];
      const run = spawnSync("bun", flowArgs, {
        cwd: worktree,
        stdio: "inherit",
        env: { ...process.env, ORCA_BACKEND: backend, ORCA_MONITOR_DIR: centralDir }
      });
      if (run.status !== 0) {
        console.warn(`  ${backend} eval exited ${String(run.status)} — verdict log (if any) retained.`);
      }
    } catch (error) {
      console.warn(`  ${backend} eval errored: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try {
        git(["worktree", "remove", "--force", worktree]);
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
      try {
        git(["branch", "-D", branch]);
      } catch {
        // Branch may not exist if the worktree add failed.
      }
    }
  }

  console.log("\n=== matrix ===");
  spawnSync("bun", [join(repoRoot, "scripts", "summarize-run.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ORCA_MONITOR_DIR: centralDir }
  });
}

main(process.argv.slice(2));
