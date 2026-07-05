import { activeRunReporter, defineLoop, loop, ok, stdout } from "../../src/index.ts";

type CheckStatus = "passed" | "failed" | "skipped";

interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly exitCode?: number | null;
}

interface RepoHealthEvent {
  readonly target?: string;
  readonly firedBy?: string;
}

async function runCheck(name: string, command: readonly string[], cwd: string): Promise<Check> {
  emitStage(name, "started");
  const proc = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  emitStage(name, exitCode === 0 ? "completed" : "failed");
  return { name, status: exitCode === 0 ? "passed" : "failed", exitCode };
}

function emitStage(name: string, status: "started" | "completed" | "failed"): void {
  activeRunReporter()?.emit({ type: "stage", name, status });
}

async function readPackageJson(target: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(`${target}/package.json`).text()) as Record<string, unknown>;
}

function targetFrom(event: unknown): string {
  if (typeof event === "object" && event !== null && "target" in event) {
    const target = (event as RepoHealthEvent).target;
    if (typeof target === "string" && target.length > 0) {
      return target;
    }
  }
  const target = process.env.ORCA_VALIDATE_TARGET_REPO;
  if (target === undefined || target.length === 0) {
    throw new Error("ORCA_VALIDATE_TARGET_REPO is required");
  }
  return target;
}

const onceSource = {
  kind: "manual" as const,
  start(handler: (event: RepoHealthEvent) => void) {
    const timer = setTimeout(() => {
      handler({ target: targetFrom(undefined), firedBy: "serve" });
    }, 20);
    return Promise.resolve(
      ok({
        stop() {
          clearTimeout(timer);
          return Promise.resolve(ok(undefined));
        },
      }),
    );
  },
};

export default defineLoop({
  name: "repo-health",
  source: onceSource,
  sink: stdout({ format: (report) => JSON.stringify(report, null, 2) }),
  async onTrigger(event) {
    const target = targetFrom(event);
    emitStage("discover-scripts", "started");
    const pkg = await readPackageJson(target);
    const scripts = Object.keys((pkg.scripts as Record<string, string> | undefined) ?? {}).sort();
    emitStage("discover-scripts", "completed");

    const checks: Check[] = [await runCheck("git-status", ["git", "status", "--short"], target)];
    for (const name of ["typecheck", "test"]) {
      if (scripts.includes(name)) {
        checks.push(await runCheck(name, ["bun", "run", name], target));
      } else {
        checks.push({ name, status: "skipped" });
      }
    }

    const run = await loop<number>("repo-health")
      .step("summarize", (state) => state - 1)
      .measure((state) => state)
      .run(1);

    return run.map((outcome) => ({
      outcome,
      output: {
        target,
        scripts,
        checks,
        checkedAt: "deterministic",
      },
    }));
  },
});
