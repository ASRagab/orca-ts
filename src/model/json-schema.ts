import { z } from "zod";
import { CanonicalSchemas } from "./schemas.ts";

export function jsonSchemaFromZod(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export function canonicalJsonSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(CanonicalSchemas)) {
    schemas[name] = jsonSchemaFromZod(schema);
  }
  return schemas;
}
