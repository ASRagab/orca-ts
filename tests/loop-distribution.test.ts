import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";

import {
  collectDefinitions,
  defineLoop,
  discoverLoops,
  exitCodeForRun,
  exitCodeForStop,
  formatLoopListing,
  ioFailed,
  listLoops,
  loadDefinition,
  serve,
  type ChildHandle,
  type ChildSpawner,
  type ChildSpec,
  type FileLister,
  type LoopDefinition,
  type LoopOutcome,
  type LoopStopReason,
  type ModuleImporter
} from "../src/index.ts";
import {
  buildChildProcessSpec,
  createLoopChildSpec,
  decodeLoopEvent,
  encodeLoopEvent,
  LOOP_EVENT_ENV,
  runLoopFiring
} from "../src/loop/firing.ts";
import { fakeSink, fakeSource } from "../src/test-utils/index.ts";
import { parseCliArgs } from "../src/cli/args.ts";
import { deferredDurableError } from "../src/cli/main.ts";
import { runQuiet } from "../src/tools/process.ts";

// L11 acceptance (spec distribution, design D8, tasks 10.1-10.5). The CLI gains run/serve/loops
// while the legacy `orca <flow.ts>` path is preserved; `serve` is a thin supervisor that spawns an
// ephemeral child per trigger firing — the loop never runs in-supervisor, a child crash is isolated,
// and a runaway child is OS-killable. Durable DBOS mode is rejected with a deferred-note pointer.

const NON_CONVERGED_STOPS: readonly LoopStopReason[] = [
  "unfixable",
  "stuck",
  "timeout",
  "ceiling",
  "budget-exhausted",
  "cancelled"
];

function outcomeOf(stopReason: LoopStopReason): LoopOutcome {
  return { state: undefined, stopReason, iterations: 1 };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeChild extends ChildHandle {
  readonly killed: NodeJS.Signals[];
  readonly resolveExit: (code: number | null) => void;
  readonly rejectExit: (reason: unknown) => void;
}

interface FakeSpawner {
  readonly spawn: ChildSpawner;
  readonly spawns: ChildSpec[];
  readonly children: FakeChild[];
}

function fakeSpawner(): FakeSpawner {
  const spawns: ChildSpec[] = [];
  const children: FakeChild[] = [];
  const spawn: ChildSpawner = (spec) => {
    spawns.push(spec);
    const killed: NodeJS.Signals[] = [];
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    const child: FakeChild = {
      kill(signal = "SIGKILL") {
        killed.push(signal);
      },
      exited: promise,
      killed,
      resolveExit: resolve,
      rejectExit: reject
    };
    children.push(child);
    return child;
  };
  return { spawn, spawns, children };
}

describe("CLI command parsing", () => {
  test("recognizes run/serve/loops verbs and their loop target", () => {
    expect(parseCliArgs(["run", "my-loop"])).toMatchObject({ command: "run", loop: "my-loop" });
    expect(parseCliArgs(["serve", "./loops/x.ts", "--no-typecheck"])).toMatchObject({
      command: "serve",
      loop: "./loops/x.ts",
      skipTypecheck: true
    });
    const loops = parseCliArgs(["loops"]);
    expect(loops.command).toBe("loops");
    expect(loops.loop).toBeUndefined();
  });

  test("legacy flow-script path is unaffected by the new verbs", () => {
    const legacy = parseCliArgs(["flow.ts", "--backend", "codex", "--", "fix", "it"]);
    expect(legacy.command).toBeUndefined();
    expect(legacy.script).toBe("flow.ts");
    expect(legacy.backend).toBe("codex");
    expect(legacy.flowArgs).toEqual(["fix", "it"]);
  });

  test("a post---- token that matches a verb stays a flow arg, not a command", () => {
    const args = parseCliArgs(["flow.ts", "--", "run"]);
    expect(args.command).toBeUndefined();
    expect(args.script).toBe("flow.ts");
    expect(args.flowArgs).toEqual(["run"]);
  });
});

describe("deferred durable mode (design D5)", () => {
  test("--durable, --postgres-url, and --state dbos are rejected with a deferred-note pointer", () => {
    for (const argv of [
      ["run", "x", "--durable"],
      ["run", "x", "--postgres-url", "postgres://db"],
      ["run", "x", "--state", "dbos"]
    ]) {
      const error = deferredDurableError(parseCliArgs(argv));
      expect(error?._tag).toBe("UnsupportedFeature");
      if (error !== undefined && "reason" in error) {
        expect(error.reason).toContain("design.md");
      }
    }
  });

  test("a default run and a non-dbos adapter need no durable mode", () => {
    expect(deferredDurableError(parseCliArgs(["run", "x"]))).toBeUndefined();
    expect(deferredDurableError(parseCliArgs(["run", "x", "--state", "sqlite"]))).toBeUndefined();
  });
});

describe("stop-reason exit status", () => {
  test("converged is 0 and every other stop is non-zero and distinct", () => {
    expect(exitCodeForStop("converged")).toBe(0);
    const codes = new Set<number>([0]);
    for (const reason of NON_CONVERGED_STOPS) {
      const code = exitCodeForStop(reason);
      expect(code).toBeGreaterThan(0);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
    }
  });

  test("exitCodeForRun maps the outcome's stop reason and 70 for a run error", () => {
    expect(exitCodeForRun(ok(outcomeOf("converged")))).toBe(0);
    expect(exitCodeForRun(ok(outcomeOf("ceiling")))).toBe(exitCodeForStop("ceiling"));
    expect(exitCodeForRun(err(ioFailed("sink", "stdout", "boom")))).toBe(70);
  });
});

describe("loop firing contract", () => {
  test("encodes and decodes trigger events with missing-event and raw-string compatibility", () => {
    const event = { issueId: "LIN-123", attempt: 2 };
    const encoded = encodeLoopEvent(event);

    expect(encoded).toBe(JSON.stringify(event));
    expect(decodeLoopEvent({ [LOOP_EVENT_ENV]: encoded })).toEqual(event);
    expect(decodeLoopEvent({})).toBeUndefined();
    expect(decodeLoopEvent({ [LOOP_EVENT_ENV]: "not json" })).toBe("not json");
  });

  test("constructs child process args and event environment from a loop target", () => {
    const spec = createLoopChildSpec("./loops/triage.ts", { issueId: "LIN-123" });

    expect(spec).toEqual({ loop: "./loops/triage.ts", event: { issueId: "LIN-123" } });

    const child = buildChildProcessSpec(spec, {
      argv: ["bun", "/repo/bin/orca"],
      env: { PATH: "/bin" },
      execPath: "/runtime/bun"
    });
    expect(child.command).toBe("/runtime/bun");
    expect(child.args).toEqual(["/repo/bin/orca", "run", "--no-typecheck", "./loops/triage.ts"]);
    expect(child.env.PATH).toBe("/bin");
    expect(child.env[LOOP_EVENT_ENV]).toBe(JSON.stringify({ issueId: "LIN-123" }));
  });

  test("constructs child process args when no CLI entrypoint is present", () => {
    const child = buildChildProcessSpec(createLoopChildSpec("registered-loop", undefined), {
      argv: ["bun"],
      env: {},
      execPath: "/runtime/bun"
    });

    expect(child.args).toEqual(["run", "--no-typecheck", "registered-loop"]);
    expect(child.env[LOOP_EVENT_ENV]).toBeUndefined();
  });

  test("constructs child process args for a compiled orca binary already running serve", () => {
    const child = buildChildProcessSpec(createLoopChildSpec("registered-loop", { n: 1 }), {
      argv: ["/dist/orca", "serve", "registered-loop"],
      env: {},
      execPath: "/dist/orca"
    });

    expect(child.args).toEqual(["run", "--no-typecheck", "registered-loop"]);
    expect(child.env[LOOP_EVENT_ENV]).toBe(JSON.stringify({ n: 1 }));
  });

  test("runs a loaded loop once, emits diagnostics, and maps the stop reason to an exit code", async () => {
    const diagnostics: string[] = [];
    let seenEvent: unknown;
    const sink = fakeSink();
    const definition = defineLoop({
      name: "fire-once",
      source: fakeSource(),
      sink,
      onTrigger: (event) => {
        seenEvent = event;
        return Promise.resolve(ok({ outcome: { state: event, stopReason: "converged", iterations: 2 }, output: event }));
      }
    });
    const event = { issueId: "LIN-123" };

    const fired = await runLoopFiring(definition, event, { writeDiagnostic: (message) => diagnostics.push(message) });

    expect(fired.result._unsafeUnwrap().stopReason).toBe("converged");
    expect(fired.exitCode).toBe(0);
    expect(fired.diagnostic).toBe('orca: loop "fire-once" stopped (converged) after 2 iteration(s)\n');
    expect(diagnostics).toEqual([fired.diagnostic]);
    expect(seenEvent).toEqual(event);
    expect(sink.emitted()).toEqual([event]);
  });

  test("bin orca run passes ORCA_LOOP_EVENT through the shared firing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-loop-firing-"));
    const outputPath = join(root, "event.json");
    const loopPath = join(root, "event-loop.ts");
    await writeFile(
      loopPath,
      `import { writeFile } from "node:fs/promises";
import { defineLoop, ok } from "@twelvehart/orca-ts";

const source = {
  kind: "manual",
  start: async () => ok({ stop: async () => ok(undefined) })
};

const sink = {
  kind: "stdout",
  emit: async (value) => {
    await writeFile(${JSON.stringify(outputPath)}, JSON.stringify(value));
    return ok(undefined);
  }
};

export default defineLoop({
  name: "cli-event",
  source,
  sink,
  onTrigger: async (event) => ok({
    outcome: { state: event, stopReason: "converged", iterations: 1 },
    output: event
  })
});
`,
    );
    const previous = process.env[LOOP_EVENT_ENV];
    process.env[LOOP_EVENT_ENV] = JSON.stringify({ issueId: "LIN-123" });
    try {
      const result = await runQuiet("bun", ["./bin/orca", "run", "--no-typecheck", loopPath], {
        cwd: process.cwd()
      });

      const proc = result._unsafeUnwrap();
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr).toContain("orca | done: cli-event stopped (converged) after 1 iteration(s)");
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({ issueId: "LIN-123" });
    } finally {
      if (previous === undefined) {
        process.env[LOOP_EVENT_ENV] = undefined;
      } else {
        process.env[LOOP_EVENT_ENV] = previous;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps loop failures and sink failures to diagnostic exit code 70", async () => {
    const loopFailure = defineLoop<unknown, string>({
      name: "loop-fails",
      source: fakeSource<unknown>(),
      sink: fakeSink<string>(),
      onTrigger: () => Promise.resolve(err(ioFailed("source", "loop", "boom")))
    });

    const failedLoop = await runLoopFiring(loopFailure, undefined);
    expect(failedLoop.exitCode).toBe(70);
    expect(failedLoop.diagnostic).toBe('orca: loop "loop-fails" failed: boom\n');

    const sinkFailure = defineLoop<unknown, string>({
      name: "sink-fails",
      source: fakeSource<unknown>(),
      sink: fakeSink<string>({ failWith: ioFailed("sink", "stdout", "no") }),
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: "done" }))
    });

    const failedSink = await runLoopFiring(sinkFailure, undefined);
    expect(failedSink.exitCode).toBe(70);
    expect(failedSink.diagnostic).toBe('orca: loop "sink-fails" failed: no\n');
  });
});

describe("defineLoop", () => {
  test("run executes the loop, emits its output to the sink, and returns the stop outcome", async () => {
    const sink = fakeSink<string>();
    const definition = defineLoop<number, string>({
      name: "emit",
      source: fakeSource<number>(),
      sink,
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: "done" }))
    });

    const result = await definition.run(0);

    expect(result._unsafeUnwrap().stopReason).toBe("converged");
    expect(sink.emitted()).toEqual(["done"]);
  });

  test("a sink emit failure surfaces as err", async () => {
    const definition = defineLoop<number, string>({
      name: "emit-fails",
      source: fakeSource<number>(),
      sink: fakeSink<string>({ failWith: ioFailed("sink", "stdout", "no") }),
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: "done" }))
    });

    expect((await definition.run(0)).isErr()).toBe(true);
  });
});

describe("orca loops discovery is side-effect free", () => {
  test("listing reads source/sink metadata without firing the Source, Sink, or loop", () => {
    const source = fakeSource();
    const sink = fakeSink();
    let ran = false;
    const definition = defineLoop({
      name: "alpha",
      source,
      sink,
      onTrigger: () => {
        ran = true;
        return Promise.resolve(ok({ outcome: outcomeOf("converged"), output: undefined }));
      }
    });

    const rows = listLoops([definition]);

    expect(rows).toEqual([{ name: "alpha", source: "manual", sink: "stdout" }]);
    expect(formatLoopListing(rows)).toContain("alpha");
    expect(source.isStarted()).toBe(false);
    expect(sink.emitted()).toEqual([]);
    expect(ran).toBe(false);
  });

  test("formatLoopListing reports an empty registry without error", () => {
    expect(formatLoopListing([])).toContain("No loops defined");
  });

  test("discovers definitions from imported modules without firing them", async () => {
    const source = fakeSource();
    let ran = false;
    const definition = defineLoop({
      name: "discovered",
      source,
      sink: fakeSink(),
      onTrigger: () => {
        ran = true;
        return Promise.resolve(ok({ outcome: outcomeOf("converged"), output: undefined }));
      }
    });
    const list: FileLister = () => Promise.resolve(["/w/discovered.ts", "/w/empty.ts"]);
    const load: ModuleImporter = (path) =>
      Promise.resolve(path.endsWith("discovered.ts") ? { default: definition } : {});

    const discovered = await discoverLoops({ dir: "/w", list, import: load });

    expect([...discovered._unsafeUnwrap().keys()]).toEqual(["discovered"]);
    expect(source.isStarted()).toBe(false);
    expect(ran).toBe(false);
  });

  test("loadDefinition resolves a registered name and errors on an unknown one", async () => {
    const definition = defineLoop({
      name: "beta",
      source: fakeSource(),
      sink: fakeSink(),
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: undefined }))
    });
    const list: FileLister = () => Promise.resolve(["/w/beta.ts"]);
    const load: ModuleImporter = () => Promise.resolve({ default: definition });
    const options = { cwd: "/w", loopsDir: "/w", list, import: load };

    expect((await loadDefinition("beta", options))._unsafeUnwrap().name).toBe("beta");
    expect((await loadDefinition("missing", options)).isErr()).toBe(true);
  });

  test("collectDefinitions ignores non-definition exports", () => {
    const definition = defineLoop({
      name: "gamma",
      source: fakeSource(),
      sink: fakeSink(),
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: undefined }))
    });
    const found = collectDefinitions([{ definition, helper: () => 1, label: "x" }]);
    expect([...found.keys()]).toEqual(["gamma"]);
  });
});

describe("serve supervisor (design D8)", () => {
  function demoLoop(source = fakeSource<number>()): { definition: LoopDefinition; ranRef: { ran: boolean } } {
    const ranRef = { ran: false };
    const definition = defineLoop<number, string>({
      name: "demo",
      source,
      sink: fakeSink<string>(),
      onTrigger: () => {
        ranRef.ran = true;
        return Promise.resolve(ok({ outcome: outcomeOf("converged"), output: "x" }));
      }
    });
    return { definition, ranRef };
  }

  test("a trigger firing spawns a child and never runs the loop in the supervisor", async () => {
    const source = fakeSource<number>();
    const { definition, ranRef } = demoLoop(source);
    const spawner = fakeSpawner();

    const supervisor = (await serve(definition, { spawn: spawner.spawn, loopRef: "demo" }))._unsafeUnwrap();
    expect(source.isStarted()).toBe(true);

    source.fire(7);

    expect(spawner.spawns.length).toBe(1);
    expect(spawner.spawns[0]?.loop).toBe("demo");
    expect(spawner.spawns[0]?.event).toBe(7);
    expect(ranRef.ran).toBe(false); // the loop body ran in the child, not the supervisor
    expect(supervisor.children().length).toBe(1);

    await supervisor.stop();
  });

  test("one child crash leaves the supervisor and its other children alive", async () => {
    const source = fakeSource<number>();
    const { definition } = demoLoop(source);
    const spawner = fakeSpawner();
    const supervisor = (await serve(definition, { spawn: spawner.spawn }))._unsafeUnwrap();

    source.fire(1);
    source.fire(2);
    expect(supervisor.children().length).toBe(2);

    spawner.children[0]?.rejectExit(new Error("loop child crashed"));
    await flush();

    expect(supervisor.children().length).toBe(1); // crashed child reaped, sibling survives

    source.fire(3); // supervisor still accepts new firings
    expect(supervisor.children().length).toBe(2);

    await supervisor.stop();
  });

  test("a clean child exit is reaped without disturbing the supervisor", async () => {
    const source = fakeSource<number>();
    const { definition } = demoLoop(source);
    const spawner = fakeSpawner();
    const supervisor = (await serve(definition, { spawn: spawner.spawn }))._unsafeUnwrap();

    source.fire(1);
    spawner.children[0]?.resolveExit(0);
    await flush();

    expect(supervisor.children().length).toBe(0);
    await supervisor.stop();
  });

  test("stop SIGKILLs in-flight children and stops the trigger", async () => {
    const source = fakeSource<number>();
    const { definition } = demoLoop(source);
    const spawner = fakeSpawner();
    const supervisor = (await serve(definition, { spawn: spawner.spawn }))._unsafeUnwrap();

    source.fire(1);
    const child = spawner.children[0];
    await supervisor.stop();

    expect(child?.killed).toContain("SIGKILL");
    expect(source.isStarted()).toBe(false);
  });

  test("serve surfaces a Source start failure as err", async () => {
    const failing = {
      kind: "cron" as const,
      start: () => Promise.resolve(err(ioFailed("source", "cron", "no scheduler bound")))
    };
    const definition = defineLoop({
      name: "broken",
      source: failing,
      sink: fakeSink(),
      onTrigger: () => Promise.resolve(ok({ outcome: outcomeOf("converged"), output: undefined }))
    });

    const result = await serve(definition, { spawn: fakeSpawner().spawn });
    expect(result.isErr()).toBe(true);
  });
});
