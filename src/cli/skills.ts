import { spawnSync } from "node:child_process";
import type { SkillsArgs } from "./args.ts";

export const SKILLS_SOURCE = "ASRagab/orca-ts";

export interface SkillsProcess {
  readonly spawnSync: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: ["inherit", "inherit", "inherit"] },
  ) => { readonly exitCode: number | null; readonly notFound: boolean };
  readonly writeError: (message: string) => void;
}

const inheritedStdio: ["inherit", "inherit", "inherit"] = ["inherit", "inherit", "inherit"];
const processOptions = { stdio: inheritedStdio };

/** Builds the fixed-source `npx skills add` invocation without exposing arbitrary forwarding. */
export function delegatedSkillsArgs(options: SkillsArgs): readonly string[] {
  return [
    ...(options.yes ? ["--yes"] : []),
    "skills",
    "add",
    SKILLS_SOURCE,
    ...(options.list ? ["--list"] : []),
    ...(options.all ? ["--skill", "*"] : options.skill === undefined ? [] : ["--skill", options.skill]),
    ...(options.agent === undefined ? [] : ["--agent", options.agent]),
    ...(options.global ? ["--global"] : []),
    ...(options.yes ? ["--yes"] : [])
  ];
}

/** Runs the delegated installer with its terminal streams intact. */
export function runSkills(options: SkillsArgs, runtime: SkillsProcess = defaultSkillsProcess): number {
  const result = runtime.spawnSync("npx", delegatedSkillsArgs(options), processOptions);
  if (result.notFound) {
    runtime.writeError("orcats: Agent Skills installation requires npx (install Node.js/npm, then retry).\n");
    return 1;
  }

  return result.exitCode ?? 1;
}

const defaultSkillsProcess: SkillsProcess = {
  spawnSync: (command, args, options) => {
    const result = spawnSync(command, [...args], options);
    const error = result.error as NodeJS.ErrnoException | undefined;
    return { exitCode: result.status, notFound: error?.code === "ENOENT" };
  },
  writeError: (message) => process.stderr.write(message)
};
