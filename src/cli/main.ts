import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { runTypecheck } from "../runner/index.ts";
import { FLOW_ARGS_ENV } from "../flow/args.ts";
import { unsupportedFeature, type RuntimeError } from "../model/index.ts";
import {
  discoverLoops,
  formatLoopListing,
  listLoops,
  loadDefinition,
  serve,
  type LoopRunError,
  type ModuleImporter
} from "../loop/index.ts";
import { decodeLoopEvent, runLoopFiring } from "../loop/firing.ts";
import { parseCliArgs, type CliArgs } from "./args.ts";
import { ORCA_VERSION } from "./version.ts";

const USAGE = [
  "Usage: orca [--backend <name>] [--no-typecheck] <flow.ts> [-- <task args>]",
  "       orca run <loop>      run a loop once; exit status reflects the stop reason",
  "       orca serve <loop>    host a loop's trigger, spawning a child process per firing",
  "       orca loops           list defined loops with their source and sink",
  "       orca --version"
].join("\n");

const DEFERRED_DBOS_NOTE =
  "durable DBOS mode is deferred — see openspec/changes/add-loop-builder/design.md §D5 (DBOS Bun-compatibility spike). " +
  "Run without --durable/--postgres-url and without `--state dbos` to use the service-free default adapter.";
const EMBEDDED_RESPAWN_ENV = "ORCA_EMBEDDED_RESPAWNED";
const PREFLIGHT_DONE_ENV = "ORCA_PREFLIGHT_DONE";

/** Durable DBOS mode is not selectable in this change (spec distribution; design D5). */
export function deferredDurableError(args: CliArgs): RuntimeError | undefined {
  if (args.durable === true || args.postgresUrl !== undefined || args.stateAdapter === "dbos") {
    return unsupportedFeature("durable", DEFERRED_DBOS_NOTE);
  }
  return undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);

  if (args.version) {
    console.log(`orca ${ORCA_VERSION}`);
    return;
  }

  // Reject deferred durable mode before any typecheck/import so the pointer surfaces immediately.
  const deferred = deferredDurableError(args);
  if (deferred !== undefined) {
    process.stderr.write(`orca: ${describeError(deferred)}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help || (args.command === undefined && args.script === undefined)) {
    console.log(USAGE);
    return;
  }

  if ((args.command === "run" || args.command === "serve") && args.loop === undefined) {
    process.stderr.write(`orca: ${args.command} requires a <loop> (module path or registered name)\n`);
    process.exitCode = 1;
    return;
  }

  if (!(await preflight(args))) {
    return; // typecheck failed; exit code already set
  }
  if (await respawnIfEmbeddedFallbackNeeded(args, argv)) {
    return;
  }

  if (args.command === "loops") {
    await runLoops();
    return;
  }
  if (args.command === "run" && args.loop !== undefined) {
    await runLoop(args.loop);
    return;
  }
  if (args.command === "serve" && args.loop !== undefined) {
    await runServe(args.loop);
    return;
  }
  if (args.script !== undefined) {
    await runFlowScript(args.script, argv);
  }
}

/** Shared preflight for every command: typecheck (unless skipped) + backend/flow-arg env wiring. */
async function preflight(args: CliArgs): Promise<boolean> {
  if (process.env[PREFLIGHT_DONE_ENV] === "1") {
    return true;
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
    return false;
  }

  if (typecheck.value.skipped) {
    if (typecheck.value.reason === "tsc-not-found") {
      process.stderr.write(
        "orca: missing project typecheck setup; skipping typecheck. Add typescript, tsconfig.json, and a local @twelvehart/orca-ts package dependency to enable it.\n"
      );
    }
    process.env.ORCA_TYPECHECK_SKIPPED = "1";
  }

  if (args.backend) {
    process.env.ORCA_BACKEND = args.backend;
  }
  process.env[FLOW_ARGS_ENV] = JSON.stringify(args.flowArgs);
  return true;
}

/** `orca loops`: discover and list defined loops without firing any Source / backend / Sink. */
async function runLoops(): Promise<void> {
  const importLoop = await loopImporter();
  const discovered = await discoverLoops({ dir: resolve(process.cwd(), ".orca", "loops"), import: importLoop });
  if (discovered.isErr()) {
    process.stderr.write(`orca: ${describeError(discovered.error)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(formatLoopListing(listLoops(discovered.value.values())));
}

/** `orca run <loop>`: resolve the loop, run it once, exit with a status reflecting the stop reason. */
async function runLoop(target: string): Promise<void> {
  const importLoop = await loopImporter();
  const loaded = await loadDefinition(target, { cwd: process.cwd(), import: importLoop });
  if (loaded.isErr()) {
    process.stderr.write(`orca: ${describeError(loaded.error)}\n`);
    process.exitCode = 1;
    return;
  }
  const definition = loaded.value;
  const firing = await runLoopFiring(definition, decodeLoopEvent(), {
    writeDiagnostic: (message) => process.stderr.write(message),
  });
  process.exitCode = firing.exitCode;
}

/** `orca serve <loop>`: a thin supervisor owning the trigger, spawning a child per firing (D8). */
async function runServe(target: string): Promise<void> {
  const importLoop = await loopImporter();
  const loaded = await loadDefinition(target, { cwd: process.cwd(), import: importLoop });
  if (loaded.isErr()) {
    process.stderr.write(`orca: ${describeError(loaded.error)}\n`);
    process.exitCode = 1;
    return;
  }
  const definition = loaded.value;
  const supervisor = await serve(definition, { loopRef: target });
  if (supervisor.isErr()) {
    process.stderr.write(`orca: ${describeError(supervisor.error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `orca: serving loop "${definition.name}" (source=${definition.source.kind}); press Ctrl-C to stop\n`
  );
  await waitForShutdown();
  await supervisor.value.stop();
}

/** Legacy flow-script path, with one respawn when the embedded fallback is needed. */
async function runFlowScript(script: string, argv: readonly string[]): Promise<void> {
  const resolvedScript = resolve(script);
  const { ensureOrcaResolvable } = await import("./embedded.ts");
  const registeredFallback = ensureOrcaResolvable(resolvedScript);
  if (registeredFallback && process.env[EMBEDDED_RESPAWN_ENV] !== "1" && !isBunExecutable()) {
    await respawnWithEmbeddedFallback(argv);
    return;
  }
  await import(pathToFileURL(resolvedScript).href);
}

/** An embedded-aware importer: register the standalone package fallback, then import the module. */
async function loopImporter(): Promise<ModuleImporter> {
  const { ensureOrcaResolvable } = await import("./embedded.ts");
  return async (absolutePath) => {
    ensureOrcaResolvable(absolutePath);
    const module: unknown = await import(pathToFileURL(absolutePath).href);
    return module as Record<string, unknown>;
  };
}

async function respawnIfEmbeddedFallbackNeeded(args: CliArgs, argv: readonly string[]): Promise<boolean> {
  if (process.env[EMBEDDED_RESPAWN_ENV] === "1" || isBunExecutable()) {
    return false;
  }

  const { ensureOrcaResolvable } = await import("./embedded.ts");
  let registeredFallback = false;
  if (args.script !== undefined) {
    registeredFallback = ensureOrcaResolvable(resolve(args.script));
  } else if (args.command === "run" || args.command === "serve") {
    registeredFallback = ensureOrcaResolvable(loopFallbackProbe(args.loop));
  } else if (args.command === "loops") {
    registeredFallback = ensureOrcaResolvable(resolve(".orca", "loops", "__orca_fallback_probe__.ts"));
  }

  if (!registeredFallback) {
    return false;
  }
  await respawnWithEmbeddedFallback(argv);
  return true;
}

function loopFallbackProbe(loopRef: string | undefined): string {
  if (loopRef !== undefined && (loopRef.includes("/") || loopRef.endsWith(".ts"))) {
    return resolve(loopRef);
  }
  return resolve(".orca", "loops", "__orca_fallback_probe__.ts");
}

function isBunExecutable(): boolean {
  const bunPath = Bun.which("bun");
  if (bunPath === null) {
    return false;
  }
  try {
    return realpathSync(process.execPath) === realpathSync(bunPath);
  } catch {
    return process.execPath === bunPath;
  }
}

async function respawnWithEmbeddedFallback(argv: readonly string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [EMBEDDED_RESPAWN_ENV]: "1",
      [PREFLIGHT_DONE_ENV]: "1"
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  process.exitCode = await child.exited;
}

/** Resolve when the supervisor receives a termination signal. */
function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolveShutdown) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveShutdown();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function describeError(error: LoopRunError): string {
  if ("message" in error) {
    return error.message;
  }
  if ("reason" in error) {
    return error.reason;
  }
  return JSON.stringify(error);
}

if (import.meta.main) {
  await main();
}
