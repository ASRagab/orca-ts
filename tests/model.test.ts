import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  BackendTagSchema,
  ConversationEventSchema,
  RuntimeErrorSchema,
  canonicalJsonSchemas,
  orThrow,
  parseStructuredOutput,
  sessionId
} from "../src/index.ts";
import { err, ok } from "neverthrow";

describe("canonical model", () => {
  test("validates backend tags and conversation events", () => {
    expect(BackendTagSchema.parse("claude")).toBe("claude");
    expect(
      ConversationEventSchema.parse({
        type: "assistant_text_delta",
        text: "hello"
      })
    ).toEqual({ type: "assistant_text_delta", text: "hello" });
  });

  test("keeps reserved human interaction events in the schema", () => {
    expect(ConversationEventSchema.parse({ type: "user_question", question: "Continue?" })).toEqual({
      type: "user_question",
      question: "Continue?"
    });
  });

  test("validates runtime errors", () => {
    expect(RuntimeErrorSchema.parse({ _tag: "NothingToCommit" })).toEqual({
      _tag: "NothingToCommit"
    });
  });

  test("exports canonical JSON schemas", () => {
    const schemas = canonicalJsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      "BackendTag",
      "ConversationEvent",
      "LlmResult",
      "OrcaEvent",
      "RuntimeError",
      "Usage"
    ]);
  });

  test("parses structured output and preserves raw invalid output", () => {
    const schema = z.object({ answer: z.string() });
    expect(parseStructuredOutput(schema, { answer: "yes" })._unsafeUnwrap().value).toEqual({
      answer: "yes"
    });

    const invalid = parseStructuredOutput(schema, { answer: 1 });
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) {
      expect(invalid.error._tag).toBe("StructuredOutputValidationFailed");
      if (invalid.error._tag === "StructuredOutputValidationFailed") {
        expect(invalid.error.raw).toEqual({ answer: 1 });
      }
    }
  });

  test("orThrow returns ok values and throws errors", () => {
    expect(orThrow(ok(1))).toBe(1);
    expect(() => orThrow(err({ _tag: "NothingToCommit" }))).toThrow();
  });

  test("brands session identifiers at runtime as strings", () => {
    expect(String(sessionId("claude", "abc"))).toBe("abc");
  });
});
