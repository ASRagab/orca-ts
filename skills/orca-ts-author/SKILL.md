---
name: orca-ts-author
description: "Turn a workflow idea into a saved, self-validating Orca TypeScript flow for ANY git-backed repo (not just TS projects). Reads the target repo to detect its real test/lint/build commands, interviews the user to fix the workflow shape, generates a flow from a bundled template that typechecks, ENFORCES verification gates (at minimum tests + linters) so a vibe becomes a productized workflow, and saves it to .orca/workflows/<name>.ts with a runbook. Use after orca-ts-setup, when someone wants to create or productize an agentic coding workflow. Triggers on \"create an orca workflow\", \"author an orca flow\", \"productize this workflow\", \"orca workflow for <task>\", \"make a saveable orca workflow\"."
compatibility: "Host-agnostic (uses AskUserQuestion on Claude Code, one-question-at-a-time elsewhere) and stack-agnostic (target repo can be Python/Go/Rust/Scala/anything git-backed). Generated flows are TypeScript that the `orca` binary runs; the repo they operate on need not be TypeScript. Author from reference/, in order: recipes.md, dsl.md, gotchas.md, backends.md."
metadata:
  author: "Ahmad Ragab"
---

# orca-ts-author — author a verification-gated Orca workflow

A "vibe" is a one-off prompt. A **productized workflow** is a saved flow that
re-runs the same shape and **gates its own output** on the target repo's real
tests and linters. This skill produces the latter, for any git-backed repo.

Flow: **read the repo → interview → generate from a template → enforce
verification gates → typecheck (when reachable) → save to `.orca/workflows/`.**

> Author from the shared cookbook, in this order: `skills/_shared/reference/recipes.md`
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
If the user says "defaults", jump to the persistent-multitask archetype with the
detected gates slotted in.

**Host-agnostic asking:** on Claude Code use `AskUserQuestion` (structured
chips); on any other host ask **one question at a time**, show the default, and
accept a bare answer. Never dump all axes at once.

| Axis | Ask | Default |
|---|---|---|
| **Archetype** | single-change · persistent-multitask · issue-to-pr · bugfix · cleanup-sweep · multi-backend-compare | persistent-multitask |
| **Backend** | which verified backend implements (and any per-backend model) | the one `orca-ts-setup` verified |
| **Input** | ad-hoc objective · CLI task arg · GitHub issue ref · file set | per archetype |
| **Verification gate** | which detected test + lint (+ optional build/format) commands | the detected test + lint |
| **Delivery** (issue-to-pr) | commit · push · open PR; base branch | open PR against `main` |
| **Scope** (cleanup-sweep) | the `git ls-files` pathspec; the per-file edit brief | confirm explicitly |

## 3. Generate from a template

1. Pick the archetype's template (`recipes.md` → table). Copy it as the skeleton.
2. Fill every labelled `REPLACE_WITH_*` slot from the interview:
   - `selectBackend({ default })` tag = the verified backend;
   - the `GATE` array = the **confirmed target-repo commands** (`command` + `args`);
   - the prompt/objective/title/pathspec for the archetype.
3. Apply every `gotchas.md` rule as you fill: import from `"orca-ts"`; narrow
   `outcome.type`; `selected.shutdown?.()` in a `finally`; `fixLoop` issues carry
   `fixable`; a `stalled` detector is supplied; Zod tolerant for pi/OpenCode.

## 4. Typecheck the flow (when a TS toolchain is reachable)

```bash
bash skills/_shared/scripts/orca-typecheck-flow.sh .orca/workflows/<name>.ts
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

Every authored workflow MUST carry, wired into its per-task/per-file loop, **at
least one test gate and one lint gate** (the confirmed target-repo commands). A
gate failure must drive repair or be reported — never silently ignored.

If no verification command was detected **and** the user declines to supply any,
**refuse to emit the workflow** and explain that a gate is what turns a vibe into
a productized workflow. Do not save an ungated flow.

## 6. Save — stack-agnostic and re-runnable

Confirm the target directory (default: the user's current repo root, so the
flow's `git`/`gh` tools act on the right repo) **before writing**. Then write:

1. **`.orca/workflows/<name>.ts`** — the generated flow.
2. **`.orca/workflows/<name>.run.md`** — a runbook containing:
   - the exact trigger: `orca .orca/workflows/<name>.ts --backend <tag> [-- "<args>"]`
     (or via `bash skills/_shared/scripts/orca-run.sh .orca/workflows/<name>.ts ...`);
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

Report the trigger command and hand off to `orca-ts-flow` to run and monitor it.
