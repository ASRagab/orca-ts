## Purpose

Define the shared configuration type and prompt-composition utility common to all subprocess backend adapters in Orcats.

## Requirements

### Requirement: SharedBackendConfig captures the common subprocess adapter fields
`SharedBackendConfig<Output>` SHALL declare exactly the fields shared by all subprocess backend adapters: `model`, `systemPrompt`, `readOnly`, `selfManagedGit`, `retryAttempts`, `schema`, `resumeSessionId`. All fields SHALL be optional. Backend-specific fields (e.g. `approvalPolicy` for codex) SHALL NOT appear in this type.

#### Scenario: Claude resolved config satisfies SharedBackendConfig
- **WHEN** `ResolvedClaudeConfig<Output>` is structurally checked against `SharedBackendConfig<Output>`
- **THEN** it is assignable without cast

#### Scenario: Codex resolved config satisfies SharedBackendConfig
- **WHEN** `ResolvedCodexConfig<Output>` is structurally checked against `SharedBackendConfig<Output>`
- **THEN** it is assignable without cast

### Requirement: composeBackendPrompt assembles prompt from shared config
`composeBackendPrompt(prompt, config)` SHALL return a string that prepends non-empty config sections (system instructions, git policy, retry policy) to `prompt`, separated by blank lines, in that order. Sections SHALL be omitted when the corresponding config field is absent or the condition does not apply. `selfManagedGit === false` SHALL include the git-ownership policy line. `selfManagedGit` absent or `true` SHALL omit it.

#### Scenario: All sections present
- **WHEN** config has `systemPrompt`, `selfManagedGit: false`, and `retryAttempts: 3`
- **THEN** result starts with `"System instructions:\n<systemPrompt>"`, contains the git policy line, contains `"Retry policy: maximum attempts 3"`, ends with `prompt`

#### Scenario: No sections apply
- **WHEN** config has no `systemPrompt`, `selfManagedGit` is absent, and `retryAttempts` is absent
- **THEN** result equals `prompt` exactly

#### Scenario: selfManagedGit true suppresses git policy
- **WHEN** config has `selfManagedGit: true`
- **THEN** result does NOT contain the git-ownership policy text

#### Scenario: Pure function — same inputs produce same output
- **WHEN** `composeBackendPrompt` is called twice with identical arguments
- **THEN** both calls return the same string
