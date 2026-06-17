import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "neverthrow";

import { ioFailed, type RuntimeError } from "../model/index.ts";
import type { LoopOutcome, LoopRunError, LoopStopReason } from "./builder/index.ts";
import type { Sink, Source } from "./io/index.ts";

// L11 loop distribution surface (spec distribution; design D8). A LoopDefinition binds a loop's
// trigger Source and output Sink to a one-shot runner; `defineLoop` is the authoring front door.
// Discovery is import-only (registers, never fires), `serve` is a thin supervisor that spawns an
// ephemeral child per trigger firing. No Effect type appears here (facade gate, design D2).

/** A registered loop: its trigger `Source`, output `Sink`, and a one-shot runner. */
export interface LoopDefinition<E = unknown, A = unknown, S = unknown> {
  readonly name: string;
  readonly source: Source<E>;
  readonly sink: Sink<A>;
  /** Run the loop once for a trigger event, emit its output to the sink, resolve to the stop outcome. */
  run(event: E): Promise<Result<LoopOutcome<S>, LoopRunError>>;
}

/** What one loop firing produces: the stop outcome plus the value to emit to the sink. */
export interface LoopEmission<A = unknown, S = unknown> {
  readonly outcome: LoopOutcome<S>;
  readonly output: A;
}

/** Authoring config for `defineLoop`. `onTrigger` runs the loop; the sink emit is wired for you. */
export interface LoopConfig<E = unknown, A = unknown, S = unknown> {
  readonly name: string;
  readonly source: Source<E>;
  readonly sink: Sink<A>;
  /** Execute the loop once for `event`; return the stop outcome and the value to emit. */
  readonly onTrigger: (event: E) => Promise<Result<LoopEmission<A, S>, LoopRunError>>;
}

/**
 * Package a loop with its Source + Sink into a discoverable definition. A loop module exports the
 * result; importing the module only registers it (no Source fires, no backend runs, no Sink emits)
 * so `orca loops` discovery is side-effect-free. `run` folds the sink emit into one Result so the
 * CLI and the `serve` child share identical output behavior.
 */
export function defineLoop<E = unknown, A = unknown, S = unknown>(
  config: LoopConfig<E, A, S>,
): LoopDefinition<E, A, S> {
  return {
    name: config.name,
    source: config.source,
    sink: config.sink,
    async run(event) {
      const fired = await config.onTrigger(event);
      if (fired.isErr()) {
        return err(fired.error);
      }
      const emitted = await config.sink.emit(fired.value.output);
      if (emitted.isErr()) {
        return err(emitted.error);
      }
      return ok(fired.value.outcome);
    },
  };
}

/** Structural guard: an object with a name, a `run`, and Source/Sink-shaped seams. */
export function isLoopDefinition(value: unknown): value is LoopDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.run === "function" &&
    isSeam(candidate.source) &&
    isSeam(candidate.sink)
  );
}

function isSeam(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string";
}

// --- Discovery: import loop modules and collect their exported definitions (import-only). ---

/** Imports a module by absolute path, returning its export namespace. */
export type ModuleImporter = (absolutePath: string) => Promise<Record<string, unknown>>;
/** Lists candidate loop-module files under a directory. */
export type FileLister = (dir: string) => Promise<string[]>;

const defaultLister: FileLister = async (dir) => {
  if (!existsSync(dir)) {
    return [];
  }
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: dir, absolute: true })) {
    files.push(entry);
  }
  return files;
};

const defaultImporter: ModuleImporter = async (absolutePath) => {
  const module: unknown = await import(pathToFileURL(absolutePath).href);
  return module as Record<string, unknown>;
};

/** Scan imported module namespaces for exported LoopDefinitions, keyed by loop name. */
export function collectDefinitions(modules: Iterable<Record<string, unknown>>): Map<string, LoopDefinition> {
  const found = new Map<string, LoopDefinition>();
  for (const module of modules) {
    for (const exported of Object.values(module)) {
      if (isLoopDefinition(exported)) {
        found.set(exported.name, exported);
      }
    }
  }
  return found;
}

export interface DiscoverOptions {
  readonly dir: string;
  readonly list?: FileLister;
  readonly import?: ModuleImporter;
}

/**
 * Discover loop definitions under `dir` (by convention `.orca/loops`, holding export-only loop
 * modules — NOT self-executing flow scripts). Import-only: constructing a definition via
 * `defineLoop` fires no Source, backend, or Sink, so discovery has no side effects.
 */
export async function discoverLoops(
  options: DiscoverOptions,
): Promise<Result<Map<string, LoopDefinition>, RuntimeError>> {
  const list = options.list ?? defaultLister;
  const load = options.import ?? defaultImporter;
  let files: string[];
  try {
    files = await list(options.dir);
  } catch (error) {
    return err(ioFailed("source", "discover", String(error)));
  }
  const modules: Record<string, unknown>[] = [];
  for (const file of files) {
    try {
      modules.push(await load(file));
    } catch (error) {
      return err(ioFailed("source", "discover", `failed to import ${file}: ${String(error)}`));
    }
  }
  return ok(collectDefinitions(modules));
}

export interface LoadOptions {
  readonly cwd: string;
  readonly import?: ModuleImporter;
  readonly list?: FileLister;
  /** Directory scanned when the target is a registered name; default `<cwd>/.orca/loops`. */
  readonly loopsDir?: string;
}

/**
 * Resolve a loop by module path OR registered name (spec distribution). A path imports that one
 * module; a name discovers the `.orca/loops` directory and looks it up. Import-only: no firing.
 */
export async function loadDefinition(
  target: string,
  options: LoadOptions,
): Promise<Result<LoopDefinition, RuntimeError>> {
  const load = options.import ?? defaultImporter;
  const asPath = isAbsolute(target) ? target : resolve(options.cwd, target);
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    let module: Record<string, unknown>;
    try {
      module = await load(asPath);
    } catch (error) {
      return err(ioFailed("source", "load", `failed to import ${target}: ${String(error)}`));
    }
    const picked = pickDefinition(module, collectDefinitions([module]));
    if (picked === undefined) {
      return err(ioFailed("source", "load", `no loop definition exported from ${target}`));
    }
    return ok(picked);
  }
  const dir = options.loopsDir ?? join(options.cwd, ".orca", "loops");
  const discovered = await discoverLoops({
    dir,
    ...(options.import === undefined ? {} : { import: options.import }),
    ...(options.list === undefined ? {} : { list: options.list }),
  });
  if (discovered.isErr()) {
    return err(discovered.error);
  }
  const found = discovered.value.get(target);
  if (found === undefined) {
    return err(ioFailed("source", "load", `no loop named "${target}" found in ${dir}`));
  }
  return ok(found);
}

/** A `default` export wins; otherwise a sole named definition; ambiguous (>1, no default) → none. */
function pickDefinition(
  module: Record<string, unknown>,
  defs: Map<string, LoopDefinition>,
): LoopDefinition | undefined {
  const fallback = module.default;
  if (isLoopDefinition(fallback)) {
    return fallback;
  }
  if (defs.size === 1) {
    return [...defs.values()].at(0);
  }
  return undefined;
}

// --- Listing: project definitions to rows; reads metadata only, fires nothing. ---

export interface LoopListing {
  readonly name: string;
  readonly source: string;
  readonly sink: string;
}

/** Project loop definitions to listing rows — reads `kind` metadata only, never `start`/`emit`/`run`. */
export function listLoops(definitions: Iterable<LoopDefinition>): LoopListing[] {
  const rows: LoopListing[] = [];
  for (const definition of definitions) {
    rows.push({ name: definition.name, source: definition.source.kind, sink: definition.sink.kind });
  }
  return rows;
}

/** Render the loop listing as text for `orca loops`. */
export function formatLoopListing(rows: readonly LoopListing[]): string {
  if (rows.length === 0) {
    return "No loops defined. Add an export-only module under .orca/loops that exports a defineLoop(...) result.";
  }
  return rows.map((row) => `${row.name}\tsource=${row.source}\tsink=${row.sink}`).join("\n");
}

// --- Exit status: a stop reason maps to a process code (spec distribution: status reflects stop). ---

const STOP_EXIT_CODES = {
  converged: 0,
  unfixable: 1,
  stuck: 2,
  timeout: 3,
  ceiling: 4,
  "budget-exhausted": 5,
  cancelled: 6,
} as const satisfies Record<LoopStopReason, number>;

/** Process exit status for a stop reason: `converged` is 0, every other stop is non-zero. */
export function exitCodeForStop(reason: LoopStopReason): number {
  return STOP_EXIT_CODES[reason];
}

/** Exit status for a completed run: the stop reason's code, or 70 for a build/runtime error. */
export function exitCodeForRun(result: Result<LoopOutcome, LoopRunError>): number {
  return result.match(
    (outcome) => exitCodeForStop(outcome.stopReason),
    () => 70,
  );
}

// --- serve: a thin long-lived supervisor that spawns an ephemeral child per trigger firing (D8). ---

/** What the supervisor hands the spawner for one trigger firing. */
export interface ChildSpec {
  /** The loop module path or registered name the child `orca run` resolves. */
  readonly loop: string;
  /** The trigger event, serialized to the child (default spawner forwards it via the environment). */
  readonly event: unknown;
}

/** A spawned ephemeral child running one loop firing; independently terminable. */
export interface ChildHandle {
  /** OS-level termination of a runaway child (default `SIGKILL`). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves when the child exits with its code (null when terminated by signal). */
  readonly exited: Promise<number | null>;
}

/** Spawns one ephemeral child per trigger firing. Injectable so tests avoid real processes. */
export type ChildSpawner = (spec: ChildSpec) => ChildHandle;

export interface ServeOptions {
  /** Spawn an ephemeral child per firing; default re-invokes `orca run <loop>` as a subprocess. */
  readonly spawn?: ChildSpawner;
  /** What the child runs: a loop name or path. Default: the definition name. */
  readonly loopRef?: string;
}

/** Live supervisor handle: owns the trigger and the in-flight children, not the loop runs. */
export interface Supervisor {
  /** In-flight child handles, one per firing not yet exited. */
  children(): readonly ChildHandle[];
  /** Stop the trigger and `SIGKILL` any in-flight children. */
  stop(): Promise<Result<void, RuntimeError>>;
}

/**
 * The thin `serve` supervisor (design D8): a long-lived process owning ONLY the trigger. Each
 * firing spawns an ephemeral child that runs the loop and exits — the loop never runs in the
 * supervisor, so one loop's crash/OOM cannot take down the supervisor or its siblings, and a
 * runaway child is killable at the OS level. Cross-loop coordination is via the shared manifest
 * store (L05), not shared process memory.
 */
export async function serve(
  definition: LoopDefinition,
  options: ServeOptions = {},
): Promise<Result<Supervisor, RuntimeError>> {
  const spawnChild = options.spawn ?? defaultSpawner;
  const loopRef = options.loopRef ?? definition.name;
  const children = new Set<ChildHandle>();

  const started = await definition.source.start((event: unknown) => {
    const child = spawnChild({ loop: loopRef, event });
    children.add(child);
    const forget = (): void => {
      children.delete(child);
    };
    void child.exited.then(forget, forget);
  });
  if (started.isErr()) {
    return err(started.error);
  }
  const subscription = started.value;

  return ok({
    children: () => [...children],
    async stop() {
      for (const child of children) {
        child.kill("SIGKILL");
      }
      children.clear();
      return subscription.stop();
    },
  });
}

/** Default spawner: re-invoke this CLI as `orca run --no-typecheck <loop>` in a fresh OS process. */
const defaultSpawner: ChildSpawner = (spec) => {
  const entry = process.argv[1];
  const args = entry === undefined ? ["run", "--no-typecheck", spec.loop] : [entry, "run", "--no-typecheck", spec.loop];
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ORCA_LOOP_EVENT: JSON.stringify(spec.event) },
  });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code) => {
      resolveExit(code);
    });
  });
  return {
    kill(signal = "SIGKILL") {
      child.kill(signal);
    },
    exited,
  };
};
