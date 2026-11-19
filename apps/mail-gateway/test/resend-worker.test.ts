import { streamMailAttachment } from "../src/mail-attachment-stream.js";
import {
  boundedMailBody,
  createMailEntrypoint,
  MAIL_EGRESS_CALLER,
} from "../src/mail-entrypoint.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewRuntimeRecord } from "@ohmyhost/contracts/previews";
import { EnvironmentSecretCipherInputError } from "@ohmyhost/platform";

const ids = {
  organization: "01H00000000000000000000601",
  project: "01H00000000000000000000603",
  environment: "01H00000000000000000000606",
  message: "01H0000000000000000000060B",
};
const state = vi.hoisted(() => ({
  persistenceCreated: 0,
  sendResult: {
    status: "accepted",
    requestId: "01H0000000000000000000060A",
    providerMessageId: "provider-message",
  } as Record<string, unknown>,
  sendInputs: [] as unknown[],
  persistenceError: null as Error | null,
  senderError: null as Error | null,
  sendError: null as Error | null,
  authorized: true,
  recordFound: true,
  commandCreated: true,
  deliveryCalls: [] as string[],
  deliveryResult: { attempted: true, delivered: true } as Record<string, unknown>,
  attachmentResult: new Response("owned attachment") as Response | Error | null,
  billed: [] as string[],
  infrastructureFailure: false,
  infrastructureInputs: [] as unknown[],
}));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("@ohmyhost/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createD1WorkspaceMailCapabilityPersistence: async () => {
    state.persistenceCreated++;
    return {};
  },
}));
vi.mock("../src/d1-resend-send-persistence.js", () => ({
  createD1ResendSendPersistence: async () => {
    state.persistenceCreated++;
    if (state.persistenceError) throw state.persistenceError;
    return {};
  },
}));
vi.mock("../src/d1-inbound-persistence.js", () => ({
  createD1InboundPersistence: async () => {
    state.persistenceCreated++;
    return {
      read: async (supplier: () => unknown) => {
        supplier();
        return state.recordFound ? { message_id: ids.message } : null;
      },
    };
  },
  createD1DeliveryCommands: async () => ({
    accept: async (supplier: () => unknown) => {
      supplier();
      return { created: state.commandCreated, response: null, claimedAttempt: null };
    },
    resume: async (supplier: () => unknown) => {
      supplier();
      return true;
    },
    complete: async (supplier: () => unknown) => {
      supplier();
    },
  }),
  authorizeD1InboundKey: async () =>
    state.authorized
      ? {
          organizationId: ids.organization,
          projectId: ids.project,
          environmentId: ids.environment,
          domain: "mail.customer.example",
        }
      : null,
}));
vi.mock("../src/d1-received-billing-persistence.js", () => ({
  createD1ReceivedBillingPersistence: async () => ({
    unbilled: async () => ["01H00000000000000000000BAD", ids.message],
    bill: async (supplier: () => { messageId: string }) => {
      const input = supplier();
      if (input.messageId === "01H00000000000000000000BAD") throw new Error("price missing");
      state.billed.push(input.messageId);
    },
  }),
}));
vi.mock("../src/d1-warning-persistence.js", () => ({
  createD1WarningPersistence: async () => ({}),
}));
vi.mock("../src/receiving-admission-persistence.js", () => ({
  createD1ReceivingAdmissionPersistence: async () => ({}),
}));
vi.mock("../src/d1-infrastructure-persistence.js", () => ({
  createD1InfrastructurePersistence: async () => {
    state.persistenceCreated++;
    return {};
  },
}));
vi.mock("../src/resend-send.js", () => ({
  createResendMailSender: (configuration: { now: () => Date }) => {
    if (state.senderError) throw state.senderError;
    configuration.now();
    return {
      send: async (input: unknown) => {
        state.sendInputs.push(input);
        if (state.sendError) throw state.sendError;
        return state.sendResult;
      },
    };
  },
}));
vi.mock("../src/inbound-delivery.js", () => {
  class MailContentExpiredError extends Error {}
  class MailAttachmentTooLargeError extends Error {}
  return {
    MailContentExpiredError,
    MailAttachmentTooLargeError,
    createInboundMailDelivery: (configuration: { now: () => Date }) => {
      configuration.now();
      return {
        list: async () => {
          state.deliveryCalls.push("list");
          return { items: [] };
        },
        content: async () => {
          state.deliveryCalls.push("content");
          return { id: ids.message, domain: "mail.customer.example" };
        },
        attachment: async () => {
          state.deliveryCalls.push("attachment");
          if (state.attachmentResult instanceof Error) throw state.attachmentResult;
          if (state.attachmentResult === null) return null;
          return state.attachmentResult;
        },
        deliver: async () => {
          state.deliveryCalls.push("deliver");
          return state.deliveryResult;
        },
        sync: async () => {
          state.deliveryCalls.push("sync");
          return { attempted: 0, failed: 0 };
        },
      };
    },
  };
});
vi.mock("../src/resend-admission.js", () => ({
  syncResendReceivingAdmission: async (configuration: { now: () => Date }) => {
    configuration.now();
    return { checked: 0, suspended: 0, resumed: 0, failed: 0 };
  },
}));
vi.mock("../src/credit-warning-dispatch.js", () => ({
  createCreditWarningDispatcher: (configuration: { now: () => Date }) => {
    configuration.now();
    return {
      sync: async () => ({ periods: 0, accepted: 0, unresolved: 0 }),
    };
  },
}));
vi.mock("../src/resend-credit-warning.js", () => ({
  createResendCreditWarningSender: (configuration: { now: () => Date }) => {
    configuration.now();
    return { send: async () => ({ status: "accepted" }) };
  },
}));
vi.mock("../src/infrastructure-alerts.js", () => ({
  createInfrastructureAlertReceiver: (input: unknown) => {
    state.infrastructureInputs.push(input);
    if (state.infrastructureFailure) throw new Error("receiver unavailable");
    return { fetch: async () => Response.json({ status: "accepted" }) };
  },
}));

import worker, {
  ResendMailDeliveryService,
  MailEgressEntrypoint,
  DatabaseMailEntrypoint,
  readRuntimeAttachmentRequest,
  InfrastructureAlertsService,
  invokeResendDelivery,
  readRuntimeMailRequest,
  sendResendRequest,
  syncResendMail,
  NativeProductPreviewAuthMailService,
} from "../src/resend-worker.js";
import { MailAttachmentTooLargeError, MailContentExpiredError } from "../src/inbound-delivery.js";

const env = {
  RUNTIME_CONFIGURATION_STATE: "configured" as const,
  MAIL_SEND_RUNTIME: {},
  MAIL_INFRASTRUCTURE_RUNTIME: {},
  MAIL_DELIVERY_RUNTIME: {},
  MAIL_WARNING_RUNTIME: {},
  MAIL_CAPABILITY_RUNTIME: {},
  RESEND_API_KEY: "re_admin",
  RESEND_PLATFORM_WARNING_API_KEY: "re_warning",
  MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString("base64"),
  MAIL_WEBHOOK_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
  PLATFORM_ENVIRONMENT: "development" as const,
  CREDIT_WARNING_RECIPIENTS: { resolve: async () => ({}) },
};
const send = () =>
  new Request("https://mail.internal/v1/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${"k".repeat(43)}`,
      "content-type": "application/json",
      "idempotency-key": "booking-1",
    },
    body: JSON.stringify({
      project_id: ids.project,
      to: "guest@example.net",
      subject: "Booking",
      text: "Confirmed",
    }),
  });

beforeEach(() => {
  state.persistenceCreated = 0;
  state.sendInputs.length = 0;
  state.persistenceError = null;
  state.senderError = null;
  state.sendError = null;
  state.sendResult = {
    status: "accepted",
    requestId: "01H0000000000000000000060A",
    providerMessageId: "provider-message",
  };
  state.authorized = true;
  state.commandCreated = true;
  state.recordFound = true;
  state.deliveryCalls.length = 0;
  state.deliveryResult = { attempted: true, delivered: true };
  state.attachmentResult = new Response("owned attachment");
  state.billed.length = 0;
  state.infrastructureFailure = false;
  state.infrastructureInputs.length = 0;
});

describe("Resend gateway Worker boundary", () => {
  it("keeps product preview mail behind current private scope in both platform environments", async () => {
    const scope = {
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
    };
    const preview = {
      ...scope,
      previewId: ids.message,
      runtimeGeneration: 2,
      tokenGeneration: 3,
      authGeneration: 4,
      state: "ready",
      retirement: "none",
    } as unknown as PreviewRuntimeRecord;
    const sender = {
      ...scope,
      domain: "example.test",
      canonicalOrigin: "https://app.example.test",
      applicationName: "Product preview",
      allowedRedirectPaths: ["/", "/reset", "/invite"],
      resetPasswordPath: "/reset",
      invitationPath: "/invite",
    };
    for (const platform of ["development", "production"] as const) {
      let current = preview;
      const authorizeNativeMail = vi.fn(async () => sender);
      const resolveTokenHash = vi.fn(async () => current);
      const authorizeRuntime = vi.fn(async () => current);
      const bindings = {
        ...env,
        PLATFORM_ENVIRONMENT: platform,
        NATIVE_AUTH_MAIL_AUTHORITY: { authorizeNativeMail },
        PROJECT_PREVIEW_AUTHORITY: { resolveTokenHash, authorizeRuntime },
      };
      const service = new NativeProductPreviewAuthMailService({}, bindings);
      const suffix = platform === "development" ? "preview.dev.omh.st" : "preview.omh.st";
      const request = {
        ...scope,
        previewId: preview.previewId,
        authGeneration: preview.authGeneration,
        kind: "verification",
        to: "person@example.test",
        messageId: "00000000-0000-4000-8000-000000000001",
        url: `https://${"a".repeat(52)}.${suffix}/api/auth/v1/verify-email?token=synthetic&callbackURL=%2F`,
      };
      expect(await service.sendNativePreviewAuthMail(request)).toEqual({ status: "accepted" });
      expect(resolveTokenHash).toHaveBeenCalledWith({
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(authorizeRuntime).toHaveBeenCalledWith({
        previewId: preview.previewId,
        runtimeGeneration: 2,
        tokenGeneration: 3,
      });
      expect(authorizeNativeMail).toHaveBeenCalledWith(scope);
      expect(state.sendInputs.at(-1)).toMatchObject({
        projectId: scope.projectId,
        idempotencyKey: `native-preview:${preview.previewId}:4:${request.messageId}`,
      });
      const sent = state.sendInputs.length;
      current = { ...preview, environmentId: "01H00000000000000000000699" };
      await expect(service.sendNativePreviewAuthMail(request)).rejects.toThrow(
        /^native_mail_unavailable$/u,
      );
      const { PROJECT_PREVIEW_AUTHORITY: omitted, ...withoutPreview } = bindings;
      expect(omitted).toBeDefined();
      await expect(
        new NativeProductPreviewAuthMailService({}, withoutPreview).sendNativePreviewAuthMail(
          request,
        ),
      ).rejects.toThrow(/^native_mail_unavailable$/u);
      expect(state.sendInputs).toHaveLength(sent);
    }
  });

  it("keeps operator alerts behind the private configured entrypoint", async () => {
    const request = new Request("https://infrastructure-alert.invalid/", { method: "POST" });
    expect((await new InfrastructureAlertsService({}, env).fetch(request)).status).toBe(503);
    expect(state.persistenceCreated).toBe(0);
    const configured = {
      ...env,
      PGCF_CAPACITY_WEBHOOK_SECRET: "a".repeat(43),
      PGCF_CAPACITY_ALERT_RECIPIENT: "owner@example.net",
    };
    expect((await new InfrastructureAlertsService({}, configured).fetch(request)).status).toBe(200);
    expect(state.infrastructureInputs[0]).toMatchObject({
      secret: configured.PGCF_CAPACITY_WEBHOOK_SECRET,
      recipient: configured.PGCF_CAPACITY_ALERT_RECIPIENT,
      apiKey: env.RESEND_PLATFORM_WARNING_API_KEY,
      platform: "development",
    });
    state.infrastructureFailure = true;
    expect((await new InfrastructureAlertsService({}, configured).fetch(request)).status).toBe(503);
  });
  it("accepts only bounded authenticated send JSON", async () => {
    const foreignProject = "01H00000000000000000000604";
    const refused = await sendResendRequest(send(), env, foreignProject);
    expect(refused.status).toBe(401);
    expect(state.persistenceCreated).toBe(0);
    expect(state.sendInputs).toHaveLength(0);
    expect((await worker.fetch(new Request("https://mail.internal/nope"), env)).status).toBe(404);
    expect(
      (
        await sendResendRequest(
          new Request("https://mail.internal/v1/send", { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(400);
    const accepted = await sendResendRequest(send(), env);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      state: "accepted",
      message_id: "provider-message",
    });
    expect(state.sendInputs).toHaveLength(1);
    state.sendResult = { status: "unauthorized" };
    expect((await sendResendRequest(send(), env)).status).toBe(401);
    state.sendResult = { status: "rejected", requestId: "01H0000000000000000000060A" };
    expect((await sendResendRequest(send(), env)).status).toBe(502);
    state.sendResult = {
      status: "accepted",
      requestId: ids.message,
      providerMessageId: "provider-message",
    };
    const stamped = (project = ids.project) => {
      const request = send();
      request.headers.set("x-ohmyhost-egress-project-id", project);
      return request;
    };
    for (const Entry of [MailEgressEntrypoint, DatabaseMailEntrypoint]) {
      const before = state.persistenceCreated;
      for (const props of [
        undefined,
        null,
        {},
        { caller: "other" },
        { caller: "wfp-egress-policy", extra: true },
      ]) {
        expect(
          (await new Entry({ props }, env).fetch(stamped("01H00000000000000000000604"))).status,
        ).toBe(401);
      }
      const badHeader = stamped("01h00000000000000000000603");
      expect((await new Entry({}, env).fetch(badHeader)).status).toBe(401);
      expect(badHeader.bodyUsed).toBe(false);
      expect(state.persistenceCreated).toBe(before);
      // Props cannot grant or remove the intrinsic capability of the selected class.
      for (const props of [undefined, { caller: "other" }])
        expect((await new Entry({ props }, env).fetch(stamped())).status).toBe(202);
    }
    // A stalled control body must terminate without opening Core persistence.
    vi.useFakeTimers();
    try {
      for (const cause of ["request-abort", "deadline"]) {
        const aborted = new AbortController();
        const stalled = new Request("https://mail.internal/v1/send", {
          method: "POST",
          body: new ReadableStream(),
          signal: aborted.signal,
          duplex: "half",
        } as RequestInit);
        const pending = expect(boundedMailBody(stalled, 1024)).rejects.toThrow(
          "Invalid mail request",
        );
        if (cause === "request-abort") aborted.abort();
        else await vi.advanceTimersByTimeAsync(5001);
        await pending;
      }
    } finally {
      vi.useRealTimers();
    }
    const disabled = new MailEgressEntrypoint({}, {
      ...env,
      RUNTIME_CONFIGURATION_STATE: "disabled",
    } as unknown as typeof env);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unavailable = await disabled.fetch(stamped());
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ code: "mail_gateway_unavailable" });
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "readiness",
        reason: "runtime_not_configured",
      });

      const entry = new MailEgressEntrypoint({}, env);
      state.persistenceError = new Error("mail_core_binding_required");
      const missingBinding = await entry.fetch(stamped());
      expect(missingBinding.status).toBe(503);
      expect(await missingBinding.json()).toEqual({ code: "mail_gateway_unavailable" });
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "initialization",
        reason: "mail_core_binding_required",
      });
      state.persistenceError = null;
      state.senderError = new EnvironmentSecretCipherInputError();
      expect((await entry.fetch(stamped())).status).toBe(503);
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "initialization",
        reason: "cipher_configuration_invalid",
      });
      state.senderError = null;
      state.sendError = Object.assign(new Error("private customer detail"), { code: "store_busy" });
      expect((await entry.fetch(stamped())).status).toBe(503);
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "send",
        reason: "store_busy",
      });
      state.sendError = new Error("private customer detail");
      expect((await entry.fetch(stamped())).status).toBe(503);
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "send",
        reason: "unknown",
      });

      const coreReadiness = vi.fn(async () => {
        throw new Error("private outer detail");
      });
      const core = {
        authorizeKey: coreReadiness,
        claim: async () => null,
        authorize: async () => null,
        reject: async () => null,
        readKey: async () => null,
        complete: async () => null,
        settle: async () => null,
      };
      const { createD1ResendSendPersistence: actualPersistence } = await vi.importActual<
        typeof import("../src/d1-resend-send-persistence.js")
      >("../src/d1-resend-send-persistence.js");
      const Outer = createMailEntrypoint(async () => {
        await actualPersistence(core);
        return new Response();
      }, MAIL_EGRESS_CALLER);
      const outer = await new Outer({}, env).fetch(stamped());
      expect(coreReadiness).toHaveBeenCalledOnce();
      expect(outer.status).toBe(503);
      expect(await outer.json()).toEqual({ code: "mail_gateway_unavailable" });
      expect(diagnostic).toHaveBeenCalledWith("mail_send_unavailable", {
        phase: "boundary",
        reason: "mail_core_unavailable",
      });
      const logged = JSON.stringify(diagnostic.mock.calls);
      for (const value of [
        "private customer detail",
        "private outer detail",
        ids.organization,
        ids.project,
        ids.environment,
        "guest@example.net",
        "Booking",
        "Confirmed",
        "booking-1",
        "k".repeat(43),
      ])
        expect(logged).not.toContain(value);

      diagnostic.mockClear();
      state.sendError = Object.assign(new Error("private customer detail"), {
        code: "paid_plan_required",
      });
      const payment = await entry.fetch(stamped());
      expect(payment.status).toBe(402);
      expect(await payment.json()).toEqual({ code: "paid_plan_required" });
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
    const db = new DatabaseMailEntrypoint({ props: { caller: "wfp-egress-policy" } }, env);
    const extraRoute = new Request("https://mail.internal/v1/attachments/download", {
      method: "POST",
      headers: { "x-ohmyhost-egress-project-id": ids.project },
    });
    expect((await db.fetch(extraRoute)).status).toBe(404);
  });
  it("limits runtime content and attachments to the Prod environment credential", async () => {
    const path = `/v1/projects/${ids.project}/environments/${ids.environment}/mail/messages/${ids.message}`;
    const request = (suffix = "") =>
      new Request(`https://mail.internal${path}${suffix}`, {
        headers: { authorization: `Bearer ${"k".repeat(43)}` },
      });
    expect(
      (await readRuntimeMailRequest(new Request(`https://mail.internal${path}`), env)).status,
    ).toBe(401);
    state.authorized = false;
    expect((await readRuntimeMailRequest(request(), env)).status).toBe(401);
    state.authorized = true;
    expect((await readRuntimeMailRequest(request(), env)).status).toBe(200);
    const attachment = await readRuntimeMailRequest(request("/attachments/a1"), env);
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe("owned attachment");
    state.attachmentResult = new MailAttachmentTooLargeError();
    const large = await readRuntimeMailRequest(request("/attachments/a1"), env);
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ code: "mail_attachment_too_large" });
    state.attachmentResult = new MailContentExpiredError();
    expect((await readRuntimeMailRequest(request("/attachments/a1"), env)).status).toBe(410);
    const post = (
      body: unknown = {
        project_id: ids.project,
        environment_id: ids.environment,
        message_id: ids.message,
        attachment_id: "a1",
      },
    ) =>
      new Request("https://mail.internal/v1/attachments/download", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"k".repeat(43)}`,
          "content-type": "application/json",
          "x-ohmyhost-egress-project-id": ids.project,
        },
        body: JSON.stringify(body),
      });
    const entry = new MailEgressEntrypoint({ props: { caller: "project-database-runtime" } }, env);
    const created = state.persistenceCreated;
    expect((await entry.fetch(post({ project_id: "01H00000000000000000000604" }))).status).toBe(
      401,
    );
    for (const body of [
      null,
      {},
      { project_id: ids.project },
      {
        project_id: ids.project,
        environment_id: ids.environment,
        message_id: ids.message,
        attachment_id: "a/b",
      },
      {
        project_id: ids.project,
        environment_id: ids.environment,
        message_id: ids.message,
        attachment_id: "a1",
        extra: true,
      },
      { project_id: ids.project, extra: "x".repeat(1024) },
    ])
      expect((await entry.fetch(post(body))).status).toBe(400);
    expect(state.persistenceCreated).toBe(created);
    expect((await worker.fetch(post(), env)).status).toBe(404);
    state.attachmentResult = new Response("live stream");
    const binary = await entry.fetch(post());
    expect(binary.status).toBe(200);
    expect(await binary.text()).toBe("live stream");
    state.attachmentResult = null;
    expect((await entry.fetch(post())).status).toBe(404);
    state.attachmentResult = new MailContentExpiredError();
    expect((await entry.fetch(post())).status).toBe(410);
    state.attachmentResult = new MailAttachmentTooLargeError();
    expect((await entry.fetch(post())).status).toBe(413);
    state.attachmentResult = new Error("private provider detail");
    const unavailable = await entry.fetch(post());
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private provider detail");
    state.authorized = false;
    expect((await entry.fetch(post())).status).toBe(401);
    const badMethod = new Request("https://mail.internal/v1/attachments/download");
    expect((await readRuntimeAttachmentRequest(badMethod, env, ids.project)).status).toBe(404);
  });
  it("routes private delivery RPCs, a durable manual retry and the scheduled tick", async () => {
    const service = new ResendMailDeliveryService({}, env);
    const scope = {
      organizationId: ids.organization,
      projectId: ids.project,
      environmentId: ids.environment,
      messageId: ids.message,
    };
    expect(await service.listMailMessages(scope)).toEqual({ items: [] });
    expect(await service.getMailMessage(scope)).toMatchObject({ id: ids.message });
    const attachment = await service.getMailAttachment({ ...scope, attachmentId: "a1" });
    expect(attachment).toBeInstanceOf(Response);
    if (!(attachment instanceof Response)) throw new Error("Missing attachment response");
    await attachment.body?.cancel();
    expect(
      await service.retryMailMessage({
        ...scope,
        idempotencyKey: "retry-1",
        principalId: "user:owner",
      }),
    ).toEqual({ attempted: true, delivered: true });
    state.commandCreated = false;
    expect(
      await invokeResendDelivery(env, "deliver", {
        ...scope,
        idempotencyKey: "retry-1",
        principalId: "user:owner",
      }),
    ).toEqual({ attempted: true, delivered: true });
    expect(await service.syncMail()).toEqual({ attempted: 0, failed: 0 });
    expect(await invokeResendDelivery(env, "sync", {})).toEqual({ attempted: 0, failed: 0 });
    // One message that cannot be billed neither blocks later ones nor the delivery tick.
    expect(await worker.scheduled({}, env)).toMatchObject({
      billing: { billed: 1, failed: 1 },
      delivery: { attempted: 0, failed: 0 },
      warnings: { accepted: 0 },
    });
    expect(state.billed).toContain(ids.message);
    expect(state.deliveryCalls).toContain("deliver");
    expect(await syncResendMail(env)).toMatchObject({ delivery: { attempted: 0, failed: 0 } });
  });
  it("isolates a failed signup feedback batch from billing, delivery and warnings", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await syncResendMail({
        ...env,
        SIGNUP_FEEDBACK_REPLY_TO: "feedback@example.com",
        SIGNUP_FEEDBACK_SENDER_NAME: "Avery",
        SIGNUP_FEEDBACK_STORE: {
          claim: async () => {
            throw new Error("unavailable");
          },
          begin: async () => false,
          finish: async () => false,
        },
        SIGNUP_FEEDBACK_RECIPIENTS: {
          resolve: async () => ({ eligible: false, reason: "missing" }),
        },
      });
      expect(result).toMatchObject({
        billing: { billed: 1 },
        delivery: { attempted: 0 },
        warnings: { accepted: 0 },
      });
      expect(error).toHaveBeenCalledWith("signup_feedback_batch_unavailable");
    } finally {
      error.mockRestore();
    }
  });
  it("refuses delivery, runtime content and attachments before any Core persistence or provider while the runtime is unconfigured", async () => {
    const off = { ...env, RUNTIME_CONFIGURATION_STATE: "unconfigured" } as unknown as typeof env;
    const created = state.persistenceCreated;
    const path = `/v1/projects/${ids.project}/environments/${ids.environment}/mail/messages/${ids.message}`;
    await expect(invokeResendDelivery(off, "sync", {})).rejects.toThrow("Mail runtime unavailable");
    const read = await readRuntimeMailRequest(
      new Request(`https://mail.internal${path}`, {
        headers: { authorization: `Bearer ${"k".repeat(43)}` },
      }),
      off,
    );
    expect(read.status).toBe(503);
    const attachment = await readRuntimeAttachmentRequest(
      new Request("https://mail.internal/v1/attachments/download", {
        method: "POST",
        headers: { authorization: `Bearer ${"k".repeat(43)}`, "content-type": "application/json" },
        body: JSON.stringify({
          project_id: ids.project,
          environment_id: ids.environment,
          message_id: ids.message,
          attachment_id: "a1",
        }),
      }),
      off,
      ids.project,
    );
    expect(attachment.status).toBe(503);
    expect(state.persistenceCreated).toBe(created);
  });
  it("streams bounded attachment bytes with ownership checks and terminal cleanup", async () => {
    const MiB = 1024 * 1024;
    const run = async (
      options: {
        size?: number;
        actual?: number;
        unknownLength?: boolean;
        idle?: boolean;
        signal?: AbortSignal;
        headers?: Record<string, string>;
        status?: number;
      } = {},
    ) => {
      let now = 0,
        produced = 0,
        cancelled = 0,
        checks = 0,
        allowed = true;
      const size = options.size ?? 2 * MiB;
      const actual = options.actual ?? size;
      const upstream = new ReadableStream(
        {
          type: "bytes",
          pull(controller) {
            if (options.idle) return;
            if (produced === actual) {
              controller.close();
              controller.byobRequest?.respond(0);
              return;
            }
            const bytes = new Uint8Array(Math.min(64 * 1024, actual - produced));
            bytes.fill(7);
            produced += bytes.byteLength;
            controller.enqueue(bytes);
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
      const response = await streamMailAttachment({
        fetch: async (_url, init) => {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          expect(init?.redirect).toBe("manual");
          return new Response(upstream, {
            status: options.status ?? 200,
            headers: {
              ...(options.unknownLength ? {} : { "content-length": String(actual) }),
              ...options.headers,
            },
          });
        },
        url: "https://inbound-cdn.resend.com/owned",
        size,
        maximumBytes: 50 * MiB,
        providerExpiresAt: new Date(60000).toISOString(),
        messageExpiresAt: new Date(72000),
        now: () => new Date(now),
        checkScope: async () => {
          checks++;
          return allowed;
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      expect(produced).toBe(0);
      if (!response.body) throw new Error("Missing response body");
      const reader = response.body.getReader();
      return {
        response,
        reader,
        stats: () => ({ produced, cancelled, checks }),
        revoke: () => {
          allowed = false;
        },
        advance: (ms: number) => {
          now += ms;
        },
      };
    };
    const full = await run();
    let total = 0;
    while (true) {
      const next = await full.reader.read();
      if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      total += next.value.byteLength;
    }
    expect(total).toBe(2 * MiB);
    expect(full.stats().checks).toBeGreaterThanOrEqual(5);
    const cancellation = await run({ unknownLength: true });
    await cancellation.reader.read();
    await Promise.resolve();
    expect(cancellation.stats().produced).toBe(64 * 1024);
    await cancellation.reader.cancel();
    expect(cancellation.stats()).toMatchObject({ cancelled: 1 });
    const revoked = await run({ unknownLength: true });
    await revoked.reader.read();
    revoked.revoke();
    revoked.advance(1001);
    await expect(revoked.reader.read()).rejects.toThrow("Mail attachment unavailable");
    expect(revoked.stats()).toMatchObject({ cancelled: 1 });
    for (const actual of [3, 7]) {
      const mismatched = await run({ size: 5, actual, unknownLength: true });
      await expect(
        (async () => {
          while (!(await mismatched.reader.read()).done) {
            /* consume the whole result */
          }
        })(),
      ).rejects.toThrow();
    }
    for (const options of [
      { size: 51 * MiB },
      { size: 5, actual: 6 },
      { headers: { "content-length": "bad" } },
      { headers: { "content-encoding": "gzip" } },
      { status: 302 },
    ])
      await expect(run(options)).rejects.toThrow();
    const aborted = new AbortController();
    const cancelledBySignal = await run({ signal: aborted.signal, idle: true });
    const pending = cancelledBySignal.reader.read();
    aborted.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelledBySignal.stats().cancelled).toBe(1);
    vi.useFakeTimers();
    try {
      const timed = await run({ idle: true });
      const pendingRead = timed.reader.read();
      const caught = expect(pendingRead).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15001);
      await caught;
      expect(timed.stats().cancelled).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
