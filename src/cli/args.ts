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
    if (arg === "--backend" || arg?.startsWith("--backend=")) {
      const value = arg === "--backend" ? argv[index + 1] : arg.slice("--backend=".length);
      backend = BackendTagSchema.parse(value);
      if (arg === "--backend") {
        index += 1;
      }
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
