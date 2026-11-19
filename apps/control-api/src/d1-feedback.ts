import { z } from "zod";
import { FeedbackPersistenceError } from "@ohmyhost/database";
import { parseFeedbackStatus } from "@ohmyhost/contracts/feedback";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { ControlApiPersistence } from "./contracts.js";
export interface FeedbackRuntime {
  submitCustomerFeedback(input: unknown): Promise<unknown>;
  readCustomerFeedbackStatus(input: unknown): Promise<unknown>;
}
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  at = z
    .string()
    .refine(
      (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    ),
  reply = z.discriminatedUnion("outcome", [
    z.strictObject({
      outcome: z.literal("stored"),
      receipt: z.strictObject({ id, organization_id: id, submitted_at: at }),
    }),
    z.strictObject({ outcome: z.enum(["resource_not_found", "idempotency_key_reused"]) }),
  ]),
  statusRecord = z.strictObject({
    organizationId: id,
    projectId: id.nullable(),
    environmentId: id.nullable(),
    status: z.unknown().transform((value) => (value === null ? null : parseFeedbackStatus(value))),
  });
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
/** Only customer submit/read; operator feedback-event writes are not exposed. */
export function createD1FeedbackPersistence(input: {
  runtime: FeedbackRuntime;
  clock: Clock;
  ids: UlidFactory;
}): Pick<ControlApiPersistence, "submitFeedback" | "readFeedbackStatus"> {
  const { runtime, clock, ids } = input;
  if (
    typeof runtime?.submitCustomerFeedback !== "function" ||
    typeof runtime.readCustomerFeedbackStatus !== "function"
  )
    throw new Error("feedback_binding_required");
  return {
    async submitFeedback(request) {
      const result = reply.parse(
        await runtime.submitCustomerFeedback({
          report: request.report,
          actorId: request.actorId,
          idempotencyKey: request.idempotencyKey,
          requestSha256: hex(request.requestSha256),
          feedbackId: ids.next(),
          submittedAt: clock.now().toISOString(),
        }),
      );
      if (result.outcome !== "stored") throw new FeedbackPersistenceError(result.outcome);
      if (result.receipt.organization_id !== request.report.organization_id)
        throw new Error("feedback_response_scope_invalid");
      return result.receipt;
    },
    async readFeedbackStatus(request) {
      const raw = await runtime.readCustomerFeedbackStatus(request);
      if (raw === null) return null;
      const result = statusRecord.parse(raw);
      if (
        !request.organizationIds.some((id) => id === result.organizationId) ||
        (result.status !== null &&
          (result.status.id !== request.feedbackId ||
            result.status.organization_id !== result.organizationId))
      )
        throw new Error("feedback_response_scope_invalid");
      return result;
    },
  };
}
