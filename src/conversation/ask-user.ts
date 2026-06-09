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
      const question = body.params?.arguments?.question ?? body.question ?? "";
      const answer = await options.responder({ question, rawInput: body });

      if (body.method === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result: { content: [{ type: "text", text: answer }] }
        });
      }

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
