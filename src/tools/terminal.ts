import type { OrcaEvent } from "../model/index.ts";

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

export function createTerminalTool(): TerminalTool {
  const output: string[] = [];

  return {
    emit(event) {
      output.push(renderOrcaEvent(event));
    },
    lines() {
      return [...output];
    },
    status(status, options) {
      const line = renderStatusBar(status, options);
      output.push(line);
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
      return `tokens: input=${event.usage.input} output=${event.usage.output}`;
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
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const text = `${status.label} ${status.current}/${status.total}`;

  if (env.NO_COLOR || env.CI || !isTTY) {
    return text;
  }

  return `\r${text}\u001b[K`;
}
