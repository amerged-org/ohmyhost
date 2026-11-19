import {
  parseGitHubInstallationWebhook,
  parseGitHubPushWebhook,
  verifyGitHubWebhookSignature,
} from "@ohmyhost/provider-github/webhooks";
import { Hono } from "hono";

import type { GithubWebhookIngressDependencies } from "./contracts.js";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;
const MAXIMUM_EXTERNAL_OPERATION_TIMEOUT_MS = 9_000;

interface GithubExternalDeadline {
  readonly signal: AbortSignal;
  readonly expired: Promise<void>;
  clear(): void;
}

class GithubIngressFailure extends Error {
  constructor(
    readonly status: 400 | 401 | 409 | 413 | 415 | 422 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "GithubIngressFailure";
  }
}

export function createGithubWebhookIngress(dependencies: GithubWebhookIngressDependencies): Hono {
  validateGithubDependencies(dependencies);
  const app = new Hono();

  app.post("/webhooks/github", async (context) => {
    const deadline = createGithubExternalDeadline(dependencies.externalOperationTimeoutMs);
    try {
      const signatureHeader = context.req.header("x-hub-signature-256");
      if (signatureHeader === undefined || signatureHeader.trim() === "") {
        throw new GithubIngressFailure(401, "invalid_webhook_signature");
      }
      const deliveryId = requiredHeader(context.req.header("x-github-delivery"), DELIVERY_ID);
      const eventName = requiredHeader(context.req.header("x-github-event"), EVENT_NAME);
      validateContentEncoding(context.req.header("content-encoding"));

      const rawBody = await readGithubRawBody(
        context.req.raw,
        dependencies.maximumBodyBytes,
        deadline,
      );
      const secret = await resolveGithubSecret(dependencies, deadline);
      const verificationNow = dependencies.clock.now();
      const additionalSecrets = resolveGithubAdditionalSecrets(
        dependencies,
        deadline,
        verificationNow,
      );
      try {
        await verifyGitHubWebhookSignature({
          body: rawBody,
          signatureHeader,
          secret,
          additionalSecrets,
          maxBodyBytes: dependencies.maximumBodyBytes,
        });
      } catch (error) {
        throw githubVerificationFailure(error);
      }

      if (deadline.signal.aborted) {
        throw new GithubIngressFailure(503, "webhook_ingress_unavailable");
      }
      if (eventName === "ping") {
        return context.json({ accepted: true, ignored: true }, 200);
      }
      // Installation notifications are not customer consent and never authorize a source link. Only an event that
      // withdraws access is recorded, by ids, so the Core can revoke the grants it covers.
      let eventType: "push" | "installation" | "installation_repositories";
      let eventPayload: Record<string, unknown>;
      if (eventName === "installation" || eventName === "installation_repositories") {
        let trigger: ReturnType<typeof parseGitHubInstallationWebhook>;
        try {
          trigger = parseGitHubInstallationWebhook({ eventName, body: rawBody });
        } catch {
          throw new GithubIngressFailure(400, "invalid_webhook_payload");
        }
        if (trigger === null) return context.json({ accepted: true, ignored: true }, 200);
        eventType = trigger.eventName;
        eventPayload = {
          schemaVersion: trigger.schemaVersion,
          action: trigger.action,
          installationId: trigger.installationId,
          removedRepositoryIds: [...trigger.removedRepositoryIds],
        };
      } else {
        if (eventName !== "push") {
          throw new GithubIngressFailure(422, "unsupported_webhook_event");
        }
        let payload: ReturnType<typeof parseGitHubPushWebhook>;
        try {
          payload = parseGitHubPushWebhook({ deliveryId, eventName, body: rawBody });
        } catch {
          throw new GithubIngressFailure(400, "invalid_webhook_payload");
        }
        eventType = "push";
        eventPayload = {
          schemaVersion: payload.schemaVersion,
          installationId: payload.installationId,
          repositoryId: payload.repositoryId,
          repositoryFullName: payload.repositoryFullName,
          ref: payload.ref,
          beforeCommitSha: payload.beforeCommitSha,
          commitSha: payload.commitSha ?? null,
          deleted: payload.deleted,
        };
      }
      const now = verificationNow;
      if (!Number.isFinite(now.getTime())) {
        throw new GithubIngressFailure(503, "webhook_ingress_unavailable");
      }
      const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawBody));

      try {
        const result = await awaitGithubExternalOperation(
          dependencies.inbox.record(
            {
              inboxEventId: dependencies.eventIds.next(),
              externalEventId: deliveryId,
              eventType,
              payload: eventPayload,
              bodyDigest,
              receivedAt: now.toISOString(),
              maxAttempts: dependencies.maximumAttempts,
            },
            deadline.signal,
          ),
          deadline,
          "webhook_inbox_unavailable",
        );
        const duplicate = result === "existing";
        return context.json({ accepted: true, duplicate }, duplicate ? 200 : 202);
      } catch (error) {
        if (hasCode(error, "webhook_event_identity_conflict")) {
          throw new GithubIngressFailure(409, "webhook_event_identity_conflict");
        }
        throw new GithubIngressFailure(503, "webhook_inbox_unavailable");
      }
    } finally {
      deadline.clear();
    }
  });

  app.onError((error, context) => {
    const failure =
      error instanceof GithubIngressFailure
        ? error
        : new GithubIngressFailure(503, "webhook_ingress_unavailable");
    return context.json({ error: failure.code }, failure.status);
  });

  return app;
}

function validateGithubDependencies(dependencies: GithubWebhookIngressDependencies): void {
  const reference = dependencies.secretReference;
  if (
    reference.kind !== "secret-reference" ||
    reference.provider !== "github" ||
    reference.purpose !== "webhook-verification" ||
    reference.reference.trim() === ""
  ) {
    throw new TypeError("A GitHub webhook secret reference is required");
  }
  if (!Number.isSafeInteger(dependencies.maximumBodyBytes) || dependencies.maximumBodyBytes < 1) {
    throw new RangeError("GitHub webhook body limit must be a positive integer");
  }
  if (!Number.isSafeInteger(dependencies.maximumAttempts) || dependencies.maximumAttempts < 1) {
    throw new RangeError("GitHub webhook maximum attempts must be a positive integer");
  }
  if (
    !Number.isSafeInteger(dependencies.externalOperationTimeoutMs) ||
    dependencies.externalOperationTimeoutMs < 1 ||
    dependencies.externalOperationTimeoutMs > MAXIMUM_EXTERNAL_OPERATION_TIMEOUT_MS
  ) {
    throw new RangeError("GitHub webhook external operation timeout must be between 1 and 9000ms");
  }
}

function requiredHeader(value: string | undefined, pattern: RegExp): string {
  if (value === undefined || !pattern.test(value)) {
    throw new GithubIngressFailure(400, "invalid_webhook_headers");
  }
  return value;
}

function validateContentEncoding(value: string | undefined): void {
  if (value !== undefined && value.toLowerCase() !== "identity") {
    throw new GithubIngressFailure(415, "unsupported_content_encoding");
  }
}

async function resolveGithubSecret(
  dependencies: GithubWebhookIngressDependencies,
  deadline: GithubExternalDeadline,
): Promise<Uint8Array> {
  try {
    const secret = await awaitGithubExternalOperation(
      dependencies.secretResolver.resolve(dependencies.secretReference, deadline.signal),
      deadline,
      "webhook_secret_unavailable",
    );
    if (!(secret instanceof Uint8Array) || secret.byteLength === 0) {
      throw new Error("invalid secret capability");
    }
    return secret;
  } catch {
    throw new GithubIngressFailure(503, "webhook_secret_unavailable");
  }
}

function resolveGithubAdditionalSecrets(
  dependencies: GithubWebhookIngressDependencies,
  deadline: GithubExternalDeadline,
  now: Date,
): readonly Uint8Array[] {
  try {
    const additional = dependencies.secretResolver.resolveAdditional
      ? dependencies.secretResolver.resolveAdditional(
          dependencies.secretReference,
          now,
          deadline.signal,
        )
      : [];
    if (
      !Array.isArray(additional) ||
      additional.length > 1 ||
      (additional.length === 1 &&
        (!(additional[0] instanceof Uint8Array) || additional[0].byteLength === 0))
    )
      throw new Error("invalid additional secret capability");
    return additional;
  } catch {
    throw new GithubIngressFailure(503, "webhook_secret_unavailable");
  }
}

async function readGithubRawBody(
  request: Request,
  maximumBodyBytes: number,
  deadline: GithubExternalDeadline,
): Promise<Uint8Array<ArrayBuffer>> {
  if (deadline.signal.aborted) {
    throw new GithubIngressFailure(503, "webhook_ingress_timeout");
  }
  if (request.signal.aborted) throw new GithubIngressFailure(400, "webhook_request_aborted");
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && !/^\d+$/u.test(declaredLength)) {
    throw new GithubIngressFailure(400, "invalid_content_length");
  }
  const parsedLength = declaredLength === null ? undefined : Number(declaredLength);
  if (parsedLength !== undefined && !Number.isSafeInteger(parsedLength)) {
    throw new GithubIngressFailure(400, "invalid_content_length");
  }
  if (parsedLength !== undefined && parsedLength > maximumBodyBytes) {
    throw new GithubIngressFailure(413, "webhook_body_too_large");
  }
  if (request.body === null) throw new GithubIngressFailure(400, "invalid_webhook_payload");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abortRequest = (): void => void reader.cancel();
  const abortDeadline = (): void => void reader.cancel();
  request.signal.addEventListener("abort", abortRequest, { once: true });
  deadline.signal.addEventListener("abort", abortDeadline, { once: true });
  try {
    while (true) {
      if (deadline.signal.aborted) {
        throw new GithubIngressFailure(503, "webhook_ingress_timeout");
      }
      if (request.signal.aborted) {
        throw new GithubIngressFailure(400, "webhook_request_aborted");
      }
      const result = await reader.read();
      if (deadline.signal.aborted) {
        throw new GithubIngressFailure(503, "webhook_ingress_timeout");
      }
      if (request.signal.aborted) {
        throw new GithubIngressFailure(400, "webhook_request_aborted");
      }
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBodyBytes) {
        await reader.cancel();
        throw new GithubIngressFailure(413, "webhook_body_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    request.signal.removeEventListener("abort", abortRequest);
    deadline.signal.removeEventListener("abort", abortDeadline);
    reader.releaseLock();
  }
  if (parsedLength !== undefined && length !== parsedLength) {
    throw new GithubIngressFailure(400, "invalid_content_length");
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function createGithubExternalDeadline(timeoutMs: number): GithubExternalDeadline {
  const controller = new AbortController();
  let expire: (() => void) | undefined;
  const expired = new Promise<void>((resolve) => {
    expire = resolve;
  });
  const timer = setTimeout(() => {
    expire?.();
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    expired,
    clear() {
      clearTimeout(timer);
    },
  };
}

async function awaitGithubExternalOperation<Result>(
  operation: Promise<Result>,
  deadline: GithubExternalDeadline,
  timeoutCode: "webhook_secret_unavailable" | "webhook_inbox_unavailable",
): Promise<Result> {
  return await Promise.race([
    operation,
    deadline.expired.then(() => {
      throw new GithubIngressFailure(503, timeoutCode);
    }),
  ]);
}

function githubVerificationFailure(error: unknown): GithubIngressFailure {
  if (hasCode(error, "webhook_body_too_large")) {
    return new GithubIngressFailure(413, "webhook_body_too_large");
  }
  return new GithubIngressFailure(401, "invalid_webhook_signature");
}

function hasCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    value.code === code
  );
}
