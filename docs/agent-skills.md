# Agent Skills

Orcats ships three self-contained Agent Skills in the source repository:
`orcats-setup`, `orcats-author`, and `orcats-flow`. Install them with
`orcats skills`; it requires `npx` from a Node.js/npm installation.

```bash
# Let the delegated installer select skills and destination interactively.
orcats skills

# List the available skills without installing.
orcats skills --list

# Install one skill for one agent.
orcats skills --skill orcats-setup --agent claude-code

# Install every skill globally without prompts.
orcats skills --all --global --yes
```

`--all` and `--skill <name>` are mutually exclusive. `--global` selects
user-level installation; without it, the delegated installer uses project
scope. `--yes` confirms both `npx` acquisition and the delegated install.

## Direct installer fallback

`orcats skills` is a fixed, thin bridge to `npx skills add ASRagab/orca-ts`.
The `skills` CLI owns agent detection, skill placement, selection prompts, and
overwrite policy. Use it directly when you need a local source checkout or
another installer feature:

```bash
npx skills add ASRagab/orca-ts --list
npx skills add ASRagab/orca-ts --skill orcats-setup --agent claude-code
npx --yes skills add ASRagab/orca-ts --skill '*' --global --yes

# Before the repository is public, use a local checkout.
npx skills add ./orca-ts --skill '*' --global
```

The npm package and standalone binary do not contain the `skills/` directories.
They always delegate to the canonical `ASRagab/orca-ts` repository, so Node/npm
is the only extra prerequisite for this administrative command.
