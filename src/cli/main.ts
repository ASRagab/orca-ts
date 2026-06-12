import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runTypecheck } from "../runner/index.ts";
import { parseCliArgs } from "./args.ts";
import { ORCA_VERSION } from "./version.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.version) {
    console.log(`orca ${ORCA_VERSION}`);
    return;
  }

  if (args.help || !args.script) {
    console.log("Usage: orca [--backend <name>] [--no-typecheck] [--version] <flow.ts>");
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
    if (typecheck.value.reason === "tsc-not-found") {
      process.stderr.write(
        "orca: missing project typecheck setup; skipping typecheck. Add typescript, tsconfig.json, and a local orca-ts Git/source dependency to enable it.\n"
      );
    }
    process.env.ORCA_TYPECHECK_SKIPPED = "1";
  }

  if (args.backend) {
    process.env.ORCA_BACKEND = args.backend;
  }

  const resolvedScript = resolve(args.script);
  const { ensureOrcaResolvable } = await import("./embedded.ts");
  ensureOrcaResolvable(resolvedScript);
  await import(pathToFileURL(resolvedScript).href);
}

if (import.meta.main) {
  await main();
}
