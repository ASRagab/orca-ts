# Release Runbook

Releases are tag-driven. A `vX.Y.Z` tag runs `.github/workflows/release.yml`, which verifies the repo, publishes GitHub Release binaries, and publishes `@twelvehart/orca-ts` to npm through Trusted Publishing.

## One-time setup

1. Confirm the repository has GitHub Actions permission to create releases (`contents: write`).
2. Make the canonical repository public before the first npm publish if provenance is required for the release. npm provenance ties the package to public source metadata.
3. Configure npm Trusted Publishing for package `@twelvehart/orca-ts`, repository `ASRagab/orca-ts`, and workflow file `release.yml`. Dry-run the CLI setup first:

   ```bash
   npm trust github @twelvehart/orca-ts \
     --repo ASRagab/orca-ts \
     --file release.yml \
     --allow-publish \
     --dry-run
   ```

   If the CLI setup is unavailable for the org account, configure the same trust relationship in the npm web UI. Do not add `NPM_TOKEN` or another long-lived publish token to GitHub Actions.

## Per release

1. Bump `package.json.version` and `src/cli/version.ts` to the same plain semver value.
2. Run:

   ```bash
   bun run verify
   bun run smoke:package
   ```

3. Commit and push the release change, then confirm CI is green on `main`.
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
   - npm package `@twelvehart/orca-ts@X.Y.Z`

6. Spot-check the GitHub Release install path:

   ```bash
   ORCA_VERSION=X.Y.Z bash <(curl -fsSL https://github.com/ASRagab/orca-ts/releases/download/vX.Y.Z/install.sh)
   orca --version
   ```

7. Spot-check the npm package:

   ```bash
   npm view @twelvehart/orca-ts@X.Y.Z version
   bunx -p @twelvehart/orca-ts@X.Y.Z orca --version
   ```

## Failed release at 0.x

If a release workflow publishes bad GitHub assets before npm publishes, delete the GitHub release and tag, fix the issue, then re-tag the same version.

If npm publishes a bad package, the version cannot be reused. Deprecate the bad package version, fix forward with the next patch version, and replace or delete any bad GitHub Release assets.

## Live backend smoke

Default CI stays deterministic and does not require backend credentials. Run live smoke separately from a configured machine:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```
