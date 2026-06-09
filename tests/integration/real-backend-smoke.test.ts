import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex, type BackendTag, type Conversation } from "../../src/index.ts";

const runSmoke = process.env.ORCA_REAL_BACKEND_SMOKE === "1";
const smokeTest = runSmoke ? test : test.skip;

describe("real backend smoke", () => {
  smokeTest("runs one gated autonomous flow in a disposable git repository", async () => {
    const backendTag = realBackendTag();
    const repo = await mkdtemp(join(tmpdir(), "orca-real-backend-"));
    try {
      run("git", ["init"], repo);
      run("git", ["config", "user.email", "orca-smoke@example.invalid"], repo);
      run("git", ["config", "user.name", "Orca Smoke"], repo);
      await writeFile(join(repo, "package.json"), "{\"name\":\"orca-smoke\",\"private\":true}\n");
      run("git", ["add", "package.json"], repo);
      run("git", ["commit", "-m", "init"], repo);

      const conversation = codex({ cwd: repo }).autonomous({ prompt: smokePrompt });

      expect(conversation.canAskUser).toBe(false);
      const events = drainEvents(conversation);
      const outcome = await withTimeout(conversation, 120_000);

      expect(outcome.type).toBe("success");
      if (outcome.type === "success") {
        expect(outcome.result.backend).toBe(backendTag);
        expect(outcome.result.sessionId.length).toBeGreaterThan(0);
        expect(outcome.result.output.length).toBeGreaterThan(0);
      }
      expect((await events).length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 130_000);
});

const smokePrompt = [
  "Inspect this tiny git repository without modifying files.",
  "Return one short sentence that includes the file name package.json.",
  "Do not ask the user any questions."
].join(" ");

function realBackendTag(): "codex" {
  const tag = process.env.ORCA_REAL_BACKEND ?? "codex";
  if (tag !== "codex") {
    throw new Error(`Only ORCA_REAL_BACKEND=codex is implemented for the live smoke; got ${tag}`);
  }
  return tag;
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
