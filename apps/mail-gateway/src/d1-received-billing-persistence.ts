import { z } from "zod";
import type { listUnbilledReceivedMail, billResendReceivedMail } from "@ohmyhost/database";
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  queue = z.array(id).max(20);
interface ReceivedBillingPersistence {
  unbilled(): ReturnType<typeof listUnbilledReceivedMail>;
  bill(
    input: () => Parameters<typeof billResendReceivedMail>[1],
  ): ReturnType<typeof billResendReceivedMail>;
}
interface Binding {
  unbilled(input: unknown): Promise<unknown>;
  bill(input: unknown): Promise<unknown>;
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
    throw new Error("mail_received_billing_core_unavailable");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("mail_received_billing_core_response_invalid");
  return parsed.data;
}
/** The fixed receipt queue and charge command; no rate, scope, amount or permission comes from Gateway. */
export async function createD1ReceivedBillingPersistence(
  raw: unknown,
): Promise<ReceivedBillingPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["unbilled", "bill"].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("mail_received_billing_core_binding_required");
  const target = raw as Binding;
  // Actual queue metadata proves the method, without assuming an empty source or persisting a clock/readiness flag.
  await invoke(() => target.unbilled({}), queue);
  return {
    unbilled: () => invoke(() => target.unbilled({}), queue),
    bill: (supplier) => {
      const input = supplier();
      return invoke(
        () => target.bill({ messageId: input.messageId, now: input.now }),
        z.undefined(),
      );
    },
  };
}
