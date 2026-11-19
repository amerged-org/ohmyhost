import { createD1ReceivedBillingPersistence } from "./d1-received-billing-persistence.js";
import { createD1WarningPersistence } from "./d1-warning-persistence.js";
import { createD1ReceivingAdmissionPersistence } from "./receiving-admission-persistence.js";
import { createD1WorkspaceMailCapabilityPersistence } from "@ohmyhost/database";
import {
  createD1InboundPersistence,
  createD1DeliveryCommands,
  authorizeD1InboundKey,
} from "./d1-inbound-persistence.js";
import { createD1InfrastructurePersistence } from "./d1-infrastructure-persistence.js";
import { createD1ResendSendPersistence } from "./d1-resend-send-persistence.js";
import {
  createMailEntrypoint,
  boundedMailBody,
  reportMailSendUnavailable,
  MAIL_EGRESS_CALLER,
  DATABASE_MAIL_CALLER,
  type MailCallerRole,
  type MailSendPhase,
} from "./mail-entrypoint.js";
import { syncResendReceivingAdmission } from "./resend-admission.js";
import { createHash } from "node:crypto";
import { WorkerEntrypoint } from "cloudflare:workers";
import { SystemClock, SystemEntropy, createUlidFactory, parseUlid } from "@ohmyhost/platform";
import { createResendMailSender } from "./resend-send.js";
import { createNativeAuthMail } from "./native-auth-mail.js";
import { createNativePreviewAuthMail } from "./native-preview-auth-mail.js";
import { createProductPreviewAuthMail } from "./product-preview-auth-mail.js";
import type { ProjectPreviewRuntime } from "@ohmyhost/contracts/previews";
import {
  createInboundMailDelivery,
  MailContentExpiredError,
  MailAttachmentTooLargeError,
} from "./inbound-delivery.js";
import { createCreditWarningDispatcher } from "./credit-warning-dispatch.js";
import { createResendCreditWarningSender } from "./resend-credit-warning.js";
import { createInfrastructureAlertReceiver } from "./infrastructure-alerts.js";
import {
  createSignupFeedbackDispatcher,
  createSignupFeedbackSender,
} from "./signup-feedback-dispatch.js";
import { createD1SignupFeedbackPersistence } from "./d1-signup-feedback-persistence.js";
interface ResendGatewayBindings {
  RUNTIME_CONFIGURATION_STATE: "configured";
  MAIL_SEND_RUNTIME: unknown;
  MAIL_INFRASTRUCTURE_RUNTIME: unknown;
  MAIL_DELIVERY_RUNTIME: unknown;
  MAIL_WARNING_RUNTIME: unknown;
  MAIL_CAPABILITY_RUNTIME: unknown;
  RESEND_API_KEY: string;
  RESEND_PLATFORM_WARNING_API_KEY: string;
  MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: string;
  MAIL_WEBHOOK_SIGNING_KEY: string;
  PLATFORM_ENVIRONMENT: "development" | "production";
  CREDIT_WARNING_RECIPIENTS: { resolve(input: unknown): Promise<unknown> };
  SIGNUP_FEEDBACK_STORE?: unknown;
  SIGNUP_FEEDBACK_REPLY_TO?: string;
  SIGNUP_FEEDBACK_SENDER_NAME?: string;
  SIGNUP_FEEDBACK_PROFILE_URL?: string;
  SIGNUP_FEEDBACK_RECIPIENTS?: {
    resolve(input: { userId: string; claimToken: string }): Promise<unknown>;
  };
  PGCF_CAPACITY_WEBHOOK_SECRET?: string;
  PGCF_CAPACITY_ALERT_RECIPIENT?: string;
  NATIVE_AUTH_MAIL_AUTHORITY?: { authorizeNativeMail(input: unknown): Promise<unknown> };
  PROJECT_PREVIEW_AUTHORITY?: Pick<ProjectPreviewRuntime, "resolveTokenHash" | "authorizeRuntime">;
  QA_STABLE_PREVIEW_AUTHORITY?: { resolve(input: unknown): Promise<unknown> };
  QA_NATIVE_PREVIEW_MAIL_ENABLED?: string;
  QA_NATIVE_PREVIEW_MAIL_SCOPE?: string;
}
export async function sendResendRequest(
  request: Request,
  env: ResendGatewayBindings,
  trustedProjectId?: string,
  role?: MailCallerRole,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/attachments/download") {
    if (trustedProjectId === undefined || role !== MAIL_EGRESS_CALLER)
      return Response.json({ code: "resource_not_found" }, { status: 404 });
    return readRuntimeAttachmentRequest(request, env, trustedProjectId);
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/projects/"))
    return readRuntimeMailRequest(request, env);
  if (request.method !== "POST" || url.pathname !== "/v1/send" || url.search)
    return Response.json({ code: "resource_not_found" }, { status: 404 });
  const authorization = request.headers.get("authorization"),
    idempotencyKey = request.headers.get("idempotency-key");
  if (
    !authorization?.startsWith("Bearer ") ||
    !idempotencyKey ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return Response.json({ code: "invalid_request" }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw Error();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 262144) throw Error();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<
      string,
      unknown
    >;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["project_id", "from", "reply_to", "to", "subject", "text", "html"].includes(key),
      ) ||
      !["project_id", "to", "subject", "text"].every((key) => typeof body[key] === "string") ||
      Object.values(body).some((value) => typeof value !== "string")
    )
      throw Error();
  } catch {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }
  if (trustedProjectId !== undefined && body["project_id"] !== trustedProjectId)
    return Response.json({ code: "unauthorized" }, { status: 401 });
  const clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  let phase: MailSendPhase = "readiness";
  let runtimeNotConfigured = false;
  try {
    if (env.RUNTIME_CONFIGURATION_STATE !== "configured") {
      runtimeNotConfigured = true;
      throw new Error("Mail runtime unavailable");
    }
    phase = "initialization";
    const persistence = await createD1ResendSendPersistence(env.MAIL_SEND_RUNTIME);
    const sender = createResendMailSender({
      persistence,
      sendingKeyEncryptionKey: env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
      ids,
      now: () => clock.now(),
    });
    phase = "send";
    const result = await sender.send({
      projectId: String(body["project_id"]),
      to: String(body["to"]),
      subject: String(body["subject"]),
      text: String(body["text"]),
      key: authorization.slice(7),
      idempotencyKey,
      ...(typeof body["from"] === "string" ? { from: body["from"] } : {}),
      ...(typeof body["reply_to"] === "string" ? { replyTo: body["reply_to"] } : {}),
      ...(typeof body["html"] === "string" ? { html: body["html"] } : {}),
    });
    if (result.status === "unauthorized")
      return Response.json({ code: "unauthorized" }, { status: 401 });
    if (result.status === "rejected")
      return Response.json(
        { code: "mail_rejected", request_id: result.requestId },
        { status: 502 },
      );
    return Response.json(
      {
        state: result.status,
        request_id: result.requestId,
        ...(result.status === "accepted" ? { message_id: result.providerMessageId } : {}),
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "mail_gateway_unavailable";
    const statuses: Record<string, number> = {
      paid_plan_required: 402,
      insufficient_organization_credits: 402,
      project_budget_exceeded: 402,
      mail_send_daily_limit: 429,
      mail_reputation_suspended: 423,
      mail_send_conflict: 409,
    };
    const status = statuses[code] ?? (error instanceof TypeError ? 400 : 503);
    if (status === 503) reportMailSendUnavailable(phase, error, runtimeNotConfigured);
    return Response.json(
      {
        code: statuses[code]
          ? code
          : error instanceof TypeError
            ? "invalid_request"
            : "mail_gateway_unavailable",
      },
      { status },
    );
  }
}
export async function invokeResendDelivery(
  env: ResendGatewayBindings,
  operation: "list" | "content" | "attachment" | "deliver" | "sync",
  raw: unknown,
) {
  const clock = new SystemClock();
  try {
    if (env.RUNTIME_CONFIGURATION_STATE !== "configured")
      throw new Error("Mail runtime unavailable");
    const inboundPersistence = await createD1InboundPersistence(env.MAIL_DELIVERY_RUNTIME),
      commands = await createD1DeliveryCommands(env.MAIL_DELIVERY_RUNTIME);
    const service = createInboundMailDelivery({
      persistence: inboundPersistence,
      apiKey: env.RESEND_API_KEY,
      signingKey: env.MAIL_WEBHOOK_SIGNING_KEY,
      now: () => clock.now(),
    });
    if (operation === "sync") return await service.sync();
    if (typeof raw !== "object" || raw === null) throw new TypeError("Invalid mail request");
    const r = raw as Record<string, unknown>;
    const scope = {
      organizationId: parseUlid(String(r["organizationId"])),
      projectId: parseUlid(String(r["projectId"])),
      environmentId: parseUlid(String(r["environmentId"])),
    };
    if (operation === "list")
      return await service.list({
        ...scope,
        ...(typeof r["after"] === "string" ? { after: r["after"] } : {}),
      });
    const messageId = parseUlid(String(r["messageId"]));
    if (operation === "content") return await service.content({ ...scope, messageId });
    if (operation === "attachment") {
      return await service.attachment({
        ...scope,
        messageId,
        attachmentId: String(r["attachmentId"]),
      });
    }
    const idempotencyKey = r["idempotencyKey"];
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey))
      throw new TypeError("Invalid retry idempotency key");
    if (
      !(await inboundPersistence.read(() => ({
        ...scope,
        messageId,
        now: clock.now().toISOString(),
      })))
    )
      return null;
    const key = createHash("sha256").update(`retry:${messageId}:${idempotencyKey}`).digest("hex");
    const digest = createHash("sha256")
      .update(JSON.stringify({ operation: "retry", messageId, principalId: r["principalId"] }))
      .digest();
    const command = await commands.accept(() => ({
      ...scope,
      key,
      digest,
      now: clock.now().toISOString(),
    }));
    if (!command.created) {
      if (command.response) return command.response;
      if (command.claimedAttempt !== null) return { attempted: true };
      if (!(await commands.resume(() => ({ ...scope, key, now: clock.now().toISOString() }))))
        throw new Error("mail_operation_pending");
    }
    const result = await service.deliver({ ...scope, messageId, manual: true, commandKey: key });
    await commands.complete(() => ({
      ...scope,
      key,
      response: result,
      now: clock.now().toISOString(),
    }));
    return result;
  } catch (error) {
    if (error instanceof MailContentExpiredError) return { status: "expired" };
    throw error;
  }
}
export class ResendMailDeliveryService extends WorkerEntrypoint<ResendGatewayBindings> {
  public listMailMessages(input: unknown) {
    return invokeResendDelivery(this.env, "list", input);
  }
  public getMailMessage(input: unknown) {
    return invokeResendDelivery(this.env, "content", input);
  }
  public getMailAttachment(input: unknown) {
    return invokeResendDelivery(this.env, "attachment", input);
  }
  public retryMailMessage(input: unknown) {
    return invokeResendDelivery(this.env, "deliver", input);
  }
  public syncMail() {
    return invokeResendDelivery(this.env, "sync", {});
  }
}
/** Private service-binding entrypoint; ordinary customer mail ingress is unchanged. */
export class InfrastructureAlertsService extends WorkerEntrypoint<ResendGatewayBindings> {
  public async fetch(request: Request): Promise<Response> {
    if (!this.env.PGCF_CAPACITY_WEBHOOK_SECRET || !this.env.PGCF_CAPACITY_ALERT_RECIPIENT)
      return Response.json({ code: "infrastructure_alert_unavailable" }, { status: 503 });
    try {
      if (this.env.RUNTIME_CONFIGURATION_STATE !== "configured")
        throw new Error("Mail runtime unavailable");
      return await createInfrastructureAlertReceiver({
        persistence: await createD1InfrastructurePersistence(this.env.MAIL_INFRASTRUCTURE_RUNTIME),
        secret: this.env.PGCF_CAPACITY_WEBHOOK_SECRET,
        recipient: this.env.PGCF_CAPACITY_ALERT_RECIPIENT,
        apiKey: this.env.RESEND_PLATFORM_WARNING_API_KEY,
        platform: this.env.PLATFORM_ENVIRONMENT,
      }).fetch(request);
    } catch {
      return Response.json({ code: "infrastructure_alert_unavailable" }, { status: 503 });
    }
  }
}

/** Native runtime only: customer applications never receive this service binding or a mail key. */
export class NativeAuthMailService extends WorkerEntrypoint<ResendGatewayBindings> {
  public async sendNativeAuthMail(raw: unknown) {
    try {
      if (
        this.env.RUNTIME_CONFIGURATION_STATE !== "configured" ||
        !this.env.NATIVE_AUTH_MAIL_AUTHORITY
      )
        throw new Error("native_mail_unavailable");
      const authority = this.env.NATIVE_AUTH_MAIL_AUTHORITY;
      const clock = new SystemClock();
      const sender = createResendMailSender({
        persistence: await createD1ResendSendPersistence(this.env.MAIL_SEND_RUNTIME),
        sendingKeyEncryptionKey: this.env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
        ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
        now: () => clock.now(),
      });
      return await createNativeAuthMail({
        authorize: (request) =>
          authority.authorizeNativeMail({
            organizationId: request.organizationId,
            projectId: request.projectId,
            environmentId: request.environmentId,
          }),
        send: (request, project) => sender.send(request, project),
      })(raw);
    } catch {
      // RPC errors never carry recipient, token, provider output or message content.
      throw new Error("native_mail_unavailable");
    }
  }
}

/** Development QA only; production profiles have no Preview authority or recipient scope. */
export class NativePreviewAuthMailService extends WorkerEntrypoint<ResendGatewayBindings> {
  public async sendNativePreviewAuthMail(raw: unknown) {
    try {
      if (
        this.env.RUNTIME_CONFIGURATION_STATE !== "configured" ||
        this.env.PLATFORM_ENVIRONMENT !== "development" ||
        this.env.QA_NATIVE_PREVIEW_MAIL_ENABLED !== "development-only-v1" ||
        !this.env.NATIVE_AUTH_MAIL_AUTHORITY ||
        !this.env.QA_STABLE_PREVIEW_AUTHORITY ||
        typeof this.env.QA_NATIVE_PREVIEW_MAIL_SCOPE !== "string"
      )
        throw new Error("native_mail_unavailable");
      const authority = this.env.NATIVE_AUTH_MAIL_AUTHORITY;
      const preview = this.env.QA_STABLE_PREVIEW_AUTHORITY;
      const clock = new SystemClock();
      const sender = createResendMailSender({
        persistence: await createD1ResendSendPersistence(this.env.MAIL_SEND_RUNTIME),
        sendingKeyEncryptionKey: this.env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
        ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
        now: () => clock.now(),
      });
      return await createNativePreviewAuthMail({
        scope: this.env.QA_NATIVE_PREVIEW_MAIL_SCOPE,
        resolve: (identity) => preview.resolve(identity),
        authorize: (scope) => authority.authorizeNativeMail(scope),
        send: (request, project) => sender.send(request, project),
      })(raw);
    } catch {
      // Never expose a recipient, token, authorization reply or provider detail through RPC.
      throw new Error("native_mail_unavailable");
    }
  }
}
/** Bound only to the trusted Native Auth runtime, including platform Production. */
export class NativeProductPreviewAuthMailService extends WorkerEntrypoint<ResendGatewayBindings> {
  public async sendNativePreviewAuthMail(raw: unknown) {
    try {
      if (
        this.env.RUNTIME_CONFIGURATION_STATE !== "configured" ||
        !this.env.NATIVE_AUTH_MAIL_AUTHORITY ||
        !this.env.PROJECT_PREVIEW_AUTHORITY
      )
        throw new Error("native_mail_unavailable");
      const authority = this.env.NATIVE_AUTH_MAIL_AUTHORITY;
      const clock = new SystemClock();
      const sender = createResendMailSender({
        persistence: await createD1ResendSendPersistence(this.env.MAIL_SEND_RUNTIME),
        sendingKeyEncryptionKey: this.env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
        ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
        now: () => clock.now(),
      });
      return await createProductPreviewAuthMail({
        platform: this.env.PLATFORM_ENVIRONMENT,
        preview: this.env.PROJECT_PREVIEW_AUTHORITY,
        authorize: (scope) => authority.authorizeNativeMail(scope),
        send: (request, project) => sender.send(request, project),
      })(raw);
    } catch {
      throw new Error("native_mail_unavailable");
    }
  }
}

export async function syncResendMail(env: ResendGatewayBindings) {
  const clock = new SystemClock();
  if (env.RUNTIME_CONFIGURATION_STATE !== "configured") throw new Error("Mail runtime unavailable");
  // Isolate this gated campaign from all other scheduled mail work.
  if (env.SIGNUP_FEEDBACK_STORE && env.SIGNUP_FEEDBACK_RECIPIENTS) {
    try {
      const replyTo = env.SIGNUP_FEEDBACK_REPLY_TO?.trim();
      const senderName = env.SIGNUP_FEEDBACK_SENDER_NAME?.trim();
      const profileUrl = env.SIGNUP_FEEDBACK_PROFILE_URL?.trim();
      if (!replyTo || !senderName) throw new Error("Signup feedback sender is not configured");
      const feedback = await createSignupFeedbackDispatcher({
        store: createD1SignupFeedbackPersistence(env.SIGNUP_FEEDBACK_STORE),
        recipients: env.SIGNUP_FEEDBACK_RECIPIENTS,
        now: () => clock.now(),
        sender: createSignupFeedbackSender({
          apiKey: env.RESEND_PLATFORM_WARNING_API_KEY,
          platform: env.PLATFORM_ENVIRONMENT,
          replyTo,
          senderName,
          ...(profileUrl ? { profileUrl } : {}),
        }),
      }).sync();
      console.info("signup_feedback_batch", feedback);
    } catch {
      console.error("signup_feedback_batch_unavailable");
    }
  } else if (
    env.PLATFORM_ENVIRONMENT === "production" ||
    env.PLATFORM_ENVIRONMENT === "development"
  ) {
    console.error("signup_feedback_bindings_unavailable");
  }
  const received = await createD1ReceivedBillingPersistence(env.MAIL_DELIVERY_RUNTIME),
    warningPersistence = await createD1WarningPersistence(env.MAIL_WARNING_RUNTIME),
    admissionPersistence = await createD1ReceivingAdmissionPersistence(env.MAIL_DELIVERY_RUNTIME),
    capabilities = await createD1WorkspaceMailCapabilityPersistence(env.MAIL_CAPABILITY_RUNTIME);
  const ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const unbilled = await received.unbilled();
  const billing = { billed: 0, failed: 0 };
  for (const messageId of unbilled)
    try {
      await received.bill(() => ({
        messageId,
        valuationId: ids.next(),
        now: clock.now().toISOString(),
      }));
      billing.billed += 1;
    } catch {
      // One unbillable message must not stop billing, admission and delivery for every tenant.
      billing.failed += 1;
    }
  console.info("resend_received_billing", billing);
  const admission = await syncResendReceivingAdmission({
    persistence: admissionPersistence,
    capabilities,
    apiKey: env.RESEND_API_KEY,
    ids,
    now: () => clock.now(),
  });
  console.info("resend_receiving_admission", admission);
  const delivery = await invokeResendDelivery(env, "sync", {});
  console.info("resend_mail_delivery_batch", delivery);
  const warnings = await createCreditWarningDispatcher({
    persistence: warningPersistence,
    now: () => clock.now(),
    recipients: env.CREDIT_WARNING_RECIPIENTS,
    sender: createResendCreditWarningSender({
      apiKey: env.RESEND_PLATFORM_WARNING_API_KEY,
      platform: env.PLATFORM_ENVIRONMENT,
      now: () => clock.now(),
    }),
  }).sync();
  return { billing, delivery, warnings };
}
export const MailEgressEntrypoint = createMailEntrypoint(sendResendRequest, MAIL_EGRESS_CALLER);
export const DatabaseMailEntrypoint = createMailEntrypoint(sendResendRequest, DATABASE_MAIL_CALLER);
export default {
  fetch: (request: Request, env: ResendGatewayBindings) => sendResendRequest(request, env),
  scheduled(_controller: unknown, env: ResendGatewayBindings) {
    return syncResendMail(env);
  },
};

export async function readRuntimeMailRequest(
  request: Request,
  env: ResendGatewayBindings,
): Promise<Response> {
  const url = new URL(request.url),
    match =
      /^\/v1\/projects\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/environments\/([0-7][0-9A-HJKMNP-TV-Z]{25})\/mail\/messages\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/attachments\/([A-Za-z0-9_-]{1,128}))?$/u.exec(
        url.pathname,
      );
  if (request.method !== "GET" || url.search || !match)
    return Response.json({ code: "resource_not_found" }, { status: 404 });
  const key = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (!key) return Response.json({ code: "unauthorized" }, { status: 401 });
  try {
    if (env.RUNTIME_CONFIGURATION_STATE !== "configured")
      throw new Error("Mail runtime unavailable");
    const persistence = await createD1InboundPersistence(env.MAIL_DELIVERY_RUNTIME);
    const project = await authorizeD1InboundKey(env.MAIL_DELIVERY_RUNTIME, {
      projectId: parseUlid(String(match[1])),
      keySha256: new Uint8Array(createHash("sha256").update(key).digest()),
    });
    if (!project || project.environmentId !== match[2])
      return Response.json({ code: "unauthorized" }, { status: 401 });
    const service = createInboundMailDelivery({
      persistence,
      apiKey: env.RESEND_API_KEY,
      signingKey: env.MAIL_WEBHOOK_SIGNING_KEY,
      now: () => new Date(),
      signal: request.signal,
    });
    const scope = { ...project, messageId: parseUlid(String(match[3])) };
    const result = match[4]
      ? await service.attachment({ ...scope, attachmentId: match[4] })
      : await service.content(scope);
    if (result === null) return Response.json({ code: "resource_not_found" }, { status: 404 });
    return result instanceof Response
      ? result
      : Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        code:
          error instanceof MailContentExpiredError
            ? "mail_content_expired"
            : error instanceof MailAttachmentTooLargeError
              ? "mail_attachment_too_large"
              : "mail_gateway_unavailable",
      },
      {
        status:
          error instanceof MailContentExpiredError
            ? 410
            : error instanceof MailAttachmentTooLargeError
              ? 413
              : 503,
      },
    );
  }
}

export async function readRuntimeAttachmentRequest(
  request: Request,
  env: ResendGatewayBindings,
  trustedProjectId: string,
): Promise<Response> {
  const ulid = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.pathname !== "/v1/attachments/download" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    return Response.json({ code: "resource_not_found" }, { status: 404 });
  if (!ulid.test(trustedProjectId)) return Response.json({ code: "unauthorized" }, { status: 401 });
  const key = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (!key) return Response.json({ code: "unauthorized" }, { status: 401 });
  let body: {
    project_id: string;
    environment_id: string;
    message_id: string;
    attachment_id: string;
  };
  try {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      throw Error();
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await boundedMailBody(request, 1024)),
    );
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "attachment_id,environment_id,message_id,project_id"
    )
      throw Error();
    const record = value as Record<string, unknown>;
    for (const field of ["project_id", "environment_id", "message_id"])
      if (typeof record[field] !== "string" || !ulid.test(record[field] as string)) throw Error();
    if (
      typeof record["attachment_id"] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(record["attachment_id"])
    )
      throw Error();
    body = {
      project_id: String(record["project_id"]),
      environment_id: String(record["environment_id"]),
      message_id: String(record["message_id"]),
      attachment_id: String(record["attachment_id"]),
    };
  } catch {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }
  if (body["project_id"] !== trustedProjectId)
    return Response.json({ code: "unauthorized" }, { status: 401 });
  try {
    if (env.RUNTIME_CONFIGURATION_STATE !== "configured")
      throw new Error("Mail runtime unavailable");
    const persistence = await createD1InboundPersistence(env.MAIL_DELIVERY_RUNTIME);
    const project = await authorizeD1InboundKey(env.MAIL_DELIVERY_RUNTIME, {
      projectId: parseUlid(trustedProjectId),
      keySha256: new Uint8Array(createHash("sha256").update(key).digest()),
    });
    if (!project || project.environmentId !== body["environment_id"])
      return Response.json({ code: "unauthorized" }, { status: 401 });
    const result = await createInboundMailDelivery({
      persistence,
      apiKey: env.RESEND_API_KEY,
      signingKey: env.MAIL_WEBHOOK_SIGNING_KEY,
      now: () => new Date(),
      signal: request.signal,
    }).attachment({
      ...project,
      messageId: parseUlid(body.message_id),
      attachmentId: body.attachment_id,
    });
    if (result === null) return Response.json({ code: "resource_not_found" }, { status: 404 });
    return result;
  } catch (error) {
    const code =
      error instanceof MailContentExpiredError
        ? "mail_content_expired"
        : error instanceof MailAttachmentTooLargeError
          ? "mail_attachment_too_large"
          : "mail_gateway_unavailable";
    return Response.json(
      { code },
      {
        status:
          code === "mail_content_expired" ? 410 : code === "mail_attachment_too_large" ? 413 : 503,
      },
    );
  }
}
