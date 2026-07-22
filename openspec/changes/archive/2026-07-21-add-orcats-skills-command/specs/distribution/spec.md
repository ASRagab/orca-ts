## ADDED Requirements

### Requirement: Package and binary delegate Agent Skills installation
The npm package and standalone Orcats binary SHALL expose the same delegated
`orcats skills` command while keeping skill payloads outside their curated
distribution artifacts.

#### Scenario: Installed package runs the skills command
- **WHEN** a user invokes `orcats skills` through an installed
  `@twelvehart/orcats` package
- **THEN** the CLI delegates the command to the canonical skills repository
  without requiring `skills/` to be present in the npm package

#### Scenario: Standalone binary runs the skills command
- **WHEN** a user invokes `orcats skills` through a standalone Orcats binary
- **THEN** the command delegates to the canonical skills repository without
  initializing the embedded runtime fallback

#### Scenario: Package artifact remains curated
- **WHEN** package artifact validation inspects a release tarball after this
  change
- **THEN** the existing runtime-only package allowlist remains unchanged and
  does not include bundled skill directories
