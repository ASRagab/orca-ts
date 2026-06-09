import { BackendTagSchema, type BackendTag } from "../model/index.ts";

export interface CliArgs {
  readonly script?: string;
  readonly backend?: BackendTag;
  readonly skipTypecheck: boolean;
  readonly help: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let backend: BackendTag | undefined;
  let script: string | undefined;
  let skipTypecheck = false;
  let help = false;

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
    if (arg === "--backend") {
      const value = argv[index + 1];
      backend = BackendTagSchema.parse(value);
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
    help
  };
}
