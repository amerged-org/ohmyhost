import { z } from "zod";
interface Scope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  grantId: string;
  now: string;
}
const row = z.strictObject({
  domain_id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment_id: z.string(),
  domain: z.string(),
  provider_domain_id: z.string(),
  receiving_status: z.string(),
  receiving_suspended: z.boolean(),
  sending: z.boolean(),
});
export interface ReceivingAdmissionPersistence {
  list(): Promise<z.output<typeof row>[]>;
  admit(input: () => Scope): Promise<{ allowed: boolean; paidAllowed: boolean }>;
  change(input: {
    domainId: string;
    phase: "disable" | "suspend" | "resume" | "observed" | "checked";
    now?: string;
    ready?: boolean;
  }): Promise<void>;
}
async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let result;
  try {
    result = await call();
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": store_outcome_unknown"))
      throw Object.assign(new Error("store_outcome_unknown"), { code: "store_outcome_unknown" });
    throw new Error("mail_receiving_admission_unavailable");
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("mail_receiving_admission_response_invalid");
  return parsed.data;
}
export async function createD1ReceivingAdmissionPersistence(
  raw: unknown,
): Promise<ReceivingAdmissionPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["listAdmission", "readAdmission", "changeAdmission"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_receiving_admission_binding_required");
  const binding = raw as {
    listAdmission(i: unknown): Promise<unknown>;
    readAdmission(i: unknown): Promise<unknown>;
    changeAdmission(i: unknown): Promise<unknown>;
  };
  await invoke(() => binding.listAdmission({}), z.array(row).max(20));
  return {
    list: () => invoke(() => binding.listAdmission({}), z.array(row).max(20)),
    admit: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          binding.readAdmission({
            organizationId: input.organizationId,
            projectId: input.projectId,
            environmentId: input.environmentId,
            now: input.now,
          }),
        z.strictObject({ allowed: z.boolean(), paidAllowed: z.boolean() }),
      );
    },
    change: (input) => invoke(() => binding.changeAdmission(input), z.undefined()),
  };
}
