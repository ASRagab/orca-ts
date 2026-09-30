## Context

The source report covers a successful, safety-preserving workflow whose first
two launches failed before producing useful work. Current code confirms the
causes remain present: Claude defaults to ACP, packaged entry points do not
shield the runtime from `BUN_OPTIONS`, target-repository typechecking skips when
local TypeScript setup is absent, and monitor files have no terminal lifecycle
contract. The packaged doctor already has an opt-in live smoke, but setup can
declare weaker static checks sufficient.

This change crosses the CLI, backend adapter, monitor, release packaging, three
self-contained skills, and two documentation surfaces. It must preserve the
zero-target-dependency standalone path, deterministic credential-free CI, the
backend-neutral conversation API, committable `.orca/workflows/` and
`.orca/loops/`, and the workflow's demonstrated no-op and repository-safety
behavior.

## Goals / Non-Goals

**Goals:**

- Make the default Claude path reliable on the consumer environment represented
  by the report while retaining ACP for explicit testing and use.
- Ensure ambient Bun preload configuration cannot enter the actual Orcats
  runtime from supported package, release, or source-checkout launchers.
- Typecheck an individual workflow or loop offline in repositories with no
  TypeScript project or Orcats dependency.
- Make ordinary terminal failures self-describing in both CLI diagnostics and
  final monitor JSON.
- Require a real selected-transport round trip before setup calls a backend
  usable.
- Keep runtime scratch out of commits without ignoring saved workflow or loop
  source.
- Keep skills, generated runbooks, CLI help, README, in-repo docs, and website
  reference accurate through deterministic checks.

**Non-Goals:**

- Do not remove ACP, add backend tags, or change the `Conversation` contract.
- Do not automatically retry a prompt on another transport; a prompt may have
  caused side effects before its first observable update.
- Do not add a generic structured-JSON repair engine, monitoring latest pointer,
  or new timeout environment variables without a failing use case that needs
  them. Existing constructor timeout options remain supported.
- Do not make default CI spend tokens or require installed live backends.
- Do not ignore all of `.orca/`; saved workflows and loop modules remain normal
  repository content.

## Decisions

### Decision: Restore stream-json as Claude's default; keep ACP explicit

`claude()` and `selectBackend()` will use `stream-json` when no transport is
selected. `claude({ transport: "acp" })` and
`ORCA_CLAUDE_TRANSPORT=acp` retain the ACP path. Documentation will explain that
ACP remains opt-in pending compatibility proof against currently installed
Claude/adapter versions.

This supersedes the previous ACP-default decision. Its benchmark showed a speed
advantage under the tested versions, but the first independent consumer run
showed a deterministic two-minute stall while stream-json completed in about
twenty seconds. Reliability of the default outranks the measured speedup.

Automatic ACP-to-stream-json fallback was rejected because absence of an ACP
update does not prove the prompt had no side effects. Merely shortening the ACP
watchdog was rejected because it would fail sooner without making the default
work.

### Decision: Put a POSIX launcher in front of every supported Bun runtime

The source-checkout and npm `bin/orcats` entry and each macOS/Linux release
archive will expose a small POSIX `orcats` launcher that unsets `BUN_OPTIONS`
and `exec`s the actual runtime. Release archives will carry the compiled runtime
under a private adjacent name plus the `checker/` assets; the source/npm launcher
will invoke Bun on the CLI source. Checksums cover the complete archive, and
installation copies checker assets before activating the launcher/runtime pair.
Direct `bun src/cli/main.ts` remains a contributor-only
path and is outside the supported consumer launcher contract.

Application-side cleanup was rejected because Bun evaluates `--preload` before
application code. The launcher is the earliest supported boundary at which the
environment can be sanitized. Direct execution of the private runtime is not a
supported user entry point.

### Decision: Add one offline artifact checker and use it everywhere

`orcats check <workflow-or-loop.ts>` will create an isolated temporary compiler
project using the original artifact as its program root, preserving sibling
imports. It resolves the checker payload under `dist/checker/`: the TypeScript
compiler runtime, required standard-library
files, and generated declarations for supported public Orcats entry points. It
will perform no network access, never read or write the target repository's
package-manager state, and remove its temporary directory on success or failure.

Normal CLI preflight will check the selected artifact directly instead of
running the target repository's project-wide `tsc`. Named-loop discovery checks
each discovered module before importing it, independent of its filename.
`--no-typecheck` remains an
explicit escape hatch. `orcats-author` will call the same command and will no
longer accept a skipped check in a non-TypeScript repository.

Reusing target `tsc`, synthesizing a project inside the repository, and using
`npx` were rejected because they recreate the reported language-stack coupling,
leave scratch, or require network/package policy. Bundling the compiler costs
binary/package size. `scripts/release-size-baselines.json` will record numeric
compressed and installed baselines plus fixed maxima. Each maximum SHALL be no
more than 110% of its measured baseline, rounded up to the next KiB; validation
fails missing fields, a larger allowance, or an artifact above its maximum.
Updating a baseline requires a non-empty rationale in the same manifest.

### Decision: Finalize monitor logs explicitly on both terminal paths

`WorkflowMonitor` will gain an idempotent terminal finalization operation. A
successful finalization records `status: "succeeded"` and `endedAt`; a failed
finalization additionally records the active/failed stage and normalized
terminal error. Backend and selected transport are stable run metadata. The
generated monitored templates will finalize in `try`/`catch` and write exactly
one atomic final JSON file before returning or rethrowing.

Final JSON remains a durable post-run summary, not a live event stream. Live
monitoring continues through stderr reporter/heartbeats, persistent plan or loop
state, and Git progress. This avoids a new continuously rewritten file protocol
while fixing the report's ambiguous ordinary failure path. Abrupt process death
can still leave no final JSON and is diagnosed from the process/log.

### Decision: Separate static readiness from transport proof

The shared doctor script will resolve the effective backend transport first and
name it in every result. Static checks verify the exact required executable and
any definitive auth status; they produce `unverified`, not `ready`. A bounded
one-turn smoke through the installed `orcats` entry point promotes the selected
backend/transport to `ready`.

Because the smoke spends a small number of tokens, the skill must ask before
running it. If the operator declines, setup reports the backend as unverified
and does not claim setup complete. Script copies remain byte-identical across
skills and gain behavior tests with stubbed executables.

### Decision: Use one canonical runtime-scratch pattern set

Authoring will add only runtime-generated patterns to the repository-local
exclude file located by `git rev-parse --git-path info/exclude`. It preserves
existing content and supports linked worktrees. Generated commit staging uses
the same patterns as explicit negative pathspecs, providing protection even if
an exclude file is missing or temporarily changed. Workflow/loop source and
runbooks are deliberately absent from the scratch set.

The checker, templates, authoring reference, and tests will share one declared
pattern set so ignore and staging behavior cannot drift.

### Decision: Verify one documented environment inventory

Public docs will contain a canonical table of supported operator-facing
`ORCA_*` variables, including backend/transport, baseline, monitoring, loop,
installer, and gated-smoke settings. A deterministic checker will scan runtime
and packaged scripts, compare discovered names with a small classification
manifest, and require every public or diagnostic variable on both documentation
surfaces. Internal test/handshake variables remain explicitly classified and
are not presented as user controls.

This replaces the current four-name hardcoded docs check and avoids treating
the deprecation warning code as an environment variable.

## Risks / Trade-offs

- **ACP speed benefit is no longer default** → preserve explicit selection and
  gated live benchmarks so it can be promoted again with compatibility data.
- **Launcher can be bypassed** → keep the runtime filename private, document
  only `orcats`, and exercise installed/package entry points in smoke tests.
- **Bundled TypeScript increases artifacts** → enforce release/package size
  budgets and include only checker inputs needed for public Orcats artifacts.
- **Checker differs from a consumer's full project** → check only the artifact
  contract against Orcats declarations; target repository gates still validate
  business code separately.
- **Terminal monitor finalization is cooperative** → generated templates and
  skills own the contract; abrupt termination remains identifiable by missing
  terminal JSON plus process/log state.
- **Required live readiness has token cost** → make cost explicit, bounded, and
  consent-gated; never run it in default CI.
- **Scratch list can miss a new runtime artifact** → centralize the list and add
  a test whenever a new persisted runtime path is introduced.

## Migration Plan

1. Add the launch wrapper and poisoned-`BUN_OPTIONS` package/release smoke before
   changing other runtime behavior.
2. Add `orcats check`, switch preflight and authoring to it, and retain
   `--no-typecheck` for explicit emergency bypass.
3. Restore stream-json default, improve transport-aware diagnostics, and run
   deterministic tests plus gated live smoke for stream-json and explicit ACP.
4. Add monitor finalization and migrate bundled monitored templates.
5. Update doctor behavior, scratch isolation, all skill copies/templates, and
   behavior tests.
6. Update CLI help, README, in-repo docs, website content, environment inventory,
   and documentation checkers.
7. Run focused tests, package/release smokes, docs gates, `bun run verify`, and a
   clean non-TypeScript consumer rehearsal matching the source report.

Rollback keeps artifacts readable: select ACP explicitly if stream-json
regresses, use `--no-typecheck` only for an acknowledged checker blocker, and
retain compatibility parsing for monitor logs that predate terminal fields.

## Open Questions

- Which installed Claude and `claude-agent-acp` version pairs are sufficient to
  reconsider ACP as the default?
