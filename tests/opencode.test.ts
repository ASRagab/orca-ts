import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { collectOpenCodeSse, createOpenCodeServerManager } from "../src/index.ts";

describe("OpenCode SSE Tier 1 fixtures", () => {
  test("maps scripted SSE streams to canonical events and outcomes", async () => {
    const root = join(process.cwd(), "fixtures", "tier1", "opencode");
    const cases = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(cases).toEqual(["assistant-text-success", "session-error", "structured-output-success"]);

    for (const name of cases) {
      const dir = join(root, name);
      const input = (await readFile(join(dir, "input.sse"), "utf8")).trim().split("\n");
      const expectedEvents = JSON.parse(await readFile(join(dir, "events.json"), "utf8")) as unknown;
      const expectedOutcome = JSON.parse(await readFile(join(dir, "outcome.json"), "utf8")) as unknown;

      const actual = await collectOpenCodeSse(input);
      expect(actual.events as unknown).toEqual(expectedEvents);
      expect(actual.outcome as unknown).toEqual(expectedOutcome);
    }
  });
});

describe("OpenCode server lifecycle", () => {
  test("starts lazily, reuses the process, and tears down with SIGINT", async () => {
    let starts = 0;
    const signals: string[] = [];
    const manager = createOpenCodeServerManager({
      async start() {
        starts += 1;
        return {
          url: "http://127.0.0.1:1234",
          async stop(signal) {
            signals.push(signal ?? "");
          }
        };
      }
    });

    expect((await manager.get()).url).toBe("http://127.0.0.1:1234");
    expect(await manager.get()).toBe(await manager.get());
    expect(starts).toBe(1);

    await manager.shutdown();
    expect(signals).toEqual(["SIGINT"]);
  });

  test("surfaces failed startup", async () => {
    const manager = createOpenCodeServerManager({
      async start() {
        throw new Error("boom");
      }
    });

    await expect(manager.get()).rejects.toThrow("boom");
  });
});
