import { z } from "zod";
import type { Clock } from "@ohmyhost/platform";
import { createPublicEntry } from "./public-entry.js";
import type { PublicEntryDataPort } from "./public-entry-persistence.js";
export interface PublicEntryRuntime {
  recordPublicContact(input: unknown): Promise<unknown>;
  recordPublicFeatureVote(input: unknown): Promise<unknown>;
  readPublicFeatureVotes(input: unknown): Promise<unknown>;
  readPublicStats(input: unknown): Promise<unknown>;
}
const rows = z
    .array(
      z.strictObject({
        feature: z.enum(["eu", "iso27001", "soc2"]),
        choice: z.enum(["up", "down"]).nullable(),
      }),
    )
    .length(3),
  number = z.number().int().nonnegative().safe();
export interface PublicEntryRetentionRuntime {
  purgePublicEntries(input: unknown): Promise<unknown>;
}
export function createD1PublicEntryPersistence(
  runtime: PublicEntryRuntime,
): Omit<PublicEntryDataPort, "purge"> {
  for (const method of [
    "recordPublicContact",
    "recordPublicFeatureVote",
    "readPublicFeatureVotes",
    "readPublicStats",
  ] as const)
    if (typeof runtime?.[method] !== "function") throw new Error("public_entry_binding_required");
  return {
    contact: async (input) => z.boolean().parse(await runtime.recordPublicContact(input)),
    vote: async (input) => z.boolean().parse(await runtime.recordPublicFeatureVote(input)),
    votes: async (input) => {
      const parsed = rows.parse(await runtime.readPublicFeatureVotes(input));
      if (new Set(parsed.map((row) => row.feature)).size !== 3)
        throw new Error("public_entry_response_invalid");
      return parsed;
    },
    stats: async (input) => number.parse(await runtime.readPublicStats(input)),
  };
}
export function createD1PublicEntry(runtime: PublicEntryRuntime, clock: Clock) {
  return createPublicEntry(createD1PublicEntryPersistence(runtime), clock);
}
export async function purgeD1PublicEntries(runtime: PublicEntryRetentionRuntime, now: Date) {
  if (typeof runtime?.purgePublicEntries !== "function")
    throw new Error("public_entry_retention_binding_required");
  return number.parse(await runtime.purgePublicEntries({ now: now.toISOString() }));
}
