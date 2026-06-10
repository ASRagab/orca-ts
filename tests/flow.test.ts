import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import {
  flow,
  flowContext,
  fs,
  plan,
  requestToolApproval,
  review,
  terminal,
  type FsTool
} from "../src/index.ts";

describe("flow runtime", () => {
  test("provides default context inside a direct-style flow", async () => {
    await flow(["one"])(() => {
      expect(flowContext().args).toEqual(["one"]);
      expect(flowContext().cwd).toBe(process.cwd());
    });
  });

  test("uses named service overrides", async () => {
    const fakeFs: FsTool = {
      readText: () => Promise.resolve(ok("override")),
      writeText: () => Promise.resolve(ok(undefined)),
      exists: () => Promise.resolve(true)
    };

    await flow([], { fs: fakeFs })(async () => {
      expect((await fs().readText("x"))._unsafeUnwrap()).toBe("override");
    });
  });

  test("terminal accessor records events", async () => {
    await flow()(() => {
      terminal().emit({ type: "assistant_message", text: "done" });
      expect(terminal().lines()).toEqual(["done"]);
    });
  });

  test("Plan.interactive is explicitly unsupported", async () => {
    await flow()(() => {
      expect(() => plan().interactive()).toThrow();
    });
  });

  test("review accessor runs the default review tool", async () => {
    await flow()(async () => {
      const result = await review().run({
        loadPrompts: () => Promise.resolve([
          { id: "code-functionality", prompt: "functionality" },
          { id: "readability", prompt: "readability" },
          { id: "test", prompt: "test" }
        ]),
        review: () => Promise.resolve(ok([])),
        fix: () => Promise.resolve(ok(undefined))
      });

      expect(result._unsafeUnwrap().selected).toEqual([
        "code-functionality",
        "readability",
        "test"
      ]);
    });
  });

  test("tool approval requests are explicitly unsupported", () => {
    expect(() => requestToolApproval({ toolName: "git", input: {} })).toThrow();
  });
});
