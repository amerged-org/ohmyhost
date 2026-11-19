import {
  parseWorkosWebhookSignature,
  verifyAndParseWorkosWebhook,
  type WorkosWebhookEnvelope,
} from "@ohmyhost/workos-auth-contracts";
import { Hono } from "hono";

import type {
  WorkosWebhookAuthStateProjection,
  WorkosWebhookInboxRecord,
  WorkosWebhookIngressDependencies,
} from "./contracts.js";

const SUPPORTED_EVENTS = new Set([
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "session.revoked",
  "user.deleted",
]);

class IngressFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 409 | 413 | 422 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "IngressFailure";
  }
}

export function createWorkosWebhookIngress(dependencies: WorkosWebhookIngressDependencies): Hono {
  validateDependencies(dependencies);
  const app = new Hono();

  app.post("/webhooks/workos", async (context) => {
    const signatureHeader = context.req.header("workos-signature");
    if (signatureHeader === undefined || signatureHeader.trim() === "") {
      throw new IngressFailure(401, "invalid_webhook_signature");
    }

    const rawBody = await readRawBody(context.req.raw, dependencies.maximumBodyBytes);
    const secret = await resolveSecret(dependencies);
    const now = dependencies.clock.now();
    const additionalSecrets = resolveAdditionalSecrets(dependencies, now);
    let envelope: WorkosWebhookEnvelope;
    let signatureTimestamp: string;
    try {
      const signature = parseWorkosWebhookSignature(signatureHeader);
      signatureTimestamp = new Date(signature.issuedAtMs).toISOString();
      envelope = await verifyAndParseWorkosWebhook({
        rawBody,
        signatureHeader,
        secret,
        additionalSecrets,
        now,
        toleranceMs: dependencies.signatureToleranceMs,
        maximumBodyBytes: dependencies.maximumBodyBytes,
      });
    } catch (error) {
      throw verificationFailure(error);
    }

    const minimized = minimizeSupportedEnvelope(envelope);
    const bodyDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(rawBody)),
    );
    const record: WorkosWebhookInboxRecord = {
      inboxEventId: dependencies.eventIds.next(),
      externalEventId: envelope.id,
      eventType: envelope.event,
      payload: minimized.payload,
      bodyDigest,
      receivedAt: now.toISOString(),
      signatureTimestamp,
      maxAttempts: dependencies.maximumAttempts,
    };

    try {
      const result = await dependencies.inbox.record(record, minimized.authStateProjection);
      const duplicate = result === "existing";
      return context.json({ accepted: true, duplicate }, 200);
    } catch (error) {
      if (hasErrorCode(error, "webhook_event_identity_conflict")) {
        throw new IngressFailure(409, "webhook_event_identity_conflict");
      }
      throw new IngressFailure(503, "webhook_inbox_unavailable");
    }
  });

  app.onError((error, context) => {
    const failure =
      error instanceof IngressFailure
        ? error
        : new IngressFailure(503, "webhook_ingress_unavailable");
    return context.json({ error: failure.code }, failure.status);
  });

  return app;
}

function validateDependencies(dependencies: WorkosWebhookIngressDependencies): void {
  const reference = dependencies.secretReference;
  if (
    reference.kind !== "secret-reference" ||
    reference.provider !== "workos" ||
    reference.purpose !== "webhook-verification" ||
    reference.reference.trim() === ""
  ) {
    throw new TypeError("A WorkOS webhook secret reference is required");
  }
  if (!Number.isSafeInteger(dependencies.maximumBodyBytes) || dependencies.maximumBodyBytes < 1) {
    throw new RangeError("WorkOS webhook body limit must be a positive integer");
  }
  if (
    !Number.isSafeInteger(dependencies.signatureToleranceMs) ||
    dependencies.signatureToleranceMs < 0
  ) {
    throw new RangeError("WorkOS webhook signature tolerance must be a non-negative integer");
  }
  if (!Number.isSafeInteger(dependencies.maximumAttempts) || dependencies.maximumAttempts < 1) {
    throw new RangeError("WorkOS webhook maximum attempts must be a positive integer");
  }
}

async function resolveSecret(dependencies: WorkosWebhookIngressDependencies): Promise<string> {
  try {
    const secret = await dependencies.secretResolver.resolve(dependencies.secretReference);
    if (typeof secret !== "string" || secret.length === 0) throw new Error("empty secret");
    return secret;
  } catch {
    throw new IngressFailure(503, "webhook_secret_unavailable");
  }
}

function resolveAdditionalSecrets(
  dependencies: WorkosWebhookIngressDependencies,
  now: Date,
): readonly string[] {
  try {
    const additional = dependencies.secretResolver.resolveAdditional
      ? dependencies.secretResolver.resolveAdditional(dependencies.secretReference, now)
      : [];
    if (
      !Array.isArray(additional) ||
      additional.length > 1 ||
      (additional.length === 1 && (typeof additional[0] !== "string" || additional[0].length === 0))
    )
      throw new Error("invalid additional secret capability");
    return additional;
  } catch {
    throw new IngressFailure(503, "webhook_secret_unavailable");
  }
}

async function readRawBody(request: Request, maximumBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new IngressFailure(400, "invalid_content_length");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new IngressFailure(400, "invalid_content_length");
    }
    if (parsedLength > maximumBodyBytes) {
      throw new IngressFailure(413, "webhook_body_too_large");
    }
  }
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      length += chunk.byteLength;
      if (length > maximumBodyBytes) {
        await reader.cancel();
        throw new IngressFailure(413, "webhook_body_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function minimizeSupportedEnvelope(envelope: WorkosWebhookEnvelope): {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly authStateProjection?: WorkosWebhookAuthStateProjection;
} {
  if (!SUPPORTED_EVENTS.has(envelope.event)) {
    throw new IngressFailure(422, "unsupported_webhook_event");
  }
  const sourceEventId = requiredProviderId(envelope.id);
  if (envelope.event === "session.revoked") {
    const workosOrganizationId = optionalProviderId(envelope.data["organization_id"]);
    return {
      payload: { schemaVersion: "workos.authentication-state.v1" },
      authStateProjection: {
        kind: "session-revocation",
        sessionId: requiredProviderId(envelope.data["id"]),
        workosUserId: requiredProviderId(envelope.data["user_id"]),
        ...(workosOrganizationId === undefined ? {} : { workosOrganizationId }),
        sourceEventId,
        effectiveAt: envelope.createdAt,
      },
    };
  }
  if (envelope.event === "user.deleted") {
    return {
      payload: { schemaVersion: "workos.authentication-state.v1" },
      authStateProjection: {
        kind: "user-revocation",
        workosUserId: requiredProviderId(envelope.data["id"]),
        sourceEventId,
        effectiveAt: envelope.createdAt,
      },
    };
  }
  const workosOrganizationId = envelope.event.startsWith("organization_membership.")
    ? requiredProviderId(envelope.data["organization_id"])
    : requiredProviderId(envelope.data["id"]);
  const payload = {
    payload: {
      schemaVersion: "workos.organization-trigger.v1",
      workosOrganizationId,
    },
  };
  if (envelope.event === "organization.deleted") {
    return {
      ...payload,
      authStateProjection: {
        kind: "organization-revocation",
        workosOrganizationId,
        sourceEventId,
        effectiveAt: envelope.createdAt,
      },
    };
  }
  if (
    envelope.event === "organization_membership.updated" ||
    envelope.event === "organization_membership.deleted"
  ) {
    return {
      ...payload,
      authStateProjection: {
        kind: "membership-barrier",
        workosOrganizationId,
        workosUserId: requiredProviderId(envelope.data["user_id"]),
        sourceEventId,
        eventCreatedAt: envelope.createdAt,
      },
    };
  }
  return payload;
}

function requiredProviderId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 255 ||
    /\s/u.test(value)
  ) {
    throw new IngressFailure(422, "invalid_webhook_resource_identity");
  }
  return value;
}

function optionalProviderId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredProviderId(value);
}

function verificationFailure(error: unknown): IngressFailure {
  const code = hasStringCode(error) ? error.code : "invalid_webhook_payload";
  if (
    code === "invalid_signature_header" ||
    code === "invalid_webhook_signature" ||
    code === "webhook_timestamp_outside_tolerance" ||
    code === "invalid_webhook_secret"
  ) {
    return new IngressFailure(401, "invalid_webhook_signature");
  }
  if (code === "webhook_body_too_large") {
    return new IngressFailure(413, "webhook_body_too_large");
  }
  return new IngressFailure(400, "invalid_webhook_payload");
}

function hasStringCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  );
}

function hasErrorCode(value: unknown, code: string): boolean {
  return hasStringCode(value) && value.code === code;
}
