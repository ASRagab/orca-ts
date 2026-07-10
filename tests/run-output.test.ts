import { describe, expect, test } from "bun:test";

import {
  createRunPresenter,
  createRunReporter,
  type RunEvent,
} from "../src/run-output/index.ts";

describe("run output reporter", () => {
  test("stores and forwards structured run facts", () => {
    const seen: RunEvent[] = [];
    const reporter = createRunReporter({
      sinks: [{ handle: (event) => { seen.push(event); } }],
    });

    const events: RunEvent[] = [
      { type: "run_started", runId: "run-1", label: "cleanup", backend: "codex" },
      { type: "preflight", name: "typecheck", status: "passed" },
      { type: "stage", name: "plan", status: "started" },
      { type: "agent_activity", backend: "codex", activity: "tool_use", name: "git status" },
      { type: "cycle_progress", iteration: 2, measure: 1, delta: -1, stopStatus: "running" },
      { type: "artifact", artifact: "monitor-log", path: ".orca/monitoring/run-1.json" },
      {
        type: "run_finished",
        label: "cleanup",
        status: "success",
        stopReason: "converged",
        iterations: 2,
      },
    ];

    for (const event of events) {
      reporter.emit(event);
    }

    expect(reporter.events()).toEqual(events);
    expect(seen).toEqual(events);
  });

  test("presenter writes deterministic diagnostics without touching stdout", async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const presenter = createRunPresenter({
      env: {},
      isTTY: false,
      writeDiagnostic: (text) => stderr.push(text),
      writeOutput: (text) => stdout.push(text),
    });

    await Promise.resolve(presenter.handle({ type: "run_started", label: "cleanup", backend: "codex" }));
    await Promise.resolve(
      presenter.handle({ type: "stage", name: "inspect", status: "completed", durationMs: 25 }),
    );
    await Promise.resolve(
      presenter.handle({ type: "cycle_progress", iteration: 3, measure: 0, delta: -1, stopStatus: "converged" }),
    );
    await Promise.resolve(
      presenter.handle({
        type: "run_finished",
        label: "cleanup",
        status: "success",
        stopReason: "converged",
        iterations: 3,
      }),
    );

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("orcats | run started: cleanup (backend=codex)\n");
    expect(stderr.join("")).toContain("orcats | stage inspect completed (25ms)\n");
    expect(stderr.join("")).toContain("orcats | cycle 3 measure=0 delta=-1 stop=converged\n");
    expect(stderr.join("")).toContain("orcats | done: cleanup stopped (converged) after 3 iteration(s)\n");
  });

  test("presenter uses color only for TTY output when color is allowed", async () => {
    const tty: string[] = [];
    const ttyPresenter = createRunPresenter({
      env: {},
      isTTY: true,
      writeDiagnostic: (text) => tty.push(text),
    });
    await Promise.resolve(ttyPresenter.handle({ type: "stage", name: "patch", status: "started" }));

    const noColor: string[] = [];
    const noColorPresenter = createRunPresenter({
      env: { NO_COLOR: "1" },
      isTTY: true,
      writeDiagnostic: (text) => noColor.push(text),
    });
    await Promise.resolve(noColorPresenter.handle({ type: "stage", name: "patch", status: "started" }));

    expect(tty.join("")).toContain("\u001b[36morca\u001b[0m | stage patch started\n");
    expect(noColor.join("")).toBe("orcats | stage patch started\n");
  });

  test("narration is disabled by default and failure falls back to deterministic output", async () => {
    let calls = 0;
    const disabled: string[] = [];
    const disabledReporter = createRunReporter({
      sinks: [
        createRunPresenter({
          env: {},
          isTTY: false,
          writeDiagnostic: (text) => disabled.push(text),
          narrator: {
            summarize() {
              calls += 1;
              return "agent inspected the failing gate";
            },
          },
        }),
      ],
    });

    disabledReporter.emit({ type: "run_finished", label: "cleanup", status: "success", iterations: 1 });
    await disabledReporter.flush();
    expect(calls).toBe(0);
    expect(disabled.join("")).toContain("orcats | done: cleanup completed after 1 iteration(s)\n");

    const fallback: string[] = [];
    const fallbackReporter = createRunReporter({
      sinks: [
        createRunPresenter({
          env: {},
          isTTY: false,
          narration: "enabled",
          writeDiagnostic: (text) => fallback.push(text),
          narrator: {
            summarize() {
              throw new Error("offline");
            },
          },
        }),
      ],
    });

    fallbackReporter.emit({ type: "run_finished", label: "cleanup", status: "success", iterations: 1 });
    await fallbackReporter.flush();
    expect(fallback.join("")).toContain("orcats | done: cleanup completed after 1 iteration(s)\n");
    expect(fallback.join("")).toContain("orcats | narration unavailable: offline\n");
  });
});
