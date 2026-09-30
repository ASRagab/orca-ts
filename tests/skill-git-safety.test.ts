import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expectExitZero, runCliProcess } from "./helpers/cli-process.ts";

const root = resolve(import.meta.dir, "..");
const author = join(root, "skills", "orcats-author");
const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

for (const linked of [false, true]) {
test(`runtime excludes preserve user work (${linked ? "linked worktree" : "repository"})`, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "orcats-git-safety-"));
  try {
    const repo = join(fixture, "repo");
    await mkdir(repo);
    await git(repo, ["init", "--initial-branch=main"]);
    await writeFile(join(repo, ".gitignore"), "user-cache/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["-c", "user.name=Safety Test", "-c", "user.email=safety@example.invalid",
      "-c", "commit.gpgSign=false", "commit", "-m", "fixture"]);
    const cwd = linked ? join(fixture, "linked") : repo;
    if (linked) await git(repo, ["worktree", "add", "-b", "safety-linked", cwd]);

    const dirtyIgnore = "user-cache/\nuser-owned/\n";
    await writeFile(join(cwd, ".gitignore"), dirtyIgnore);
    const dirtyDiff = await git(cwd, ["diff", "--", ".gitignore"]);
    const exclude = resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "info/exclude"])).trim());
    const originalExclude = "# user-owned excludes\n*.private";
    await writeFile(exclude, originalExclude);

    const canonical = (await readFile(join(author, "assets", "runtime-scratch-patterns.txt"), "utf8"))
      .split("\n").filter(Boolean);
    const template = await templateStaging();
    expect([...template.patterns].sort()).toEqual([...canonical].sort());
    const scratch = canonical.map((pattern) => pattern.replaceAll("**", "nested/run").replaceAll("*", "sample"));
    const authored = [".orca/workflows/example.ts", ".orca/workflows/example.run.md",
      ".orca/loops/example.ts", ".orca/loops/example.run.md"];
    for (const path of [...scratch, ...authored]) {
      await mkdir(dirname(join(cwd, path)), { recursive: true });
      await writeFile(join(cwd, path), "fixture\n");
    }

    const install = () => runCliProcess("bash", [join(author, "scripts", "orca-git-exclude.sh"), cwd],
      { cwd: fixture, env: gitEnv, timeoutMs: 10_000 });
    const first = await install();
    expectExitZero(first);
    expect(resolve(first.stdout.trim())).toBe(exclude);
    const installedExclude = await readFile(exclude, "utf8");
    expect(installedExclude.startsWith(originalExclude)).toBe(true);
    const second = await install();
    expectExitZero(second);
    expect(await readFile(exclude, "utf8")).toBe(installedExclude);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(dirtyIgnore);
    expect(await git(cwd, ["diff", "--", ".gitignore"])).toBe(dirtyDiff);

    const committable = [".gitignore", ...authored].sort();
    await git(cwd, ["add", "-A"]);
    expect((await git(cwd, ["diff", "--cached", "--name-only"])).trim().split("\n").sort()).toEqual(committable);

    // Exercise the template's independent staging defense without Git ignores.
    await git(cwd, ["restore", "--staged", "--", "."]);
    await writeFile(exclude, originalExclude);
    const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).trim().split("\n");
    for (const path of scratch) expect(untracked).toContain(path);
    await git(cwd, template.args);
    expect((await git(cwd, ["diff", "--cached", "--name-only"])).trim().split("\n").sort()).toEqual(committable);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(dirtyIgnore);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runCliProcess("git", args, { cwd, env: gitEnv, timeoutMs: 10_000 });
  expectExitZero(result);
  return result.stdout;
}

async function templateStaging(): Promise<{ patterns: string[]; args: string[] }> {
  const path = join(author, "assets", "templates", "issue-to-pr.ts");
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  let patternsNode: ts.Expression | undefined;
  let stagingNode: ts.ArrayLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "RUNTIME_SCRATCH_PATTERNS") {
      patternsNode = node.initializer;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements[0];
      if (first !== undefined && ts.isStringLiteral(first) && first.text === "add") stagingNode = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (patternsNode !== undefined && ts.isAsExpression(patternsNode)) patternsNode = patternsNode.expression;
  if (patternsNode === undefined || !ts.isArrayLiteralExpression(patternsNode) || stagingNode === undefined) {
    throw new Error("issue-to-pr scratch patterns or staging arguments missing");
  }
  const patterns = patternsNode.elements.map((node) => {
    if (!ts.isStringLiteral(node)) throw new Error("scratch pattern must be a string literal");
    return node.text;
  });
  const args: unknown = runInNewContext(stagingNode.getText(source), { RUNTIME_SCRATCH_PATTERNS: patterns }, { timeout: 1_000 });
  if (!Array.isArray(args) || !args.every((arg: unknown) => typeof arg === "string")) {
    throw new Error("issue-to-pr staging arguments must be strings");
  }
  return { patterns, args };
}
