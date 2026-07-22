# Validation Notes

## Deterministic Gates

- `bun test tests/claude-backend.test.ts tests/codex-backend.test.ts tests/acp-client.test.ts`: 42 pass.
- Focused flow/loop tests: 177 pass.
- `bun run typecheck`: pass.
- `bun run docs:check`: pass.
- `bun run docs:symbols`: pass.
- `openspec validate productionize-claude-acp-default --strict`: pass.
- `bun run verify`: pass; test phase reported 447 pass, 1 skipped live-gated smoke, 0 fail, then docs/build/signature/facade/binary smoke phases completed.

## Live Smoke

| Scenario | Command | Result |
| --- | --- | --- |
| Claude ACP default | `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=claude bun test tests/integration/real-backend-smoke.test.ts` | pass; `wallTimeMs=51971`, `eventCount=5`, usage reported |
| Claude stream-json fallback | `ORCA_CLAUDE_TRANSPORT=stream-json ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=claude bun test tests/integration/real-backend-smoke.test.ts` | pass; `wallTimeMs=50637`, `eventCount=8` |
| Codex default subprocess | `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts` | pass; `wallTimeMs=32202`, `eventCount=12`, usage reported |

## Claude Benchmark Confirmation

Command:

```bash
ORCA_ACP_BENCHMARK_LIVE=1 bun run scripts/benchmark-acp-backends.ts --backends claude --transports current,acp --workloads direct,flow,loop --out-dir openspec/changes/productionize-claude-acp-default/acp-benchmark
```

Results written to `openspec/changes/productionize-claude-acp-default/acp-benchmark/results.json`.

| Workload | Stream-json fallback | ACP default | Delta |
| --- | ---: | ---: | ---: |
| Direct | 72211 ms | 30712 ms | ACP faster by 41499 ms |
| Flow | 67553 ms | 52544 ms | ACP faster by 15009 ms |
| Loop | 118427 ms | 71222 ms | ACP faster by 47205 ms |

All benchmark rows completed successfully. The run did not reuse sessions across prompts; the performance claim is transport-level, not session-reuse-driven.
