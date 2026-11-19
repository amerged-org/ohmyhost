import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { ResendSendPersistence } from "./resend-send.js";

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  natural = z.string().regex(/^(0|[1-9][0-9]*)$/u),
  int8 = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/u)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  time = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  sender = z.strictObject({
    domainId: id,
    bindingRevision: int8,
    from: z.string().min(1),
    replyTo: z.string().nullable(),
  });
const authorized = z
  .strictObject({ organizationId: id, projectId: id, environmentId: id, domain: z.string().min(1) })
  .nullable();
const claim = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("claimed"),
    requestId: id,
    remainingCreditMicros: natural,
    sender: sender.optional(),
  }),
  z.strictObject({
    outcome: z.literal("accepted"),
    requestId: id,
    providerMessageId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/u),
  }),
  z.strictObject({
    outcome: z.literal("uncertain"),
    requestId: id,
    requestedAt: time,
    providerStarted: z.boolean(),
    sender: sender.optional(),
  }),
  z.strictObject({ outcome: z.literal("rejected"), requestId: id }),
]);
const key = z.strictObject({
  domainId: id,
  keyOrganizationId: id,
  keyProjectId: id,
  keyEnvironmentId: id,
  ciphertext: z.string().regex(/^(?:[a-f0-9]{2}){16,}$/u),
  nonce: z.string().regex(/^[a-f0-9]{24}$/u),
  valueSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  keyVersion: z.literal(1),
});
const attempt = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("accepted"),
    providerMessageId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/u),
  }),
  z.strictObject({ state: z.enum(["uncertain", "rejected"]) }),
]);
const METHODS = [
  "authorizeKey",
  "claim",
  "authorize",
  "reject",
  "readKey",
  "complete",
  "settle",
] as const;
interface MailSendBinding {
  authorizeKey(input: unknown): Promise<unknown>;
  claim(input: unknown): Promise<unknown>;
  authorize(input: unknown): Promise<unknown>;
  reject(input: unknown): Promise<unknown>;
  readKey(input: unknown): Promise<unknown>;
  complete(input: unknown): Promise<unknown>;
  settle(input: unknown): Promise<unknown>;
}
const CODES = [
  "paid_plan_required",
  "insufficient_organization_credits",
  "project_budget_exceeded",
  "mail_send_daily_limit",
  "mail_reputation_suspended",
  "mail_send_conflict",
  "mail_send_scope_unavailable",
  "mail_scope_unavailable",
  "store_busy",
  "store_outcome_unknown",
];
async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? CODES.find((value) => error.message === value || error.message.endsWith(`: ${value}`))
          : undefined;
    if (code && CODES.includes(code)) throw Object.assign(new Error(code), { code });
    throw new Error("mail_core_unavailable");
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error("mail_core_response_invalid");
  return result.data;
}
function bytes(hex: string) {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
function hex(value: Uint8Array) {
  return Buffer.from(value).toString("hex");
}
function runtimeScope(input: { organizationId: string; projectId: string; environmentId: string }) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
  };
}
function transitionScope(input: { organizationId: string; projectId: string; requestId: string }) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    requestId: input.requestId,
  };
}
/** Fixed private methods only. Suppliers and all message/recipient plaintext stay in Gateway. */
export async function createD1ResendSendPersistence(raw: unknown): Promise<ResendSendPersistence> {
  if (
    raw === null ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    METHODS.some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new Error("mail_core_binding_required");
  const target = raw as MailSendBinding;
  // Real RPC stubs make absent methods look callable. Prove the existing narrow digest read before constructing a provider.
  const probe = await invoke(
    () =>
      target.authorizeKey({ projectId: "00000000000000000000000000", keySha256: "0".repeat(64) }),
    authorized,
  );
  if (probe !== null) throw new Error("mail_core_response_invalid");
  return {
    authorizeKey: async (supplier) => {
      const input = supplier(),
        row = await invoke(
          () => target.authorizeKey({ ...input, keySha256: hex(input.keySha256) }),
          authorized,
        );
      return row === null
        ? null
        : {
            ...row,
            organizationId: parseUlid(row.organizationId),
            projectId: parseUlid(row.projectId),
            environmentId: parseUlid(row.environmentId),
          };
    },
    claim: async (supplier, paid) => {
      const paidInput = paid(),
        input = supplier();
      if (input.organizationId !== paidInput.organizationId)
        throw new TypeError("Invalid mail scope");
      const row = await invoke(
          () =>
            target.claim({
              ...runtimeScope(input),
              provider: input.provider,
              requestId: input.requestId,
              idempotencyKey: input.idempotencyKey,
              requestedAt: input.requestedAt,
              ...(input.sender === undefined ? {} : { sender: input.sender }),
              paidAt: paidInput.now,
              requestSha256: hex(input.requestSha256),
              recipientSha256: hex(input.recipientSha256),
              contentSha256: hex(input.contentSha256),
              ...(input.requestInputSha256 === undefined
                ? {}
                : { requestInputSha256: hex(input.requestInputSha256) }),
            }),
          claim,
        ),
        base = {
          requestId: parseUlid(row.requestId),
          ...("sender" in row && row.sender
            ? {
                sender: {
                  ...row.sender,
                  domainId: parseUlid(row.sender.domainId),
                  bindingRevision: Number(row.sender.bindingRevision),
                },
              }
            : {}),
        };
      if (row.outcome === "claimed")
        return {
          ...base,
          outcome: "claimed",
          remainingCreditMicros: BigInt(row.remainingCreditMicros),
        };
      if (row.outcome === "accepted")
        return {
          outcome: "accepted",
          requestId: base.requestId,
          providerMessageId: row.providerMessageId,
        };
      if (row.outcome === "rejected") return { outcome: "rejected", requestId: base.requestId };
      return {
        ...base,
        outcome: "uncertain",
        requestedAt: row.requestedAt,
        providerStarted: row.providerStarted,
      };
    },
    authorize: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.authorize({
            ...runtimeScope(input),
            requestId: input.requestId,
            idempotencyKey: input.idempotencyKey,
            now: input.now,
          }),
        z.boolean(),
      );
    },
    reject: (supplier) => {
      const input = supplier();
      return invoke(
        () => target.reject({ ...transitionScope(input), rejectedAt: input.rejectedAt }),
        z.enum(["released", "existing"]),
      );
    },
    readKey: async (supplier) => {
      const input = supplier(),
        row = await invoke(() => target.readKey({ ...runtimeScope(input), now: input.now }), key);
      return {
        ...row,
        domainId: parseUlid(row.domainId),
        keyOrganizationId: parseUlid(row.keyOrganizationId),
        keyProjectId: parseUlid(row.keyProjectId),
        keyEnvironmentId: parseUlid(row.keyEnvironmentId),
        ciphertext: bytes(row.ciphertext),
        nonce: bytes(row.nonce),
        valueSha256: bytes(row.valueSha256),
      };
    },
    complete: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.complete({
            ...transitionScope(input),
            providerMessageId: input.providerMessageId,
            completedAt: input.completedAt,
          }),
        z.enum(["completed", "existing"]),
      );
    },
    settle: (supplier, refused) => {
      const input = supplier();
      if (input.refused !== refused) throw new TypeError("Invalid mail attempt");
      return invoke(
        () =>
          target.settle({
            ...transitionScope(input),
            observedAt: input.observedAt,
            refused: input.refused,
          }),
        attempt,
      );
    },
  } satisfies ResendSendPersistence;
}
