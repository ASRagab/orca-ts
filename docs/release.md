# Release Checks

Release validation requires package metadata, Apache 2.0 license text, `NOTICE`, npm exports, CLI `bin`, and a build script for the Bun binary.

Run `bun run verify` before release. This gate covers typecheck, unit tests, fixture validation, release metadata, declarations, and binary smoke without requiring backend credentials.

Run the live smoke separately only in an environment configured for a real backend:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```
