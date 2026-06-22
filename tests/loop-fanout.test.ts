import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSnapshotStore,
  createSqliteStore,
  fanIn,
  fanOut,
  isComplete,
  loop,
  storeBackedFanIn,
  storeBackedFanOut,
  type Branch,
  type BranchWritableStateStore,
  type LoopVariant,
  type RuntimeError,
  type StateHash,
  type StateReducer,
  type TaskManifest,
} from "../src/index.ts";

// L07 acceptance: bounded fan-out + join-policy fan-in are OPT-IN combinators (spec loop-builder;
// design D9; tasks 6.1-6.4). `fanOut` collects branch results under a concurrency cap with an
// isolated state copy per branch; `fanIn` applies a join policy then a reducer — the only merge
// point — under a partial-failure policy. Omitting them leaves the single-cycle loop() surface
// from L06 unchanged.

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const manifest = (tasks: { id: string; passes: boolean }[]): TaskManifest => ({ tasks });

const mergeByPass: StateReducer<TaskManifest> = (states) => {
  const byId = new Map<string, boolean>();
  for (const state of states) {
    for (const task of state.tasks) {
      byId.set(task.id, (byId.get(task.id) ?? false) || task.passes);
    }
  }
  return { tasks: [...byId].map(([id, passes]) => ({ id, passes })) };
};

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orca-fanout-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withDbPath(run: (path: string) => Promise<void>): Promise<void> {
  await withRoot((root) => run(join(root, "state.db")));
}

function passTask(id: string): (state: TaskManifest) => { state: TaskManifest; summary: { summary: string; data: string } } {
  return (state) => ({
    state: {
      tasks: state.tasks.map((task) => (task.id === id ? { ...task, passes: true } : task)),
    },
    summary: { summary: `passed ${id}`, data: id },
  });
}

describe("bounded fan-out", () => {
  test("honors the concurrency bound — at most k branches run at once", async () => {
    let active = 0;
    let peak = 0;
    const branches: Branch<string, number>[] = Array.from({ length: 6 }, (_value, i) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(25);
      active -= 1;
      return { summary: `branch-${String(i)}`, data: i };
    });

    const result = await fanOut({ state: "root", branches, maxConcurrency: 2 });

    expect(result.isOk()).toBe(true);
    expect(peak).toBe(2); // never more than maxConcurrency in flight, and parallelism is real
    if (result.isOk()) {
      expect(result.value).toHaveLength(6);
      expect(result.value.every((outcome) => outcome.ok)).toBe(true);
    }
  });

  test("each branch mutates only its isolated copy; the reducer is the only merge point", async () => {
    interface Accumulator {
      items: string[];
    }
    const state: Accumulator = { items: ["seed"] };
    const branches: Branch<Accumulator, string>[] = ["a", "b", "c"].map((label) => (isolated) => {
      isolated.items.push(label); // mutate the COPY — must not leak to siblings or the source
      return { summary: `added ${label} (now ${String(isolated.items.length)})`, data: label };
    });

    const out = await fanOut({ state, branches, maxConcurrency: 3 });

    expect(out.isOk()).toBe(true);
    expect(state.items).toEqual(["seed"]); // no shared-mutable write-back to the source state
    if (out.isOk()) {
      const merged = fanIn("barrier", out.value, {
        reducer: (summaries): Accumulator => ({
          items: ["seed", ...summaries.flatMap((s) => (s.data === undefined ? [] : [s.data]))],
        }),
      });
      expect(merged.isOk()).toBe(true);
      if (merged.isOk()) {
        expect([...merged.value.items].sort()).toEqual(["a", "b", "c", "seed"]);
      }
    }
  });

  test("an over-budget branch summary is condensed, never returned raw (task 6.3)", async () => {
    const branches: Branch<string, never>[] = [() => ({ summary: "x".repeat(10_000) })];

    const out = await fanOut({ state: "root", branches, maxConcurrency: 1, summaryBudgetChars: 100 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const first = out.value[0];
      expect(first?.ok).toBe(true);
      if (first?.ok) {
        expect(first.summary.summary.length).toBeLessThanOrEqual(100);
        expect(first.summary.summary.endsWith("…[truncated]")).toBe(true);
      }
    }
  });

  test("rejects misconfiguration up front", async () => {
    const empty = await fanOut({ state: "root", branches: [], maxConcurrency: 2 });
    expect(empty.isErr()).toBe(true);
    if (empty.isErr()) expect(empty.error.kind).toBe("misconfigured");

    const branch: Branch<string, never> = () => ({ summary: "x" });
    const badConcurrency = await fanOut({ state: "root", branches: [branch], maxConcurrency: 0 });
    expect(badConcurrency.isErr()).toBe(true);
  });
});

describe("store-backed fan-out", () => {
  function createInstrumentedStore(): BranchWritableStateStore {
    const snapshots = new Map<StateHash, TaskManifest>();
    const history: StateHash[] = [];
    let nonce = 0;
    const counters = { branch: 0, merge: 0 };
    const store: BranchWritableStateStore & { counters: typeof counters } = {
      counters,
      load(hash): Promise<Result<TaskManifest, RuntimeError>> {
        const target = hash ?? history.at(-1);
        const found = target === undefined ? undefined : snapshots.get(target);
        if (found === undefined) {
          return Promise.resolve(ok(manifest([])));
        }
        return Promise.resolve(ok(structuredClone(found)));
      },
      checkpoint(state): Promise<Result<StateHash, RuntimeError>> {
        const hash = `mem-${String(nonce++)}`;
        snapshots.set(hash, structuredClone(state));
        history.push(hash);
        return Promise.resolve(ok(hash));
      },
      branch(from): Promise<Result<StateHash, RuntimeError>> {
        counters.branch++;
        const source = snapshots.get(from);
        const hash = `branch-${String(nonce++)}`;
        snapshots.set(hash, structuredClone(source ?? manifest([])));
        return Promise.resolve(ok(hash));
      },
      saveBranch(branch, state): Promise<Result<StateHash, RuntimeError>> {
        if (!snapshots.has(branch)) {
          return Promise.resolve(err({ _tag: "FileSystemError", path: branch, message: "unknown branch" }));
        }
        const hash = `branch-result-${String(nonce++)}`;
        snapshots.set(hash, structuredClone(state));
        return Promise.resolve(ok(hash));
      },
      merge(branches, reducer): Promise<Result<TaskManifest, RuntimeError>> {
        counters.merge++;
        const states = branches.flatMap((hash) => {
          const state = snapshots.get(hash);
          return state === undefined ? [] : [state];
        });
        return Promise.resolve(ok(reducer(states)));
      },
      history(): Promise<Result<readonly StateHash[], RuntimeError>> {
        return Promise.resolve(ok([...history]));
      },
    };
    return store;
  }

  test("uses StateStore.branch per branch and StateStore.merge at fan-in", async () => {
    const store = createInstrumentedStore() as BranchWritableStateStore & { counters: { branch: number; merge: number } };
    const base = await store.checkpoint(manifest([
      { id: "a", passes: false },
      { id: "b", passes: false },
    ]));

    const out = await storeBackedFanOut({
      store,
      from: base._unsafeUnwrap(),
      branches: [passTask("a"), passTask("b")],
      maxConcurrency: 2,
    });

    expect(out.isOk()).toBe(true);
    expect(store.counters.branch).toBe(2);
    if (out.isOk()) {
      const merged = await storeBackedFanIn("barrier", out.value, { store, reducer: mergeByPass });
      expect(merged.isOk()).toBe(true);
      if (merged.isOk()) expect(isComplete(merged.value)).toBe(true);
    }
    expect(store.counters.merge).toBe(1);
  });

  async function runStorePath(store: BranchWritableStateStore): Promise<void> {
    const base = (await store.checkpoint(manifest([
      { id: "a", passes: false },
      { id: "b", passes: false },
    ])))._unsafeUnwrap();
    const out = await storeBackedFanOut({
      store,
      from: base,
      branches: [passTask("a"), passTask("b")],
      maxConcurrency: 2,
    });
    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      expect((await store.history())._unsafeUnwrap()).toEqual([base]);
      expect((await store.load())._unsafeUnwrap()).toEqual(manifest([
        { id: "a", passes: false },
        { id: "b", passes: false },
      ]));
      for (const outcome of out.value) {
        if (!outcome.ok) continue;
        expect((await store.load(outcome.stateHash))._unsafeUnwrap().tasks.some((task) => task.passes)).toBe(true);
      }
      const merged = await storeBackedFanIn("barrier", out.value, { store, reducer: mergeByPass });
      expect(merged.isOk()).toBe(true);
      if (merged.isOk()) {
        expect(merged.value).toEqual(manifest([
          { id: "a", passes: true },
          { id: "b", passes: true },
        ]));
      }
    }
  }

  test("same fan-out path runs against snapshot and sqlite adapters", async () => {
    await withRoot(async (root) => {
      await runStorePath(createSnapshotStore({ root }));
    });
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        await runStorePath(store);
      } finally {
        store.close();
      }
    });
  });
});

describe("join-policy fan-in", () => {
  /** Branches that vote; `data` is the vote so the default agreement key uses it. */
  async function voteOut(votes: readonly string[]) {
    const branches: Branch<string, string>[] = votes.map((vote) => () => ({ summary: `voted ${vote}`, data: vote }));
    return fanOut({ state: "root", branches, maxConcurrency: votes.length });
  }

  test("quorum proceeds once k branches agree and the reducer merges the agreeing group", async () => {
    const out = await voteOut(["A", "A", "B", "A", "B"]);

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn<{ winner: string; agree: number }, string>("quorum", out.value, {
        quorum: 3,
        reducer: (summaries) => ({ winner: summaries[0]?.data ?? "?", agree: summaries.length }),
      });
      expect(merged.isOk()).toBe(true);
      if (merged.isOk()) {
        expect(merged.value).toEqual({ winner: "A", agree: 3 });
      }
    }
  });

  test("quorum errs with the largest agreement seen when no group reaches k", async () => {
    const out = await voteOut(["A", "B", "A", "B", "A"]); // A agrees 3×, never 4

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn("quorum", out.value, { quorum: 4, reducer: (summaries) => summaries.length });
      expect(merged.isErr()).toBe(true);
      if (merged.isErr() && merged.error.kind === "no-quorum") {
        expect(merged.error.required).toBe(4);
        expect(merged.error.largestAgreement).toBe(3);
      }
    }
  });

  test("quorum without a quorum size is a misconfiguration", async () => {
    const out = await voteOut(["A"]);
    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn("quorum", out.value, { reducer: (summaries) => summaries.length });
      expect(merged.isErr()).toBe(true);
      if (merged.isErr()) expect(merged.error.kind).toBe("misconfigured");
    }
  });

  test("barrier fails fast when any branch fails", async () => {
    const branches: Branch<string, never>[] = [
      () => ({ summary: "ok-1" }),
      () => {
        throw new Error("boom");
      },
      () => ({ summary: "ok-2" }),
    ];
    const out = await fanOut({ state: "root", branches, maxConcurrency: 3 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      expect(out.value.filter((outcome) => !outcome.ok)).toHaveLength(1); // failure captured, not thrown
      const merged = fanIn("barrier", out.value, { reducer: (summaries) => summaries.length });
      expect(merged.isErr()).toBe(true);
      if (merged.isErr()) expect(merged.error.kind).toBe("partial-failure");
    }
  });

  test("reduce tolerates branch failures and folds the survivors", async () => {
    const branches: Branch<string, number>[] = [
      () => ({ summary: "1", data: 1 }),
      () => {
        throw new Error("x");
      },
      () => ({ summary: "3", data: 3 }),
      () => ({ summary: "4", data: 4 }),
    ];
    const out = await fanOut({ state: "root", branches, maxConcurrency: 4 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn<number, number>("reduce", out.value, {
        reducer: (summaries) => summaries.reduce((sum, s) => sum + (s.data ?? 0), 0),
        onPartialFailure: { kind: "tolerate", minSuccess: 2 },
      });
      expect(merged.isOk()).toBe(true);
      if (merged.isOk()) expect(merged.value).toBe(8); // 1 + 3 + 4; the failed branch is dropped
    }
  });

  test("tolerate errs when survivors fall below minSuccess", async () => {
    const branches: Branch<string, number>[] = [
      () => ({ summary: "1", data: 1 }),
      () => {
        throw new Error("x");
      },
      () => {
        throw new Error("y");
      },
    ];
    const out = await fanOut({ state: "root", branches, maxConcurrency: 3 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn("reduce", out.value, {
        reducer: (summaries) => summaries.length,
        onPartialFailure: { kind: "tolerate", minSuccess: 2 },
      });
      expect(merged.isErr()).toBe(true);
      if (merged.isErr()) expect(merged.error.kind).toBe("partial-failure");
    }
  });

  test("race folds only the fastest successful branch", async () => {
    const branches: Branch<string, string>[] = [
      async () => {
        await delay(40);
        return { summary: "slow", data: "slow" };
      },
      async () => {
        await delay(5);
        return { summary: "fast", data: "fast" };
      },
    ];
    const out = await fanOut({ state: "root", branches, maxConcurrency: 2 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      let folded = -1;
      const merged = fanIn<string, string>("race", out.value, {
        reducer: (summaries) => {
          folded = summaries.length;
          return summaries[0]?.data ?? "?";
        },
      });
      expect(merged.isOk()).toBe(true);
      expect(folded).toBe(1); // the reducer sees exactly the winner
      if (merged.isOk()) expect(merged.value).toBe("fast");
    }
  });

  test("errs no-success when every branch failed", async () => {
    const branches: Branch<string, never>[] = [
      () => {
        throw new Error("a");
      },
      () => {
        throw new Error("b");
      },
    ];
    const out = await fanOut({ state: "root", branches, maxConcurrency: 2 });

    expect(out.isOk()).toBe(true);
    if (out.isOk()) {
      const merged = fanIn("reduce", out.value, { reducer: (summaries) => summaries.length });
      expect(merged.isErr()).toBe(true);
      if (merged.isErr()) expect(merged.error.kind).toBe("no-success");
    }
  });
});

describe("single-cycle surface unchanged", () => {
  test("a loop() with no combinators still builds and converges (L06 surface intact)", async () => {
    const variant: LoopVariant<{ n: number }> = { measure: (state) => state.n };

    const result = await loop<{ n: number }>("countdown")
      .step("decrement", (state) => ({ n: state.n - 1 }))
      .until(variant)
      .run({ n: 3 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.stopReason).toBe("converged");
      expect(result.value.state.n).toBe(0);
    }
  });
});
