import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("honors an explicit Claude ACP environment override", async () => {
    const originalTransport = process.env.ORCA_CLAUDE_TRANSPORT;
    try {
      process.env.ORCA_CLAUDE_TRANSPORT = "stream-json";
      const selected = selectBackend({
        default: "claude",
        config: { model: "claude-opus-4-8" },
        env: { ORCA_CLAUDE_TRANSPORT: "acp" }
      });
      expect(await selected.backend.autonomous({ prompt: "run" }).awaitResult()).toMatchObject({
        type: "failed",
        error: { _tag: "BackendFailed", transport: "acp", phase: "initialization" }
      });
    } finally {
      if (originalTransport === undefined) delete process.env.ORCA_CLAUDE_TRANSPORT;
      else process.env.ORCA_CLAUDE_TRANSPORT = originalTransport;
    }
  });

  test.skipIf(process.platform === "win32")("inherits Claude child environment with partial selector overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-selector-env-"));
    const originalPath = process.env.PATH;
    const originalMarker = process.env.ORCA_SELECTOR_TEST_MARKER;
    const originalTransport = process.env.ORCA_CLAUDE_TRANSPORT;
    try {
      const command = join(root, "claude");
      await writeFile(command, '#!/bin/sh\nprintf "%s" "$ORCA_SELECTOR_TEST_MARKER" >&2\nexit 1\n');
      await chmod(command, 0o755);
      process.env.PATH = `${root}:${originalPath ?? ""}`;
      process.env.ORCA_SELECTOR_TEST_MARKER = "inherited-child-marker";
      process.env.ORCA_CLAUDE_TRANSPORT = "acp";
      const selected = selectBackend({
        default: "claude",
        env: { ORCA_CLAUDE_TRANSPORT: "stream-json" }
      });
      const outcome = await selected.backend.autonomous({ prompt: "run" }).awaitResult();
      expect(outcome).toMatchObject({
        type: "failed",
        error: { _tag: "BackendFailed", transport: "stream-json" }
      });
      if (outcome.type === "failed" && outcome.error._tag === "BackendFailed") {
        expect(outcome.error.message).toContain("inherited-child-marker");
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMarker === undefined) delete process.env.ORCA_SELECTOR_TEST_MARKER;
      else process.env.ORCA_SELECTOR_TEST_MARKER = originalMarker;
      if (originalTransport === undefined) delete process.env.ORCA_CLAUDE_TRANSPORT;
      else process.env.ORCA_CLAUDE_TRANSPORT = originalTransport;
      await rm(root, { recursive: true, force: true });
    }
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
