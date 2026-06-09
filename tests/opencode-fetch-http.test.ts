import { afterEach, describe, expect, test } from "bun:test";
import { createFetchOpenCodeHttp, type OpenCodeServerProcess } from "../src/index.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function server(authHeader?: string): OpenCodeServerProcess {
  return {
    url: "http://127.0.0.1:9999",
    ...(authHeader === undefined ? {} : { authHeader }),
    stop: () => Promise.resolve()
  };
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function stubFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: urlOf(input), ...(init === undefined ? {} : { init }) };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as typeof fetch;
  return calls;
}

describe("createFetchOpenCodeHttp", () => {
  test("sends preemptive Basic auth on POST and returns the body", async () => {
    const calls = stubFetch(() => new Response('{"id":"ses_x"}', { status: 200 }));
    const http = createFetchOpenCodeHttp(server("Basic dXNlcjpwdw=="));

    const body = await http.postJson("/session", "{}");

    expect(body).toBe('{"id":"ses_x"}');
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/session");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Basic dXNlcjpwdw==");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("throws on a non-2xx POST instead of returning the error body", async () => {
    stubFetch(() => new Response("bad model", { status: 500 }));
    const http = createFetchOpenCodeHttp(server("Basic x"));

    let error: unknown;
    try {
      await http.postJson("/session/s/prompt_async", "{}");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/500.*bad model/);
  });

  test("sends auth on the /event SSE request", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (c) => {
              c.close();
            }
          }),
          { status: 200 }
        )
    );
    const http = createFetchOpenCodeHttp(server("Basic y"));

    await http.openEvents(new AbortController().signal);

    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/event");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Basic y");
  });

  test("omits auth when the server has no password", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }));
    const http = createFetchOpenCodeHttp(server());

    await http.postJson("/session", "{}");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBeNull();
  });
});
