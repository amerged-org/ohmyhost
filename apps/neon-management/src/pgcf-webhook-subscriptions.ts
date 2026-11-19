import {
  createEnvironmentSecretCipher,
  createEnvironmentSecretCipherKeyring,
} from "@ohmyhost/platform";
import {
  parseDatabaseWebhookCreateRequest,
  parseDatabaseWebhookSubscriptionId,
  DATABASE_WEBHOOK_LIMIT,
  type DatabaseWebhookCreateRequest,
  type DatabaseWebhookSubscription,
} from "@ohmyhost/contracts/database-events";
import { PgcfProviderError, type PgcfWebhook } from "@ohmyhost/provider-pgcf";
import {
  databaseWebhooks,
  webhookCleanupKey,
  type DatabaseEventsProvider,
  type DatabaseEventOutcome,
} from "./pgcf-database-events.js";
import {
  parseDatabaseRequest,
  resolveDatabaseScope,
  sha256Hex,
  type DatabaseRequestEnvelope,
  type ReadDatabaseScope,
} from "./pgcf-database-request.js";

type Operation = "subscription.activate" | "subscription.deactivate" | "subscription.status";
type Request = DatabaseRequestEnvelope & { subscriptionId: string } & (
    | { operation: "subscription.status" }
    | { operation: "subscription.deactivate"; generation: number; idempotencyKey: string }
    | {
        operation: "subscription.activate";
        generation: number;
        idempotencyKey: string;
        webhook: DatabaseWebhookCreateRequest;
      }
  );
const shapes = {
  "subscription.status": [["subscriptionId"], []],
  "subscription.deactivate": [["subscriptionId", "generation", "idempotencyKey"], []],
  "subscription.activate": [
    ["subscriptionId", "generation", "idempotencyKey", "url", "eventTypes"],
    ["headers"],
  ],
} as const;
export const isDatabaseWebhookSubscriptionOperation = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>)["operation"] === "string" &&
  String((value as Record<string, unknown>)["operation"]).startsWith("subscription.");
export function parseDatabaseWebhookSubscriptionRequest(raw: unknown): Request {
  const { operation, envelope, input } = parseDatabaseRequest<Operation>(raw, shapes);
  const subscriptionId = parseDatabaseWebhookSubscriptionId(input["subscriptionId"]);
  if (operation === "subscription.status") return { ...envelope, operation, subscriptionId };
  const generation = input["generation"],
    key = input["idempotencyKey"];
  if (
    !Number.isSafeInteger(generation) ||
    Number(generation) < 1 ||
    typeof key !== "string" ||
    !/^[\x21-\x7e]{1,200}$/u.test(key)
  )
    throw new TypeError("Invalid subscription request");
  if (operation === "subscription.deactivate")
    return {
      ...envelope,
      operation,
      subscriptionId,
      generation: Number(generation),
      idempotencyKey: key,
    };
  return {
    ...envelope,
    operation,
    subscriptionId,
    generation: Number(generation),
    idempotencyKey: key,
    webhook: parseDatabaseWebhookCreateRequest({
      url: input["url"],
      event_types: input["eventTypes"],
      ...(input["headers"] === undefined ? {} : { headers: input["headers"] }),
    }),
  };
}

type Head = {
  generation: number;
  state: "creating" | "active" | "deactivating" | "inactive";
  provider_id: string | null;
};
type Receipt = {
  created_at: string;
  provider_id: string | null;
  ciphertext: string | null;
  nonce: string | null;
  value_sha256: string | null;
  key_version: number | null;
  abort_reason: "webhook_limit" | "idempotency_key_reused" | null;
};
type CoreResult =
  | {
      outcome:
        | "absent"
        | "pending"
        | "idempotency_key_reused"
        | "webhook_limit"
        | "capacity_required";
    }
  | { outcome: "ok"; head: Head; receipt?: Receipt };
export interface WebhookLifecycleRuntime {
  beginWebhookActivation(input: unknown): Promise<CoreResult>;
  finishWebhookActivation(input: unknown): Promise<CoreResult>;
  abortWebhookActivation(input: unknown): Promise<CoreResult>;
  beginWebhookDeactivation(input: unknown): Promise<CoreResult>;
  finishWebhookDeactivation(input: unknown): Promise<CoreResult>;
  readWebhookSubscription(input: unknown): Promise<CoreResult>;
}
type Cipher = ReturnType<typeof createEnvironmentSecretCipherKeyring>;
export function createWebhookLifecycleCipher(input: {
  keyBase64: string;
  keyVersion: number;
  additionalKeysJson?: string;
}): { cipher: Cipher; digest: ReturnType<typeof createEnvironmentSecretCipher>["keyedDigest"] } {
  const cipher = createEnvironmentSecretCipherKeyring({
    primaryKeyBase64: input.keyBase64,
    currentKeyVersion: input.keyVersion,
    crypto,
    ...(input.additionalKeysJson === undefined
      ? {}
      : { additionalKeysJson: input.additionalKeysJson }),
  });
  // Digest identity stays on the purpose's first key even when later encryption versions are introduced.
  const digest = createEnvironmentSecretCipher({
    keyBase64: input.keyBase64,
    keyVersion: 1,
    crypto,
  }).keyedDigest;
  return { cipher, digest };
}
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16));
const hex = (value: Uint8Array) => [...value].map((v) => v.toString(16).padStart(2, "0")).join("");
const keyName = (environment: "dev" | "prod", id: string, generation: number) =>
  `DATABASE_WEBHOOK_${environment.toUpperCase()}_${id}_GEN_${generation}`;
const refusal = (
  code: "pending" | "webhook_limit" | "idempotency_key_reused",
): DatabaseEventOutcome => ({ status: "rejected", code });
const absent: DatabaseEventOutcome = { status: "absent" };
const wire = (request: Request, head: Head): DatabaseWebhookSubscription => ({
  id: request.subscriptionId,
  environment: request.environment,
  state: head.state,
  generation: head.generation,
  provider_id: head.provider_id,
});
function mapped(result: Exclude<CoreResult, { outcome: "ok" }>): DatabaseEventOutcome {
  if (result.outcome === "absent") return absent;
  if (result.outcome === "capacity_required") throw new Error("Unexpected webhook capacity result");
  return refusal(result.outcome);
}
const owned = (provider: DatabaseEventsProvider, databaseId: string, webhook: PgcfWebhook) =>
  webhook.projectId === provider.projectId &&
  webhook.databaseIds?.length === 1 &&
  webhook.databaseIds[0] === databaseId;

/** Provider calls are fenced by Core generation receipts. Only an exact activation retry can recover a sealed secret. */
export function createPgcfWebhookSubscriptions(deps: {
  readScope: ReadDatabaseScope;
  provider: DatabaseEventsProvider;
  runtime: WebhookLifecycleRuntime;
  cipher: Cipher;
  digest: ReturnType<typeof createEnvironmentSecretCipher>["keyedDigest"];
  now: () => Date;
}) {
  async function run(request: Request): Promise<DatabaseEventOutcome> {
    const target = await resolveDatabaseScope(
      { readScope: deps.readScope, provider: deps.provider },
      request,
    );
    if (!target) return absent;
    const scope = {
      organizationId: request.organizationId,
      projectId: request.projectId,
      environment: request.environment,
      physicalEnvironmentId: target.physicalEnvironmentId,
      providerProjectId: deps.provider.projectId,
      databaseId: target.databaseId,
      subscriptionId: request.subscriptionId,
    };
    if (request.operation === "subscription.status") {
      const result = await deps.runtime.readWebhookSubscription(scope);
      if (result.outcome !== "ok") return mapped(result);
      if (result.head.state === "active") {
        if (!result.head.provider_id) throw new Error("Webhook provider state unavailable");
        try {
          const current = await deps.provider.getWebhook(result.head.provider_id);
          if (!owned(deps.provider, target.databaseId, current))
            throw new Error("Webhook provider state unavailable");
        } catch (error) {
          if (error instanceof PgcfProviderError && error.status === 404)
            throw new Error("Webhook provider state unavailable");
          throw error;
        }
      }
      return { status: "ok", value: wire(request, result.head) };
    }
    const at = () => deps.now().toISOString();
    const hashed = async (purpose: "key" | "request", value: unknown) =>
      hex(
        await deps.digest(
          "request",
          new TextEncoder().encode(
            JSON.stringify([
              "database-webhook-v1",
              purpose,
              scope.organizationId,
              scope.projectId,
              scope.environment,
              value,
            ]),
          ),
        ),
      );
    const keyHash = await hashed("key", request.idempotencyKey),
      base = { ...scope, generation: request.generation, keyHash, now: at() };
    if (request.operation === "subscription.deactivate") {
      const begun = await deps.runtime.beginWebhookDeactivation(base);
      if (begun.outcome !== "ok") return mapped(begun);
      const head = begun.head;
      if (head.state === "inactive") return { status: "ok", value: wire(request, head) };
      if (head.state !== "deactivating" || !head.provider_id)
        throw new Error("Invalid webhook deactivation state");
      const providerId = head.provider_id;
      const providerKey = `omh-wh-${await sha256Hex(JSON.stringify(["subscription-delete", ...Object.values(scope), request.generation]))}`;
      try {
        const found = await deps.provider.getWebhook(providerId);
        if (!owned(deps.provider, target.databaseId, found))
          throw new Error("Webhook ownership changed");
        await deps.provider.deleteWebhook(providerId, { key: providerKey });
      } catch (error) {
        if (!(error instanceof PgcfProviderError && error.status === 404)) {
          if (
            error instanceof PgcfProviderError &&
            error.status === 409 &&
            error.conflictReason === "idempotency_in_progress"
          )
            return refusal("pending");
          throw error;
        }
      }
      const finished = await deps.runtime.finishWebhookDeactivation({ ...base, now: at() });
      if (finished.outcome !== "ok") return mapped(finished);
      return { status: "ok", value: wire(request, finished.head) };
    }
    const headers = Object.fromEntries(
      Object.entries(request.webhook.headers).sort(([a], [b]) => a.localeCompare(b)),
    );
    const requestHash = await hashed("request", [
      request.subscriptionId,
      request.generation,
      request.webhook.url,
      request.webhook.event_types,
      headers,
    ]);
    const activation = { ...base, requestHash };
    let begun = await deps.runtime.beginWebhookActivation({ ...activation, providerIds: null });
    if (begun.outcome === "capacity_required") {
      const listed = await databaseWebhooks(deps.provider, target.databaseId);
      begun = await deps.runtime.beginWebhookActivation({
        ...activation,
        providerIds: listed.webhooks.map((w) => w.id),
      });
    }
    if (begun.outcome !== "ok") return mapped(begun);
    // The first reservation returns no receipt; reread it under the exact key before any provider call.
    if (!begun.receipt)
      begun = await deps.runtime.beginWebhookActivation({
        ...activation,
        now: at(),
        providerIds: null,
      });
    if (begun.outcome !== "ok") return mapped(begun);
    const reserved = begun;
    if (!reserved.receipt) throw new Error("Webhook activation receipt unavailable");
    let receipt = reserved.receipt;
    const cleanOverCap = async (
      providerId: string,
      reason: "webhook_limit" | "idempotency_key_reused" = "webhook_limit",
    ): Promise<DatabaseEventOutcome> => {
      const fenced = await deps.runtime.abortWebhookActivation({
        ...activation,
        now: at(),
        providerId,
        reason,
        confirmed: false,
      });
      if (fenced.outcome !== "ok") return mapped(fenced);
      try {
        const current = await deps.provider.getWebhook(providerId);
        if (!owned(deps.provider, target.databaseId, current))
          throw new Error("Webhook ownership changed");
        await deps.provider.deleteWebhook(providerId, { key: webhookCleanupKey(providerId) });
      } catch (error) {
        if (!(error instanceof PgcfProviderError && error.status === 404)) throw error;
      }
      const finished = await deps.runtime.abortWebhookActivation({
        ...activation,
        now: at(),
        providerId,
        reason,
        confirmed: true,
      });
      return finished.outcome === "ok" ? refusal(reason) : mapped(finished);
    };
    if (
      reserved.head.state === "deactivating" &&
      receipt.provider_id === null &&
      reserved.head.provider_id &&
      receipt.abort_reason
    )
      return cleanOverCap(reserved.head.provider_id, receipt.abort_reason);
    const identity = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.physicalEnvironmentId,
      name: keyName(scope.environment, scope.subscriptionId, request.generation),
    };
    if (reserved.head.state === "creating") {
      // PGCF retains its idempotency response for 24 hours. Never create a second webhook after that fence.
      if (
        deps.now().getTime() - Date.parse(receipt.created_at) >=
        23 * 60 * 60 * 1000 + 55 * 60 * 1000
      )
        return refusal("pending");
      const providerKey = `omh-wh-${await sha256Hex(JSON.stringify(["subscription-create", ...Object.values(scope), request.generation]))}`;
      let created;
      try {
        created = await deps.provider.createWebhook(
          {
            url: request.webhook.url,
            eventTypes: request.webhook.event_types,
            databaseIds: [target.databaseId],
            ...(Object.keys(headers).length ? { headers } : {}),
          },
          { key: providerKey },
        );
      } catch (error) {
        if (error instanceof PgcfProviderError && error.status === 409) {
          if (error.conflictReason === "idempotency_in_progress") return refusal("pending");
          if (error.conflictReason === "idempotency_conflict")
            return refusal("idempotency_key_reused");
          if (error.conflictReason === undefined) return refusal("webhook_limit");
        }
        throw error;
      }
      if (!owned(deps.provider, target.databaseId, created))
        throw new Error("Webhook ownership changed");
      try {
        const live = await deps.provider.getWebhook(created.id);
        if (!owned(deps.provider, target.databaseId, live))
          throw new Error("Webhook ownership changed");
      } catch (error) {
        if (error instanceof PgcfProviderError && error.status === 404)
          return cleanOverCap(created.id, "idempotency_key_reused");
        throw error;
      }
      const all = (await databaseWebhooks(deps.provider, target.databaseId)).webhooks.sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const position = all.findIndex((webhook) => webhook.id === created.id);
      if (position < 0) return refusal("pending");
      if (position >= DATABASE_WEBHOOK_LIMIT) return cleanOverCap(created.id);
      const sealed = await deps.cipher.encrypt({ ...identity, value: created.secret });
      const finished = await deps.runtime.finishWebhookActivation({
        ...activation,
        now: at(),
        providerId: created.id,
        ciphertext: hex(sealed.ciphertext),
        nonce: hex(sealed.nonce),
        valueSha256: hex(sealed.valueSha256),
        keyVersion: sealed.keyVersion,
      });
      if (finished.outcome !== "ok") return mapped(finished);
      if (!finished.receipt) throw new Error("Webhook activation receipt unavailable");
      receipt = finished.receipt;
    }
    if (
      !receipt.provider_id ||
      !receipt.ciphertext ||
      !receipt.nonce ||
      !receipt.value_sha256 ||
      !receipt.key_version
    )
      throw new Error("Webhook activation secret unavailable");
    try {
      if (
        !owned(
          deps.provider,
          target.databaseId,
          await deps.provider.getWebhook(receipt.provider_id),
        )
      )
        throw new Error("Webhook ownership changed");
    } catch (error) {
      if (error instanceof PgcfProviderError && error.status === 404)
        return refusal("idempotency_key_reused");
      throw error;
    }
    const secret = await deps.cipher.decrypt({
      ...identity,
      ciphertext: bytes(receipt.ciphertext),
      nonce: bytes(receipt.nonce),
      valueSha256: bytes(receipt.value_sha256),
      keyVersion: receipt.key_version,
    });
    const confirmed = await deps.runtime.beginWebhookActivation({
      ...activation,
      now: at(),
      providerIds: null,
    });
    if (confirmed.outcome !== "ok") return mapped(confirmed);
    const head = confirmed.head;
    if (head.state !== "active" || head.provider_id !== receipt.provider_id)
      return refusal("pending");
    return {
      status: "ok",
      value: { ...wire(request, head), state: "active", provider_id: receipt.provider_id, secret },
    };
  }
  return { run };
}
