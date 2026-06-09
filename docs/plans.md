# Plans

Persistent plan helpers write `.orca/plan-<hash>.md` files from deterministic input hashes.

The default v1 loop is autonomous: create or recover a plan, implement tasks in order, persist progress, and let the runtime own repository commits.

`Plan.interactive` is intentionally unsupported in v1 because live answers cannot be replayed after a crash.
