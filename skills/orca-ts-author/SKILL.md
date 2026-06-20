---
name: orca-ts-author
description: "Turn a workflow idea into a saved, self-validating Orca TypeScript workflow or loop module for ANY git-backed repo (not just TS projects). Reads the target repo to detect real test/lint/build commands, interviews the user to fix the artifact shape, generates from bundled references/templates, ENFORCES verification gates for mutating work, and saves either .orca/workflows/<name>.ts or .orca/loops/<name>.ts with a runbook. Use after orca-ts-setup, when someone wants to create or productize an agentic coding workflow or reusable loop. Triggers on \"create an orca workflow\", \"author an orca flow\", \"productize this workflow\", \"orca loop for <task>\", \"make a saveable orca workflow\"."
compatibility: "Host-agnostic (uses AskUserQuestion on Claude Code, one-question-at-a-time elsewhere) and stack-agnostic (target repo can be Python/Go/Rust/Scala/anything git-backed). Generated flows are TypeScript that the `orca` binary runs; the repo they operate on need not be TypeScript. Author from reference/, in order: recipes.md, dsl.md, gotchas.md, backends.md."
metadata:
  author: "Ahmad Ragab"
---

# orca-ts-author — author a verification-gated Orca artifact

A "vibe" is a one-off prompt. A **productized Orca artifact** is either a saved
one-shot workflow script or a reusable loop module that re-runs the same shape
and gates mutating output on the target repo's real tests and linters.

Flow: **read the repo → interview → generate from a template → enforce
verification gates → typecheck (when reachable) → save to `.orca/workflows/` or
`.orca/loops/`.**

> Author from the shared cookbook, in this order: `skills/orca-ts-author/reference/recipes.md`
> (the 6 archetypes = the templates), `dsl.md` (verbs/types), `gotchas.md`
> (codegen rules + self-audit), `backends.md` (backend matrix). Prefer the
> bundled `assets/templates/` — they are kept compiling by CI.

## 0. Prerequisite

Assume `orca-ts-setup` has run (binary installed, ≥1 backend verified). If not,
direct the user there first — you need a working backend to run what you author.

## 1. Discover the target repo's stack and verification commands

Read the repo to detect its real commands. Probe these markers (stop at what's
present — do **not** assume Node/TS):

| Marker | Likely test | Likely lint/format |
|---|---|---|
| `package.json` `scripts` | `npm test` / `bun test` / the named script | `eslint`, `prettier`, the named script |
| `Makefile` / `justfile` | `make test` / `just test` | `make lint` / `just lint` |
| `pyproject.toml` / `pytest.ini` / `tox.ini` | `pytest` | `ruff check`, `flake8`, `black --check`, `mypy` |
| `Cargo.toml` | `cargo test` | `cargo clippy`, `cargo fmt --check` |
| `go.mod` | `go test ./...` | `go vet ./...`, `golangci-lint run` |
| `build.sbt` | `sbt test` | `sbt scalafmtCheckAll` |
| `.pre-commit-config.yaml` | — | `pre-commit run --all-files` |
| `.github/workflows/*.yml` | mirror the CI test job | mirror the CI lint job |

**Confirm the detected commands with the user before using them.** If you
cannot detect any test or lint command, **ask the user to supply them** — do not
guess (see §5: an ungated workflow is refused).

## 2. Interview — fix the workflow shape

Adaptive decision tree, not a fixed questionnaire. Ask the **archetype first**,
then only that archetype's sub-decisions. **Offer a default for every question.**
If the user says "defaults", jump to a legacy `.orca/workflows/` persistent-multitask
workflow with the detected gates slotted in.

**Host-agnostic asking:** on Claude Code use `AskUserQuestion` (structured
chips); on any other host ask **one question at a time**, show the default, and
accept a bare answer. Never dump all axes at once.

| Axis | Ask | Default |
|---|---|---|
| **Artifact** | one-shot workflow script · reusable loop module | one-shot workflow script |
| **Archetype** | single-change · persistent-multitask · issue-to-pr · bugfix · cleanup-sweep · multi-backend-compare | persistent-multitask |
| **Loop shape** | minimal · gated task · fan-out/fan-in · persisted state · served trigger | gated task when a reusable loop module is requested |
| **Backend** | which verified backend implements (and any per-backend model) | the one `orca-ts-setup` verified |
| **Input** | ad-hoc objective · CLI task arg · GitHub issue ref · file set | per archetype |
| **Verification gate** | which detected test + lint (+ optional build/format) commands | the detected test + lint |
| **Delivery** (issue-to-pr) | commit · push · open PR; base branch | open PR against `main` |
| **Scope** (cleanup-sweep) | the `git ls-files` pathspec; the per-file edit brief | confirm explicitly |

## 3. Generate from a template

1. Pick the artifact shape first:
   - **Workflow script**: a self-executing `flow(flowArgs())(...)` file under `.orca/workflows/<name>.ts`.
   - **Loop module**: an import-safe `defineLoop()` export under `.orca/loops/<name>.ts`; importing it must not start a source, run a backend, or emit a sink.
2. Pick the archetype or loop recipe's template (`recipes.md` → tables). Copy it as the skeleton.
3. Fill every labelled `REPLACE_WITH_*` slot from the interview:
   - `selectBackend({ default })` tag = the verified backend;
   - the `GATE` array = the **confirmed target-repo commands** (`command` + `args`);
   - the prompt/objective/title/pathspec for the archetype.
4. Apply every `gotchas.md` rule as you fill: import from `"orca-ts"`; narrow
   `outcome.type`; `selected.shutdown?.()` in a `finally`; `fixLoop` issues carry
   `fixable`; no-progress detection is explicit; deprecated task/review wrappers
   are not used in new artifacts; loop modules stay import-safe; `loop()` and
   `fixLoop` are used instead of internal `executeLoop`; Zod tolerant for
   pi/OpenCode.

## 4. Typecheck the flow (when a TS toolchain is reachable)

```bash
bash skills/orca-ts-author/scripts/orca-typecheck-flow.sh .orca/workflows/<name>.ts
bash skills/orca-ts-author/scripts/orca-typecheck-flow.sh .orca/loops/<name>.ts
```

- **OK** → the flow typechecks against `orca-ts`; proceed.
- **FAILED** → read the error, fix per `gotchas.md`, re-run (bounded retries).
  **Never hand back a flow that fails typecheck.**
- **SKIPPED** (no `tsconfig.json`/`orca-ts` dep in the target — the common
  non-TS case) → you cannot locally typecheck. Run the **self-audit checklist**
  at the end of `gotchas.md` instead, and record the skipped-typecheck note in
  the runbook (§6). The bundled templates are CI-typecheck-gated, so a careful
  slot-fill is high-confidence even without a local gate.

## 5. Enforce verification gates (non-negotiable)

Every authored mutating workflow or loop module MUST carry, wired into its
per-task/per-file loop, **at least one test gate and one lint gate** (the
confirmed target-repo commands). A gate failure must drive repair or be reported
— never silently ignored.

If no verification command was detected **and** the user declines to supply any,
**refuse to emit the artifact** and explain that a gate is what turns a vibe into
a productized workflow. Do not save ungated mutating code.

## 6. Save — stack-agnostic and re-runnable

Confirm the target directory (default: the user's current repo root, so the
flow's `git`/`gh` tools act on the right repo) **before writing**. Then write:

For a workflow script, write:

1. **`.orca/workflows/<name>.ts`** — the generated self-executing flow.
2. **`.orca/workflows/<name>.run.md`** — a runbook containing:
   - the exact trigger: `orca .orca/workflows/<name>.ts --backend <tag> [-- "<args>"]`
     (or via `bash skills/orca-ts-author/scripts/orca-run.sh .orca/workflows/<name>.ts ...`);
   - prerequisites (verified backend, clean worktree if the flow commits, `gh`
     auth for issue-to-pr);
   - the verification commands it gates on;
   - **for non-TS targets**: the note that the binary skips its typecheck guard
     in a repo with no `tsconfig.json` (it warns and runs anyway);
   - resume notes for the persistent-multitask archetype (re-running recovers
     `.orca/plan-*.md`).
3. *(optional)* **`.orca/workflows/<name>.sh`** — a thin POSIX wrapper that pins
   the backend and flags, for users who prefer `./<name>.sh` over the full
   `orca` command. It must call the `orca` binary, **never** a `package.json`
   script — the trigger must not depend on the target repo's package manager.

For a loop module, write:

1. **`.orca/loops/<name>.ts`** — the generated `defineLoop()` module.
2. **`.orca/loops/<name>.run.md`** — a runbook containing:
   - discovery: `orca loops`;
   - one-shot run: `ORCA_LOOP_EVENT='{}' orca run <name-or-path>`;
   - served run: `orca serve <name-or-path>`;
   - prerequisites for its `Source`, `Sink`, backend, and verification gates;
   - note that `ORCA_LOOP_EVENT` is the CLI/supervisor firing envelope; custom
     `Source` and `Sink` adapters should not read it directly;
   - state/resume notes if the loop uses `createSnapshotStore()` or `createSqliteStore()`.

Report the trigger command and hand off to `orca-ts-flow` to run and monitor it.
