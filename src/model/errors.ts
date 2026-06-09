import type { BackendTag, RuntimeError } from "./schemas.ts";

type RuntimeErrorArgs<Tag extends RuntimeError["_tag"]> = Omit<
  Extract<RuntimeError, { _tag: Tag }>,
  "_tag"
>;

export function unsupportedFeature(feature: string, reason: string): RuntimeError {
  return { _tag: "UnsupportedFeature", feature, reason };
}

export function backendFailed(backend: BackendTag, message: string): RuntimeError {
  return { _tag: "BackendFailed", backend, message };
}

export function commandFailed(args: RuntimeErrorArgs<"CommandFailed">): RuntimeError {
  return { _tag: "CommandFailed", ...args };
}

export function structuredOutputValidationFailed(
  args: RuntimeErrorArgs<"StructuredOutputValidationFailed">
): RuntimeError {
  return { _tag: "StructuredOutputValidationFailed", ...args };
}
