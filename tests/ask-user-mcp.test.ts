import { afterEach, describe, expect, test } from "bun:test";
import { createAskUserMcpServer, type AskUserMcpServer } from "../src/index.ts";

let active: AskUserMcpServer | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

function start(): { server: AskUserMcpServer; calls: () => number } {
  let count = 0;
  const server = createAskUserMcpServer({
    responder: ({ question }) => {
      count += 1;
      return `answer:${question}`;
    }
  });
  active = server;
  return { server, calls: () => count };
}

async function rpc(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("ask_user MCP server JSON-RPC handshake", () => {
  test("initialize advertises tool capability without asking the human", async () => {
    const { server, calls } = start();
    const response = await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "initialize" });
    const json = (await response.json()) as {
      result?: { capabilities?: { tools?: unknown }; serverInfo?: { name?: string } };
    };

    expect(json.result?.capabilities?.tools).toBeDefined();
    expect(json.result?.serverInfo?.name).toBe("orcats");
    expect(calls()).toBe(0);
  });

  test("tools/list advertises ask_user without asking the human", async () => {
    const { server, calls } = start();
    const response = await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const json = (await response.json()) as { result?: { tools?: Array<{ name?: string }> } };

    expect(json.result?.tools?.[0]?.name).toBe("ask_user");
    expect(calls()).toBe(0);
  });

  test("tools/call invokes the responder and returns the answer", async () => {
    const { server, calls } = start();
    const response = await rpc(server.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ask_user", arguments: { question: "Continue?" } }
    });
    const json = (await response.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };

    expect(json.result?.content?.[0]?.text).toBe("answer:Continue?");
    expect(calls()).toBe(1);
  });

  test("unknown methods return JSON-RPC method-not-found", async () => {
    const { server, calls } = start();
    const response = await rpc(server.url, { jsonrpc: "2.0", id: 4, method: "resources/list" });
    const json = (await response.json()) as { error?: { code?: number } };

    expect(json.error?.code).toBe(-32601);
    expect(calls()).toBe(0);
  });

  test("notifications are acknowledged with no body", async () => {
    const { server } = start();
    const response = await rpc(server.url, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
  });
});
