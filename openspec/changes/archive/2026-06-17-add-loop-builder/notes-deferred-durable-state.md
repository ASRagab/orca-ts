# Deferred design notes — durable state adapters (DBOS, Dolt)

Follow-up notes for `tasks.md` §12.2–12.3. **Status: DEFERRED — not implemented, not selectable.**
What ships in this change is two `StateStore` adapters: `snapshot` (zero-config default) and
`sqlite` (`bun:sqlite`, per-step WAL checkpoint + lease-based crash recovery). `dbos` and `dolt`
are recorded here only; the `StateStore` port (`load/checkpoint/branch/merge/history`) already keeps
them expressible, so either can be added later without touching a loop definition. See `design.md`
D4 (adapters) and D5 (deferral) for the decision; this note records the spike verdicts.

## DBOS on Bun — spike verdict

Target tier (D5): "graduate to durable multi-process resume-after-crash once you already have
Postgres." DBOS Transact is the strongest durable-execution candidate that needs no separate
orchestrator daemon — an in-process library + Postgres, with a decorator-free TSv3 API
(`registerWorkflow` / `runStep`) that wraps only chosen entrypoints. Checkpoints are step rows in
Postgres, so there is no Temporal-style event-history ceiling on long loops.

**Verdict: do NOT ship `--durable` or a `dbos` adapter in this change.** Blockers found:

- **Postgres-only system DB.** The TS runtime stores workflow/step state in Postgres; the SQLite
  system DB is Python-only today. So a DBOS adapter cannot reuse the embedded `bun:sqlite` file —
  it requires standing up Postgres, which violates the no-service default ethos. `sqlite` already
  covers single-process crash recovery without any service.
- **Not bundleable.** DBOS is an external dependency that must be `bun run`, not `bun build` — it
  cannot be folded into the smoke binary. That conflicts with the minimal-dep / single-binary
  posture.
- **Bun support is real but unofficial.** Works in practice, no compatibility guarantee.

**Promotion criterion:** revisit only for a concrete multi-process / at-scale workflow that already
runs Postgres and needs resume-after-crash beyond what `sqlite` gives. Then add a `dbos` adapter
behind the existing port and gate it on an explicit opt-in; never make it required for core function.

## Dolt — rationale for deferral

Dolt ("Git for data") is the conceptual source of the port's first-class `branch`/`merge`/`history`
operations (fan-out = `DOLT_BRANCH`, fan-in = `DOLT_MERGE` with cell-level conflict tables, `AS OF`
time-travel; the client is painless — `Bun.sql` speaks MySQL natively). The branch/merge model is
valuable *as a port shape* even though Dolt itself is not adopted.

**Verdict: keep the design note only; no adapter.** Blockers found:

- **Not embeddable in Bun.** Dolt offers a Go-only single-process driver; from Bun the only options
  are a ~103 MB binary run as a `dolt sql-server` daemon or a per-op CLI subprocess — a daemon or a
  heavyweight dependency, contradicting the no-daemon / minimal-dep ethos. (The Beads case study,
  same solo-tool profile, hit embedded single-process locking, DDL non-atomicity, and a load panic.)
- **Branch/merge tuned for human-scale persistent branches.** High-churn ephemeral per-cycle
  branching is unbenchmarked; the fan-out workload here is exactly that high-churn case.

**Promotion criterion:** promote from deferred to documented-optional only when a concrete workflow
needs DB-adjudicated cell-level fan-in merges on overlapping rows — the one thing the reducer-based
`merge` cannot express. Until then `sqlite` is the shipped embedded durable option.

## What this leaves open (non-blocking)

- `sqlite` lease is advisory crash-recovery metadata, not a write lock: content-addressed snapshots
  + append-only history make concurrent writers safe-but-interleaved, and a lost lease surfaces via
  `heartbeat()` rather than blocking writes. A hard write-fence (refuse checkpoints after lease loss)
  is a future hardening if `serve` ever shares one store file across child loops.
