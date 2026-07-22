## ADDED Requirements

### Requirement: Agent Skills CLI installation is documented
The README, in-repo documentation, and documentation website SHALL document
`orcats skills` as the preferred convenience path while retaining the direct
`npx skills add ASRagab/orca-ts` command as the equivalent fallback.

#### Scenario: User installs skills interactively
- **WHEN** a user reads Agent Skills installation guidance
- **THEN** the guidance shows `orcats skills`, explains that the delegated
  installer owns interactive selection, and states that `npx` is required

#### Scenario: User needs explicit installation control
- **WHEN** a user reads Agent Skills installation guidance for a chosen skill,
  agent, scope, or non-interactive run
- **THEN** the guidance documents the supported Orcats options and their direct
  `npx skills` equivalent

#### Scenario: Documentation is verified
- **WHEN** documentation verification runs
- **THEN** the README, in-repo guide, and website pages link to valid supported
  Agent Skills installation guidance without requiring an external installer run
