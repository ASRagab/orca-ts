import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { runTypecheck, type CommandRunner } from "../src/index.ts";

describe("typecheck pre-flight", () => {
  test("skips only when explicitly requested", async () => {
    const result = await runTypecheck({ cwd: process.cwd(), skip: true });

    expect(result._unsafeUnwrap()).toEqual({ skipped: true, reason: "flag", stdout: "", stderr: "" });
  });

  test("returns success when tsc succeeds", async () => {
    const runner: CommandRunner = () =>
      Promise.resolve(ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 }));
    const result = await runTypecheck({ cwd: process.cwd(), runner, which: () => "/fake/tsc" });

    expect(result._unsafeUnwrap()).toEqual({ skipped: false, stdout: "ok", stderr: "" });
  });

  test("skips when tsc is not available", async () => {
    const runner: CommandRunner = () => {
      throw new Error("runner should not be called");
    };
    const result = await runTypecheck({ cwd: process.cwd(), runner, which: () => null });

    expect(result._unsafeUnwrap()).toEqual({
      skipped: true,
      reason: "tsc-not-found",
      stdout: "",
      stderr: ""
    });
  });

  test("skips when project setup has no tsconfig", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orca-typecheck-"));
    try {
      const binDir = join(cwd, "node_modules", ".bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, "tsc"), "");
      const runner: CommandRunner = () => {
        throw new Error("runner should not be called");
      };

      const result = await runTypecheck({ cwd, runner });

      expect(result._unsafeUnwrap()).toEqual({
        skipped: true,
        reason: "tsc-not-found",
        stdout: "",
        stderr: ""
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses explicit project file when default tsconfig is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orca-typecheck-"));
    try {
      const binDir = join(cwd, "node_modules", ".bin");
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, "tsc"), "");
      await writeFile(join(cwd, "tsconfig.build.json"), "{}");
      let command = "";
      let args: readonly string[] = [];
      const runner: CommandRunner = (candidate, candidateArgs) => {
        command = candidate;
        args = candidateArgs;
        return Promise.resolve(ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 }));
      };

      const result = await runTypecheck({ cwd, project: "tsconfig.build.json", runner });

      expect(result._unsafeUnwrap()).toEqual({ skipped: false, stdout: "ok", stderr: "" });
      expect(command).toBe(join(cwd, "node_modules", ".bin", "tsc"));
      expect(args).toEqual(["--noEmit", "-p", "tsconfig.build.json"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses the resolved tsc path", async () => {
    let command = "";
    const runner: CommandRunner = (candidate) => {
      command = candidate;
      return Promise.resolve(ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 }));
    };
    const result = await runTypecheck({
      cwd: process.cwd(),
      runner,
      which: () => "/fake/tsc"
    });

    expect(result._unsafeUnwrap()).toEqual({ skipped: false, stdout: "ok", stderr: "" });
    expect(command).toBe("/fake/tsc");
  });

  test("maps command failure to TypecheckFailed", async () => {
    const runner: CommandRunner = () =>
      Promise.resolve(err({
        _tag: "CommandFailed",
        command: "tsc --noEmit",
        exitCode: 2,
        stdout: "",
        stderr: "bad"
      }));
    const result = await runTypecheck({ cwd: process.cwd(), runner, which: () => "/fake/tsc" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        _tag: "TypecheckFailed",
        stdout: "",
        stderr: "bad",
        exitCode: 2
      });
    }
  });
});
