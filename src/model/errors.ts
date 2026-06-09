import type { BackendTag, RuntimeError } from "./schemas.ts";

export function unsupportedFeature(feature: string, reason: string): RuntimeError {
  return { _tag: "UnsupportedFeature", feature, reason };
}

export function backendFailed(backend: BackendTag, message: string): RuntimeError {
  return { _tag: "BackendFailed", backend, message };
}

export function commandFailed(args: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): RuntimeError {
  return { _tag: "CommandFailed", ...args };
}

export function structuredOutputValidationFailed(args: {
  issues: string[];
  raw: unknown;
}): RuntimeError {
  return { _tag: "StructuredOutputValidationFailed", ...args };
}
