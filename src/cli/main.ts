import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runTypecheck } from "../runner/index.ts";
import { parseCliArgs } from "./args.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.help || !args.script) {
    console.log("Usage: orca [--backend <name>] [--no-typecheck] <flow.ts>");
    return;
  }

  const typecheck = await runTypecheck({ cwd: process.cwd(), skip: args.skipTypecheck });
  if (typecheck.isErr()) {
    const error = typecheck.error;
    if (error._tag === "TypecheckFailed") {
      process.stderr.write(error.stdout);
      process.stderr.write(error.stderr);
    } else {
      process.stderr.write(`${JSON.stringify(error)}\n`);
    }
    process.exitCode = 1;
    return;
  }

  if (typecheck.value.skipped) {
    process.env.ORCA_TYPECHECK_SKIPPED = "1";
  }

  if (args.backend) {
    process.env.ORCA_BACKEND = args.backend;
  }

  await import(pathToFileURL(resolve(args.script)).href);
}

if (import.meta.main) {
  await main();
}
