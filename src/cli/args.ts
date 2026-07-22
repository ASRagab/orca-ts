import { BackendTagSchema, type BackendTag } from "../model/index.ts";
import { extractFlowArgs } from "../flow/args.ts";

/** Loop verbs (spec distribution). Absent => the legacy `orcats <flow.ts>` script path. */
export type LoopCommand = "run" | "serve" | "loops";
export type CliCommand = LoopCommand | "skills";

export interface SkillsArgs {
  readonly list: boolean;
  readonly all: boolean;
  readonly skill?: string;
  readonly agent?: string;
  readonly global: boolean;
  readonly yes: boolean;
}

export interface CliArgs {
  /** A CLI verb when the first positional is a recognized command; otherwise undefined (legacy). */
  readonly command?: CliCommand;
  /** The loop module path or registered name for `run`/`serve`. */
  readonly loop?: string;
  /** The legacy flow-script path (no loop verb). */
  readonly script?: string;
  readonly backend?: BackendTag;
  readonly skipTypecheck: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Deferred durable-mode flags (spec distribution / design D5) — rejected by `main`. */
  readonly durable?: true;
  readonly postgresUrl?: string;
  readonly stateAdapter?: string;
  /** Options for the administrative `orcats skills` command. */
  readonly skills?: SkillsArgs;
  readonly flowArgs: readonly string[];
}

const LOOP_COMMANDS = new Set<string>(["run", "serve", "loops"]);

/** Invalid CLI input that must be reported before a command starts. */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (firstPositional(argv) === "skills") {
    return parseSkillsArgs(argv);
  }

  let backend: BackendTag | undefined;
  let skipTypecheck = false;
  let help = false;
  let version = false;
  let durable = false;
  let postgresUrl: string | undefined;
  let stateAdapter: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      break; // everything after `--` is the flow/loop task input, captured by extractFlowArgs
    }
    if (arg === "--no-typecheck") {
      skipTypecheck = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--durable") {
      durable = true;
      continue;
    }
    if (arg === "--backend") {
      backend = BackendTagSchema.parse(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--backend=")) {
      backend = BackendTagSchema.parse(arg.slice("--backend=".length));
      continue;
    }
    if (arg === "--postgres-url") {
      postgresUrl = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg?.startsWith("--postgres-url=")) {
      postgresUrl = arg.slice("--postgres-url=".length);
      continue;
    }
    if (arg === "--state") {
      stateAdapter = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--state=")) {
      stateAdapter = arg.slice("--state=".length);
      continue;
    }
    if (arg !== undefined && !arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  const first = positionals.at(0);
  const isCommand = first !== undefined && LOOP_COMMANDS.has(first);
  const command = isCommand ? (first as LoopCommand) : undefined;
  const loop = isCommand && command !== "loops" ? positionals.at(1) : undefined;
  const script = isCommand ? undefined : first;

  return {
    ...(command === undefined ? {} : { command }),
    ...(loop === undefined ? {} : { loop }),
    ...(script === undefined ? {} : { script }),
    ...(backend === undefined ? {} : { backend }),
    skipTypecheck,
    help,
    version,
    ...(durable ? { durable: true as const } : {}),
    ...(postgresUrl === undefined ? {} : { postgresUrl }),
    ...(stateAdapter === undefined ? {} : { stateAdapter }),
    flowArgs: extractFlowArgs(argv)
  };
}

function firstPositional(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      return undefined;
    }
    if (arg === "--backend" || arg === "--postgres-url" || arg === "--state") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--backend=") || arg?.startsWith("--postgres-url=") || arg?.startsWith("--state=")) {
      continue;
    }
    if (arg !== undefined && !arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

function parseSkillsArgs(argv: readonly string[]): CliArgs {
  let help = false;
  let version = false;
  let list = false;
  let all = false;
  let skill: string | undefined;
  let agent: string | undefined;
  let global = false;
  let yes = false;
  let sawCommand = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "skills" && !sawCommand) {
      sawCommand = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--global") {
      global = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--skill" || arg === "--agent") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new CliUsageError(`orcats skills: ${arg} requires a value`);
      }
      if (arg === "--skill") {
        if (skill !== undefined) {
          throw new CliUsageError("orcats skills: --skill may be provided once");
        }
        skill = value;
      } else {
        if (agent !== undefined) {
          throw new CliUsageError("orcats skills: --agent may be provided once");
        }
        agent = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--") {
      throw new CliUsageError("orcats skills: task arguments are not supported");
    }
    if (arg?.startsWith("-")) {
      throw new CliUsageError(`orcats skills: unsupported option ${arg}`);
    }
    throw new CliUsageError(`orcats skills: unexpected argument ${arg ?? ""}`);
  }

  if (all && skill !== undefined) {
    throw new CliUsageError("orcats skills: --all cannot be combined with --skill");
  }

  return {
    command: "skills",
    skills: { list, all, ...(skill === undefined ? {} : { skill }), ...(agent === undefined ? {} : { agent }), global, yes },
    skipTypecheck: false,
    help,
    version,
    flowArgs: []
  };
}
