import { z } from "zod";
import { CanonicalSchemas } from "./schemas.ts";

export function jsonSchemaFromZod(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export function canonicalJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(CanonicalSchemas).map(([name, schema]) => [
      name,
      jsonSchemaFromZod(schema)
    ])
  );
}
