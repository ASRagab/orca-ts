## ADDED Requirements

### Requirement: cleanupFile reverts a non-converging change
When a post-edit change cannot be made to pass the targeted gate within the repair loop's convergence guards, `cleanupFile()` SHALL restore the affected files to their pre-attempt state before returning a `regressed` verdict. The working tree SHALL NOT appear dirty for those files after the function returns. This extends the existing restore-on-agent-error behavior to the case where the agent completes without throwing but leaves the gate red and the repair loop exhausts its convergence guards.

#### Scenario: Repair loop exhausts guards and the change is reverted
- **WHEN** the post-edit gate is red and the repair loop stops on a no-progress, wall-clock, or ceiling guard without reaching green
- **THEN** `cleanupFile()` restores the affected files to their pre-attempt content
- **THEN** `git status --short` shows no dirty entry for those files
- **THEN** `cleanupFile()` returns a `regressed` verdict carrying the guard reason

#### Scenario: Converged change is kept
- **WHEN** the repair loop reaches a green gate after one or more iterations
- **THEN** the change is retained and `cleanupFile()` returns a `repaired` verdict carrying the iteration count
