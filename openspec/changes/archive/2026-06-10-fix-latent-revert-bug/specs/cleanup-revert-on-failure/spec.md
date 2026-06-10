## ADDED Requirements

### Requirement: cleanupFile restores file on agent error
When `askAgentForCleanup` throws after editing the target file, `cleanupFile()` SHALL restore the file to its pre-attempt state before returning a skipped result. The file SHALL NOT appear dirty in `git status` after the function returns.

#### Scenario: Agent throws after editing file
- **WHEN** `askAgentForCleanup` edits the target file and then throws an error
- **THEN** `cleanupFile()` restores the file to its original content
- **THEN** `git status --short` shows no dirty entry for the target file
- **THEN** `cleanupFile()` returns a skipped result (not an error)

#### Scenario: Agent throws without editing file
- **WHEN** `askAgentForCleanup` throws before making any edits
- **THEN** `cleanupFile()` returns a skipped result
- **THEN** the target file is unchanged
