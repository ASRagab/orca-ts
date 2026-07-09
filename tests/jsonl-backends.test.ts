import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  collectCodexJsonl,
  collectPiRpc,
  StreamConversation,
  codexExecJsonlArgs,
  piPromptCommand,
  piRpcArgs,
  sessionId
} from "../src/index.ts";

describe("Codex JSONL Tier 1 fixtures", () => {
  test("maps scripted JSONL streams to canonical events and outcomes", async () => {
    await assertJsonlFixtures("codex", async (lines) => await collectCodexJsonl(lines));
  });

  test("fails ask_user MCP bridge attempts explicitly", async () => {
    const actual = await collectCodexJsonl([
      '{"type":"thread.started","thread_id":"thr"}',
      '{"type":"item.started","item":{"id":"ask","type":"mcp_tool_call","server":"orcats","tool":"ask_user","arguments":{"question":"Continue?"}}}'
    ]);

    expect(actual.outcome).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "codex ask_user",
        reason: "Codex ask_user MCP bridge requires an explicit interactive conversation"
      }
    });
  });

  test("builds codex exec JSONL args", () => {
    expect(codexExecJsonlArgs({ model: "gpt-5", approvalPolicy: "never", ignoreUserConfig: true })).toEqual([
      "exec",
      "--json",
      "--ignore-user-config",
      "--model",
      "gpt-5",
      "-c",
      "approval_policy=\"never\""
    ]);
  });

  test("builds read-only, schema, and resume args", () => {
    expect(
      codexExecJsonlArgs({
        readOnly: true,
        outputSchemaPath: "/tmp/schema.json",
        resumeSessionId: "codex-thread",
        prompt: "continue"
      })
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--output-schema",
      "/tmp/schema.json",
      // `codex exec resume` rejects `--sandbox`; sandbox is a config override here.
      "-c",
      "sandbox_mode=\"read-only\"",
      "codex-thread",
      "continue"
    ]);
  });

  test("plain exec keeps the exec-only --sandbox flag", () => {
    expect(codexExecJsonlArgs({ readOnly: true, prompt: "go" })).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "go"
    ]);
  });

  test("validates structured output from JSONL", async () => {
    const actual = await collectCodexJsonl(
      [
        "{\"type\":\"thread.started\",\"thread_id\":\"thr\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"msg\",\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":\\\"yes\\\"}\"}}",
        "{\"type\":\"turn.completed\"}"
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "thr"),
        output: "{\"answer\":\"yes\"}",
        structured: { answer: "yes" },
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("uses last agent_message for structured output when codex emits progress blobs", async () => {
    // Codex emits one agent_message per step (progress updates then final answer).
    // Concatenating all steps produces invalid JSON; only the last message is the result.
    const actual = await collectCodexJsonl(
      [
        '{"type":"thread.started","thread_id":"thr"}',
        '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"{\\"answer\\":\\"thinking\\"}"}}',
        '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"{\\"answer\\":\\"done\\"}"}}',
        '{"type":"turn.completed"}'
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome).toEqual({
      type: "success",
      result: {
        backend: "codex",
        sessionId: sessionId("codex", "thr"),
        output: '{"answer":"thinking"}{"answer":"done"}',
        structured: { answer: "done" },
        usage: { input: 0, output: 0 }
      }
    });
  });

  test("fails invalid structured output with raw output", async () => {
    const actual = await collectCodexJsonl(
      [
        "{\"type\":\"thread.started\",\"thread_id\":\"thr\"}",
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"msg\",\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":1}\"}}",
        "{\"type\":\"turn.completed\"}"
      ],
      { schema: z.object({ answer: z.string() }) }
    );

    expect(actual.outcome.type).toBe("failed");
    if (actual.outcome.type === "failed") {
      expect(actual.outcome.error._tag).toBe("StructuredOutputValidationFailed");
      if (actual.outcome.error._tag === "StructuredOutputValidationFailed") {
        expect(actual.outcome.error.raw).toEqual({ answer: 1 });
      }
    }
  });
});

describe("Pi RPC Tier 1 fixtures", () => {
  test("maps scripted RPC streams to canonical events and outcomes", async () => {
    await assertJsonlFixtures("pi", async (lines, dir) => {
      const session = JSON.parse(await readFile(join(dir, "session.json"), "utf8")) as {
        sessionId: string;
      };
      return await collectPiRpc(lines, session.sessionId);
    });
  });

  test("builds Pi RPC startup args and prompt command", () => {
    expect(piRpcArgs("/tmp/session")).toEqual(["--mode", "rpc", "--session-dir", "/tmp/session"]);
    expect(piPromptCommand("do it")).toBe(
      '{"id":"orca-prompt","type":"prompt","message":"do it"}'
    );
  });

  test("supports Pi cancellation through the shared conversation engine", async () => {
    const conversation = new StreamConversation({ backend: "pi" });
    await conversation.cancel("stop");
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });
});

async function assertJsonlFixtures(
  backend: "codex" | "pi",
  collect: (
    lines: readonly string[],
    dir: string
  ) => Promise<{ readonly events: readonly unknown[]; readonly outcome: unknown }>
): Promise<void> {
  const root = join(process.cwd(), "fixtures", "tier1", backend);
  const cases = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  expect(cases.length).toBeGreaterThan(0);

  for (const name of cases) {
    const dir = join(root, name);
    const input = (await readFile(join(dir, "input.jsonl"), "utf8")).trim().split("\n");
    const expectedEvents = JSON.parse(await readFile(join(dir, "events.json"), "utf8")) as unknown;
    const expectedOutcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as unknown;
    const actual = await collect(input, dir);

    expect(actual.events as unknown).toEqual(expectedEvents);
    expect(actual.outcome).toEqual(expectedOutcome);
  }
}
