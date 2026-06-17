import {
  defineLoop,
  err,
  linear,
  linearIssueSink,
  linearIssueSource,
  loop,
  ok,
  slack,
  times,
  type LinearIssueSinkOutput,
  type LinearIssueTriggerEvent,
  type LoopOutcome,
  type LoopRunError,
  type Result,
  type Sink,
} from "../src/index.ts";
import { createFakeLinearTool } from "../src/test-utils/index.ts";

interface TriageState {
  readonly issueId: string;
  readonly summary: string;
  readonly requiresCodeChange: boolean;
}

interface TriageOutput {
  readonly linear: LinearIssueSinkOutput;
  readonly slack?: string;
}

const fakeLinear = createFakeLinearTool();

const compositeSink: Sink<TriageOutput> = {
  kind: "linear-issue",
  async emit(output) {
    const linearResult = await linearIssueSink({ tool: fakeLinear }).emit(output.linear);
    if (linearResult.isErr()) return err(linearResult.error);

    if (output.slack !== undefined) {
      return slack<string>({
        webhookUrl: process.env.SLACK_WEBHOOK_URL ?? "https://hooks.slack.invalid/orca",
        post: () => Promise.resolve(ok(undefined)),
      }).emit(output.slack);
    }

    return ok(undefined);
  },
};

async function triage(event: LinearIssueTriggerEvent): Promise<Result<LoopOutcome<TriageState>, LoopRunError>> {
  let progressFailed: LoopRunError | undefined;
  const result = await loop<TriageState>("linear-ticket-triage")
    .step("acknowledge-linear", async (state) => {
      const progress = await linear().createIssueComment({
        issueId: state.issueId,
        body: `Orca started triage for ${event.issueIdentifier ?? state.issueId}.`,
      });
      if (progress.isErr()) progressFailed = progress.error;
      return state;
    })
    .step("triage-ticket", (state) => ({
      ...state,
      summary: `Triaged ${event.issueIdentifier ?? state.issueId}; no code change required by this example.`,
      requiresCodeChange: false,
    }))
    .until(times(1))
    .run(
      {
        issueId: event.issueId,
        summary: "",
        requiresCodeChange: false,
      },
      { overrides: { linear: fakeLinear } },
    );

  if (progressFailed !== undefined) {
    return err(progressFailed);
  }
  return result;
}

export default defineLoop<LinearIssueTriggerEvent, TriageOutput, TriageState>({
  name: "linear-ticket-triage",
  source: linearIssueSource({
    webhookSecret: process.env.LINEAR_WEBHOOK_SECRET ?? "example-secret",
    listenerFactory: () => Promise.resolve(ok({ close: () => Promise.resolve() })),
    actions: ["create", "update"],
  }),
  sink: compositeSink,
  async onTrigger(event) {
    const result = await triage(event);
    if (result.isErr()) return err(result.error);

    const state = result.value.state;
    let linearOutput: LinearIssueSinkOutput = {
      issueId: state.issueId,
      finalSummary: state.summary,
    };
    if (!state.requiresCodeChange && process.env.LINEAR_DONE_STATE_ID !== undefined) {
      linearOutput = { ...linearOutput, update: { stateId: process.env.LINEAR_DONE_STATE_ID } };
    }

    return ok({
      outcome: result.value,
      output: {
        linear: linearOutput,
        slack: `Linear ${event.issueIdentifier ?? state.issueId}: ${state.summary}`,
      },
    });
  },
});
