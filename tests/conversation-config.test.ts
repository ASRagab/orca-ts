import { describe, expect, test } from "bun:test";
import { composeBackendPrompt } from "../src/backends/conversation-config.ts";

describe("composeBackendPrompt", () => {
  test("all sections present", () => {
    const result = composeBackendPrompt("do the thing", {
      systemPrompt: "be helpful",
      selfManagedGit: false,
      retryAttempts: 3
    });
    expect(result).toMatch(/^System instructions:\nbe helpful/);
    expect(result).toContain(
      "Git policy: Orca is the parent runtime. Do not create commits, branches, pushes, or pull requests; leave repository mutation to the parent workflow."
    );
    expect(result).toContain("Retry policy: maximum attempts 3.");
    expect(result).toMatch(/do the thing$/);
  });

  test("no sections — returns prompt exactly", () => {
    const result = composeBackendPrompt("do the thing", {});
    expect(result).toBe("do the thing");
  });

  test("selfManagedGit true suppresses git policy", () => {
    const result = composeBackendPrompt("do the thing", {
      selfManagedGit: true,
      systemPrompt: "be helpful"
    });
    expect(result).not.toContain("Git policy");
  });

  test("selfManagedGit absent suppresses git policy", () => {
    const result = composeBackendPrompt("do the thing", { systemPrompt: "be helpful" });
    expect(result).not.toContain("Git policy");
  });

  test("pure function — same inputs produce same output", () => {
    const config = { systemPrompt: "be helpful", selfManagedGit: false as const, retryAttempts: 2 };
    expect(composeBackendPrompt("prompt", config)).toBe(composeBackendPrompt("prompt", config));
  });

  test("sections joined by blank lines", () => {
    const result = composeBackendPrompt("do the thing", {
      systemPrompt: "be helpful",
      retryAttempts: 1
    });
    const parts = result.split("\n\n");
    expect(parts[0]).toBe("System instructions:\nbe helpful");
    expect(parts[1]).toBe("Retry policy: maximum attempts 1.");
    expect(parts[2]).toBe("do the thing");
  });
});
