import { err, ok, type Result } from "neverthrow";
import type { ZodType } from "zod";
import { structuredOutputValidationFailed } from "./errors.ts";
import type { RuntimeError } from "./schemas.ts";

export interface StructuredOutput<T> {
  readonly raw: unknown;
  readonly value: T;
}

export function parseStructuredOutput<T>(
  schema: ZodType<T>,
  raw: unknown
): Result<StructuredOutput<T>, RuntimeError> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return ok({ raw, value: parsed.data });
  }

  return err(
    structuredOutputValidationFailed({
      raw,
      issues: parsed.error.issues.map(({ message }) => message)
    })
  );
}
