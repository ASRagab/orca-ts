## Context

The `unify-cli-run-output` change introduced a shared reporter and presenter for
flow and loop progress. Unit and integration tests verify the event model,
presenter formatting, flow context propagation, loop cycle reporting, and basic
CLI stream separation. The remaining confidence gap is operational: a user runs
the CLI as a process, a monitor captures stdout and stderr, a useful loop emits
payload output, and `orca serve` starts, supervises children, and shuts down
without leaving a process behind.

This validation should dogfood Orca without adding nondeterminism. Automated
coverage must be portable and should not depend on live backend credentials or a
specific developer's local repositories. Manual dogfood can use a real local
repo selected by the operator, such as the already-identified
`cursor-agents-sdk-ts` checkout on this machine.

## Goals / Non-Goals

**Goals:**

- Validate `orca run` and `orca serve` as black-box child processes with stdout
  and stderr captured independently.
- Exercise a useful, read-only repo health loop that emits a concise payload
  report to stdout while progress remains on stderr.
- Monitor process lifecycle evidence: start, progress, completion, timeout,
  graceful shutdown, and kill fallback.
- Keep automated tests deterministic, portable, and free of live-agent calls.
- Provide a manual dogfood command path for running the same validation against
  a real repo on disk.

**Non-Goals:**

- Do not change the run-output event model or presenter semantics as part of
  this validation change.
- Do not hard-code a developer-specific repo path in committed tests.
- Do not require real Codex/Claude/OpenCode/Pi runs.
- Do not mutate, branch, commit, push, or clean the selected target repo.
- Do not replace focused unit tests for the reporter, presenter, monitor, or
  loop APIs.

## Decisions

### D1. Validate through a process harness, not direct API calls

Add a small test harness that launches the Orca CLI with stdout and stderr
piped. It should capture stream chunks, final stream text, exit code, duration,
and termination signal. Assertions then inspect the same evidence an operator or
external monitor would have.

Alternative considered: call `main()` or `runLoopFiring()` directly. That is
useful for unit coverage but misses shell stream behavior, child-process
lifecycle, and `serve` supervision.

### D2. Use deterministic repo-health loops

Create a read-only loop fixture that runs deterministic shell checks and returns
a short health report through `stdout()` or an injected equivalent. The loop
should be productive enough to reveal real status, for example package scripts,
git dirtiness, typecheck/test outcomes, and selected warnings, while still being
safe for arbitrary repositories.

Alternative considered: use a live coding-agent loop. That better matches the
eventual product feel, but it introduces credentials, cost, latency, and
non-deterministic output into the validation gate.

### D3. Separate automated fixture coverage from manual dogfood

Automated tests should create disposable fixture repos or use repo-local
examples so CI is portable. Manual dogfood should accept a target path through
an environment variable or CLI argument and may document a known local candidate
for this machine. The same harness shape should support both modes.

Alternative considered: depend directly on `/Users/aragab/Dev/repos/...` in
tests. That would validate one workstation but fail for other contributors and
CI.

### D4. Treat stream discipline as a first-class assertion

The harness should assert that stdout contains only the loop payload and stderr
contains lifecycle/progress lines. It should also assert ordering at a coarse
level: preflight, run start, stage or cycle progress, payload emission, final
summary. This catches regressions where diagnostic output leaks into stdout or
where output is too sparse to monitor.

Alternative considered: snapshot the full terminal transcript. Full snapshots
are brittle because durations, paths, and failure text can vary. Structured
matchers around categories and stream boundaries provide better signal.

### D5. Test `serve` lifecycle with bounded children

For `orca serve`, use a source that fires a bounded event or a temporary watched
path so the supervisor launches a child and the harness can observe inherited
child output. The harness must stop the supervisor with SIGINT, wait for a clean
exit, and fall back to SIGKILL if the process ignores shutdown.

Alternative considered: only test `orca run`. That proves the presenter path but
does not validate the operational surface most likely to expose lifecycle bugs.

## Risks / Trade-offs

- Flaky filesystem watch behavior -> Prefer an explicitly bounded test source
  where possible; if using `watch`, allow a short timeout and assert cleanup.
- Harness hides useful failure evidence -> Include captured stdout, stderr,
  exit code, duration, and termination signal in assertion errors.
- Productive loop becomes too specific -> Keep the loop read-only and script
  driven; make checks configurable and tolerate absent scripts.
- Diagnostics change wording -> Match stable categories and stream placement
  rather than every character of every line.
- Manual dogfood mutates a real repo -> Run only read-only commands and verify
  git status before/after when the target repo is a git checkout.

## Migration Plan

1. Add the process capture harness and focused tests around existing repo-local
   loop examples.
2. Add the read-only repo-health loop fixture and run it against a disposable
   fixture repo in automated tests.
3. Add `serve` lifecycle coverage with bounded child execution and shutdown
   assertions.
4. Add manual dogfood documentation for running the validation against a real
   local repo path.

No runtime migration is required; this change adds validation and documentation.
