import { describe, expect, test } from "bun:test";
import { createFakeLlmTool, eventRecorder, fakeBackend } from "../src/test-utils/index.ts";
import { flow, llm } from "../src/index.ts";

describe("workflow test harness", () => {
  test("fakeBackend drains outputs in order", async () => {
    const fake = fakeBackend(["first response", "second response"]);
    expect(fake.tag).toBe("codex");

    const conv1 = fake.autonomous({ prompt: "prompt 1" });
    const events1: string[] = [];
    for await (const event of conv1.events()) {
      if (event.type === "assistant_text_delta") events1.push(event.text);
    }
    expect(events1).toEqual(["first response"]);

    const conv2 = fake.autonomous({ prompt: "prompt 2" });
    const events2: string[] = [];
    for await (const event of conv2.events()) {
      if (event.type === "assistant_text_delta") events2.push(event.text);
    }
    expect(events2).toEqual(["second response"]);

    expect(fake.calls).toEqual(["prompt 1", "prompt 2"]);
  });

  test("fakeBackend records prompts in calls array", () => {
    const fake = fakeBackend(["a", "b", "c"]);
    fake.autonomous({ prompt: "x" });
    fake.autonomous({ prompt: "y" });
    expect(fake.calls).toEqual(["x", "y"]);
  });

  test("fakeBackend throws when outputs are exhausted", () => {
    const fake = fakeBackend(["only one"]);
    fake.autonomous({ prompt: "first" });
    expect(() => fake.autonomous({ prompt: "second" })).toThrow("exhausted");
  });

  test("fakeBackend conversation succeeds with expected output", async () => {
    const fake = fakeBackend(["hello world"]);
    const conv = fake.autonomous({ prompt: "say hello" });
    const outcome = await conv.awaitResult();
    expect(outcome.type).toBe("success");
    if (outcome.type === "success") {
      expect(outcome.result.output).toBe("hello world");
      expect(outcome.result.backend).toBe("codex");
      expect(String(outcome.result.sessionId)).toBe("fake-session-1");
    }
  });

  test("fakeBackend session IDs are unique and sequential", async () => {
    const fake = fakeBackend(["a", "b", "c"]);
    const outcomes = await Promise.all([
      fake.autonomous({ prompt: "p1" }).awaitResult(),
      fake.autonomous({ prompt: "p2" }).awaitResult(),
      fake.autonomous({ prompt: "p3" }).awaitResult(),
    ]);
    const sessionIds = outcomes.map(o => o.type === "success" ? String(o.result.sessionId) : null);
    expect(sessionIds).toEqual(["fake-session-1", "fake-session-2", "fake-session-3"]);
  });

  test("createFakeLlmTool injects fake backend into FlowContext", async () => {
    const fake = fakeBackend(["workflow output"]);
    const fakeLlm = createFakeLlmTool(fake);

    let capturedOutput: string | undefined;
    await flow([], { llm: fakeLlm })(async () => {
      const conv = llm().autonomous(fake, { prompt: "do the thing" });
      const outcome = await conv.awaitResult();
      if (outcome.type === "success") {
        capturedOutput = outcome.result.output;
      }
    });

    expect(capturedOutput).toBe("workflow output");
    expect(fake.calls).toHaveLength(1);
  });

  test("eventRecorder collects pushed events in order", () => {
    const recorder = eventRecorder<string>();
    recorder.push("first");
    recorder.push("second");
    recorder.push("third");
    expect(recorder.events()).toEqual(["first", "second", "third"]);
  });

  test("eventRecorder starts empty", () => {
    const recorder = eventRecorder();
    expect(recorder.events()).toHaveLength(0);
  });
});
