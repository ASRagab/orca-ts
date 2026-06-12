import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCommandTool, createFsTool, createGitTool, renderStatusBar, runQuiet } from "../src/index.ts";

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


  test("command tool reports duration for successful and non-zero commands", async () => {
    const tool = createCommandTool();

    const success = await tool.run({
      command: process.execPath,
      args: ["--eval", "console.log('ok')"]
    });
    expect(success.type).toBe("success");
    expect(success.durationMs).toBeGreaterThanOrEqual(0);
    expect(success.stdout).toContain("ok");

    const failed = await tool.run({
      command: process.execPath,
      args: ["--eval", "console.error('bad'); process.exit(2)"]
    });
    expect(failed.type).toBe("failed");
    expect(failed.durationMs).toBeGreaterThanOrEqual(0);
    expect(failed.exitCode).toBe(2);
    expect(failed.stderr).toContain("bad");
  });

  test("runQuiet kills timed-out commands and reports timeout text", async () => {
    const result = await runQuiet(
      process.execPath,
      ["--eval", "setTimeout(() => {}, 1000)"],
      { timeoutMs: 20 }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const error = result.error;
      if (error._tag !== "CommandFailed") {
        throw new Error(`expected CommandFailed, got ${error._tag}`);
      }
      expect(error._tag).toBe("CommandFailed");
      expect(error.exitCode).toBeNull();
      expect(error.stderr).toBe("Command timed out after 20ms");
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
