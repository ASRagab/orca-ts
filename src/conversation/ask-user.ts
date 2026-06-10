export interface AskUserRequest {
  readonly question: string;
  readonly rawInput?: unknown;
}

export type AskUserResponder = (request: AskUserRequest) => Promise<string> | string;

export interface AskUserMcpServer {
  readonly url: string;
  ask(request: AskUserRequest): Promise<string>;
  close(): Promise<void>;
}

export interface AskUserMcpServerOptions {
  readonly responder: AskUserResponder;
}

/** The tool name Codex's MCP client discovers and calls (namespaced `orca.ask_user`). */
export const ASK_USER_TOOL_NAME = "ask_user";

const ASK_USER_TOOL = {
  name: ASK_USER_TOOL_NAME,
  description: "Ask the human operator a single free-form clarifying question.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"]
  }
} as const;

export function createAskUserMcpServer(options: AskUserMcpServerOptions): AskUserMcpServer {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      const body = (await request.json()) as {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: {
          readonly name?: string;
          readonly arguments?: { readonly question?: string };
        };
        readonly question?: string;
      };

      // JSON-RPC notifications carry no id and expect no response body.
      if (body.method?.startsWith("notifications/")) {
        return new Response(null, { status: 202 });
      }

      // MCP handshake: a client (Codex) must `initialize` then `tools/list`
      // before it can `tools/call`. These must NOT invoke the human responder.
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "orca", version: "1.0.0" }
          }
        });
      }

      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: { tools: [ASK_USER_TOOL] }
        });
      }

      if (body.method === "tools/call") {
        const question = body.params?.arguments?.question ?? "";
        const answer = await options.responder({ question, rawInput: body });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: { content: [{ type: "text", text: answer }] }
        });
      }

      // Any other JSON-RPC method is unsupported — surface a method-not-found
      // error rather than silently invoking the responder.
      if (body.method !== undefined) {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32601, message: `Method not found: ${body.method}` }
        });
      }

      // Non-JSON-RPC fallback (a bare `{question}` body) — direct answer.
      const answer = await options.responder({ question: body.question ?? "", rawInput: body });
      return Response.json({ answer });
    }
  });

  return {
    url: server.url.href.replace(/\/$/, ""),
    async ask(request) {
      return options.responder(request);
    },
    async close() {
      return server.stop(true);
    }
  };
}
