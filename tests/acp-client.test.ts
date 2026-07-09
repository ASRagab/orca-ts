import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAcpClient,
  type AcpProcess,
  type AcpIncomingMessage,
  type AcpRequestMessage
} from "../src/backends/acp-client.ts";

describe("ACP client seam", () => {
  test("maps deterministic ACP JSON-RPC fixtures", async () => {
    const dir = join(globalThis.process.cwd(), "fixtures", "tier1", "acp", "prompt-completion");
    const lines = (await readFile(join(dir, "input.jsonl"), "utf8")).trim().split("\n");
    const expectedEvents = JSON.parse(await readFile(join(dir, "events.json"), "utf8")) as AcpIncomingMessage[];
    const expectedOutcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as {
      initialize: unknown;
      session: unknown;
      prompt: unknown;
    };
    const expectedEvent = expectedEvents[0];
    if (expectedEvent === undefined) {
      throw new Error("ACP fixture has no expected events");
    }
    let index = 0;
    const fakeProcess = fakeAcpProcess((_message, push) => {
      push(JSON.parse(lines[index] ?? "{}") as Record<string, unknown>);
      index += 1;
      if (index === 3) {
        push(JSON.parse(lines[index] ?? "{}") as Record<string, unknown>);
        index += 1;
      }
    });
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => fakeProcess,
      requestTimeoutMs: 100
    });

    const events = collectOne(client.messages());
    const actual = {
      initialize: await client.request("initialize"),
      session: await client.request("session/new"),
      prompt: await client.request("session/prompt")
    };

    await expect(events).resolves.toEqual(expectedEvent);
    expect(actual).toEqual(expectedOutcome);
    client.close();
  });

  test("routes initialize, session, prompt responses and update notifications", async () => {
    const process = fakeAcpProcess((message, push) => {
      if (message.method === "initialize") {
        push(response(message.id, { protocolVersion: 1, agentCapabilities: {} }));
      }
      if (message.method === "session/new") {
        push(response(message.id, { sessionId: "sid-1" }));
      }
      if (message.method === "session/prompt") {
        push({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "sid-1", update: { sessionUpdate: "agent_message_chunk" } }
        });
        push(response(message.id, { stopReason: "end_turn" }));
      }
    });
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => process,
      requestTimeoutMs: 100
    });

    await expect(client.request("initialize")).resolves.toEqual({
      protocolVersion: 1,
      agentCapabilities: {}
    });
    await expect(client.request("session/new")).resolves.toEqual({ sessionId: "sid-1" });
    const messages = collectOne(client.messages());
    await expect(client.request("session/prompt")).resolves.toEqual({ stopReason: "end_turn" });
    await expect(messages).resolves.toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "sid-1", update: { sessionUpdate: "agent_message_chunk" } }
    });
    client.close();
  });

  test("responds to agent client requests through the handler", async () => {
    const process = fakeAcpProcess((message, push) => {
      if (message.method === "session/prompt") {
        push({
          jsonrpc: "2.0",
          id: 99,
          method: "fs/read_text_file",
          params: { uri: "file:///tmp/package.json" }
        });
        push(response(message.id, { stopReason: "end_turn" }));
      }
    });
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => process,
      requestTimeoutMs: 100,
      handleRequest: (message) => {
        expect(message.method).toBe("fs/read_text_file");
        return { content: "{}" };
      }
    });

    await client.request("session/prompt");

    expect(process.writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { content: "{}" }
    });
    client.close();
  });

  test("sends notifications without waiting for a response", () => {
    const process = fakeAcpProcess(() => {});
    const client = createAcpClient({ command: "agent", spawnProcess: () => process });

    client.notify("session/cancel", { sessionId: "sid-1" });

    expect(JSON.parse(process.writes[0] ?? "")).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sid-1" }
    });
    client.close();
  });

  test("rejects request errors", async () => {
    const process = fakeAcpProcess((message, push) => {
      push({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "boom" } });
    });
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => process,
      requestTimeoutMs: 100
    });

    await expect(client.request("initialize")).rejects.toThrow("boom (-32000)");
    client.close();
  });

  test("rejects malformed JSON-RPC output", async () => {
    const process = fakeAcpProcess(() => {});
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => process,
      requestTimeoutMs: 100
    });
    process.pushRaw("not json");

    await expect(client.done).rejects.toThrow("invalid ACP JSON-RPC message");
  });

  test("rejects pending requests when the process exits", async () => {
    const process = fakeAcpProcess(() => {});
    const client = createAcpClient({
      command: "agent",
      spawnProcess: () => process,
      requestTimeoutMs: 1_000
    });
    const done = client.done.catch(() => undefined);
    const request = client.request("initialize");
    process.close(1);

    await expect(request).rejects.toThrow("ACP process exited with code 1");
    await done;
  });
});

function response(id: AcpRequestMessage["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

interface FakeAcpProcess extends AcpProcess {
  readonly writes: string[];
  pushRaw(line: string): void;
  close(exitCode?: number | null): void;
}

function fakeAcpProcess(
  onMessage: (message: AcpRequestMessage, push: (message: Record<string, unknown>) => void) => void
): FakeAcpProcess {
  const writes: string[] = [];
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const exit = Promise.withResolvers<number | null>();

  const pushRaw = (line: string): void => {
    lines.push(line);
    wake?.();
    wake = undefined;
  };
  const push = (message: Record<string, unknown>): void => {
    pushRaw(JSON.stringify(message));
  };

  return {
    writes,
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const line = lines.shift();
          if (line !== undefined) {
            yield `${line}\n`;
            continue;
          }
          if (closed) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    },
    exit: exit.promise,
    write(data: string) {
      const line = data.trim();
      writes.push(line);
      onMessage(JSON.parse(line) as AcpRequestMessage, push);
    },
    endStdin() {},
    kill() {
      this.close(null);
    },
    pushRaw,
    close(exitCode: number | null = 0) {
      closed = true;
      wake?.();
      wake = undefined;
      exit.resolve(exitCode);
    }
  };
}

async function collectOne<T>(iterable: AsyncIterable<T>): Promise<T> {
  for await (const item of iterable) {
    return item;
  }
  throw new Error("empty iterable");
}
