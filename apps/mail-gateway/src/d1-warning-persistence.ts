import { z } from "zod";
import type { CreditWarningPersistence } from "./credit-warning-dispatch.js";
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  time = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  period = z.strictObject({ organizationId: id, exhaustedAt: time, leaseUntil: time });
interface Binding {
  claimPeriods(input: unknown): Promise<unknown>;
  finishPeriod(input: unknown): Promise<unknown>;
}
async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let value;
  try {
    value = await call();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "store_outcome_unknown" ||
        error.message.endsWith(": store_outcome_unknown"))
    )
      throw Object.assign(new Error("store_outcome_unknown"), { code: "store_outcome_unknown" });
    throw new Error("mail_warning_core_unavailable");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("mail_warning_core_response_invalid");
  return parsed.data;
}
/** Fixed warning metadata only. WorkOS owner email addresses and outbound provider parameters stay in Gateway. */
export async function createD1WarningPersistence(raw: unknown): Promise<CreditWarningPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["claimPeriods", "finishPeriod"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_warning_core_binding_required");
  const target = raw as Binding;
  // Real RPC stubs make absent methods look callable. A finish of a lease nobody holds answers false and changes nothing.
  const epoch = "1970-01-01T00:00:00.000Z";
  const proof = await invoke(
    () =>
      target.finishPeriod({
        organizationId: "00000000000000000000000000",
        exhaustedAt: epoch,
        leaseUntil: epoch,
        now: epoch,
        delivered: false,
      }),
    z.boolean(),
  );
  if (proof) throw new Error("mail_warning_core_response_invalid");
  return {
    claimPeriods: (now) => invoke(() => target.claimPeriods({ now: now() }), z.array(period)),
    finishPeriod: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.finishPeriod({
            organizationId: input.organizationId,
            exhaustedAt: input.exhaustedAt,
            leaseUntil: input.leaseUntil,
            now: input.now,
            delivered: input.delivered,
          }),
        z.boolean(),
      );
    },
  };
}
