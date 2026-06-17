import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";

import {
  createLinearTool,
  ioFailed,
  linearAgentSink,
  linearIssueSink,
  type LinearAgentActivityInput,
  type LinearAgentSessionUpdateInput,
  type LinearIssueUpdateInput,
  type LinearTool,
} from "../src/index.ts";

interface RecordingLinearTool extends LinearTool {
  readonly comments: readonly { readonly issueId: string; readonly body: string }[];
  readonly issueUpdates: readonly LinearIssueUpdateInput[];
  readonly activities: readonly LinearAgentActivityInput[];
  readonly sessionUpdates: readonly LinearAgentSessionUpdateInput[];
}

function recordingLinearTool(options: { readonly fail?: boolean } = {}): RecordingLinearTool {
  const comments: { readonly issueId: string; readonly body: string }[] = [];
  const issueUpdates: LinearIssueUpdateInput[] = [];
  const activities: LinearAgentActivityInput[] = [];
  const sessionUpdates: LinearAgentSessionUpdateInput[] = [];
  return {
    comments,
    issueUpdates,
    activities,
    sessionUpdates,
    fetchIssue: () => Promise.resolve(ok(null)),
    updateIssue(input) {
      if (options.fail === true) return Promise.resolve(err(ioFailed("tool", "linear", "Linear update failed")));
      issueUpdates.push(input);
      return Promise.resolve(ok({ id: input.issueId, title: input.title ?? null }));
    },
    createIssueComment(input) {
      if (options.fail === true) return Promise.resolve(err(ioFailed("tool", "linear", "Linear comment failed")));
      comments.push(input);
      return Promise.resolve(ok({ id: `comment-${String(comments.length)}`, body: input.body }));
    },
    createAgentActivity(input) {
      if (options.fail === true) return Promise.resolve(err(ioFailed("tool", "linear", "Linear activity failed")));
      activities.push(input);
      return Promise.resolve(ok({
        id: `activity-${String(activities.length)}`,
        body: input.body,
        ...(input.type === undefined ? {} : { type: input.type }),
      }));
    },
    updateAgentSession(input) {
      if (options.fail === true) return Promise.resolve(err(ioFailed("tool", "linear", "Linear session failed")));
      sessionUpdates.push(input);
      return Promise.resolve(ok({ id: input.agentSessionId, externalUrls: input.externalUrls ?? [] }));
    },
    getTeamWorkflowStates: () => Promise.resolve(ok([])),
  };
}

describe("Linear sinks", () => {
  test("issue sink creates comments, records PR URLs, and updates fields", async () => {
    const tool = recordingLinearTool();
    const sink = linearIssueSink({ tool, commentPrefix: "Orca update" });

    const result = await sink.emit({
      issueId: "issue-1",
      finalSummary: "Implemented the fix.",
      prUrl: "https://github.com/acme/repo/pull/1",
      update: { stateId: "done" },
    });

    expect(result.isOk()).toBe(true);
    expect(tool.comments).toEqual([
      {
        issueId: "issue-1",
        body: "Orca update\n\nImplemented the fix.\n\nPR: https://github.com/acme/repo/pull/1",
      },
    ]);
    expect(tool.issueUpdates).toEqual([{ issueId: "issue-1", stateId: "done" }]);
  });

  test("agent sink emits terminal responses and attaches PR URLs", async () => {
    const tool = recordingLinearTool();
    const sink = linearAgentSink({ tool });

    const result = await sink.emit({
      agentSessionId: "session-1",
      responseBody: "Done.",
      prUrl: "https://github.com/acme/repo/pull/1",
      plan: "Ship the fix",
    });

    expect(result.isOk()).toBe(true);
    expect(tool.activities).toEqual([
      { agentSessionId: "session-1", body: "Done.", type: "response" },
    ]);
    expect(tool.sessionUpdates).toEqual([
      {
        agentSessionId: "session-1",
        plan: "Ship the fix",
        externalUrl: "https://github.com/acme/repo/pull/1",
        externalUrls: [{ label: "Pull request", url: "https://github.com/acme/repo/pull/1" }],
      },
    ]);
  });

  test("agent sink emits final errors", async () => {
    const tool = recordingLinearTool();
    const sink = linearAgentSink({ tool });

    const result = await sink.emit({ agentSessionId: "session-1", errorBody: "The run failed." });

    expect(result.isOk()).toBe(true);
    expect(tool.activities).toEqual([
      { agentSessionId: "session-1", body: "The run failed.", type: "error" },
    ]);
    expect(tool.sessionUpdates).toEqual([]);
  });

  test("sink failures are typed err(RuntimeError) values and do not throw", async () => {
    const sink = linearIssueSink({ tool: recordingLinearTool({ fail: true }) });

    const result = await sink.emit({ issueId: "issue-1", finalSummary: "done" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        _tag: "IoFailed",
        seam: "tool",
        kind: "linear",
        message: "Linear comment failed",
      });
    }
  });

  test("transport failures do not leak auth tokens through sinks", async () => {
    const token = "lin_api_secret";
    const tool = createLinearTool({
      auth: { kind: "apiKey", token },
      transport: () => Promise.resolve(err(ioFailed("tool", "linear", `Linear failed with ${token}`))),
    });
    const sink = linearIssueSink({ tool });

    const result = await sink.emit({ issueId: "issue-1", finalSummary: "done" });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("IoFailed");
      if (result.error._tag !== "IoFailed") throw new Error("expected IoFailed");
      expect(result.error.message).not.toContain(token);
      expect(result.error.message).toContain("[redacted]");
    }
  });
});
