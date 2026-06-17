## ADDED Requirements

### Requirement: The loop builder lowers onto the flow runtime
The system SHALL implement `loop()` by lowering it onto `flow()`, reusing the existing dependency-injected runtime accessors. The loop builder SHALL NOT introduce a parallel public runtime.

#### Scenario: Loop accessors resolve from flow context
- **WHEN** a step inside a `loop()` calls a runtime accessor (`fs`/`git`/`llm`/…)
- **THEN** it resolves from the same flow context, including any test overrides supplied to the run

### Requirement: The execution engine is Effect-powered behind an Effect-free facade
The system SHALL implement the internal loop engine (scheduling, bounded concurrency, structured cancellation) with Effect, while keeping the public API and the flow-authoring surface free of any Effect type. The boundary SHALL bridge to neverthrow `Result`/plain values. Internal dependency injection MAY use Effect `Layer`, provided the authoring accessors remain plain functions exposing no Effect type.

#### Scenario: Public call returns a Result, not an Effect
- **WHEN** a loop is invoked through the public API
- **THEN** it returns a neverthrow `Result` (or plain value), and no Effect type appears in the public signature

#### Scenario: Structured cancellation interrupts in-flight branches
- **WHEN** a loop run is cancelled while fan-out branches are in flight
- **THEN** the engine interrupts the outstanding branches via structured concurrency and returns a cancelled outcome

### Requirement: A facade gate forbids Effect types in the authoring surface
The system SHALL enforce, via a type-test/lint check in the verification gate, that no Effect type appears in public runtime signatures or flow-authoring files. The gate SHALL scan generated declarations for the root runtime export (`orca-ts`) and the explicit loop export surface, plus authored flow files used by examples/tests (`examples/**/*.ts` and `.orca/workflows/**/*.ts`). Internal engine files under `src/loop/engine/**` MAY reference Effect. Testing helpers MAY expose fakes and assertions but SHALL NOT require ordinary loop tests to import Effect.

#### Scenario: Effect leak fails verification
- **WHEN** a root runtime signature, loop export signature, example flow, or `.orca/workflows` flow references an Effect type
- **THEN** the facade gate fails the `verify` run with an error identifying the leak

#### Scenario: Clean surface passes the gate
- **WHEN** the scanned public declarations and flow files expose only `Result`/plain types
- **THEN** the facade gate passes
