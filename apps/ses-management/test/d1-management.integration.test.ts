import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import {
  fundMail,
  MAIL_KEY_ENCRYPTION_KEY,
  publishMailRates,
  seedReadyMailDomain,
} from "../../control-store/test/support/mail-domain.js";
import { newUlid } from "../../control-store/src/catalog/common.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import {
  MailManagementRuntime,
  MailWorkspaceRuntime,
  MailDeletionRuntime,
  MailCommandRuntime,
  MailCapabilityRuntime,
  MailManagementJobRuntime,
  ProductProviderAuthorizationRuntime,
} from "../../control-store/src/worker-main.js";
import { ResendMailManagementService } from "../src/resend-worker.js";

it("runs the SES Worker entrypoint read, safe webhook replay, configure and accepted-parent ensure against native Core, and refuses a stale parent before the provider", async () => {
  const control = await createTestControl();
  const originalFetch = globalThis.fetch;
  try {
    await publishMailRates(control);
    const f = await gatewayFixture(control),
      domain = await seedReadyMailDomain(control, f.project),
      scope = f.scope,
      providerId = domain.providerDomainId;
    await fundMail(control, f.project.organizationId);
    let providerReceiving = true;
    const dnsCalls: unknown[] = [];
    const calls: { method: string; path: string }[] = [];
    vi.stubGlobal("fetch", async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof raw === "string" || raw instanceof URL ? String(raw) : raw.url);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
        return originalFetch(raw, init);
      if (url.origin !== "https://api.resend.com") throw new Error("Unexpected external request");
      const method = init?.method ?? "GET";
      calls.push({ method, path: url.pathname });
      if (url.pathname !== `/domains/${providerId}`)
        throw new Error("Unexpected provider identity");
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { capabilities: { receiving: string } };
        providerReceiving = body.capabilities.receiving === "enabled";
        return Response.json({ id: providerId });
      }
      if (method !== "GET") throw new Error("Unexpected provider mutation");
      return Response.json({
        id: providerId,
        name: domain.domain,
        status: "verified",
        capabilities: { sending: "enabled", receiving: providerReceiving ? "enabled" : "disabled" },
        records: [
          {
            type: "TXT",
            name: "resend._domainkey",
            value: "fixture-dkim",
            record: "DKIM",
            status: "verified",
          },
          {
            type: "MX",
            name: "@",
            value: "feedback.example.net",
            priority: 10,
            record: "Receiving",
            status: "verified",
          },
        ],
      });
    });
    const unexpected = async () => {
      throw new Error("Unexpected DNS effect");
    };
    const env = {
      RUNTIME_CONFIGURATION_STATE: "configured" as const,
      RESEND_API_KEY: "re_fixture_manager_path",
      MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_KEY_ENCRYPTION_KEY,
      MAIL_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 0x35).toString("base64"),
      CLOUDFLARE_DOMAIN_MANAGEMENT: {
        ensureMailRecords: async (input: unknown) => {
          dnsCalls.push(input);
          const stored = await control.core
            .prepare("SELECT records FROM resend_mail_domains WHERE domain_id=?")
            .bind(domain.domainId)
            .first<{ records: string }>();
          return { status: "action_required", records: JSON.parse(String(stored?.records)) };
        },
        deleteMailRecords: unexpected,
        ensureWorkspaceMailRecords: unexpected,
        retireWorkspaceMailRecords: unexpected,
        revalidateApplicationDomainIdentity: unexpected,
        sweepRevokedGrants: unexpected,
      },
      MAIL_MANAGEMENT_RUNTIME: new MailManagementRuntime({}, control.bindings),
      MAIL_WORKSPACE_RUNTIME: new MailWorkspaceRuntime({}, control.bindings),
      MAIL_DELETION_RUNTIME: new MailDeletionRuntime({}, control.bindings),
      MAIL_COMMAND_RUNTIME: new MailCommandRuntime({}, control.bindings),
      MAIL_CAPABILITY_RUNTIME: new MailCapabilityRuntime({}, control.bindings),
      MAIL_MANAGEMENT_JOB_RUNTIME: new MailManagementJobRuntime({}, control.bindings),
      PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME: new ProductProviderAuthorizationRuntime(
        {},
        control.bindings,
      ),
    };
    const service = new ResendMailManagementService({}, env);
    const read = await service.readMailDomain(scope);
    expect(read).toMatchObject({ domain_id: domain.domainId, status: "ready" });
    const request = {
      ...scope,
      principalId: "user:fixture",
      idempotencyKey: "native-manager-webhook",
      url: "https://hooks.example.com/mail",
    };
    const prepared = await service.prepareMailWebhook(request);
    expect(prepared).toMatchObject({
      url: "https://hooks.example.com/mail",
      status: "verification_required",
      signing_secret: expect.stringMatching(/^whsec_/u),
    });
    expect(await service.prepareMailWebhook(request)).toEqual(prepared);
    // Rotation advances the signing generation: the answer carries a new secret for the same endpoint.
    const rotated = (await service.rotateMailWebhook({
      ...scope,
      principalId: "user:fixture",
      idempotencyKey: "native-manager-rotate",
    })) as { signing_secret: string };
    expect(rotated).toMatchObject({
      url: "https://hooks.example.com/mail",
      status: "verification_required",
      signing_secret: expect.stringMatching(/^whsec_/u),
    });
    expect(rotated.signing_secret).not.toBe(
      (prepared as { signing_secret: string }).signing_secret,
    );
    const configured = await service.configureMailDomain({
      ...scope,
      domain: domain.domain,
      sending: true,
      receiving: false,
      principalId: "user:fixture",
      idempotencyKey: "native-manager-configure",
    });
    expect(configured).toMatchObject({ domain_id: domain.domainId, domain: domain.domain });
    const ensured = await service.ensureMailDomain({
      ...scope,
      operationId: f.accepted.operationId,
      acceptedLifecycleVersion: 1,
    });
    expect(ensured).toMatchObject({
      status: "ready",
      receipt: { domainId: domain.domainId, providerDomainId: providerId },
    });
    expect(dnsCalls).toHaveLength(1);
    // The receipt keeps only the safe reply: the webhook signing secret never reaches storage.
    const receipt = await control.core
      .prepare(
        "SELECT response FROM resend_mail_commands WHERE organization_id=? AND idempotency_key=?",
      )
      .bind(scope.organizationId, "native-manager-webhook")
      .first<{ response: string }>();
    expect(JSON.parse(receipt?.response ?? "null")).toEqual({
      status: "verification_required",
      url: "https://hooks.example.com/mail",
    });
    const before = calls.length;
    await expect(
      service.ensureMailDomain({
        ...scope,
        operationId: f.accepted.operationId,
        acceptedLifecycleVersion: 2,
      }),
    ).rejects.toThrow();
    expect(await service.readMailDomain({ ...scope, organizationId: newUlid() })).toBeNull();
    expect(calls).toHaveLength(before);
  } finally {
    vi.unstubAllGlobals();
    await control.dispose();
  }
}, 240000);
