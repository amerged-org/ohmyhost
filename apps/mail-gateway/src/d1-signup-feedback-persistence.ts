import { z } from "zod";

const userId = z.string().regex(/^user_[A-Za-z0-9_]{1,128}$/u);
const claimToken = z.string().uuid();
const timestamp = z
  .string()
  .refine((s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s);
const claim = z.strictObject({ userId, claimToken, leaseUntil: timestamp });
interface Binding {
  claim(input: unknown): Promise<unknown>;
  begin(input: unknown): Promise<unknown>;
  finish(input: unknown): Promise<unknown>;
}

/** Keeps gateway input/output bounded; all durable transitions are owned by the private Core service. */
export function createD1SignupFeedbackPersistence(raw: unknown) {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["claim", "begin", "finish"].some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("signup_feedback_binding_required");
  const binding = raw as Binding;
  return {
    async claim(input: { now: string }) {
      const result = await binding.claim(input);
      return z.array(claim).max(100).parse(result);
    },
    async begin(input: { userId: string; claimToken: string; now: string }) {
      return z.boolean().parse(await binding.begin(input));
    },
    async finish(input: {
      userId: string;
      claimToken: string;
      now: string;
      state: "pending" | "skipped" | "accepted" | "uncertain";
      providerMessageId: string | null;
    }) {
      return z.boolean().parse(await binding.finish(input));
    },
  };
}
