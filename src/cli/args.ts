import { BackendTagSchema, type BackendTag } from "../model/index.ts";
import { extractFlowArgs } from "../flow/args.ts";

/** Loop verbs (spec distribution). Absent => the legacy `orcats <flow.ts>` script path. */
export type LoopCommand = "run" | "serve" | "loops";

export interface CliArgs {
  /** A loop verb when the first positional is `run`/`serve`/`loops`; otherwise undefined (legacy). */
  readonly command?: LoopCommand;
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
  readonly flowArgs: readonly string[];
}

const LOOP_COMMANDS = new Set<string>(["run", "serve", "loops"]);

export function parseCliArgs(argv: readonly string[]): CliArgs {
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
