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
  type ModuleImporter
} from "../loop/index.ts";
import { decodeLoopEvent, runLoopFiring } from "../loop/firing.ts";
import {
  createRunPresenter,
  createRunReporter,
  withRunReporter,
  type RunReporter,
} from "../run-output/index.ts";
import { parseCliArgs, type CliArgs } from "./args.ts";
import { ORCA_VERSION } from "./version.ts";

const USAGE = [
  "Usage: orcats [--backend <name>] [--no-typecheck] <flow.ts> [-- <task args>]",
  "       orcats run <loop>      run a loop once; exit status reflects the stop reason",
  "       orcats serve <loop>    host a loop's trigger, spawning a child process per firing",
  "       orcats loops           list defined loops with their source and sink",
  "       orcats --version"
].join("\n");

const DEFERRED_DBOS_NOTE =
  "durable DBOS mode is deferred — see openspec/changes/add-loop-builder/design.md §D5 (DBOS Bun-compatibility spike). " +
  "Run without --durable/--postgres-url and without `--state dbos` to use the service-free default adapter.";
// Private parent->child handshake for the embedded-fallback respawn. The value is the
// PARENT's pid, not a constant flag: a genuine child's process.ppid equals it, while a stale
// value inherited from an unrelated shell or a prior orcats process does not. Validating against
// ppid keeps a leaked ORCA_EMBEDDED_RESPAWNED from making a fresh invocation skip the bootstrap
// + respawn (which would then fail to resolve @twelvehart/orcats from a bare directory).
const EMBEDDED_RESPAWN_ENV = "ORCA_EMBEDDED_RESPAWNED";

/** True only when this process is the embedded-fallback child spawned by THIS run's parent. */
function isEmbeddedRespawnChild(): boolean {
  const token = process.env[EMBEDDED_RESPAWN_ENV];
  return token !== undefined && token === String(process.ppid);
}

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
    console.log(`orcats ${ORCA_VERSION}`);
    return;
  }

  // Reject deferred durable mode before any typecheck/import so the pointer surfaces immediately.
  const deferred = deferredDurableError(args);
  if (deferred !== undefined) {
    process.stderr.write(`orcats: ${describeError(deferred)}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help || (args.command === undefined && args.script === undefined)) {
    console.log(USAGE);
    return;
  }

  if ((args.command === "run" || args.command === "serve") && args.loop === undefined) {
    process.stderr.write(`orcats: ${args.command} requires a <loop> (module path or registered name)\n`);
    process.exitCode = 1;
    return;
  }

  const reporter = createCliReporter();

  if (!(await preflight(args, reporter))) {
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
    await runLoop(args.loop, reporter);
    return;
  }
  if (args.command === "serve" && args.loop !== undefined) {
    await runServe(args.loop);
    return;
  }
  if (args.script !== undefined) {
    await runFlowScript(args.script, argv, reporter);
  }
}

/** Shared preflight for every command: typecheck (unless skipped) + backend/flow-arg env wiring. */
async function preflight(args: CliArgs, reporter: RunReporter): Promise<boolean> {
  if (isEmbeddedRespawnChild()) {
    return true; // the spawning parent already ran preflight; the child inherits its env
  }

  reporter.emit({ type: "preflight", name: "typecheck", status: "started" });
  const typecheck = await runTypecheck({ cwd: process.cwd(), skip: args.skipTypecheck });
  if (typecheck.isErr()) {
    const error = typecheck.error;
    reporter.emit({ type: "preflight", name: "typecheck", status: "failed", reason: describeError(error) });
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
    reporter.emit({
      type: "preflight",
      name: "typecheck",
      status: "skipped",
      ...(typecheck.value.reason === undefined ? {} : { reason: typecheck.value.reason }),
    });
    if (typecheck.value.reason === "tsc-not-found") {
      process.stderr.write(
        "orcats: missing project typecheck setup; skipping typecheck. Add typescript, tsconfig.json, and a local @twelvehart/orcats package dependency to enable it.\n"
      );
    }
    process.env.ORCA_TYPECHECK_SKIPPED = "1";
  } else {
    reporter.emit({ type: "preflight", name: "typecheck", status: "passed" });
  }

  if (args.backend) {
    process.env.ORCA_BACKEND = args.backend;
  }
  process.env[FLOW_ARGS_ENV] = JSON.stringify(args.flowArgs);
  return true;
}

/** `orcats loops`: discover and list defined loops without firing any Source / backend / Sink. */
async function runLoops(): Promise<void> {
  const importLoop = await loopImporter();
  const discovered = await discoverLoops({ dir: resolve(process.cwd(), ".orca", "loops"), import: importLoop });
  if (discovered.isErr()) {
    process.stderr.write(`orcats: ${describeError(discovered.error)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(formatLoopListing(listLoops(discovered.value.values())));
}

/** `orcats run <loop>`: resolve the loop, run it once, exit with a status reflecting the stop reason. */
async function runLoop(target: string, reporter: RunReporter): Promise<void> {
  const importLoop = await loopImporter();
  const loaded = await loadDefinition(target, { cwd: process.cwd(), import: importLoop });
  if (loaded.isErr()) {
    process.stderr.write(`orcats: ${describeError(loaded.error)}\n`);
    process.exitCode = 1;
    return;
  }
  const definition = loaded.value;
  const firing = await runLoopFiring(definition, decodeLoopEvent(), { reporter });
  process.exitCode = firing.exitCode;
}

/** `orcats serve <loop>`: a thin supervisor owning the trigger, spawning a child per firing (D8). */
async function runServe(target: string): Promise<void> {
  const importLoop = await loopImporter();
  const loaded = await loadDefinition(target, { cwd: process.cwd(), import: importLoop });
  if (loaded.isErr()) {
    process.stderr.write(`orcats: ${describeError(loaded.error)}\n`);
    process.exitCode = 1;
    return;
  }
  const definition = loaded.value;
  const supervisor = await serve(definition, { loopRef: target });
  if (supervisor.isErr()) {
    process.stderr.write(`orcats: ${describeError(supervisor.error)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(
    `orcats: serving loop "${definition.name}" (source=${definition.source.kind}); press Ctrl-C to stop\n`
  );
  await waitForShutdown();
  await supervisor.value.stop();
}

/** Legacy flow-script path, with one respawn when the embedded fallback is needed. */
async function runFlowScript(script: string, argv: readonly string[], reporter: RunReporter): Promise<void> {
  const resolvedScript = resolve(script);
  const { ensureOrcaResolvable } = await import("./embedded.ts");
  const shouldRespawn = !isEmbeddedRespawnChild() && !isBunExecutable();
  const registeredFallback = ensureOrcaResolvable(resolvedScript, { cleanup: !shouldRespawn });
  if (registeredFallback && shouldRespawn) {
    respawnWithEmbeddedFallback(argv);
    return;
  }
  reporter.emit({ type: "run_started", label: resolvedScript });
  try {
    await withRunReporter(reporter, () => import(pathToFileURL(resolvedScript).href));
    reporter.emit({ type: "run_finished", label: resolvedScript, status: "success" });
  } catch (error) {
    reporter.emit({ type: "run_finished", label: resolvedScript, status: "failed", error: describeError(error) });
    throw error;
  }
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
  if (isEmbeddedRespawnChild() || isBunExecutable()) {
    return false;
  }

  const { ensureOrcaResolvable } = await import("./embedded.ts");
  let registeredFallback = false;
  if (args.script !== undefined) {
    registeredFallback = ensureOrcaResolvable(resolve(args.script), { cleanup: false });
  } else if (args.command === "run" || args.command === "serve") {
    registeredFallback = ensureOrcaResolvable(loopFallbackProbe(args.loop), { cleanup: false });
  } else if (args.command === "loops") {
    registeredFallback = ensureOrcaResolvable(resolve(".orca", "loops", "__orca_fallback_probe__.ts"), { cleanup: false });
  }

  if (!registeredFallback) {
    return false;
  }
  respawnWithEmbeddedFallback(argv);
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

function respawnWithEmbeddedFallback(argv: readonly string[]): void {
  const child = Bun.spawnSync([process.execPath, ...argv], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Stamp the handshake with our pid; the child validates it against process.ppid.
      [EMBEDDED_RESPAWN_ENV]: String(process.pid)
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  process.exitCode = child.exitCode;
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

function createCliReporter(): RunReporter {
  return createRunReporter({
    sinks: [
      createRunPresenter({
        isTTY: process.stderr.isTTY,
        writeDiagnostic: (message) => {
          process.stderr.write(message);
        },
      }),
    ],
  });
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string") {
    return error.reason;
  }
  try {
    const serialized = JSON.stringify(error) as string | undefined;
    return serialized ?? String(error);
  } catch {
    return String(error);
  }
}

if (import.meta.main) {
  await main();
}
