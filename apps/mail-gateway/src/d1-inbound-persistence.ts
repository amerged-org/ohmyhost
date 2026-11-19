import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type { InboundMailPersistence, DeliveryCommandPersistence } from "./inbound-delivery.js";
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  time = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  state = z.enum(["pending", "delivering", "delivered", "delivery_failed", "expired"]),
  row = z.strictObject({
    message_id: id,
    provider_message_id: z.string(),
    domain_id: id,
    organization_id: id,
    project_id: id,
    environment_id: id,
    received_at: time,
    expires_at: time,
    state,
    attempts: z.number().int().min(0).max(4),
    first_attempt_at: time.nullable(),
    lease_until: time.nullable(),
    next_attempt_at: time,
    last_http_status: z.number().int().min(100).max(599).nullable(),
    billed_at: time.nullable(),
    domain: z.string(),
    webhook_url: z.string(),
    webhook_secret_generation: z.number().int().min(0).max(2147483647),
  });
type Row = z.output<typeof row>;
interface Binding {
  read(input: unknown): Promise<unknown>;
  claim(input: unknown): Promise<unknown>;
  complete(input: unknown): Promise<unknown>;
  list(input: unknown): Promise<unknown>;
  due(input: unknown): Promise<unknown>;
  defer(input: unknown): Promise<unknown>;
  expire(input: unknown): Promise<unknown>;
}
async function invoke<T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  let value;
  try {
    value = await call();
  } catch (error) {
    const code = ["store_outcome_unknown", "idempotency_key_reused"].find(
      (value) =>
        error instanceof Error && (error.message === value || error.message.endsWith(`: ${value}`)),
    );
    if (code) throw Object.assign(new Error(code), { code });
    throw new Error("mail_delivery_core_unavailable");
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("mail_delivery_core_response_invalid");
  return result.data;
}

/** The zero ULID is valid source data: validate a matching row too, without assuming absence. */
async function probeDelivery(target: Pick<Binding, "read">): Promise<void> {
  const zero = "00000000000000000000000000",
    found = await invoke(
      () =>
        target.read({
          organizationId: zero,
          projectId: zero,
          environmentId: zero,
          messageId: zero,
          now: new Date().toISOString(),
        }),
      row.nullable(),
    );
  if (
    found !== null &&
    [found.organization_id, found.project_id, found.environment_id, found.message_id].some(
      (id) => id !== zero,
    )
  )
    throw new Error("mail_delivery_core_response_invalid");
}

/** The original retry command groups share the delivery capability, without callbacks or customer data on RPC. */
export async function createD1DeliveryCommands(raw: unknown): Promise<DeliveryCommandPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["read", "acceptRetry", "resumeRetry", "completeRetry"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_delivery_core_binding_required");
  const target = raw as Binding & {
    acceptRetry(input: unknown): Promise<unknown>;
    resumeRetry(input: unknown): Promise<unknown>;
    completeRetry(input: unknown): Promise<unknown>;
  };
  await probeDelivery(target);
  return {
    accept: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.acceptRetry({
            ...coordinates(input),
            key: input.key,
            digest: Buffer.from(input.digest).toString("hex"),
            now: input.now,
          }),
        z.strictObject({
          created: z.boolean(),
          response: z.json(),
          claimedAttempt: z.number().int().min(1).max(4).nullable(),
        }),
      );
    },
    resume: (supplier) => {
      const input = supplier();
      return invoke(
        () => target.resumeRetry({ ...coordinates(input), key: input.key, now: input.now }),
        z.boolean(),
      );
    },
    complete: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.completeRetry({
            ...coordinates(input),
            key: input.key,
            response: input.response,
            now: input.now,
          }),
        z.undefined(),
      );
    },
  };
}
function coordinates(input: { organizationId: string; projectId: string; environmentId: string }) {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
  };
}
function decode(value: Row) {
  return {
    ...value,
    received_at: new Date(value.received_at),
    expires_at: new Date(value.expires_at),
    first_attempt_at: value.first_attempt_at === null ? null : new Date(value.first_attempt_at),
    lease_until: value.lease_until === null ? null : new Date(value.lease_until),
    next_attempt_at: new Date(value.next_attempt_at),
    billed_at: value.billed_at === null ? null : new Date(value.billed_at),
  };
}

/** Original receiving-key read on the already-probed delivery capability; only the digest crosses RPC. */
export async function authorizeD1InboundKey(
  raw: unknown,
  input: { projectId: string; keySha256: Uint8Array },
) {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    typeof Reflect.get(raw, "authorizeKey") !== "function"
  )
    throw new Error("mail_delivery_core_binding_required");
  const target = raw as { authorizeKey(input: unknown): Promise<unknown> },
    found = await invoke(
      () =>
        target.authorizeKey({
          projectId: input.projectId,
          keySha256: Buffer.from(input.keySha256).toString("hex"),
          receiving: true,
        }),
      z
        .strictObject({ organizationId: id, projectId: id, environmentId: id, domain: z.string() })
        .nullable(),
    );
  return found === null
    ? null
    : {
        organizationId: parseUlid(found.organizationId),
        projectId: parseUlid(found.projectId),
        environmentId: parseUlid(found.environmentId),
        domain: found.domain,
      };
}
/** Six fixed metadata transactions. Provider/content/signing key and all transient message data stay Gateway. */
export async function createD1InboundPersistence(raw: unknown): Promise<InboundMailPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["read", "claim", "complete", "list", "due", "defer", "expire"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_delivery_core_binding_required");
  const target = raw as Binding;
  // The ordinary read proves a real method; no readiness flag or timestamp is persisted.
  await probeDelivery(target);
  return {
    read: async (supplier) => {
      const input = supplier(),
        found = await invoke(
          () => target.read({ ...coordinates(input), messageId: input.messageId, now: input.now }),
          row.nullable(),
        );
      return found === null ? null : decode(found);
    },
    claim: async (supplier) => {
      const input = supplier(),
        found = await invoke(
          () =>
            target.claim({
              ...coordinates(input),
              messageId: input.messageId,
              now: input.now,
              ...(input.manual === undefined ? {} : { manual: input.manual }),
              ...(input.commandKey === undefined ? {} : { commandKey: input.commandKey }),
            }),
          row.nullable(),
        );
      if (found === null) return null;
      if (found.first_attempt_at === null) throw new Error("mail_delivery_core_response_invalid");
      return { ...decode(found), first_attempt_at: new Date(found.first_attempt_at) };
    },
    complete: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.complete({
            messageId: input.messageId,
            attempt: input.attempt,
            now: input.now,
            status: input.status,
          }),
        z.undefined(),
      );
    },
    list: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.list({
            ...coordinates(input),
            now: input.now,
            ...(input.after === undefined ? {} : { after: input.after }),
          }),
        z.array(
          z.strictObject({
            message_id: id,
            received_at: time,
            state,
            attempts: z.number().int().min(0).max(4),
          }),
        ),
      );
    },
    due: async (now) => {
      const input = { now: now() },
        rows = await invoke(
          () => target.due(input),
          z.array(
            z.strictObject({ messageId: id, organizationId: id, projectId: id, environmentId: id }),
          ),
        );
      return rows.map((value) => ({
        messageId: parseUlid(value.messageId),
        organizationId: parseUlid(value.organizationId),
        projectId: parseUlid(value.projectId),
        environmentId: parseUlid(value.environmentId),
      }));
    },
    defer: (supplier) => {
      const input = supplier();
      return invoke(
        () =>
          target.defer({
            ...coordinates(input),
            messageId: input.messageId,
            attempt: input.attempt,
            now: input.now,
          }),
        z.undefined(),
      );
    },
    expire: (now) => {
      const input = { now: now() };
      return invoke(() => target.expire(input), z.undefined());
    },
  };
}
