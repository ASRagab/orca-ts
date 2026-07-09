import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claude,
  codex,
  flow,
  llm,
  loop,
  type BackendTag,
  type Conversation,
  type ConversationEvent,
  type LlmBackend,
  type LlmTool
} from "../src/index.ts";

type BenchBackend = "claude" | "codex";
type BenchTransport = "current" | "acp";
type BenchWorkload = "direct" | "flow" | "loop";

interface PromptMetric {
  readonly promptIndex: number;
  readonly wallTimeMs: number;
  readonly timeToFirstEventMs: number | null;
  readonly eventCount: number;
  readonly outcomeType: string;
}

interface WorkloadResult {
  readonly backend: BenchBackend;
  readonly transport: BenchTransport;
  readonly workload: BenchWorkload;
  readonly wallTimeMs: number;
  readonly backendPromptCount: number;
  readonly processCountEstimate: number;
  readonly sessionReuse: boolean;
  readonly eventCount: number;
  readonly timeToFirstBackendEventMs: readonly (number | null)[];
  readonly promptMetrics: readonly PromptMetric[];
  readonly finalStatus: string;
  readonly cleanupStatus: string;
}

const directPrompt = [
  "Inspect this tiny git repository without modifying files.",
  "Return one short sentence that includes package.json.",
  "Do not ask the user any questions."
].join(" ");

const flowPromptA = "Inspect package.json without modifying files and answer in one short sentence.";
const flowPromptB = "Inspect README.md without modifying files and answer in one short sentence.";
const loopPrompt = "Inspect this tiny repository without modifying files and answer in five words or fewer.";

async function main(): Promise<void> {
  if (process.env.ORCA_ACP_BENCHMARK_LIVE !== "1") {
    throw new Error("set ORCA_ACP_BENCHMARK_LIVE=1 to run live backend benchmarks");
  }
  const backends = parseList<BenchBackend>(flag("--backends") ?? "codex,claude", ["codex", "claude"]);
  const workloads = parseList<BenchWorkload>(flag("--workloads") ?? "direct,flow,loop", [
    "direct",
    "flow",
    "loop"
  ]);
  const transports = parseList<BenchTransport>(flag("--transports") ?? "current,acp", ["current", "acp"]);
  const outDir = flag("--out-dir") ?? join(".orca", "acp-benchmarks", String(Date.now()));
  const results: WorkloadResult[] = [];

  for (const backend of backends) {
    for (const transport of transports) {
      for (const workload of workloads) {
        results.push(await runWorkload(backend, transport, workload));
      }
    }
  }

  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, "results.json");
  await writeFile(outputPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, results }, null, 2));
}

async function runWorkload(
  backend: BenchBackend,
  transport: BenchTransport,
  workload: BenchWorkload
): Promise<WorkloadResult> {
  const repo = await createDisposableRepo();
  const previousAcp = process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS;
  const previousClaudeTransport = process.env.ORCA_CLAUDE_TRANSPORT;
  if (backend === "claude") {
    process.env.ORCA_CLAUDE_TRANSPORT = transport === "acp" ? "acp" : "stream-json";
  } else if (transport === "acp") {
    process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS = backend;
  } else {
    delete process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS;
  }

  const promptMetrics: PromptMetric[] = [];
  const startedAt = Date.now();
  let finalStatus = "success";

  try {
    const rawBackend = makeBackend(backend, repo);
    const tool = createMeasuredLlmTool(promptMetrics);

    if (workload === "direct") {
      const outcome = await tool.autonomous(rawBackend, { prompt: directPrompt }).awaitResult();
      finalStatus = outcome.type;
    } else if (workload === "flow") {
      await flow([], { cwd: repo, llm: tool })(async () => {
        const first = await llm().autonomous(rawBackend, { prompt: flowPromptA }).awaitResult();
        const second = await llm().autonomous(rawBackend, { prompt: flowPromptB }).awaitResult();
        finalStatus = first.type === "success" && second.type === "success" ? "success" : "failed";
      });
    } else {
      const result = await loop<{ remaining: number }>("acp-benchmark-loop")
        .reason(rawBackend, { prompt: loopPrompt })
        .step("decrement", (state) => ({ remaining: state.remaining - 1 }))
        .until({ measure: (state: { remaining: number }) => state.remaining })
        .run({ remaining: 3 }, { overrides: { llm: tool } });
      finalStatus = result.isOk() ? result._unsafeUnwrap().stopReason : result._unsafeUnwrapErr()._tag;
    }
  } finally {
    if (previousAcp === undefined) {
      delete process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS;
    } else {
      process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS = previousAcp;
    }
    if (previousClaudeTransport === undefined) {
      delete process.env.ORCA_CLAUDE_TRANSPORT;
    } else {
      process.env.ORCA_CLAUDE_TRANSPORT = previousClaudeTransport;
    }
    await rm(repo, { recursive: true, force: true });
  }

  return {
    backend,
    transport,
    workload,
    wallTimeMs: Date.now() - startedAt,
    backendPromptCount: promptMetrics.length,
    processCountEstimate: promptMetrics.length,
    sessionReuse: false,
    eventCount: promptMetrics.reduce((sum, metric) => sum + metric.eventCount, 0),
    timeToFirstBackendEventMs: promptMetrics.map((metric) => metric.timeToFirstEventMs),
    promptMetrics,
    finalStatus,
    cleanupStatus: "owned process closed by conversation"
  };
}

function createMeasuredLlmTool(metrics: PromptMetric[]): LlmTool {
  return {
    autonomous(backend, request) {
      const promptIndex = metrics.length;
      const startedAt = Date.now();
      const conversation = backend.autonomous(request);
      let firstEventAt: number | null = null;
      let eventCount = 0;
      const drained = drainEvents(conversation, (event) => {
        eventCount += 1;
        void event;
        if (firstEventAt === null) {
          firstEventAt = Date.now() - startedAt;
        }
      });

      return {
        backend: conversation.backend,
        canAskUser: conversation.canAskUser,
        signal: conversation.signal,
        events: () => conversation.events(),
        cancel: (reason?: string) => conversation.cancel(reason),
        awaitResult: async () => {
          const outcome = await conversation.awaitResult();
          await drained;
          metrics.push({
            promptIndex,
            wallTimeMs: Date.now() - startedAt,
            timeToFirstEventMs: firstEventAt,
            eventCount,
            outcomeType: outcome.type
          });
          return outcome;
        }
      };
    }
  };
}

async function drainEvents(
  conversation: Conversation,
  onEvent: (event: ConversationEvent) => void
): Promise<void> {
  for await (const event of conversation.events()) {
    onEvent(event);
  }
}

function makeBackend(backend: BenchBackend, cwd: string): LlmBackend<BackendTag> {
  if (backend === "codex") {
    return codex({ cwd, readOnly: true, ignoreUserConfig: true });
  }
  return claude({ cwd, config: { readOnly: true } });
}

async function createDisposableRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "orca-acp-benchmark-"));
  await writeFile(join(repo, "package.json"), "{\"name\":\"orca-acp-benchmark\",\"private\":true}\n");
  await writeFile(join(repo, "README.md"), "# ACP benchmark fixture\n");
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "orca-benchmark@example.invalid"]);
  runGit(repo, ["config", "user.name", "Orca Benchmark"]);
  runGit(repo, ["add", "package.json", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseList<T extends string>(value: string, choices: readonly T[]): T[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is T => choices.includes(item as T));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
