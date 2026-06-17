import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import {
  createFetchLinearGraphQLTransport,
  createLinearTool,
  ioFailed,
  type LinearGraphQLRequest,
  type LinearGraphQLResponse,
  type LinearGraphQLTransport,
  type RuntimeError,
} from "../src/index.ts";

interface ScriptedTransport {
  readonly requests: readonly LinearGraphQLRequest[];
  readonly transport: LinearGraphQLTransport;
}

function scriptedTransport(
  responses: readonly Result<LinearGraphQLResponse, RuntimeError>[],
): ScriptedTransport {
  const requests: LinearGraphQLRequest[] = [];
  const queue = [...responses];
  return {
    requests,
    transport<TData = unknown>(request: LinearGraphQLRequest) {
      requests.push(request);
      const response = queue.shift();
      if (response === undefined) {
        return Promise.resolve(err(ioFailed("tool", "linear", "scripted transport exhausted")));
      }
      return Promise.resolve(response as Result<LinearGraphQLResponse<TData>, RuntimeError>);
    },
  };
}

function firstRequest(scripted: ScriptedTransport): LinearGraphQLRequest {
  const request = scripted.requests.at(0);
  if (request === undefined) throw new Error("expected one Linear request");
  return request;
}

describe("LinearTool GraphQL transport", () => {
  test("sends personal API keys as raw Authorization values", async () => {
    const apiKey = "lin_api_secret";
    const scripted = scriptedTransport([
      ok({ data: { issue: { id: "issue-1", identifier: "ENG-1", title: "Fix it", state: null } } }),
    ]);
    const tool = createLinearTool({
      auth: { kind: "apiKey", token: apiKey },
      transport: scripted.transport,
    });

    const issue = await tool.fetchIssue({ issueId: "ENG-1" });

    expect(issue._unsafeUnwrap()?.id).toBe("issue-1");
    expect(firstRequest(scripted).headers.authorization).toBe(apiKey);
  });

  test("sends OAuth tokens as bearer Authorization values", async () => {
    const token = "lin_oauth_secret";
    const scripted = scriptedTransport([ok({ data: { issue: null } })]);
    const tool = createLinearTool({
      auth: { kind: "oauth", token },
      transport: scripted.transport,
    });

    const issue = await tool.fetchIssue({ issueId: "ENG-1" });

    expect(issue._unsafeUnwrap()).toBeNull();
    expect(firstRequest(scripted).headers.authorization).toBe(`Bearer ${token}`);
  });

  test("redacts auth values from GraphQL errors", async () => {
    const apiKey = "lin_api_secret";
    const scripted = scriptedTransport([
      ok({ errors: [{ message: `do not leak ${apiKey}` }] }),
    ]);
    const tool = createLinearTool({
      auth: { kind: "apiKey", token: apiKey },
      transport: scripted.transport,
    });

    const result = await tool.fetchIssue({ issueId: "ENG-1" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("IoFailed");
      if (result.error._tag !== "IoFailed") throw new Error("expected IoFailed");
      expect(result.error.message).toContain("Linear");
      expect(result.error.message).not.toContain(apiKey);
      expect(result.error.message).toContain("[redacted]");
    }
  });

  test("redacts auth values from transport failures and non-2xx HTTP responses", async () => {
    const token = "lin_oauth_secret";
    const failingFetch: typeof fetch = (() =>
      Promise.resolve(new Response(`bad token ${token}`, { status: 500 }))) as unknown as typeof fetch;
    const tool = createLinearTool({
      auth: { kind: "oauth", token },
      transport: createFetchLinearGraphQLTransport(failingFetch),
    });

    const result = await tool.fetchIssue({ issueId: "ENG-1" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("IoFailed");
      if (result.error._tag !== "IoFailed") throw new Error("expected IoFailed");
      expect(result.error.message).toContain("Linear GraphQL HTTP 500");
      expect(result.error.message).not.toContain(token);
    }
  });

  test("returns typed failures when no auth is configured", async () => {
    const tool = createLinearTool({ env: {}, transport: scriptedTransport([]).transport });

    const result = await tool.fetchIssue({ issueId: "ENG-1" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        _tag: "IoFailed",
        seam: "tool",
        kind: "linear",
        message: "Linear authentication is not configured",
      });
    }
  });

  test("implements the Linear issue, agent, and workflow-state methods", async () => {
    const scripted = scriptedTransport([
      ok({ data: { issue: { id: "issue-1", identifier: "ENG-1", state: null } } }),
      ok({ data: { issueUpdate: { success: true, issue: { id: "issue-1", title: "Updated" } } } }),
      ok({ data: { commentCreate: { success: true, comment: { id: "comment-1", body: "done" } } } }),
      ok({
        data: {
          agentActivityCreate: {
            success: true,
            agentActivity: { id: "activity-1", type: "response", body: "done" },
          },
        },
      }),
      ok({
        data: {
          agentSessionUpdate: {
            success: true,
            agentSession: { id: "session-1", externalUrl: "https://example.test/pr/1" },
          },
        },
      }),
      ok({
        data: {
          team: {
            states: {
              nodes: [
                { id: "state-1", name: "Todo", type: "unstarted" },
                { id: "state-2", name: "Done", type: "completed" },
              ],
            },
          },
        },
      }),
    ]);
    const tool = createLinearTool({
      auth: { kind: "apiKey", token: "lin_api_secret" },
      transport: scripted.transport,
    });

    expect((await tool.fetchIssue({ issueId: "ENG-1" }))._unsafeUnwrap()?.identifier).toBe("ENG-1");
    expect((await tool.updateIssue({ issueId: "issue-1", title: "Updated" }))._unsafeUnwrap().id).toBe("issue-1");
    expect((await tool.createIssueComment({ issueId: "issue-1", body: "done" }))._unsafeUnwrap().id).toBe(
      "comment-1",
    );
    expect(
      (await tool.createAgentActivity({ agentSessionId: "session-1", body: "done" }))._unsafeUnwrap().id,
    ).toBe("activity-1");
    expect(
      (await tool.updateAgentSession({ agentSessionId: "session-1", externalUrl: "https://example.test/pr/1" }))
        ._unsafeUnwrap()
        .id,
    ).toBe("session-1");
    expect((await tool.getTeamWorkflowStates({ teamId: "team-1" }))._unsafeUnwrap()).toHaveLength(2);
    expect(scripted.requests.map((request) => request.operationName)).toEqual([
      "Issue",
      "IssueUpdate",
      "CommentCreate",
      "AgentActivityCreate",
      "AgentSessionUpdate",
      "TeamWorkflowStates",
    ]);
  });
});
