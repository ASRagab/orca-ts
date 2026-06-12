import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { runTypecheck, type CommandRunner } from "../src/index.ts";

describe("typecheck pre-flight", () => {
  test("skips only when explicitly requested", async () => {
    const result = await runTypecheck({ cwd: process.cwd(), skip: true });
    expect(result._unsafeUnwrap()).toEqual({ skipped: true, stdout: "", stderr: "" });
  });

  test("returns success when tsc succeeds", async () => {
    const runner: CommandRunner = () =>
      Promise.resolve(ok({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 1 }));
    const result = await runTypecheck({ cwd: process.cwd(), runner });
    expect(result._unsafeUnwrap()).toEqual({ skipped: false, stdout: "ok", stderr: "" });
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
    const result = await runTypecheck({ cwd: process.cwd(), runner });
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
