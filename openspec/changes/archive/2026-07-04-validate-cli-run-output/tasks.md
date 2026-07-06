## 1. Process Capture Harness

- [x] 1.1 Add a reusable CLI process runner for tests that captures stdout, stderr, exit code, signal, duration, command metadata, and timeout state.
- [x] 1.2 Add timeout handling that sends a graceful signal first, falls back to a forced kill, and reports captured evidence on failure.
- [x] 1.3 Add stream assertion helpers that verify Orca diagnostics stay off stdout and expected progress categories appear on stderr.
- [x] 1.4 Add lifecycle assertion helpers for coarse ordering of preflight, run start, progress, payload, and final summary evidence.

## 2. Repo Health Loop Fixture

- [x] 2.1 Add a deterministic disposable target repo fixture for automated validation, including package scripts that are safe to run in CI.
- [x] 2.2 Add a read-only repo health loop fixture that accepts a target repo path and emits a concise structured or delimited health report through stdout.
- [x] 2.3 Ensure the repo health loop reports meaningful progress through shared run-output events while keeping payload output on stdout.
- [x] 2.4 Add before/after git-status checks proving the repo health loop does not mutate a git target.

## 3. Run Command Validation

- [x] 3.1 Add an `orca run` black-box test for stdout sink payload separation and stderr progress diagnostics.
- [x] 3.2 Add an `orca run` black-box test for the repo health loop against the disposable target repo.
- [x] 3.3 Add a failing assertion or failing process fixture test proving captured stdout, stderr, exit code, duration, and signal are exposed as failure evidence.

## 4. Serve Lifecycle Validation

- [x] 4.1 Add a bounded served-loop fixture or source adapter that fires one deterministic child event without requiring live external services.
- [x] 4.2 Add an `orca serve` test that captures supervisor startup, child firing payload on stdout, child diagnostics on stderr, and clean SIGINT shutdown.
- [x] 4.3 Add a hung-process validation test proving the harness times out, terminates the process, and leaves no running child process.

## 5. Dogfood Documentation

- [x] 5.1 Document the manual dogfood command for selecting a real local repo path without hard-coding machine-specific paths in tests.
- [x] 5.2 Document expected stdout, stderr, exit-code, timeout, and lifecycle evidence for interpreting validation results.
- [x] 5.3 Include guidance for running against the known local candidate `cursor-agents-sdk-ts` when it exists, while keeping CI portable.

## 6. Verification

- [x] 6.1 Run focused tests for the CLI process harness, repo health loop fixture, `orca run`, and `orca serve` lifecycle behavior.
- [x] 6.2 Run documentation checks affected by the dogfood guide updates.
- [x] 6.3 Run `openspec validate "validate-cli-run-output" --type change --strict`.
- [x] 6.4 Run the repository verification gate before marking implementation complete.
