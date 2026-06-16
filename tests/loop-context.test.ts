import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compact,
  createOffloadStore,
  DEFAULT_COMPACTION_CONFIG,
  estimateTokens,
  type CompactionConfig,
  type CompactionStage,
  type Observation,
} from "../src/index.ts";

// L08 acceptance (spec loop-context; design D10; tasks 7.1-7.3). Compaction is AUTOMATIC by token
// pressure with aggressive defaults and a small working window — no author opt-in: as pressure rises
// it escalates mask → prune → summarize in order, keeping the window within bound. Large outputs are
// offloaded to a scratch file with only a short pointer injected, resolvable back to the full payload.

const WINDOW = 100;
const config: CompactionConfig = { workingWindowTokens: WINDOW, offloadThresholdChars: 8000 };

/** An observation of an exact token cost (content sized so the estimate matches the override). */
const obs = (id: string, tokens: number, extra: Partial<Observation> = {}): Observation => ({
  id,
  content: "x".repeat(tokens * 4),
  tokens,
  ...extra,
});

const DEFAULT_SUMMARY_RESERVE = 48; // matches the summarize-stage reservation in compaction.ts
/** Newest observation that alone fills the recent tail, so history = everything before it. */
const recentTail = (id: string): Observation => obs(id, WINDOW - DEFAULT_SUMMARY_RESERVE);

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orca-context-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("staged compaction by token pressure (design D10)", () => {
  test("no pressure leaves the context untouched", () => {
    const input = [obs("a", 30), obs("b", 30)];
    const result = compact(input, config);

    expect(result.stagesApplied).toEqual([]);
    expect(result.tokensAfter).toBe(60);
    expect(result.observations.map((o) => o.id)).toEqual(["a", "b"]);
  });

  test("escalates mask → prune → summarize across successive thresholds, staying within the window", () => {
    // Each tier adds the next stage; the recent tail is always kept verbatim and the window holds.
    const tiers: { name: string; history: number; perToken: number; expected: CompactionStage[] }[] = [
      { name: "light → mask only", history: 3, perToken: 40, expected: ["mask"] },
      { name: "moderate → mask + prune", history: 30, perToken: 20, expected: ["mask", "prune"] },
      { name: "heavy → mask + prune + summarize", history: 60, perToken: 20, expected: ["mask", "prune", "summarize"] },
    ];

    for (const tier of tiers) {
      const history = Array.from({ length: tier.history }, (_v, i) => obs(`h${String(i)}`, tier.perToken));
      const newest = recentTail("newest");
      const result = compact([...history, newest], config);

      expect(result.stagesApplied, tier.name).toEqual(tier.expected);
      expect(result.tokensAfter, tier.name).toBeLessThanOrEqual(WINDOW); // small bound respected
      expect(result.tokensAfter, tier.name).toBeLessThan(result.tokensBefore); // pressure actually relieved

      // The newest observation is never compacted — it survives verbatim in the working window.
      const kept = result.observations.find((o) => o.id === "newest");
      expect(kept?.content, tier.name).toBe(newest.content);
    }
  });

  test("summarize collapses history into a single bounded summary observation", () => {
    const history = Array.from({ length: 60 }, (_v, i) => obs(`h${String(i)}`, 20));
    const result = compact([...history, recentTail("newest")], config);

    expect(result.stagesApplied).toEqual(["mask", "prune", "summarize"]);
    const summary = result.observations.find((o) => o.id === "compaction-summary");
    expect(summary).toBeDefined();
    if (summary !== undefined) {
      expect(estimateTokens(summary.content)).toBeLessThanOrEqual(DEFAULT_SUMMARY_RESERVE);
    }
  });

  test("pinned observations are never compacted", () => {
    const goal = obs("goal", 10, { pinned: true });
    const history = Array.from({ length: 60 }, (_v, i) => obs(`h${String(i)}`, 20));
    const result = compact([goal, ...history, recentTail("newest")], config);

    const pinned = result.observations.find((o) => o.id === "goal");
    expect(pinned?.content).toBe(goal.content); // body intact, not masked
    expect(result.stagesApplied).toContain("summarize");
  });

  test("aggressive defaults apply with NO configuration", () => {
    // A small working window is in effect out of the box, and an oversized context compacts under it.
    expect(DEFAULT_COMPACTION_CONFIG.workingWindowTokens).toBeLessThanOrEqual(4000);

    const history = Array.from({ length: 50 }, (_v, i) => obs(`h${String(i)}`, 200));
    const result = compact([...history, obs("newest", 200)]); // no config arg → defaults

    expect(result.stagesApplied.length).toBeGreaterThan(0); // pressure triggered compaction
    expect(result.tokensAfter).toBeLessThanOrEqual(DEFAULT_COMPACTION_CONFIG.workingWindowTokens);
  });
});

describe("large-output offload (design D10)", () => {
  test("small output stays inline — nothing is written to scratch", async () => {
    await withRoot(async (root) => {
      const store = createOffloadStore({ root, thresholdChars: 50 });
      const result = await store.intercept("tiny output");

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ offloaded: false, content: "tiny output" });
      }
      expect(existsSync(join(root, ".orca", "scratch"))).toBe(false);
    });
  });

  test("oversized output is written to scratch and replaced by only a short pointer", async () => {
    await withRoot(async (root) => {
      const store = createOffloadStore({ root, thresholdChars: 50 });
      const payload = "B".repeat(5000);
      const result = await store.intercept(payload);

      expect(result.isOk()).toBe(true);
      if (result.isOk() && result.value.offloaded) {
        const { ref, pointer } = result.value;
        expect(ref.length).toBeLessThan(payload.length); // a pointer, not the payload, enters context
        expect(pointer.path).toContain(join(".orca", "scratch"));
        expect(pointer.bytes).toBe(Buffer.byteLength(payload, "utf8"));

        const onDisk = await readFile(pointer.path, "utf8");
        expect(onDisk).toBe(payload); // full payload written out
      } else {
        throw new Error("expected the oversized output to be offloaded");
      }
    });
  });

  test("an offloaded payload remains retrievable via its pointer", async () => {
    await withRoot(async (root) => {
      const store = createOffloadStore({ root, thresholdChars: 50 });
      const payload = `huge:${"Z".repeat(9000)}`;
      const intercepted = await store.intercept(payload);

      expect(intercepted.isOk()).toBe(true);
      if (intercepted.isOk() && intercepted.value.offloaded) {
        const resolved = await store.resolve(intercepted.value.pointer);
        expect(resolved.isOk()).toBe(true);
        if (resolved.isOk()) {
          expect(resolved.value).toBe(payload); // a later step resolves the pointer to the full payload
        }
      } else {
        throw new Error("expected the oversized output to be offloaded");
      }
    });
  });
});
