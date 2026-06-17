import { loop, untilGatesGreen, type GatesState } from "../src/index.ts";

const result = await loop<GatesState>("gate-repair")
  .step("repair-one-gate", (state) => ({ failingGates: Math.max(0, state.failingGates - 1) }))
  .until(untilGatesGreen())
  .guard({ maxIterations: 5 })
  .run({ failingGates: 3 });

if (result.isErr()) {
  console.error(`loop failed: ${JSON.stringify(result.error)}`);
  process.exit(1);
}

const outcome = result.value;
console.log(`stop reason: ${outcome.stopReason}`);
console.log(`iterations:  ${String(outcome.iterations)}`);
console.log(`failing gates: ${String(outcome.state.failingGates)}`);
