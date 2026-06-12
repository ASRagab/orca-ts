import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claude,
  codex,
  opencode,
  pi,
  type BackendTag,
  type Conversation,
  type LlmBackend
} from "../../src/index.ts";

const runSmoke = process.env.ORCA_REAL_BACKEND_SMOKE === "1";
const smokeTest = runSmoke ? test : test.skip;

describe("real backend smoke", () => {
  smokeTest("runs one gated autonomous flow in a disposable git repository", async () => {
    const backendTag = realBackendTag();
    if (!commandExists(CLI_COMMAND[backendTag])) {
      // Gate enabled but this backend's CLI is absent — skip rather than fail.
      return;
    }
    const repo = await mkdtemp(join(tmpdir(), "orca-real-backend-"));
    const { backend, shutdown } = makeBackend(backendTag, repo);
    try {
      run("git", ["init"], repo);
      run("git", ["config", "user.email", "orca-smoke@example.invalid"], repo);
      run("git", ["config", "user.name", "Orca Smoke"], repo);
      await writeFile(join(repo, "package.json"), "{\"name\":\"orca-smoke\",\"private\":true}\n");
      run("git", ["add", "package.json"], repo);
      run("git", ["commit", "-m", "init"], repo);

      const conversation = backend.autonomous({ prompt: smokePrompt });

      expect(conversation.canAskUser).toBe(false);
      const startedAt = Date.now();
      const events = drainEvents(conversation);
      const outcome = await withTimeout(conversation, 120_000);
      const wallTimeMs = Date.now() - startedAt;
      const capturedEvents = await events;
      const smokeMetadata = {
        backend: backendTag,
        wallTimeMs,
        outcomeType: outcome.type,
        eventCount: capturedEvents.length,
        sessionIdPresent: outcome.type === "success" && outcome.result.sessionId.length > 0,
        usage: outcome.type === "success" ? outcome.result.usage : undefined
      };

      console.log(`ORCA_REAL_BACKEND_SMOKE ${JSON.stringify(smokeMetadata)}`);
      expect(smokeMetadata.wallTimeMs).toBeGreaterThanOrEqual(0);
      expect(smokeMetadata.eventCount).toBeGreaterThan(0);
      expect(outcome.type).toBe("success");
      if (outcome.type === "success") {
        expect(outcome.result.backend).toBe(backendTag);
        expect(smokeMetadata.sessionIdPresent).toBe(true);
        expect(outcome.result.output.length).toBeGreaterThan(0);
      }
    } finally {
      await shutdown?.();
      await rm(repo, { recursive: true, force: true });
    }
  }, 130_000);
});

const smokePrompt = [
  "Inspect this tiny git repository without modifying files.",
  "Return one short sentence that includes the file name package.json.",
  "Do not ask the user any questions."
].join(" ");

type SmokeBackend = "codex" | "claude" | "opencode" | "pi";

const CLI_COMMAND: Record<SmokeBackend, string> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  pi: "pi"
};

function realBackendTag(): SmokeBackend {
  const tag = process.env.ORCA_REAL_BACKEND ?? "codex";
  if (tag !== "codex" && tag !== "claude" && tag !== "opencode" && tag !== "pi") {
    throw new Error(`ORCA_REAL_BACKEND must be one of codex|claude|opencode|pi; got ${tag}`);
  }
  return tag;
}

function makeBackend(
  tag: SmokeBackend,
  repo: string
): { backend: LlmBackend; shutdown?: () => Promise<void> } {
  switch (tag) {
    case "codex":
      return { backend: codex({ cwd: repo }) };
    case "claude":
      return { backend: claude({ cwd: repo }) };
    case "opencode": {
      const backend = opencode({ cwd: repo });
      return { backend, shutdown: () => backend.shutdown() };
    }
    case "pi":
      return { backend: pi({ cwd: repo }) };
  }
}

function commandExists(command: string): boolean {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function withTimeout<B extends BackendTag>(
  conversation: Conversation<B>,
  timeoutMs: number
) {
  const timer = setTimeout(() => {
    void conversation.cancel(`timed out after ${String(timeoutMs)}ms`);
  }, timeoutMs);
  try {
    return await conversation.awaitResult();
  } finally {
    clearTimeout(timer);
  }
}

async function drainEvents(conversation: Conversation): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of conversation.events()) {
    events.push(event);
  }
  return events;
}
