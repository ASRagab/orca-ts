import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAcpClient,
  spawnAcpProcess,
  type AcpProcess,
  type AcpIncomingMessage,
  type AcpRequestMessage
} from "../src/backends/acp-client.ts";

describe("ACP client seam", () => {
  test("spawns a process with piped stdin, stdout, and stderr", async () => {
    const process = spawnAcpProcess(
      globalThis.process.execPath,
      ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('stderr')"],
      {}
    );
    const stderr = process.stderr;
    if (stderr === undefined) {
      throw new Error("spawned ACP process has no stderr stream");
    }
    const stdoutText = collectStream(process.stdout);
    const stderrText = collectStream(stderr);

    process.write("ping");
    process.endStdin();

    expect(await stdoutText).toBe("ping");
    expect(await stderrText).toBe("stderr");
    expect(await process.exit).toBe(0);
  });

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

    expect(await events).toEqual(expectedEvent);
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

    const initialize = await client.request("initialize");
    expect(initialize).toEqual({
      protocolVersion: 1,
      agentCapabilities: {}
    });
    const session = await client.request("session/new");
    expect(session).toEqual({ sessionId: "sid-1" });
    const messages = collectOne(client.messages());
    const prompt = await client.request("session/prompt");
    expect(prompt).toEqual({ stopReason: "end_turn" });
    expect(await messages).toEqual({
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

    expect((await rejectionError(client.request("initialize"))).message).toContain("boom (-32000)");
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

    expect((await rejectionError(client.done)).message).toContain("invalid ACP JSON-RPC message");
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

    expect((await rejectionError(request)).message).toContain("ACP process exited with code 1");
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

async function collectStream(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function rejectionError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("promise rejected with a non-Error value");
  }
  throw new Error("expected promise to reject");
}
