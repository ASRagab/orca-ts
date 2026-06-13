import { BackendTagSchema, type BackendTag } from "../model/index.ts";
import { extractFlowArgs } from "../flow/args.ts";

export interface CliArgs {
  readonly script?: string;
  readonly backend?: BackendTag;
  readonly skipTypecheck: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly flowArgs: readonly string[];
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let backend: BackendTag | undefined;
  let script: string | undefined;
  let skipTypecheck = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
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
    if (arg === "--backend") {
      backend = BackendTagSchema.parse(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg?.startsWith("--backend=")) {
      backend = BackendTagSchema.parse(arg.slice("--backend=".length));
      continue;
    }
    if (!arg?.startsWith("-") && !script) {
      script = arg;
    }
  }

  return {
    ...(script === undefined ? {} : { script }),
    ...(backend === undefined ? {} : { backend }),
    skipTypecheck,
    help,
    version,
    flowArgs: extractFlowArgs(argv)
  };
}
