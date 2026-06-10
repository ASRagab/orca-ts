import { codex, fakeBackend, flow, fs, llm, z } from "../src/index.ts";
import { join } from "node:path";

const OutputSchema = z.object({
  summary: z.string(),
  confidence: z.number(),
});

const PROMPT = "Summarize the key architectural patterns in this repository.";
const CANNED_OUTPUT = JSON.stringify({ summary: "Functional pipeline with Result types.", confidence: 0.9 });

await flow(process.argv.slice(2))(async () => {
  const fake = fakeBackend([CANNED_OUTPUT]);

  const [codexOutcome, fakeOutcome] = await Promise.all([
    llm().autonomous(codex(), { prompt: PROMPT, schema: OutputSchema }).awaitResult(),
    fake.autonomous({ prompt: PROMPT, schema: OutputSchema }).awaitResult(),
  ]);

  const codexOutput = codexOutcome.type === "success" ? codexOutcome.result.output : `FAILED: ${codexOutcome.type}`;
  const fakeOutput = fakeOutcome.type === "success" ? fakeOutcome.result.output : `FAILED: ${fakeOutcome.type}`;

  const report = {
    prompt: PROMPT,
    timestamp: new Date().toISOString(),
    backends: {
      codex: { output: codexOutput, sessionId: codexOutcome.type === "success" ? String(codexOutcome.result.sessionId) : null },
      fake: { output: fakeOutput, sessionId: fakeOutcome.type === "success" ? String(fakeOutcome.result.sessionId) : null },
    },
    match: codexOutput === fakeOutput,
  };

  const logPath = join(process.cwd(), ".orca", `backend-compare-${Date.now()}.json`);
  await fs().writeText(logPath, JSON.stringify(report, null, 2));

  console.log(`Comparison written to ${logPath}`);
  console.log(`Outputs match: ${report.match}`);
  if (!report.match) {
    console.log(`codex: ${codexOutput.slice(0, 120)}`);
    console.log(`fake:  ${fakeOutput.slice(0, 120)}`);
  }
});

