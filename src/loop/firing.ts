import { spawn } from "node:child_process";
import type { Result } from "neverthrow";

import type { LoopOutcome, LoopRunError, LoopStopReason } from "./builder/index.ts";
import type { LoopDefinition } from "./serve.ts";

export const LOOP_EVENT_ENV = "ORCA_LOOP_EVENT";

const STOP_EXIT_CODES = {
  converged: 0,
  unfixable: 1,
  stuck: 2,
  timeout: 3,
  ceiling: 4,
  "budget-exhausted": 5,
  cancelled: 6,
} as const satisfies Record<LoopStopReason, number>;

/** What the supervisor hands the spawner for one trigger firing. */
export interface ChildSpec {
  /** The loop module path or registered name the child `orca run` resolves. */
  readonly loop: string;
  /** The trigger event, serialized to the child by the default spawner. */
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

export interface ChildProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface ChildProcessSpecOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly execPath?: string;
}

export interface LoopFiringResult {
  readonly result: Result<LoopOutcome, LoopRunError>;
  readonly exitCode: number;
  readonly diagnostic: string;
}

export interface LoopFiringOptions {
  readonly writeDiagnostic?: (message: string) => void;
}

export function createLoopChildSpec(loop: string, event: unknown): ChildSpec {
  return { loop, event };
}

export function encodeLoopEvent(event: unknown): string | undefined {
  return JSON.stringify(event);
}

export function decodeLoopEvent(env: NodeJS.ProcessEnv = process.env): unknown {
  const raw = env[LOOP_EVENT_ENV];
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return raw;
  }
}

export function buildChildProcessSpec(
  spec: ChildSpec,
  options: ChildProcessSpecOptions = {},
): ChildProcessSpec {
  const argv = options.argv ?? process.argv;
  const entry = childEntrypoint(argv);
  const args =
    entry === undefined ? ["run", "--no-typecheck", spec.loop] : [entry, "run", "--no-typecheck", spec.loop];
  return {
    command: options.execPath ?? process.execPath,
    args,
    env: { ...(options.env ?? process.env), [LOOP_EVENT_ENV]: encodeLoopEvent(spec.event) },
  };
}

function childEntrypoint(argv: readonly string[]): string | undefined {
  const entry = argv[1];
  if (entry === undefined || entry.startsWith("-") || entry === "run" || entry === "serve" || entry === "loops") {
    return undefined;
  }
  return entry;
}

/** Default spawner: re-invoke this CLI as `orca run --no-typecheck <loop>` in a fresh OS process. */
export const spawnLoopChild: ChildSpawner = (spec) => {
  const childSpec = buildChildProcessSpec(spec);
  const child = spawn(childSpec.command, [...childSpec.args], {
    stdio: "inherit",
    env: childSpec.env,
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

export async function runLoopFiring(
  definition: LoopDefinition,
  event: unknown,
  options: LoopFiringOptions = {},
): Promise<LoopFiringResult> {
  const result = await definition.run(event);
  const diagnostic = formatLoopFiringDiagnostic(definition.name, result);
  options.writeDiagnostic?.(diagnostic);
  return { result, exitCode: exitCodeForRun(result), diagnostic };
}

export function formatLoopFiringDiagnostic(
  name: string,
  result: Result<LoopOutcome, LoopRunError>,
): string {
  return result.match(
    (outcome) =>
      `orca: loop "${name}" stopped (${outcome.stopReason}) after ${String(outcome.iterations)} iteration(s)\n`,
    (error) => `orca: loop "${name}" failed: ${describeLoopRunError(error)}\n`,
  );
}

export function describeLoopRunError(error: LoopRunError): string {
  if ("message" in error) {
    return error.message;
  }
  if ("reason" in error) {
    return error.reason;
  }
  return JSON.stringify(error);
}
