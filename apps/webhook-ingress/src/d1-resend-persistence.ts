import { minimizeResendObservation } from "./resend-observation.js";
import type { ResendIngressPersistence } from "./resend-ingress.js";
function receipt(raw: unknown): { eventId: string; digest: string } | null {
  if (raw === null) return null;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== "digest,eventId"
  )
    throw new Error("mail_resend_core_response_invalid");
  const row = raw as Record<string, unknown>;
  if (
    typeof row["eventId"] !== "string" ||
    typeof row["digest"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row["digest"])
  )
    throw new Error("mail_resend_core_response_invalid");
  return { eventId: row["eventId"], digest: row["digest"] };
}
interface Binding {
  readReceipt(input: unknown): Promise<unknown>;
  ingest(input: unknown): Promise<unknown>;
}
async function read(binding: Binding, eventId: string) {
  const value = receipt(await binding.readReceipt({ eventId }));
  if (value !== null && value.eventId !== eventId)
    throw new Error("mail_resend_core_response_invalid");
  return value;
}
/** Only minimized signed facts cross the private binding; receipt replay precedes the lazy receive identity draw. */
export function createD1ResendIngressPersistence(raw: unknown): ResendIngressPersistence {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["readReceipt", "ingest"].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("mail_resend_core_binding_required");
  const binding = raw as Binding;
  return {
    ingest: async (event) => {
      const found = await read(binding, event.eventId),
        digest = Buffer.from(event.digest).toString("hex");
      if (found) {
        if (found.digest !== digest) throw new Error("Resend event identity conflict");
        return;
      }
      const result = await binding.ingest(minimizeResendObservation(event));
      if (result !== undefined) throw new Error("mail_resend_core_response_invalid");
    },
  };
}
