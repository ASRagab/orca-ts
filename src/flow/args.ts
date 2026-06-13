export const FLOW_ARGS_ENV = "ORCA_FLOW_ARGS";

// User task tokens are everything after a standalone `--`, so CLI flags and the
// flow path never leak into a flow's task input. No `--` means no task args.
export function extractFlowArgs(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  return separator === -1 ? [] : argv.slice(separator + 1);
}

// The arguments a flow should treat as its task input. The orca CLI captures
// the post-`--` tokens and forwards them via ORCA_FLOW_ARGS; a flow run directly
// (e.g. `bun flow.ts -- foo`) falls back to parsing argv.
export function flowArgs(): string[] {
  const raw = process.env[FLOW_ARGS_ENV];
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((arg): arg is string => typeof arg === "string");
      }
    } catch {
      // malformed env — fall back to argv parsing below
    }
  }
  return extractFlowArgs(process.argv.slice(2));
}
