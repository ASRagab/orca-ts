---
title: Typecheck Troubleshooting
description: Understand the CLI preflight and zero-project fallback.
---

The CLI typechecks the current project before importing a flow when it can find:

- `typescript`
- `tsconfig.json`
- a local `@twelvehart/orcats` package dependency

If setup is missing, the standalone binary can skip the typecheck guard and warn:

```text
orcats: missing project typecheck setup; skipping typecheck.
```

For typed authoring, install the project dependencies:

```bash
npm i @twelvehart/orcats
npm i -D typescript
```

Use `--no-typecheck` only when you intentionally want to skip the preflight.
