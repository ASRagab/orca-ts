import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFsTool, createGitTool, renderStatusBar, runQuiet } from "../src/index.ts";

describe("runtime tools", () => {
  test("filesystem tool reads and writes text", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-fs-"));
    try {
      const file = join(root, "nested", "file.txt");
      const fs = createFsTool();
      expect((await fs.writeText(file, "hello")).isOk()).toBe(true);
      expect((await fs.readText(file))._unsafeUnwrap()).toBe("hello");
      expect(await fs.exists(file)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("git tool reports NothingToCommit and commits staged changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-git-"));
    try {
      expect((await runQuiet("git", ["init"], { cwd: root })).isOk()).toBe(true);
      expect((await runQuiet("git", ["config", "user.email", "orca@example.test"], { cwd: root })).isOk()).toBe(true);
      expect((await runQuiet("git", ["config", "user.name", "Orca Test"], { cwd: root })).isOk()).toBe(true);

      const git = createGitTool(root);
      const empty = await git.commit("empty");
      expect(empty.isErr()).toBe(true);
      if (empty.isErr()) {
        expect(empty.error).toEqual({ _tag: "NothingToCommit" });
      }

      await writeFile(join(root, "file.txt"), "content\n");
      expect((await git.add(["file.txt"])).isOk()).toBe(true);
      expect((await git.commit("add file")).isOk()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("status bar renders plain output when ANSI is unavailable", () => {
    expect(
      renderStatusBar(
        { label: "plan", current: 1, total: 3 },
        { env: { NO_COLOR: "1" }, isTTY: true }
      )
    ).toBe("plan 1/3");
    expect(
      renderStatusBar(
        { label: "plan", current: 1, total: 3 },
        { env: {}, isTTY: true }
      )
    ).toBe("\rplan 1/3\u001b[K");
  });
});
