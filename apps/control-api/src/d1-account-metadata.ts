import { z } from "zod";
import { createAccountProfilePortWithPersistence } from "./account-profile.js";
import { createCurrentIdentityPortWithMappings } from "./current-identity.js";
import type { WorkosSessionStatusBinding } from "./workos-session-status.js";

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const mappings = z.array(
  z.strictObject({ organization_id: ulid, workos_organization_id: z.string() }),
);
const instant = z.string().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const facts = z.strictObject({
  memberships: z.array(z.strictObject({ id: ulid, workos_id: z.string(), name: z.string() })),
  origin: z.strictObject({ source: z.string().nullable(), recordedAt: instant }).nullable(),
  workspace: z.strictObject({ organization_id: ulid.nullable(), source_id: z.string() }).nullable(),
});
interface Binding {
  readCurrentIdentityMappings(input: unknown): Promise<unknown>;
  readAccountProfileFacts(input: unknown): Promise<unknown>;
  recordAccountSignupSource(input: unknown): Promise<unknown>;
}
const methods = [
  "readCurrentIdentityMappings",
  "readAccountProfileFacts",
  "recordAccountSignupSource",
] as const;

async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  const value = await call();
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("account_metadata_core_response_invalid");
  return result.data;
}

/** Closed metadata capability; provider profile, session checks and account plaintext remain in the API. */
export async function createD1AccountMetadataPorts(
  raw: unknown,
  authStatus: WorkosSessionStatusBinding,
  now: () => Date,
) {
  if (
    raw === null ||
    typeof raw !== "object" ||
    methods.some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("account_metadata_core_binding_required");
  const binding = raw as Binding;
  // A real RPC stub makes absent methods callable. Prove the existing narrow read before provider I/O.
  if (
    (await invoke(() => binding.readCurrentIdentityMappings({ organizationIds: [] }), mappings))
      .length !== 0
  )
    throw new Error("account_metadata_core_response_invalid");
  return {
    currentIdentity: createCurrentIdentityPortWithMappings(
      (organizationIds) =>
        invoke(() => binding.readCurrentIdentityMappings({ organizationIds }), mappings),
      authStatus,
    ),
    accountProfile: createAccountProfilePortWithPersistence(
      {
        read: (userId, workosOrganizationIds) =>
          invoke(() => binding.readAccountProfileFacts({ userId, workosOrganizationIds }), facts),
        async recordSource(userId, source, recordedAt, utm) {
          await invoke(
            () =>
              binding.recordAccountSignupSource({
                userId,
                source,
                recordedAt: recordedAt.toISOString(),
                ...(utm === undefined ? {} : { utm }),
              }),
            z.strictObject({ recorded: z.literal(true) }),
          );
        },
      },
      authStatus,
      now,
    ),
  };
}
