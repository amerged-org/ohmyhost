import { z } from "zod";
import type { InfrastructureAlertPersistence } from "./infrastructure-alerts.js";
const timestamp = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  receipt = z
    .strictObject({
      eventId: z.string().uuid(),
      requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      firstAttemptAt: timestamp,
      leaseUntil: timestamp,
      providerMessageId: z.string().nullable(),
      acceptedAt: timestamp.nullable(),
    })
    .nullable();
interface Binding {
  readReceipt(input: unknown): Promise<unknown>;
  claim(input: unknown): Promise<unknown>;
  complete(input: unknown): Promise<unknown>;
}
async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let row;
  try {
    row = await call();
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": store_outcome_unknown"))
      throw Object.assign(new Error("store_outcome_unknown"), { code: "store_outcome_unknown" });
    throw new Error("infrastructure_core_unavailable");
  }
  const result = schema.safeParse(row);
  if (!result.success) throw new Error("infrastructure_core_response_invalid");
  return result.data;
}
/** Closed infrastructure receipt actions only; no alert payload, recipient, provider key or callback crosses Core. */
export async function createD1InfrastructurePersistence(
  raw: unknown,
): Promise<InfrastructureAlertPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["readReceipt", "claim", "complete"].some((m) => typeof Reflect.get(raw, m) !== "function")
  )
    throw new Error("infrastructure_core_binding_required");
  const target = raw as Binding;
  if (
    (await invoke(
      () => target.readReceipt({ eventId: "00000000-0000-0000-0000-000000000000" }),
      receipt,
    )) !== null
  )
    throw new Error("infrastructure_core_response_invalid");
  return {
    claim: (input) =>
      invoke(() => target.claim(input), z.enum(["send", "wait", "accepted", "conflict"])),
    complete: (input) => invoke(() => target.complete(input), z.boolean()),
  };
}
