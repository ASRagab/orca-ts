# Release Runbook

Releases are tag-driven. A `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies the repo and publishes GitHub Release binaries.

## One-time setup

1. Confirm the repository has GitHub Actions permission to create releases (`contents: write`).

## Per release

1. Bump `package.json.version` and `src/cli/version.ts` to the same plain semver value.
2. Run:

   ```bash
   bun run verify
   ```

3. Commit the release change.
4. Tag and push:

   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

5. Watch the Release workflow. It must produce:
   - GitHub Release `vX.Y.Z`
   - four tarballs: macOS arm64/x64 and Linux arm64/x64
   - `SHA256SUMS.txt`
   - `install.sh`

6. Spot-check the install path:

   ```bash
   ORCA_VERSION=X.Y.Z bash <(curl -fsSL https://github.com/ASRagab/orca-ts/releases/download/vX.Y.Z/install.sh)
   orca --version
   ```

## Failed release at 0.x

If a release workflow publishes bad GitHub assets, delete the GitHub release and tag, fix the issue, then re-tag the same version.

## Live backend smoke

Default CI stays deterministic and does not require backend credentials. Run live smoke separately from a configured machine:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```
