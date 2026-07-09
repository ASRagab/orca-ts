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

/** The tool name Codex's MCP client discovers and calls (namespaced `orcats.ask_user`). */
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
          readonly arguments?: { readonly question?: string };
        };
        readonly question?: string;
      };
      const id = body.id ?? null;

      if (body.method?.startsWith("notifications/")) {
        return new Response(null, { status: 202 });
      }

      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "orcats", version: "1.0.0" }
          }
        });
      }

      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { tools: [ASK_USER_TOOL] }
        });
      }

      if (body.method === "tools/call") {
        const question = body.params?.arguments?.question ?? "";
        const answer = await options.responder({ question, rawInput: body });
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: answer }] }
        });
      }

      if (body.method !== undefined) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${body.method}` }
        });
      }

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
