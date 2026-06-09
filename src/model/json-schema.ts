import { z } from "zod";
import { CanonicalSchemas } from "./schemas.ts";

export function canonicalJsonSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(CanonicalSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { target: "draft-7" })
    ])
  );
}
