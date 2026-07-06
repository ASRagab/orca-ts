import type { OrcaEvent } from "../model/index.ts";
import type { RunReporter } from "../run-output/index.ts";

export interface TerminalTool {
  emit(event: OrcaEvent): void;
  lines(): readonly string[];
  status(status: StatusBarState, options?: StatusBarOptions): string;
}

export interface StatusBarState {
  readonly label: string;
  readonly current: number;
  readonly total: number;
}

export interface StatusBarOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
}

export interface TerminalToolOptions {
  readonly reporter?: RunReporter;
}

export function createTerminalTool(options: TerminalToolOptions = {}): TerminalTool {
  const output: string[] = [];
  const reporter = options.reporter;

  return {
    emit(event) {
      output.push(renderOrcaEvent(event));
      emitRunEvent(event, reporter);
    },
    lines() {
      return [...output];
    },
    status(status, options) {
      const line = renderStatusBar(status, options);
      output.push(line);
      reporter?.emit({
        type: "stage",
        name: status.label,
        status: "running",
        message: `${String(status.current)}/${String(status.total)}`,
      });
      return line;
    }
  };
}

export function renderOrcaEvent(event: OrcaEvent): string {
  switch (event.type) {
    case "user_prompt":
      return `prompt: ${event.text}`;
    case "tool_use":
      return `tool: ${event.name}`;
    case "assistant_message":
      return event.text;
    case "tokens_used":
      return `tokens: input=${String(event.usage.input)} output=${String(event.usage.output)}`;
    case "structured_result":
      return event.summary ?? JSON.stringify(event.raw);
    case "step":
      return `step: ${event.name} ${event.status}`;
    case "error":
      return `error: ${event.message}`;
  }
}

export function renderStatusBar(
  status: StatusBarState,
  options: StatusBarOptions = {}
): string {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  const text = `${status.label} ${String(status.current)}/${String(status.total)}`;

  if (env.NO_COLOR || env.CI || !isTTY) {
    return text;
  }

  return `\r${text}\u001b[K`;
}

function emitRunEvent(event: OrcaEvent, reporter: RunReporter | undefined): void {
  if (reporter === undefined) {
    return;
  }
  switch (event.type) {
    case "tool_use":
      reporter.emit({ type: "agent_activity", activity: "tool_use", name: event.name });
      return;
    case "assistant_message":
      reporter.emit({ type: "agent_activity", activity: "assistant_summary", summary: event.text });
      return;
    case "tokens_used":
      reporter.emit({ type: "agent_activity", activity: "usage", usage: event.usage });
      return;
    case "structured_result":
      reporter.emit({
        type: "agent_activity",
        activity: "assistant_summary",
        summary: event.summary ?? JSON.stringify(event.raw),
      });
      return;
    case "step":
      reporter.emit({ type: "stage", name: event.name, status: event.status });
      return;
    case "error":
      reporter.emit({ type: "failure", file: "flow", message: event.message });
      return;
    case "user_prompt":
      reporter.emit({ type: "agent_activity", activity: "assistant_summary", summary: event.text });
      return;
  }
}
