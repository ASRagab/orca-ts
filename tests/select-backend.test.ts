import { describe, expect, test } from "bun:test";
import { selectBackend } from "../src/index.ts";

describe("selectBackend", () => {
  test("uses the default when env is unset", () => {
    const selected = selectBackend({ default: "codex", env: {} });

    expect(selected.tag).toBe("codex");
    expect(selected.backend.tag).toBe("codex");
  });

  test("ORCA_BACKEND overrides the default", () => {
    expect(selectBackend({ default: "codex", env: { ORCA_BACKEND: "claude" } }).tag).toBe("claude");
    expect(selectBackend({ default: "codex", env: { ORCA_BACKEND: "pi" } }).tag).toBe("pi");
  });

  test("empty ORCA_BACKEND falls back to the default", () => {
    expect(selectBackend({ default: "pi", env: { ORCA_BACKEND: "" } }).tag).toBe("pi");
  });

  test("opencode exposes lazy shutdown", async () => {
    const selected = selectBackend({ default: "codex", env: { ORCA_BACKEND: "opencode" } });

    expect(selected.tag).toBe("opencode");
    expect(selected.shutdown).toBeFunction();
    await selected.shutdown?.();
  });

  test("resolves model precedence", () => {
    const fromBackend = selectBackend({
      default: "opencode",
      env: {},
      perBackend: { opencode: { model: "openai/gpt-5.5" } }
    });
    const fromEnv = selectBackend({
      default: "opencode",
      env: { ORCA_BACKEND_MODEL: "anthropic/x" },
      perBackend: { opencode: { model: "openai/gpt-5.5" } }
    });

    expect(fromBackend.model).toBe("openai/gpt-5.5");
    expect(fromEnv.model).toBe("anthropic/x");
  });

  test("rejects unsupported backend tags", () => {
    expect(() => selectBackend({ default: "codex", env: { ORCA_BACKEND: "nope" } })).toThrow(
      'Unsupported backend "nope"'
    );
  });
});
