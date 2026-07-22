import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError, parseCliArgs, type SkillsArgs } from "../src/cli/args.ts";
import { delegatedSkillsArgs, runSkills } from "../src/cli/skills.ts";

const interactive: SkillsArgs = { list: false, all: false, global: false, yes: false };

test("parses the allowlisted skills command options", () => {
  expect(parseCliArgs(["skills", "--list"])).toMatchObject({
    command: "skills",
    skills: { ...interactive, list: true }
  });
  expect(parseCliArgs(["skills", "--skill", "orcats-setup", "--agent", "claude-code", "--global", "--yes"])).toMatchObject({
    command: "skills",
    skills: { ...interactive, skill: "orcats-setup", agent: "claude-code", global: true, yes: true }
  });
  expect(parseCliArgs(["skills", "--all"])).toMatchObject({
    command: "skills",
    skills: { ...interactive, all: true }
  });
});

test("rejects invalid skills input before delegation", () => {
  expect(() => parseCliArgs(["skills", "--all", "--skill", "orcats-setup"])).toThrow(CliUsageError);
  expect(() => parseCliArgs(["skills", "--skill"])).toThrow(CliUsageError);
  expect(() => parseCliArgs(["skills", "--backend"])).toThrow(CliUsageError);
  expect(() => parseCliArgs(["skills", "--unknown"])).toThrow(CliUsageError);
  expect(() => parseCliArgs(["skills", "unexpected"])).toThrow(CliUsageError);
});

test("maps skills options to the fixed npx invocation", () => {
  expect(delegatedSkillsArgs(interactive)).toEqual(["skills", "add", "ASRagab/orca-ts"]);
  expect(delegatedSkillsArgs({ ...interactive, list: true })).toEqual([
    "skills", "add", "ASRagab/orca-ts", "--list"
  ]);
  expect(delegatedSkillsArgs({ ...interactive, all: true, global: true, yes: true })).toEqual([
    "--yes", "skills", "add", "ASRagab/orca-ts", "--skill", "*", "--global", "--yes"
  ]);
  expect(delegatedSkillsArgs({ ...interactive, skill: "orcats-setup", agent: "claude-code" })).toEqual([
    "skills", "add", "ASRagab/orca-ts", "--skill", "orcats-setup", "--agent", "claude-code"
  ]);
});

test("inherits stdio and propagates the delegated exit code", () => {
  const calls: unknown[][] = [];
  const exitCode = runSkills({ ...interactive, all: true }, {
    spawnSync: (command, args, options) => {
      calls.push([command, args, options]);
      return { exitCode: 23, notFound: false };
    },
    writeError: () => undefined
  });

  expect(exitCode).toBe(23);
  expect(calls).toEqual([[
    "npx",
    ["skills", "add", "ASRagab/orca-ts", "--skill", "*"],
    { stdio: ["inherit", "inherit", "inherit"] }
  ]]);
});

test("reports a missing npx prerequisite without spawning", () => {
  const errors: string[] = [];
  const exitCode = runSkills(interactive, {
    spawnSync: () => {
      return { exitCode: null, notFound: true };
    },
    writeError: (message) => errors.push(message)
  });

  expect(exitCode).toBe(1);
  expect(errors.join("")).toContain("install Node.js/npm");
});

test("skills bypasses flow preflight and embedded fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "orcats-skills-cli-"));
  const fakeBin = join(root, "bin");
  const fakeNpx = join(fakeBin, "npx");
  const cliPath = join(import.meta.dir, "..", "bin", "orcats");

  try {
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeNpx, "#!/bin/sh\nprintf 'fake-npx %s\\n' \"$*\"\nexit 23\n");
    chmodSync(fakeNpx, 0o755);

    const result = Bun.spawnSync(
      [process.execPath, cliPath, "skills", "--all", "--yes"],
      {
        cwd: root,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe"
      }
    );

    expect(result.exitCode).toBe(23);
    expect(result.stdout.toString()).toContain("fake-npx --yes skills add ASRagab/orca-ts --skill * --yes");
    expect(result.stderr.toString()).not.toContain("missing project typecheck setup");
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
