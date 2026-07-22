---
title: Agent Skills
description: Install the bundled Orca skills for setup, authoring, and running flows.
---

The repository ships three host-agnostic Agent Skills:

| Skill | Purpose |
| --- | --- |
| `orcats-setup` | Install or verify the `orcats` CLI and verify at least one backend. |
| `orcats-author` | Generate a saved, verification-gated workflow or loop module. |
| `orcats-flow` | Run, monitor, diagnose, and heal a saved workflow or loop. |

The intended sequence is:

```text
orcats-setup -> orcats-author -> orcats-flow
```

## Install from GitHub

`orcats skills` is the preferred convenience command. It requires `npx` from a
Node.js/npm installation and delegates source retrieval, agent detection,
destination, prompts, and overwrite policy to the `skills` CLI.

```bash
# Let the delegated installer choose skills and scope interactively.
orcats skills

# List available skills without installing.
orcats skills --list

# Install every skill globally without prompts.
orcats skills --all --global --yes
```

Install one skill to one agent:

```bash
orcats skills --skill orcats-setup --agent claude-code
```

The command supports `--list`, `--skill <name>`, `--all`, `--agent <name>`,
`--global`, and `--yes`. `--all` and `--skill` cannot be combined. Without a
selection option, the delegated installer stays interactive.

## Direct installer fallback

Orcats does not implement agent-directory installation or package the skills in
npm artifacts. The equivalent direct commands remain available:

```bash
npx skills add ASRagab/orca-ts --list
npx skills add ASRagab/orca-ts --skill orcats-setup --agent claude-code
npx --yes skills add ASRagab/orca-ts --skill '*' --global --yes
```

Before the repository is public, use a local checkout with the direct installer:

```bash
git clone https://github.com/ASRagab/orca-ts.git
npx skills add ./orca-ts --skill '*' --global
```

Each skill is self-contained. Its `SKILL.md`, `scripts/`, references, and templates are installed together.

Generated mutating artifacts default to baseline policy `repair`. Use
`--baseline=strict`, `--baseline=accept-dirty`, or `ORCA_BASELINE_POLICY` only
when you want to override that per run.
