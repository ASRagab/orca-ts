import { describe, expect, test } from "bun:test";
import { StreamConversation, sessionId } from "../src/index.ts";

describe("StreamConversation", () => {
  test("yields events in order and completes successfully", async () => {
    const conversation = new StreamConversation({ backend: "claude", capacity: 1 });
    await conversation.emit({ type: "assistant_text_delta", text: "a" });
    const events: unknown[] = [];
    const read = (async () => {
      for await (const event of conversation.events()) {
        events.push(event);
      }
    })();

    await conversation.emit({ type: "assistant_turn_end" });
    conversation.succeed({
      backend: "claude",
      sessionId: sessionId("claude", "s1"),
      output: "a"
    });
    await read;

    expect(events).toEqual([
      { type: "assistant_text_delta", text: "a" },
      { type: "assistant_turn_end" }
    ]);
    expect(await conversation.awaitResult()).toEqual({
      type: "success",
      result: {
        backend: "claude",
        sessionId: sessionId("claude", "s1"),
        output: "a"
      }
    });
  });

  test("cancels with AbortController signal", async () => {
    let cancelled = "";
    const conversation = new StreamConversation({
      backend: "codex",
      onCancel(reason) {
        cancelled = reason ?? "";
      }
    });

    await conversation.cancel("stop");

    expect(conversation.signal.aborted).toBe(true);
    expect(cancelled).toBe("stop");
    expect(await conversation.awaitResult()).toEqual({ type: "cancelled", reason: "stop" });
  });

  test("fails reserved user interaction events", async () => {
    const conversation = new StreamConversation({ backend: "gemini" });
    const emitted = await conversation.emit({ type: "user_question", question: "Need input?" });

    expect(emitted.isErr()).toBe(true);
    expect(await conversation.awaitResult()).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "user_question",
        reason: "Human interaction events require an explicit interactive conversation"
      }
    });
  });

  test("emits user questions in explicit interactive conversations", async () => {
    const conversation = new StreamConversation({ backend: "codex", canAskUser: true });
    const emitted = await conversation.emit({ type: "user_question", question: "Continue?" });
    const events = drainEvents(conversation.events());

    conversation.succeed({
      backend: "codex",
      sessionId: sessionId("codex", "interactive"),
      output: ""
    });

    expect(emitted.isOk()).toBe(true);
    expect(await events).toEqual([{ type: "user_question", question: "Continue?" }]);
  });

  test("fails reserved approval events", async () => {
    const conversation = new StreamConversation({ backend: "claude" });
    const emitted = await conversation.emit({
      type: "approve_tool",
      toolCallId: "t1",
      name: "git",
      input: {}
    });

    expect(emitted.isErr()).toBe(true);
    expect(await conversation.awaitResult()).toEqual({
      type: "failed",
      error: {
        _tag: "UnsupportedFeature",
        feature: "approve_tool",
        reason: "Live approval events are unsupported for autonomous execution"
      }
    });
  });
});

async function drainEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
