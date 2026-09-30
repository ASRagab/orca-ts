## MODIFIED Requirements

### Requirement: Skill verifies at least one chosen backend is functional

The skill SHALL ask the user which of the supported backends (`claude`,
`codex`, `opencode`, `pi`) to enable. For each chosen backend it SHALL report
CLI presence, static authentication evidence, selected transport, and
transport readiness as separate results. A backend SHALL be called `usable`
only after a successful readiness turn over the selected transport. Static
presence, version, or authentication checks alone SHALL NOT establish
usability. When no safe non-spending check can prove authentication or
transport readiness, the skill SHALL report the backend as `unverified` until
the user opts into the gated live smoke. Setup SHALL NOT complete until at
least one chosen backend is transport-proven usable.

#### Scenario: User selects a backend to enable

- **WHEN** the skill starts backend verification
- **THEN** it asks the user which supported backend(s) to enable before probing

#### Scenario: Static checks do not prove usability

- **WHEN** a chosen backend CLI is present and its available static auth check succeeds
- **THEN** the skill reports the presence and authentication evidence separately
- **THEN** it does not call that backend usable without a successful readiness turn over the selected transport

#### Scenario: Selected Claude transport is checked

- **WHEN** the user selects Claude
- **THEN** the skill reports whether `stream-json` or `acp` is selected
- **THEN** its readiness probe exercises that selected transport rather than a different Claude transport

#### Scenario: A chosen backend is functional

- **WHEN** a chosen backend completes the gated readiness turn over its selected transport
- **THEN** the skill marks that backend usable and records the backend tag and transport

#### Scenario: Auth cannot be cheaply proven

- **WHEN** a chosen backend passes its static checks but has no safe non-spending probe that proves authentication and selected-transport readiness
- **THEN** the skill marks that backend `unverified`, explains the missing proof, and offers the gated live smoke

#### Scenario: No chosen backend is functional

- **WHEN** every chosen backend is `missing`, `unauth`, `misconfig`, or `unverified`
- **THEN** the skill reports failure with the per-backend evidence and does not declare setup complete

#### Scenario: Optional live smoke is gated

- **WHEN** transport readiness requires a live backend turn
- **THEN** the skill runs it only after explicit user opt-in through the documented environment gate
- **THEN** declining the smoke leaves that backend unverified rather than usable
