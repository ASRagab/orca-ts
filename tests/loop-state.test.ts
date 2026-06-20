import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../src/index.ts";
import {
  createSnapshotStore,
  isComplete,
  measure,
  parseManifest,
  progress,
  statePath,
  type StateHash,
  type StateReducer,
  type StateStore,
  type TaskManifest
} from "../src/loop/state/index.ts";
import { defaultPlanPath, recoverPlan, writePlan } from "../src/index.ts";

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

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "orca-state-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("manifest projection (design D4)", () => {
  test("measure, progress, and isComplete share the pending-task count", () => {
    const two = manifest([
      { id: "a", passes: false },
      { id: "b", passes: false }
    ]);
    const one = manifest([
      { id: "a", passes: true },
      { id: "b", passes: false }
    ]);
    const done = manifest([
      { id: "a", passes: true },
      { id: "b", passes: true }
    ]);

    // The pending count decreases 2 -> 1 -> 0, and progress + variant read the same value.
    expect(measure(two)).toBe(2);
    expect(measure(one)).toBe(1);
    expect(measure(done)).toBe(0);

    expect(progress(one).pending).toBe(measure(one));
    expect(progress(one)).toEqual({ total: 2, passed: 1, pending: 1, ratio: 0.5 });

    expect(isComplete(two)).toBe(false);
    expect(isComplete(done)).toBe(true);
    expect(progress(manifest([])).ratio).toBe(1);
  });

  test("manifest is schema-validated; invalid input is err(RuntimeError)", () => {
    const good = parseManifest({ tasks: [{ id: "a", passes: true }] });
    expect(good._unsafeUnwrap()).toEqual(manifest([{ id: "a", passes: true }]));

    const bad = parseManifest({ tasks: [{ id: 1, passes: "no" }] });
    expect(bad.isErr()).toBe(true);
    expect(bad._unsafeUnwrapErr()._tag).toBe("StructuredOutputValidationFailed");
  });
});

describe("loop manifest does not replace the persistent plan artifact (design D4)", () => {
  test("a plan-driven loop keeps .orca/plan-<hash>.md recoverable while the manifest holds runtime progress", async () => {
    await withRoot(async (root) => {
      // The human plan artifact is written and recovered through the plans-and-review API.
      const input = "ship the loop builder";
      const planMarkdown = "# Plan\n\n- [ ] scaffold\n- [ ] wire-routes\n";
      const planPath = (await writePlan(root, input, planMarkdown))._unsafeUnwrap();
      expect(planPath).toBe(defaultPlanPath(root, input));

      // The loop's runtime progress lives in a SEPARATE manifest snapshot, not the plan file.
      const store = createSnapshotStore({ root });
      const hash = (
        await store.checkpoint(
          manifest([
            { id: "scaffold", passes: true },
            { id: "wire-routes", passes: false }
          ])
        )
      )._unsafeUnwrap();
      expect(statePath(root, hash)).not.toBe(planPath);

      // The plan API still recovers the human artifact verbatim — the loop manifest did not touch it.
      expect((await recoverPlan(planPath))._unsafeUnwrap()).toBe(planMarkdown);
      // …while the manifest store holds the runtime projection the loop engine reads.
      expect(measure((await store.load())._unsafeUnwrap())).toBe(1);
    });
  });
});

describe("snapshot adapter (zero-config default)", () => {
  test("persists human-readable JSON to .orca/state-<hash>.json and round-trips", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const seed = manifest([
        { id: "a", passes: false },
        { id: "b", passes: true }
      ]);

      const checkpointed = await store.checkpoint(seed);
      const hash = checkpointed._unsafeUnwrap();

      const path = statePath(root, hash);
      expect(path).toBe(join(root, ".orca", `state-${hash}.json`));

      // Human-readable + git-diffable: indented JSON the snapshot round-trips.
      const onDisk = await readFile(path, "utf8");
      expect(onDisk).toContain('"id": "a"');
      expect(JSON.parse(onDisk)).toEqual(seed);

      // load() with no hash returns the most recent checkpoint; load(hash) the same.
      expect((await store.load())._unsafeUnwrap()).toEqual(seed);
      expect((await store.load(hash))._unsafeUnwrap()).toEqual(seed);
    });
  });

  test("checkpoint validates the manifest each cycle", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const invalid = await store.checkpoint({ tasks: [{ id: 1, passes: "x" }] } as unknown as TaskManifest);
      expect(invalid.isErr()).toBe(true);
      expect(invalid._unsafeUnwrapErr()._tag).toBe("StructuredOutputValidationFailed");
    });
  });

  test("load surfaces corrupt snapshots as err(RuntimeError)", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const path = statePath(root, "corrupt00");
      await mkdir(join(root, ".orca"), { recursive: true });
      await writeFile(path, "{ not json");
      const loaded = await store.load("corrupt00");
      expect(loaded.isErr()).toBe(true);
      expect(loaded._unsafeUnwrapErr()._tag).toBe("FileSystemError");
    });
  });

  test("load with no prior checkpoint is err", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      expect((await store.load()).isErr()).toBe(true);
    });
  });

  test("branch is copy-on-fanout; merge is the only place state combines", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const base = manifest([
        { id: "a", passes: false },
        { id: "b", passes: false }
      ]);
      const baseHash = (await store.checkpoint(base))._unsafeUnwrap();

      const branchA = (await store.branch(baseHash))._unsafeUnwrap();
      const branchB = (await store.branch(baseHash))._unsafeUnwrap();
      expect(branchA).not.toBe(branchB); // isolated identities

      // Each branch starts from an isolated copy of base.
      expect((await store.load(branchA))._unsafeUnwrap()).toEqual(base);
      expect((await store.load(branchB))._unsafeUnwrap()).toEqual(base);

      // Branch A flips a, branch B flips b — independent branch snapshots.
      const aHash = (await store.saveBranch(branchA, manifest([
        { id: "a", passes: true },
        { id: "b", passes: false }
      ])))._unsafeUnwrap();
      const bHash = (await store.saveBranch(branchB, manifest([
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
    });
  });

  test("merge validates the reducer output", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const hash = (await store.checkpoint(manifest([{ id: "a", passes: true }])))._unsafeUnwrap();
      const broken: StateReducer<TaskManifest> = () => ({ tasks: [{ id: 1 }] }) as unknown as TaskManifest;
      const merged = await store.merge([hash], broken);
      expect(merged.isErr()).toBe(true);
    });
  });

  test("history is the ordered cycle stream and excludes branch copies", async () => {
    await withRoot(async (root) => {
      const store = createSnapshotStore({ root });
      const h1 = (await store.checkpoint(manifest([{ id: "a", passes: false }])))._unsafeUnwrap();
      const branch = (await store.branch(h1))._unsafeUnwrap(); // fan-out copy — not a cycle
      await store.saveBranch(branch, manifest([{ id: "a", passes: true }]));
      const h2 = (await store.checkpoint(manifest([{ id: "a", passes: true }])))._unsafeUnwrap();
      expect((await store.history())._unsafeUnwrap()).toEqual([h1, h2]);
    });
  });
});

describe("StateStore port stability (adapter swap leaves loop code unchanged)", () => {
  // Loop code targets the port, never an adapter. This in-memory store proves a
  // swap requires no change to the cycle driver below.
  function createMemoryStore(): StateStore {
    const snapshots = new Map<StateHash, TaskManifest>();
    const cycles: StateHash[] = [];
    let nonce = 0;
    const hash = (): StateHash => `mem-${String(nonce++)}`;
    return {
      load(h): Promise<Result<TaskManifest, RuntimeError>> {
        const target = h ?? cycles.at(-1);
        const found = target === undefined ? undefined : snapshots.get(target);
        if (found === undefined) {
          return Promise.resolve(parseManifest(undefined));
        }
        return Promise.resolve(ok(found));
      },
      checkpoint(state): Promise<Result<StateHash, RuntimeError>> {
        return Promise.resolve(parseManifest(state).map((valid) => {
          const id = hash();
          snapshots.set(id, valid);
          cycles.push(id);
          return id;
        }));
      },
      branch(from): Promise<Result<StateHash, RuntimeError>> {
        const source = snapshots.get(from);
        if (source === undefined) {
          return Promise.resolve(err({ _tag: "FileSystemError", path: from, message: "unknown branch" }));
        }
        const id = hash();
        snapshots.set(id, source);
        return Promise.resolve(ok(id));
      },
      merge(branches, reducer): Promise<Result<TaskManifest, RuntimeError>> {
        const states = branches.map((b) => snapshots.get(b)).filter((s): s is TaskManifest => s !== undefined);
        return Promise.resolve(parseManifest(reducer(states)));
      },
      history(): Promise<Result<readonly StateHash[], RuntimeError>> {
        return Promise.resolve(ok([...cycles]));
      }
    };
  }

  /** Adapter-agnostic loop step: written once, runs against any StateStore. */
  async function driveCycle(store: StateStore): Promise<number> {
    await store.checkpoint(manifest([{ id: "a", passes: false }]));
    await store.checkpoint(manifest([{ id: "a", passes: true }]));
    const latest = await store.load();
    return measure(latest._unsafeUnwrap());
  }

  test("the same cycle driver runs against snapshot and in-memory adapters", async () => {
    await withRoot(async (root) => {
      const viaSnapshot = await driveCycle(createSnapshotStore({ root }));
      const viaMemory = await driveCycle(createMemoryStore());
      expect(viaSnapshot).toBe(0);
      expect(viaMemory).toBe(viaSnapshot);
    });
  });
});
