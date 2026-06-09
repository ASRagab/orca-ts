import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { flow, flowContext, fs, plan, requestToolApproval, terminal, type FsTool } from "../src/index.ts";

describe("flow runtime", () => {
  test("provides default context inside a direct-style flow", async () => {
    await flow(["one"])(async () => {
      expect(flowContext().args).toEqual(["one"]);
      expect(flowContext().cwd).toBe(process.cwd());
    });
  });

  test("uses named service overrides", async () => {
    const fakeFs: FsTool = {
      readText: async () => ok("override"),
      writeText: async () => ok(undefined),
      exists: async () => true
    };

    await flow([], { fs: fakeFs })(async () => {
      expect((await fs().readText("x"))._unsafeUnwrap()).toBe("override");
    });
  });

  test("terminal accessor records events", async () => {
    await flow()(async () => {
      terminal().emit({ type: "assistant_message", text: "done" });
      expect(terminal().lines()).toEqual(["done"]);
    });
  });

  test("Plan.interactive is explicitly unsupported", async () => {
    await flow()(async () => {
      expect(() => plan().interactive()).toThrow();
    });
  });

  test("tool approval requests are explicitly unsupported", () => {
    expect(() => requestToolApproval({ toolName: "git", input: {} })).toThrow();
  });
});
