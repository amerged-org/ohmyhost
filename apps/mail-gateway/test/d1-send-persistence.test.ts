import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  creditLog,
  mailFixture,
  fundMailFixture,
  MAIL_FIXTURE_CIPHER,
} from "../../control-store/test/mail/mail-fixture.js";
import { MailSendRuntime } from "../../control-store/src/worker-main.js";
import { createD1ResendSendPersistence } from "../src/d1-resend-send-persistence.js";
import { createResendMailSender } from "../src/resend-send.js";
import { NativeAuthMailService, NativePreviewAuthMailService } from "../src/resend-worker.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
it("runs the actual seven-method Core adapter through accepted, uncertain, refusal and custody paths, charging each send once and refunding the refused one", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const target = new MailSendRuntime({} as never, control.bindings as never),
    persistence = await createD1ResendSendPersistence(target),
    clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  let status = 200,
    calls = 0;
  const sender = createResendMailSender({
      persistence,
      sendingKeyEncryptionKey: MAIL_FIXTURE_CIPHER,
      ids,
      now: () => new Date(f.now),
      fetch: async (_input, init) => {
        expect((init?.headers as Record<string, string>)["authorization"]).toBe(
          `Bearer ${f.providerKey}`,
        );
        calls++;
        return Response.json(
          status === 200 ? { id: `provider_${calls}` } : { message: "failure" },
          { status },
        );
      },
    }),
    request = {
      projectId: f.scope.projectId,
      key: f.key,
      idempotencyKey: "normal",
      to: "recipient@example.net",
      subject: "subject",
      text: "body",
    };
  const accepted = await sender.send(request);
  expect(accepted.status).toBe("accepted");
  if (accepted.status === "unauthorized") throw new Error("Expected owned accepted send");
  expect(await sender.send(request)).toEqual(accepted);
  status = 500;
  const uncertain = await sender.send({ ...request, idempotencyKey: "uncertain" });
  expect(uncertain.status).toBe("uncertain");
  if (uncertain.status === "unauthorized") throw new Error("Expected owned uncertain send");
  status = 200;
  expect(await sender.send({ ...request, idempotencyKey: "uncertain" })).toMatchObject({
    status: "accepted",
    requestId: uncertain.requestId,
  });
  status = 422;
  const refused = await sender.send({ ...request, idempotencyKey: "refused" });
  expect(refused.status).toBe("rejected");
  expect(await sender.send({ ...request, idempotencyKey: "refused" })).toEqual(refused);
  expect(await sender.send({ ...request, key: "a".repeat(43) })).toEqual({
    status: "unauthorized",
  });
  expect(
    (await creditLog(control, f.scope.organizationId, "mail")).map((row) => [
      row.key.split(":")[0],
      row.delta_micros,
    ]),
  ).toEqual([
    ["mail", -180000],
    ["mail", -180000],
    ["mail", -180000],
    ["mailrefund", 180000],
  ]);
  // A send the Core refuses to authorize is released and never reaches the provider.
  const callsBefore = calls,
    denied = await createResendMailSender({
      persistence: { ...persistence, authorize: async () => false },
      sendingKeyEncryptionKey: MAIL_FIXTURE_CIPHER,
      ids,
      now: () => new Date(f.now),
      fetch: async () => {
        throw new Error("provider must not be called");
      },
    }).send({ ...request, idempotencyKey: "denied" });
  expect(denied.status).toBe("rejected");
  expect(calls).toBe(callsBefore);
  const extra = {
    organizationId: f.scope.organizationId,
    projectId: f.scope.projectId,
    requestId: accepted.requestId,
  };
  await expect(persistence.reject(() => ({ ...extra, rejectedAt: f.now }))).rejects.toMatchObject({
    code: "mail_send_conflict",
  });
  await expect(
    persistence.claim(
      () => {
        throw new Error("local supplier");
      },
      () => ({ organizationId: f.scope.organizationId, now: f.now }),
    ),
  ).rejects.toThrow("local supplier");
  expect(calls).toBe(4);
  // A private Native sender uses an already-authorized realm, then the same Core mail
  // claim, admission and provider-key custody paths as ordinary application mail.
  status = 200;
  const nativeRequest = {
    projectId: f.scope.projectId,
    idempotencyKey: "native-auth:test-message",
    to: "recipient@example.net",
    subject: "Verify",
    text: "private link",
  };
  const native = await sender.send(nativeRequest, { ...f.scope, domain: f.domain });
  expect(native.status).toBe("accepted");
  expect(await sender.send(nativeRequest, { ...f.scope, domain: f.domain })).toEqual(native);
  await expect(
    sender.send({ ...nativeRequest, text: "different link" }, { ...f.scope, domain: f.domain }),
  ).rejects.toMatchObject({ code: "mail_send_conflict" });
  expect(calls).toBe(5);
});
it("sends Native verification through current realm scope and actual Core custody, with one charge and no sensitive public result", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const authority = {
    ...f.scope,
    domain: f.domain,
    canonicalOrigin: "https://app.example.com",
    applicationName: "Native fixture",
    allowedRedirectPaths: ["/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  let allowed = true;
  const authorizeNativeMail = vi.fn(async () => (allowed ? authority : null));
  const configuration = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    MAIL_SEND_RUNTIME: new MailSendRuntime({} as never, control.bindings as never),
    MAIL_INFRASTRUCTURE_RUNTIME: null,
    MAIL_DELIVERY_RUNTIME: null,
    MAIL_WARNING_RUNTIME: null,
    MAIL_CAPABILITY_RUNTIME: null,
    RESEND_API_KEY: "unused-fixture-management-key",
    RESEND_PLATFORM_WARNING_API_KEY: "unused-fixture-warning-key",
    MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_FIXTURE_CIPHER,
    MAIL_WEBHOOK_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
    PLATFORM_ENVIRONMENT: "development" as const,
    CREDIT_WARNING_RECIPIENTS: { resolve: async () => ({}) },
  };
  const service = new NativeAuthMailService({} as never, {
    ...configuration,
    NATIVE_AUTH_MAIL_AUTHORITY: { authorizeNativeMail },
  });
  const token = "fixture-native-verification-token";
  const request = {
    ...f.scope,
    kind: "verification",
    messageId: "00000000-0000-4000-8000-000000000001",
    to: "native-recipient@example.net",
    url: `https://app.example.com/api/auth/v1/verify-email?token=${token}&callbackURL=%2Flogin`,
  };
  const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["authorization"]).toBe(
      `Bearer ${f.providerKey}`,
    );
    const message = JSON.parse(String(init?.body));
    expect(message).toMatchObject({
      to: [request.to],
      subject: "Verify your Native fixture email",
    });
    expect(message.text).toContain(request.url);
    return Response.json({ id: "native_provider_fixture" });
  });
  vi.stubGlobal("fetch", provider);
  try {
    expect(await service.sendNativeAuthMail(request)).toEqual({ status: "accepted" });
    expect(await service.sendNativeAuthMail(request)).toEqual({ status: "accepted" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(authorizeNativeMail).toHaveBeenCalledWith(f.scope);
    expect(await creditLog(control, f.scope.organizationId, "mail")).toHaveLength(1);

    for (const invalid of [
      { ...request, environmentId: "00000000000000000000000004" },
      { ...request, url: "https://foreign.example/verify?token=fixture" },
      { ...request, key: f.key },
    ])
      await expect(service.sendNativeAuthMail(invalid)).rejects.toThrow(
        /^native_mail_unavailable$/u,
      );
    allowed = false;
    await expect(service.sendNativeAuthMail(request)).rejects.toThrow(/^native_mail_unavailable$/u);
    await expect(
      new NativeAuthMailService({} as never, configuration).sendNativeAuthMail(request),
    ).rejects.toThrow(/^native_mail_unavailable$/u);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await creditLog(control, f.scope.organizationId, "mail")).toHaveLength(1);
    const metadata = JSON.stringify(
      (await control.core.prepare("SELECT * FROM mail_send_requests").all()).results,
    );
    for (const privateValue of [token, request.to, request.url, f.providerKey, f.key])
      expect(metadata).not.toContain(privateValue);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("routes QA Preview verification through current Core custody with one charge and fixed recipients", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const previewId = "a".repeat(32);
  const previewOrigin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
  const qa = {
    platform: "development",
    ...f.scope,
    region: "eu",
    previewId,
    previewOrigin,
    authGeneration: 1,
    devAccessEpoch: 1,
    revocationEpoch: 1,
    configurationRevision: 1,
    enabled: true,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: true,
  };
  const sender = {
    ...f.scope,
    domain: f.domain,
    canonicalOrigin: "https://app.example.com",
    applicationName: "Native fixture",
    allowedRedirectPaths: ["/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  let allowed = true;
  const env = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    MAIL_SEND_RUNTIME: new MailSendRuntime({} as never, control.bindings as never),
    MAIL_INFRASTRUCTURE_RUNTIME: null,
    MAIL_DELIVERY_RUNTIME: null,
    MAIL_WARNING_RUNTIME: null,
    MAIL_CAPABILITY_RUNTIME: null,
    RESEND_API_KEY: "unused-fixture-management-key",
    RESEND_PLATFORM_WARNING_API_KEY: "unused-fixture-warning-key",
    MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_FIXTURE_CIPHER,
    MAIL_WEBHOOK_SIGNING_KEY: Buffer.alloc(32).toString("base64"),
    PLATFORM_ENVIRONMENT: "development" as const,
    CREDIT_WARNING_RECIPIENTS: { resolve: async () => ({}) },
    NATIVE_AUTH_MAIL_AUTHORITY: { authorizeNativeMail: async () => sender },
    QA_STABLE_PREVIEW_AUTHORITY: { resolve: async () => (allowed ? qa : null) },
    QA_NATIVE_PREVIEW_MAIL_ENABLED: "development-only-v1",
    QA_NATIVE_PREVIEW_MAIL_SCOPE: JSON.stringify({
      platform: "development",
      fixture: "next-native-auth",
      ...f.scope,
      recipients: ["first@example.net", "second@example.net"],
    }),
  };
  const request = {
    ...f.scope,
    previewId,
    authGeneration: 1,
    kind: "verification",
    messageId: "00000000-0000-4000-8000-000000000001",
    to: "first@example.net",
    url: `${previewOrigin}/api/auth/v1/verify-email?token=fixture-private&callbackURL=%2Flogin`,
  };
  const provider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.to).toEqual([request.to]);
    expect(body.text).toContain(request.url);
    return Response.json({ id: "qa_native_provider_fixture" });
  });
  vi.stubGlobal("fetch", provider);
  try {
    const service = new NativePreviewAuthMailService({} as never, env);
    expect(await service.sendNativePreviewAuthMail(request)).toEqual({ status: "accepted" });
    expect(await service.sendNativePreviewAuthMail(request)).toEqual({ status: "accepted" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await creditLog(control, f.scope.organizationId, "mail")).toHaveLength(1);
    await expect(
      service.sendNativePreviewAuthMail({ ...request, to: "outside@example.net" }),
    ).rejects.toThrow(/^native_mail_unavailable$/u);
    allowed = false;
    await expect(service.sendNativePreviewAuthMail(request)).rejects.toThrow(
      /^native_mail_unavailable$/u,
    );
    allowed = true;
    await expect(
      new NativePreviewAuthMailService({} as never, {
        ...env,
        PLATFORM_ENVIRONMENT: "production",
      }).sendNativePreviewAuthMail(request),
    ).rejects.toThrow(/^native_mail_unavailable$/u);
    const { QA_NATIVE_PREVIEW_MAIL_ENABLED: enabledFlag, ...disabledEnv } = env;
    expect(enabledFlag).toBe("development-only-v1");
    await expect(
      new NativePreviewAuthMailService({} as never, disabledEnv).sendNativePreviewAuthMail(request),
    ).rejects.toThrow(/^native_mail_unavailable$/u);
    expect(provider).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("strictly refuses malformed private replies and missing methods", async () => {
  await expect(createD1ResendSendPersistence(null)).rejects.toThrow("mail_core_binding_required");
  await expect(createD1ResendSendPersistence({})).rejects.toThrow("mail_core_binding_required");
  const methods = {
    authorizeKey: async () => null,
    claim: async () => ({ outcome: "claimed" }),
    authorize: async () => "true",
    reject: async () => "released",
    readKey: async () => ({}),
    complete: async () => "completed",
    settle: async () => ({}),
  };
  await expect(
    createD1ResendSendPersistence({ ...methods, authorizeKey: async () => ({ ready: true }) }),
  ).rejects.toThrow("mail_core_response_invalid");
  const port = await createD1ResendSendPersistence(methods);
  await expect(
    port.authorize(() => ({
      organizationId: "a" as never,
      projectId: "b" as never,
      environmentId: "c" as never,
      requestId: "d" as never,
      idempotencyKey: "key",
      now: new Date().toISOString(),
    })),
  ).rejects.toThrow("mail_core_response_invalid");
  const unknown = await createD1ResendSendPersistence({
    ...methods,
    authorize: async () => {
      throw new Error("mail.authorizeSend: store_outcome_unknown");
    },
  });
  await expect(unknown.authorize(() => ({}) as never)).rejects.toMatchObject({
    code: "store_outcome_unknown",
  });
  const unclassified = await createD1ResendSendPersistence({
    ...methods,
    authorize: async () => {
      throw new Error("unclassified");
    },
  });
  await expect(unclassified.authorize(() => ({}) as never)).rejects.toThrow(
    "mail_core_unavailable",
  );
});

it("keeps a first send reserved through a transient sending-key read failure, so a retry with the same key sends", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const target = new MailSendRuntime({} as never, control.bindings as never),
    persistence = await createD1ResendSendPersistence(target),
    clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const fetch = vi.fn(async () => Response.json({ id: "provider_after_retry" }));
  let keyReads = 0;
  const sender = createResendMailSender({
    persistence: {
      ...persistence,
      readKey: (supplier) => {
        keyReads += 1;
        // The first read fails the way a D1 outage does; the retry reads the key normally.
        if (keyReads === 1) return Promise.reject(new Error("mail_core_unavailable"));
        return persistence.readKey(supplier);
      },
    },
    sendingKeyEncryptionKey: MAIL_FIXTURE_CIPHER,
    ids,
    now: () => new Date(f.now),
    fetch,
  });
  const request = {
    projectId: f.scope.projectId,
    key: f.key,
    idempotencyKey: "transient-key",
    to: "recipient@example.net",
    subject: "subject",
    text: "body",
  };
  await expect(sender.send(request)).rejects.toThrow("mail_core_unavailable");
  expect(fetch).not.toHaveBeenCalled();
  await expect(sender.send(request)).resolves.toMatchObject({ status: "accepted" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    (await creditLog(control, f.scope.organizationId, "mail")).filter((row) =>
      row.key.startsWith("mailrefund:"),
    ),
  ).toEqual([]);
});

it("refunds a first send whose sending key is definitively absent, and never calls the provider", async () => {
  const f = await mailFixture(control);
  await fundMailFixture(control, f);
  const target = new MailSendRuntime({} as never, control.bindings as never),
    persistence = await createD1ResendSendPersistence(target),
    clock = new SystemClock(),
    ids = createUlidFactory({ clock, entropy: new SystemEntropy() });
  const fetch = vi.fn(async () => Response.json({ id: "provider_must_not_exist" }));
  const sender = createResendMailSender({
    persistence: {
      ...persistence,
      readKey: async () => {
        throw new Error("mail_scope_unavailable");
      },
    },
    sendingKeyEncryptionKey: MAIL_FIXTURE_CIPHER,
    ids,
    now: () => new Date(f.now),
    fetch,
  });
  await expect(
    sender.send({
      projectId: f.scope.projectId,
      key: f.key,
      idempotencyKey: "absent-key",
      to: "recipient@example.net",
      subject: "subject",
      text: "body",
    }),
  ).resolves.toMatchObject({ status: "rejected" });
  expect(fetch).not.toHaveBeenCalled();
  expect(
    (await creditLog(control, f.scope.organizationId, "mail"))
      .filter((row) => row.key.startsWith("mailrefund:"))
      .map((row) => row.delta_micros),
  ).toEqual([180000]);
});
