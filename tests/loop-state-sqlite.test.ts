import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteStore,
  isComplete,
  measure,
  stateHash,
  type StateAdapterId,
  type StateReducer,
  type StateStore,
  type TaskManifest
} from "../src/loop/state/index.ts";

const manifest = (tasks: { id: string; passes: boolean }[]): TaskManifest => ({ tasks });

/** Merge branch manifests: a task passes if it passed in any branch. */
const mergeByPass: StateReducer<TaskManifest> = (states) => {
  const byId = new Map<string, boolean>();
  for (const state of states) {
    for (const task of state.tasks) {
      byId.set(task.id, (byId.get(task.id) ?? false) || task.passes);
    }
  }
  return { tasks: [...byId].map(([id, passes]) => ({ id, passes })) };
};

async function withDbPath(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orca-sqlite-"));
  try {
    await run(join(dir, "state.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("sqlite adapter (escalate-for-durability, design D4)", () => {
  test("persists to an embedded db file and round-trips — no service required", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        const seed = manifest([
          { id: "a", passes: false },
          { id: "b", passes: true }
        ]);

        const hash = (await store.checkpoint(seed))._unsafeUnwrap();
        // bun:sqlite is built into Bun — the only artifact is a local file, no daemon.
        expect(existsSync(path)).toBe(true);
        // Content hash matches the snapshot adapter: a manifest hashes the same everywhere.
        expect(hash).toBe(stateHash(seed));

        expect((await store.load())._unsafeUnwrap()).toEqual(seed);
        expect((await store.load(hash))._unsafeUnwrap()).toEqual(seed);
      } finally {
        store.close();
      }
    });
  });

  test("checkpoint validates the manifest each cycle", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        const invalid = await store.checkpoint({ tasks: [{ id: 1, passes: "x" }] } as unknown as TaskManifest);
        expect(invalid.isErr()).toBe(true);
        expect(invalid._unsafeUnwrapErr()._tag).toBe("StructuredOutputValidationFailed");
      } finally {
        store.close();
      }
    });
  });

  test("load surfaces unknown hashes and empty stores as err(RuntimeError)", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        expect((await store.load()).isErr()).toBe(true); // nothing checkpointed yet
        const missing = await store.load("deadbeef0000");
        expect(missing.isErr()).toBe(true);
        expect(missing._unsafeUnwrapErr()._tag).toBe("FileSystemError");
      } finally {
        store.close();
      }
    });
  });

  test("branch is copy-on-fanout; merge is the only place state combines", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        const base = manifest([
          { id: "a", passes: false },
          { id: "b", passes: false }
        ]);
        const baseHash = (await store.checkpoint(base))._unsafeUnwrap();

        const branchA = (await store.branch(baseHash))._unsafeUnwrap();
        const branchB = (await store.branch(baseHash))._unsafeUnwrap();
        expect(branchA).not.toBe(branchB); // isolated identities

        expect((await store.load(branchA))._unsafeUnwrap()).toEqual(base);
        expect((await store.load(branchB))._unsafeUnwrap()).toEqual(base);

        const aHash = (await store.checkpoint(manifest([
          { id: "a", passes: true },
          { id: "b", passes: false }
        ])))._unsafeUnwrap();
        const bHash = (await store.checkpoint(manifest([
          { id: "a", passes: false },
          { id: "b", passes: true }
        ])))._unsafeUnwrap();

        // No branch observes the other's writes before fan-in.
        expect((await store.load(aHash))._unsafeUnwrap().tasks.find((t) => t.id === "b")?.passes).toBe(false);
        expect((await store.load(bHash))._unsafeUnwrap().tasks.find((t) => t.id === "a")?.passes).toBe(false);

        const merged = (await store.merge([aHash, bHash], mergeByPass))._unsafeUnwrap();
        expect(isComplete(merged)).toBe(true);
        expect(merged).toEqual(manifest([
          { id: "a", passes: true },
          { id: "b", passes: true }
        ]));
      } finally {
        store.close();
      }
    });
  });

  test("history is the ordered cycle stream and excludes branch copies", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        const h1 = (await store.checkpoint(manifest([{ id: "a", passes: false }])))._unsafeUnwrap();
        await store.branch(h1); // fan-out copy — not a cycle
        const h2 = (await store.checkpoint(manifest([{ id: "a", passes: true }])))._unsafeUnwrap();
        expect((await store.history())._unsafeUnwrap()).toEqual([h1, h2]);
      } finally {
        store.close();
      }
    });
  });

  test("mid-loop resume: a fresh store recovers per-step checkpoints after a crash", async () => {
    await withDbPath(async (path) => {
      // Runner "A" checkpoints two cycles, then "crashes" (never calls close()).
      const runnerA = createSqliteStore({ path, owner: "A", now: () => 1_000 })._unsafeUnwrap();
      const h1 = (await runnerA.checkpoint(manifest([
        { id: "a", passes: true },
        { id: "b", passes: false }
      ])))._unsafeUnwrap();
      const h2 = (await runnerA.checkpoint(manifest([
        { id: "a", passes: true },
        { id: "b", passes: false }
      ])))._unsafeUnwrap();

      // Runner "B" opens the SAME file after the lease TTL elapsed — A is presumed
      // crashed, so B reclaims the stale lease and resumes from committed history.
      const runnerB = createSqliteStore({
        path,
        owner: "B",
        now: () => 1_000 + 30_000 + 1
      })._unsafeUnwrap();
      try {
        expect((await runnerB.history())._unsafeUnwrap()).toEqual([h1, h2]);
        expect((await runnerB.load())._unsafeUnwrap()).toEqual(manifest([
          { id: "a", passes: true },
          { id: "b", passes: false }
        ]));
        // B can keep checkpointing onto the recovered history.
        const h3 = (await runnerB.checkpoint(manifest([
          { id: "a", passes: true },
          { id: "b", passes: true }
        ])))._unsafeUnwrap();
        expect((await runnerB.history())._unsafeUnwrap()).toEqual([h1, h2, h3]);

        // A's lease is gone: its heartbeat now fails (split-brain is surfaced, not silent).
        expect(runnerA.heartbeat().isErr()).toBe(true);
      } finally {
        runnerA.close();
        runnerB.close();
      }
    });
  });

  test("a live foreign lease is refused (no two active runners on one store)", async () => {
    // No async ops here: open/heartbeat/close are all synchronous on bun:sqlite.
    await withDbPath((path) => {
      const runnerA = createSqliteStore({ path, owner: "A", now: () => 5_000 })._unsafeUnwrap();
      try {
        // B opens within the TTL window — A is still alive, so the open is rejected.
        const refused = createSqliteStore({ path, owner: "B", now: () => 5_001 });
        expect(refused.isErr()).toBe(true);
        expect(refused._unsafeUnwrapErr()._tag).toBe("FileSystemError");
        // A keeps its lease.
        expect(runnerA.heartbeat().isOk()).toBe(true);
      } finally {
        runnerA.close();
      }
      return Promise.resolve();
    });
  });

  test("dbos and dolt are NOT selectable adapters (deferred by design D5)", () => {
    const selectable: StateAdapterId[] = ["snapshot", "sqlite"];
    expect(selectable).toEqual(["snapshot", "sqlite"]);
    // @ts-expect-error dbos is deferred and must not be a selectable StateAdapterId
    const dbos: StateAdapterId = "dbos";
    // @ts-expect-error dolt is deferred and must not be a selectable StateAdapterId
    const dolt: StateAdapterId = "dolt";
    // The suppressed assignments above prove the union rejects them; observe the values.
    expect([dbos, dolt].join(",")).toBe("dbos,dolt");
  });
});

describe("StateStore port stability (adapter swap leaves loop code unchanged)", () => {
  /** Adapter-agnostic loop step: written once, runs against any StateStore. */
  async function driveCycle(store: StateStore): Promise<number> {
    await store.checkpoint(manifest([{ id: "a", passes: false }]));
    await store.checkpoint(manifest([{ id: "a", passes: true }]));
    const latest = await store.load();
    return measure(latest._unsafeUnwrap());
  }

  test("the same cycle driver runs unchanged against the sqlite adapter", async () => {
    await withDbPath(async (path) => {
      const store = createSqliteStore({ path })._unsafeUnwrap();
      try {
        expect(await driveCycle(store)).toBe(0);
      } finally {
        store.close();
      }
    });
  });
});
