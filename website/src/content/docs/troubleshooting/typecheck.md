---
title: Typecheck Troubleshooting
description: Understand the CLI preflight and zero-project fallback.
---

The CLI typechecks the current project before importing a flow when it can find:

- `typescript`
- `tsconfig.json`
- a local `@twelvehart/orca-ts` package dependency

If setup is missing, the standalone binary can skip the typecheck guard and warn:

```text
orca: missing project typecheck setup; skipping typecheck.
```

For typed authoring, install the project dependencies:

```bash
bun add -d @twelvehart/orca-ts typescript
```

Use `--no-typecheck` only when you intentionally want to skip the preflight.
