import { generatedJsonb } from "../../jsonb-generated.js";

/** Fresh Mail metadata only. Captured Source strings are preserved verbatim elsewhere. */
export function mailMetadataJsonb(value: unknown): string {
  return generatedJsonb(value);
}
