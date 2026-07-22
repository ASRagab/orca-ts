## Context

The repository's three self-contained skills live only in the source
repository. The curated npm package deliberately excludes `skills/`, and the
current documentation installs them with `npx skills add ASRagab/orca-ts`.
The existing CLI parser recognizes only flow and loop commands, and its normal
dispatch performs typecheck and may initialize the standalone embedded fallback.
Neither behavior applies to an administrative skill installer.

## Goals / Non-Goals

**Goals:**

- Make the bundled skills discoverable and installable from `orcats`.
- Reuse the `skills` CLI for source retrieval, agent detection, placement,
  prompting, and overwrite policy.
- Preserve interactive terminal behavior, child output, and exit status.
- Keep the command independent of a target project, configured backend, and
  embedded runtime fallback.

**Non-Goals:**

- Reimplement skill installation, update, removal, or agent-directory layouts.
- Publish `skills/` in the npm package or embed it in release binaries.
- Add a persistent npm dependency, automatic Node installation, or a custom
  updater.
- Pin the skill source to the Orcats package version; the existing documented
  source remains the canonical repository default branch.

## Decisions

### Delegate to `npx skills`

`orcats skills` SHALL invoke `npx skills add ASRagab/orca-ts` rather than copy
or install skills itself. This preserves the existing documented trust and
placement model, avoids duplicated host-specific behavior, and keeps the npm
artifact allowlist unchanged.

Alternatives considered:

- A native installer would need to own per-agent directories, selection,
  overwrite behavior, and future installer compatibility.
- Shipping the skill directories in the npm package would expand the curated
  package payload but would still not solve cross-agent installation.

### Provide a small, allowlisted command surface

The command uses the following syntax:

```text
orcats skills [--list] [--skill <name>|--all] [--agent <name>] [--global] [--yes]
```

With no options, the delegated CLI owns interactive selection. `--list` maps to
the delegated discovery path. `--all` expands to the delegated wildcard skill
selection and cannot be combined with `--skill`. `--agent`, `--global`, and
`--yes` are forwarded only through explicit Orcats parsing. `--yes` makes both
the `npx` acquisition and the delegated install non-interactive. Invalid option
combinations or unexpected positional input fail before a child process starts.

An allowlist keeps the Orcats contract stable and prevents shell or arbitrary
argument forwarding from becoming a second, undocumented `skills` CLI surface.

### Execute as an administrative fast path

CLI dispatch handles the skills command after global help/version handling and
before typecheck, backend environment setup, and embedded fallback resolution.
It starts `npx` with an argument array and inherited standard streams, never a
shell. The parent returns the child's exit status. If `npx` is unavailable, it
prints an actionable prerequisite diagnostic and exits non-zero.

Alternatives considered:

- Routing through the normal flow/loop preflight would require unrelated project
  setup and could create fallback files before the installer starts.
- Capturing child output would break its interactive selection UI and obscure
  its diagnostics.

## Risks / Trade-offs

- [The `skills` CLI changes its flags or interaction] → Keep the bridge small,
  test its constructed argv, preserve the documented direct command as escape
  hatch, and update the mapping when its contract changes.
- [The user has a standalone Orcats binary but no Node/npm] → Detect missing
  `npx` before spawn and state that Node/npm is required for skill installation.
- [Repository-default skills drift from a released Orcats binary] → This matches
  the existing direct-install contract; defer version-pinned skill sources until
  the delegated CLI supports and the project needs that guarantee.
- [Non-interactive install writes to agent directories] → Require the caller to
  opt into `--yes`; otherwise preserve delegated confirmation/selection.

## Migration Plan

The change is additive. Existing `npx skills add ASRagab/orca-ts` commands keep
working unchanged. Release the command with documentation, run deterministic
CLI and documentation checks, and retain the direct command as a documented
fallback. Rollback is removal of the new command and its documentation; it does
not alter installed skills or package contents.

## Open Questions

None for the initial bridge. Version-pinned source selection is a future
compatibility decision, not a prerequisite for this change.
