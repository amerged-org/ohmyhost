import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createD1WorkspaceMailCapabilityPersistence } from "@ohmyhost/database";
import { createUlidFactory, parseUlid, SystemClock, SystemEntropy } from "@ohmyhost/platform";
import { mailWebhookSecret } from "@ohmyhost/provider-resend";
import {
  MailCapabilityRuntime,
  MailCommandRuntime,
  MailDeletionRuntime,
  MailManagementJobRuntime,
  MailManagementRuntime,
  MailWorkspaceRuntime,
  ProductProviderAuthorizationRuntime,
} from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import {
  seedDeletionIntent,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import {
  fundMail,
  MAIL_KEY_ENCRYPTION_KEY,
  publishMailRates,
  seedBoundNativeSender,
  seedReadyMailDomain,
  seedNativeWorkspaceDomain,
} from "../../control-store/test/support/mail-domain.js";
import {
  invokeD1ResendManagement,
  invokeD1WorkspaceMailManagement,
  reconcileD1MailManagement,
} from "../src/d1-management-dispatch.js";
import { createD1MailManagementSession } from "../src/d1-management-session.js";
import { createD1ResendManagementPersistence } from "../src/d1-resend-persistence.js";
import { createResendMailManagement } from "../src/resend-runtime.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

let control: TestControl;
const dnsCalls: { method: string; input: unknown }[] = [];
const providerDomains = new Map<string, string>();
const providerKeys = new Set<string>();
const providerCalls: string[] = [];
let created = 0;
/** What the provider reports for the DKIM record of every domain. */
let dkimStatus: "verified" | "failed" = "verified";
/** Verification requests that Resend refuses with 429 before it answers normally. */
let verifyRefusals = 0;
const originalFetch = globalThis.fetch;

/** The Resend HTTP boundary: a small stateful provider. Everything behind it is the real Worker code. */
function resend(raw: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = new URL(typeof raw === "string" || raw instanceof URL ? String(raw) : raw.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(raw, init);
  if (url.origin !== "https://api.resend.com") throw new Error("Unexpected external request");
  const method = init?.method ?? "GET",
    [, collection, id] = url.pathname.split("/");
  providerCalls.push(`${method} ${url.pathname}`);
  const respond = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
  if (collection === "domains" && id === undefined && method === "GET")
    return respond({
      object: "list",
      has_more: false,
      data: [...providerDomains].map(([providerId, name]) => ({
        id: providerId,
        name,
        created_at: "2026-10-01T00:00:00.000Z",
      })),
    });
  if (collection === "api-keys" && id === undefined && method === "GET")
    return respond({ object: "list", has_more: false, data: [] });
  if (collection === "api-keys" && id === undefined && method === "POST") {
    created += 1;
    providerKeys.add(`created_key_${created}`);
    return respond({ id: `created_key_${created}`, token: `re_created_${created}` });
  }
  if (collection === "domains" && id === undefined && method === "POST") {
    created += 1;
    const name = (JSON.parse(String(init?.body)) as { name: string }).name;
    providerDomains.set(`created_domain_${created}`, name);
    return respond(domainBody(`created_domain_${created}`, name));
  }
  if (collection === "domains" && url.pathname.endsWith("/verify")) {
    if (verifyRefusals > 0) {
      verifyRefusals -= 1;
      return respond({ message: "rate limited" }, 429);
    }
    return respond({ id });
  }
  if (collection === "api-keys" && id !== undefined && method === "DELETE") {
    providerKeys.delete(id);
    return respond({ id, deleted: true });
  }
  const name = id === undefined ? undefined : providerDomains.get(id);
  if (collection !== "domains" || id === undefined || name === undefined)
    return respond({ name: "not_found", message: "not found" }, 404);
  if (method === "DELETE") {
    providerDomains.delete(id);
    return respond({ id, deleted: true });
  }
  if (method === "PATCH") return respond({ id });
  return respond(domainBody(id, name));
}
function domainBody(id: string, name: string) {
  return {
    id,
    name,
    status: dkimStatus === "verified" ? "verified" : "failed",
    capabilities: { sending: "enabled", receiving: "enabled" },
    records: [
      { type: "TXT", name: "resend._domainkey", value: "dkim", record: "DKIM", status: dkimStatus },
      {
        type: "MX",
        name: "@",
        value: "feedback.example.net",
        priority: 10,
        record: "Receiving",
        status: "verified",
      },
    ],
  };
}

function environment(accepted?: object) {
  const call = (method: string, answer: unknown) => async (input: unknown) => {
    dnsCalls.push({ method, input });
    return answer;
  };
  return {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    RESEND_API_KEY: "re_fixture_dispatch",
    MAIL_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 0x35).toString("base64"),
    MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_KEY_ENCRYPTION_KEY,
    CLOUDFLARE_DOMAIN_MANAGEMENT: {
      ensureMailRecords: call("ensureMailRecords", { status: "action_required", records: [] }),
      deleteMailRecords: call("deleteMailRecords", {
        status: "deleted",
        recordIds: ["a".repeat(32)],
      }),
      ensureWorkspaceMailRecords: call("ensureWorkspaceMailRecords", { status: "configured" }),
      retireWorkspaceMailRecords: call("retireWorkspaceMailRecords", {
        status: "deleted",
        recordIds: ["b".repeat(32)],
      }),
      revalidateApplicationDomainIdentity: call("revalidateApplicationDomainIdentity", {
        status: "revalidated",
      }),
      sweepRevokedGrants: call("sweepRevokedGrants", {
        attempted: 0,
        wiped: 0,
        failed: 0,
      }),
    },
    PRODUCT_PROVIDER_AUTHORIZATION_RUNTIME: new ProductProviderAuthorizationRuntime(
      {},
      control.bindings,
    ),
    MAIL_MANAGEMENT_RUNTIME: new MailManagementRuntime({}, control.bindings),
    MAIL_WORKSPACE_RUNTIME: new MailWorkspaceRuntime({}, control.bindings),
    MAIL_DELETION_RUNTIME: new MailDeletionRuntime({}, control.bindings),
    MAIL_COMMAND_RUNTIME: new MailCommandRuntime({}, control.bindings),
    MAIL_CAPABILITY_RUNTIME: new MailCapabilityRuntime({}, control.bindings),
    MAIL_MANAGEMENT_JOB_RUNTIME: new MailManagementJobRuntime({}, control.bindings),
    ...accepted,
  };
}

beforeAll(async () => {
  control = await createTestControl();
  await publishMailRates(control);
  vi.stubGlobal("fetch", resend);
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await control.dispose();
});
afterEach(() => {
  dnsCalls.length = 0;
  providerCalls.length = 0;
  dkimStatus = "verified";
  verifyRefusals = 0;
});

describe("the D1 manager command path", () => {
  it("resumes an abandoned command after its lease, admits receiving for an accepted parent, and refuses anything else before the provider", async () => {
    const f = await gatewayFixture(control),
      domain = await seedReadyMailDomain(control, f.project);
    providerDomains.set(domain.providerDomainId, domain.domain);
    await fundMail(control, f.project.organizationId);
    const env = environment(),
      scope = f.scope;
    // Two callers recorded the command and died before completing it: one lease is still held, one has run out.
    const digest = createHash("sha256")
      .update(JSON.stringify({ operation: "disableReceiving", principalId: "user:owner" }))
      .digest();
    for (const [key, lease] of [
      ["disable-held", "2099-01-01T00:00:00.000000Z"],
      ["disable-1", "2026-10-29T10:02:00.000000Z"],
    ] as const)
      await control.core
        .prepare(
          "INSERT INTO resend_mail_commands(organization_id,project_id,environment_id,idempotency_key,request_sha256,created_at,lease_until) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        )
        .bind(
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          key,
          digest,
          STORED_NOW,
          lease,
        )
        .run();
    await expect(
      invokeD1ResendManagement(env, "disableReceiving", {
        ...scope,
        principalId: "user:owner",
        idempotencyKey: "disable-held",
      }),
    ).rejects.toThrow("mail_operation_pending");
    expect(providerCalls).toEqual([]);
    await invokeD1ResendManagement(env, "disableReceiving", {
      ...scope,
      principalId: "user:owner",
      idempotencyKey: "disable-1",
    });
    expect(
      JSON.parse(
        (
          await control.core
            .prepare("SELECT response FROM resend_mail_commands WHERE idempotency_key='disable-1'")
            .first<{ response: string }>()
        )?.response ?? "null",
      ),
    ).toMatchObject({ status: expect.any(String) });
    expect(
      (
        await control.core
          .prepare("SELECT receiving r FROM resend_mail_domains WHERE domain_id=?")
          .bind(domain.domainId)
          .first<{ r: number }>()
      )?.r,
    ).toBe(0);

    // A receiving domain is admitted against the credit policy before its provider state is reconciled.
    await control.core
      .prepare(
        "UPDATE resend_mail_domains SET receiving=1,receiving_status='ready',webhook_url='https://receiver.example.com/mail',webhook_verified_at=?2 WHERE domain_id=?1",
      )
      .bind(domain.domainId, STORED_NOW)
      .run();
    expect(
      await invokeD1ResendManagement(env, "ensure", {
        ...scope,
        operationId: f.accepted.operationId,
        acceptedLifecycleVersion: 1,
      }),
    ).toMatchObject({ status: "ready", receipt: { domainId: domain.domainId } });
    await expect(
      invokeD1ResendManagement(env, "ensure", {
        ...scope,
        operationId: f.accepted.operationId,
        acceptedLifecycleVersion: 2,
      }),
    ).rejects.toThrow();
    await expect(invokeD1ResendManagement(env, "get", "scope")).rejects.toThrow(TypeError);
    await expect(
      invokeD1ResendManagement(env, "retire", { ...scope, idempotencyKey: "bad key" }),
    ).rejects.toThrow("Invalid mail idempotency key");
    await expect(
      createD1MailManagementSession({ ...env, RUNTIME_CONFIGURATION_STATE: "disabled" }),
    ).rejects.toThrow("Mail management configuration unavailable");
    await expect(
      createD1MailManagementSession({ ...env, CLOUDFLARE_DOMAIN_MANAGEMENT: {} }),
    ).rejects.toThrow("Mail management dependency binding required");
    const withoutKey = Object.fromEntries(
      Object.entries(env).filter(([name]) => name !== "RESEND_API_KEY"),
    );
    await expect(createD1MailManagementSession(withoutKey)).rejects.toThrow(
      "Mail management configuration unavailable",
    );
    const session = await createD1MailManagementSession(env);
    await expect(
      session.authorizeParent({
        ...scope,
        operationId: newUlid(),
        acceptedLifecycleVersion: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("the D1 workspace command path", () => {
  it("answers a recorded receipt, claims retirement once, and retires a native sender", async () => {
    const project = await seedProject(control),
      org = project.organizationId,
      legacy = await seedReadyMailDomain(control, project),
      native = await seedNativeWorkspaceDomain(control, await seedProject(control, {}));
    // The native sender belongs to its own organization; the receipt rows are written as the Control API leaves them.
    const nativeOrg = native.organizationId,
      digest = new Uint8Array(32).fill(9);
    providerDomains.set(legacy.providerDomainId, legacy.domain);
    await fundMail(control, org);
    await fundMail(control, nativeOrg);
    const env = environment(),
      command = (
        organizationId: string,
        domainId: string,
        operation: "retire" | "bind",
        key: string,
        response: string | null,
      ) =>
        control.core
          .prepare(
            "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,response,created_at) VALUES(?1,?2,?3,?4,'user:owner',?5,?6,?7)",
          )
          .bind(organizationId, key, domainId, operation, digest, response, STORED_NOW)
          .run(),
      request = (
        organizationId: string,
        domainId: string,
        commandOperation: string,
        idempotencyKey: string,
      ) => ({
        organizationId,
        domainId,
        canonicalRequestDigest: digest,
        idempotencyKey,
        principalId: "user:owner",
        commandOperation,
        expectedRevision: 1,
      });
    await command(org, legacy.domainId, "bind", "bind-1", null);
    await command(org, legacy.domainId, "retire", "retire-done", '{"status":"retired"}');
    await command(nativeOrg, native.domainId, "retire", "retire-native", null);

    expect(
      await invokeD1WorkspaceMailManagement(
        env,
        "sync",
        request(org, legacy.domainId, "bind", "bind-1"),
      ),
    ).toMatchObject({ domain_id: legacy.domainId });
    expect(
      await invokeD1WorkspaceMailManagement(
        env,
        "retire",
        request(org, legacy.domainId, "retire", "retire-done"),
      ),
    ).toEqual({ status: "retired" });
    expect(
      await invokeD1WorkspaceMailManagement(
        env,
        "retire",
        request(nativeOrg, native.domainId, "retire", "retire-native"),
      ),
    ).toMatchObject({ domain_id: native.domainId, status: "retired" });
    expect(dnsCalls.map(({ method }) => method)).toEqual(["retireWorkspaceMailRecords"]);
    // A second claim of the same retirement is a pending operation, not a second cleanup.
    await command(nativeOrg, native.domainId, "retire", "retire-leased", null);
    await control.core
      .prepare(
        "UPDATE workspace_mail_commands SET lease_until='2099-01-01T00:00:00.000000Z' WHERE idempotency_key='retire-leased'",
      )
      .run();
    await expect(
      invokeD1WorkspaceMailManagement(
        env,
        "retire",
        request(nativeOrg, native.domainId, "retire", "retire-leased"),
      ),
    ).rejects.toThrow("mail_operation_pending");
    for (const bad of [
      null,
      {
        ...request(org, legacy.domainId, "bind", "bind-1"),
        canonicalRequestDigest: new Uint8Array(3),
      },
      request(org, legacy.domainId, "create", "bind-1"),
    ])
      await expect(invokeD1WorkspaceMailManagement(env, "sync", bad)).rejects.toThrow(TypeError);
  });
});

describe("the scheduled reconciliation", () => {
  it("revalidates the due identity, syncs the dirty workspace and finishes the pending project domain", async () => {
    const isolated = await createTestControl();
    const saved = control;
    try {
      control = isolated;
      await publishMailRates(isolated);
      const owner = await seedProject(isolated),
        bound = await seedBoundNativeSender(
          isolated,
          owner,
          new Date(Date.now() + 3 * 86_400_000).toISOString(),
        ),
        pendingProject = await seedProject(isolated),
        pending = await seedReadyMailDomain(isolated, pendingProject, {
          receiving: false,
          sendingStatus: "pending",
        });
      providerDomains.set(bound.providerDomainId, bound.domain);
      providerDomains.set(pending.providerDomainId, pending.domain);
      const fresh = await seedProject(isolated),
        unprovisioned = await seedNativeWorkspaceDomain(isolated, fresh);
      for (const organizationId of [
        owner.organizationId,
        pendingProject.organizationId,
        fresh.organizationId,
      ])
        await fundMail(isolated, organizationId);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await reconcileD1MailManagement(environment());
      const logged = Object.fromEntries(info.mock.calls.map(([name, value]) => [name, value]));
      info.mockRestore();
      expect(logged["resend_mail_domain_reconciliation"]).toEqual({ reconciled: 1, failed: 0 });
      expect(logged["workspace_mail_domain_reconciliation"]).toMatchObject({
        reconciled: 3,
        failed: 0,
        revalidation: { attempted: 1, renewed: 1, failed: 0 },
      });
      expect(dnsCalls.map(({ method }) => method)).toContain("revalidateApplicationDomainIdentity");
      expect(dnsCalls.map(({ method }) => method)).toContain("sweepRevokedGrants");
      expect(dnsCalls.map(({ method }) => method)).toContain("ensureMailRecords");
      // The unprovisioned native sender got a provider domain, its DNS and a sealed sending key.
      expect(dnsCalls.map(({ method }) => method)).toContain("ensureWorkspaceMailRecords");
      const stored = await isolated.core
        .prepare(
          "SELECT provider_domain_id p,sending_key_id k,sending_status s FROM workspace_mail_domains WHERE domain_id=?",
        )
        .bind(unprovisioned.domainId)
        .first<{ p: string | null; k: string | null; s: string }>();
      expect(stored).toEqual({
        p: expect.stringMatching(/^created_domain_/u),
        k: expect.stringMatching(/^created_key_/u),
        s: "ready",
      });
    } finally {
      control = saved;
      await isolated.dispose();
    }
  });

  it("retires an unverified native sender configured before the seven-day cutoff through the provider and frees its name", async () => {
    const isolated = await createTestControl();
    const saved = control;
    try {
      control = isolated;
      const project = await seedProject(isolated),
        // Configured on 2026-10-29: already past the seven-day cutoff of the scheduled run.
        stale = await seedNativeWorkspaceDomain(isolated, project);
      await fundMail(isolated, project.organizationId);
      // The provider keeps the DKIM record unverified, so the sender stays unverified for sending.
      dkimStatus = "failed";
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      await reconcileD1MailManagement(environment());
      const logged = Object.fromEntries(info.mock.calls.map(([name, value]) => [name, value]));
      info.mockRestore();
      expect(logged["workspace_mail_unverified_expiry"]).toEqual({
        attempted: 1,
        retired: 1,
        failed: 0,
      });
      expect(
        await isolated.core
          .prepare("SELECT status FROM workspace_mail_domains WHERE domain_id=?")
          .bind(stale.domainId)
          .first(),
      ).toEqual({ status: "retired" });
    } finally {
      control = saved;
      await isolated.dispose();
    }
  });
});

describe("the D1 project deletion path", () => {
  async function deleting(options: { detach: boolean }) {
    const project = await seedProject(control),
      domain = await seedReadyMailDomain(control, project, { receiving: false }),
      operationId = await seedOperation(project);
    providerDomains.set(domain.providerDomainId, domain.domain);
    providerKeys.add(`key_${domain.domainId}`);
    await seedDeletionIntent(project, project.prodEnvironmentId, operationId);
    await control.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    // A domain that never reached a shared workspace is the deletion's own provider resource.
    if (options.detach)
      await control.core.batch([
        control.core
          .prepare("DELETE FROM project_mail_domain_bindings WHERE project_id=?")
          .bind(project.projectId),
        control.core
          .prepare("DELETE FROM workspace_mail_domains WHERE legacy_domain_id=?")
          .bind(domain.domainId),
      ]);
    return {
      domain,
      input: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId,
      },
    };
  }

  it("syncs the retained workspace sender and removes the project's own mail resources", async () => {
    const retained = await deleting({ detach: false }),
      own = await deleting({ detach: true }),
      session = await createD1MailManagementSession(environment());
    expect(await session.deleteProject(retained.input)).toMatchObject({
      status: "deleted",
      projectId: retained.input.projectId,
      resourcesAbsent: true,
    });
    expect(providerDomains.has(retained.domain.providerDomainId)).toBe(true);

    expect(await session.deleteProject(own.input)).toMatchObject({
      status: "deleted",
      projectId: own.input.projectId,
      resourcesAbsent: true,
    });
    expect(providerDomains.has(own.domain.providerDomainId)).toBe(false);
    expect(providerKeys.has(`key_${own.domain.domainId}`)).toBe(false);
    expect(dnsCalls.filter(({ method }) => method === "deleteMailRecords")).toHaveLength(1);
    expect(
      (
        await control.core
          .prepare("SELECT deleted_at d FROM resend_mail_domains WHERE domain_id=?")
          .bind(own.domain.domainId)
          .first<{ d: string | null }>()
      )?.d,
    ).not.toBeNull();
    expect(
      await session.revalidateApplicationDomainIdentity({
        organizationId: own.input.organizationId,
        projectId: own.input.projectId,
        expectedRevision: 1,
      }),
    ).toEqual({ status: "revalidated" });
  });
});

describe("the original project manager lifecycle", () => {
  const principal = { principalId: "user:owner" };
  async function freshProject() {
    const project = await seedProject(control);
    await fundMail(control, project.organizationId);
    return {
      project,
      scope: {
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
      },
    };
  }
  const row = async (domainId: string) =>
    control.core
      .prepare(
        "SELECT sending_key_id k,provider_domain_id p,sending_status s,deleted_at d FROM resend_mail_domains WHERE domain_id=?",
      )
      .bind(domainId)
      .first<{ k: string | null; p: string | null; s: string; d: string | null }>();

  it("creates the provider domain after the inventory check, keeps failed records visible and mints the sending key once they verify", async () => {
    const { scope } = await freshProject(),
      env = environment();
    dkimStatus = "failed";
    const failed = (await invokeD1ResendManagement(env, "configure", {
      ...scope,
      ...principal,
      domain: "fresh-failed.example.com",
      sending: true,
      receiving: false,
      idempotencyKey: "configure-failed",
    })) as { domain_id: string };
    expect(failed).toMatchObject({ sending: "failed", status: "verification_pending" });
    expect(providerCalls).toContain("GET /domains");
    expect(providerCalls).toContain("POST /domains");
    expect(providerCalls.some((call) => call.endsWith("/verify"))).toBe(true);
    expect((await row(failed.domain_id))?.k).toBeNull();
    dkimStatus = "verified";
    expect(await invokeD1ResendManagement(env, "ensure_pending", scope)).toMatchObject({
      sending: "ready",
      status: "ready",
    });
    expect((await row(failed.domain_id))?.k).toMatch(/^created_key_/u);
  });

  it("refuses a configure without sending as an invalid configuration before any provider call", async () => {
    const { scope } = await freshProject(),
      env = environment(),
      before = providerCalls.length;
    await expect(
      invokeD1ResendManagement(env, "configure", {
        ...scope,
        ...principal,
        domain: "receive-only.example.com",
        sending: false,
        receiving: false,
        idempotencyKey: "configure-without-sending",
      }),
    ).rejects.toThrow("Invalid domain configuration");
    expect(providerCalls).toHaveLength(before);
  });

  it("recovers a sending-key creation that never recorded its token", async () => {
    const { scope } = await freshProject(),
      domainId = newUlid(),
      domain = `keyless-${domainId.slice(-10).toLowerCase()}.example.com`;
    providerDomains.set(`provider_${domainId}`, domain);
    // A key creation that claimed the row more than five minutes ago and never stored its one-time token.
    await control.core
      .prepare(
        `INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,
          sending_key_claimed_at,sending,receiving,sending_status,receiving_status,configured_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,1,0,'ready','disabled',?7)`,
      )
      .bind(
        domainId,
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        domain,
        `provider_${domainId}`,
        "2026-10-01T00:00:00.000000Z",
      )
      .run();
    expect(await invokeD1ResendManagement(environment(), "ensure_pending", scope)).toMatchObject({
      domain_id: domainId,
      sending: "ready",
    });
    expect((await row(domainId))?.k).toMatch(/^created_key_/u);
  });

  it("reads a mail domain without creating or revoking its sending key while a recent key claim is open", async () => {
    const { scope } = await freshProject(),
      domainId = newUlid(),
      domain = `claimed-${domainId.slice(-10).toLowerCase()}.example.com`;
    providerDomains.set(`provider_${domainId}`, domain);
    // A key creation that claimed the row a minute ago is still in flight, so only the reconciliation may touch keys.
    const claimedAt = `${new Date(Date.now() - 60_000).toISOString().slice(0, -1)}000Z`;
    await control.core
      .prepare(
        `INSERT INTO resend_mail_domains(domain_id,organization_id,project_id,environment_id,domain,provider_domain_id,
          sending_key_claimed_at,sending,receiving,sending_status,receiving_status,configured_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,1,0,'ready','disabled',?7)`,
      )
      .bind(
        domainId,
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        domain,
        `provider_${domainId}`,
        claimedAt,
      )
      .run();
    providerCalls.length = 0;
    expect(await invokeD1ResendManagement(environment(), "get", scope)).toMatchObject({
      domain_id: domainId,
      sending: "pending",
    });
    expect(providerCalls.filter((call) => call.includes("/api-keys"))).toEqual([]);
    expect((await row(domainId))?.k).toBeNull();
  });

  it("admits receiving on configure and verifies the webhook with a signed delivery", async () => {
    const { project, scope: ids } = await freshProject(),
      scope = {
        organizationId: parseUlid(ids.organizationId),
        projectId: parseUlid(ids.projectId),
        environmentId: parseUlid(ids.environmentId),
      },
      domain = await seedReadyMailDomain(control, project),
      env = environment(),
      clock = new SystemClock(),
      posts: { body: string; headers: Headers }[] = [];
    providerDomains.set(domain.providerDomainId, domain.domain);
    const runtime = createResendMailManagement({
      persistence: await createD1ResendManagementPersistence(env.MAIL_MANAGEMENT_RUNTIME),
      capabilityPersistence: await createD1WorkspaceMailCapabilityPersistence(
        env.MAIL_CAPABILITY_RUNTIME,
      ),
      apiKey: env.RESEND_API_KEY,
      signingKey: env.MAIL_WEBHOOK_SIGNING_KEY,
      sendingKeyEncryptionKey: env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      now: () => clock.now(),
      dns: env.CLOUDFLARE_DOMAIN_MANAGEMENT,
      publicTarget: async (value) => new URL(value),
      fetch: async (raw, init) => {
        const request = new Request(raw, init);
        if (new URL(request.url).origin !== "https://receiver.example.com")
          return resend(request.url, init);
        posts.push({ body: await request.text(), headers: request.headers });
        return new Response(null, { status: 200 });
      },
    });
    await fundMail(control, project.organizationId);
    expect(
      await runtime.configure({
        ...scope,
        ...principal,
        domain: domain.domain,
        sending: true,
        receiving: true,
        idempotencyKey: "configure-receiving",
      }),
    ).toMatchObject({ domain_id: domain.domainId, receiving: "ready" });
    expect(await runtime.verifyWebhook(scope)).toMatchObject({
      domain_id: domain.domainId,
      webhook: { url: "https://receiver.example.com/mail", verified: true },
    });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]?.body ?? "null")).toMatchObject({
      type: "email.webhook_test",
      project_id: scope.projectId,
    });
    expect(posts[0]?.headers.get("content-type")).toMatch(/json/u);
  });

  it("rotates the signing secret: the next signed test carries the new generation, the old secret stops verifying, and a replay answers the current secret", async () => {
    const { project, scope: ids } = await freshProject(),
      scope = {
        organizationId: parseUlid(ids.organizationId),
        projectId: parseUlid(ids.projectId),
        environmentId: parseUlid(ids.environmentId),
      },
      domain = await seedReadyMailDomain(control, project),
      env = environment(),
      clock = new SystemClock(),
      posts: { body: string; headers: Headers }[] = [];
    providerDomains.set(domain.providerDomainId, domain.domain);
    const runtime = createResendMailManagement({
      persistence: await createD1ResendManagementPersistence(env.MAIL_MANAGEMENT_RUNTIME),
      capabilityPersistence: await createD1WorkspaceMailCapabilityPersistence(
        env.MAIL_CAPABILITY_RUNTIME,
      ),
      apiKey: env.RESEND_API_KEY,
      signingKey: env.MAIL_WEBHOOK_SIGNING_KEY,
      sendingKeyEncryptionKey: env.MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64,
      ids: createUlidFactory({ clock, entropy: new SystemEntropy() }),
      now: () => clock.now(),
      dns: env.CLOUDFLARE_DOMAIN_MANAGEMENT,
      publicTarget: async (value) => new URL(value),
      fetch: async (raw, init) => {
        const request = new Request(raw, init);
        if (new URL(request.url).origin !== "https://receiver.example.com")
          return resend(request.url, init);
        posts.push({ body: await request.text(), headers: request.headers });
        return new Response(null, { status: 200 });
      },
    });
    const signedBy = (secret: string, post: { body: string; headers: Headers } | undefined) => {
      const id = post?.headers.get("webhook-id"),
        time = post?.headers.get("webhook-timestamp");
      return (
        post?.headers.get("webhook-signature") ===
        "v1," +
          createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
            .update(`${id}.${time}.${post?.body}`)
            .digest("base64")
      );
    };
    const original = mailWebhookSecret(env.MAIL_WEBHOOK_SIGNING_KEY, domain.domainId);
    await fundMail(control, project.organizationId);
    await runtime.configure({
      ...scope,
      ...principal,
      domain: domain.domain,
      sending: true,
      receiving: true,
      idempotencyKey: "configure-rotation",
    });
    await runtime.verifyWebhook(scope);
    expect(signedBy(original, posts[0])).toBe(true);

    const rotated = await runtime.rotateWebhook(scope);
    expect(rotated).toMatchObject({
      url: "https://receiver.example.com/mail",
      status: "verification_required",
    });
    expect(rotated.signing_secret).not.toBe(original);
    await runtime.verifyWebhook(scope);
    expect(signedBy(rotated.signing_secret, posts[1])).toBe(true);
    expect(signedBy(original, posts[1])).toBe(false);

    // A replay of the same idempotency key answers the current secret and does not advance the generation again.
    const rotate = (idempotencyKey: string) =>
      invokeD1ResendManagement(env, "rotateWebhook", {
        ...scope,
        ...principal,
        idempotencyKey,
      }) as Promise<{ signing_secret: string }>;
    const once = await rotate("rotate-once");
    expect(once.signing_secret).not.toBe(rotated.signing_secret);
    expect(await rotate("rotate-once")).toMatchObject({ signing_secret: once.signing_secret });
    expect((await rotate("rotate-twice")).signing_secret).not.toBe(once.signing_secret);
  });

  it("retires the project's mail domain: key and domain removed, absence read back, receipt recorded", async () => {
    const { project, scope } = await freshProject(),
      domain = await seedReadyMailDomain(control, project, { receiving: false });
    providerDomains.set(domain.providerDomainId, domain.domain);
    providerKeys.add(`key_${domain.domainId}`);
    expect(
      await invokeD1ResendManagement(environment(), "retire", {
        ...scope,
        ...principal,
        idempotencyKey: "retire-project",
      }),
    ).toMatchObject({ status: "deleted", domain: domain.domain });
    expect(providerDomains.has(domain.providerDomainId)).toBe(false);
    expect(providerKeys.has(`key_${domain.domainId}`)).toBe(false);
    expect((await row(domain.domainId))?.d).not.toBeNull();
  });
});

describe("the workspace manager lifecycle", () => {
  const digest = new Uint8Array(32).fill(7);
  const request = (
    organizationId: string,
    domainId: string,
    commandOperation: string,
    idempotencyKey: string,
  ) => ({
    organizationId,
    domainId,
    canonicalRequestDigest: digest,
    idempotencyKey,
    principalId: "user:owner",
    commandOperation,
    expectedRevision: 1,
  });
  const receipt = (organizationId: string, domainId: string, operation: string, key: string) =>
    control.core
      .prepare(
        "INSERT INTO workspace_mail_commands(organization_id,idempotency_key,domain_id,operation,principal_id,request_sha256,response,created_at) VALUES(?1,?2,?3,?4,'user:owner',?5,NULL,?6)",
      )
      .bind(organizationId, key, domainId, operation, digest, STORED_NOW)
      .run();

  it("provisions a native sender whose records failed and asks the provider to verify again", async () => {
    const project = await seedProject(control),
      native = await seedNativeWorkspaceDomain(control, project);
    await fundMail(control, project.organizationId);
    await receipt(project.organizationId, native.domainId, "create", "create-native");
    dkimStatus = "failed";
    expect(
      await invokeD1WorkspaceMailManagement(
        environment(),
        "ensure",
        request(project.organizationId, native.domainId, "create", "create-native"),
      ),
    ).toMatchObject({ domain_id: native.domainId, sending: "failed" });
    expect(providerCalls.some((call) => call.endsWith("/verify"))).toBe(true);
    expect(dnsCalls.map(({ method }) => method)).toContain("ensureWorkspaceMailRecords");
  });

  it("clears a verification claim that Resend definitely refused, so the next ensure asks again at once", async () => {
    const project = await seedProject(control),
      native = await seedNativeWorkspaceDomain(control, project),
      ensure = () =>
        invokeD1WorkspaceMailManagement(
          environment(),
          "ensure",
          request(project.organizationId, native.domainId, "create", "create-refused"),
        );
    await fundMail(control, project.organizationId);
    await receipt(project.organizationId, native.domainId, "create", "create-refused");
    dkimStatus = "failed";
    verifyRefusals = 1;
    await expect(ensure()).rejects.toThrow();
    providerCalls.length = 0;
    // Without the cleared claim the ten-minute guard would keep this retry from asking Resend.
    await expect(ensure()).resolves.toMatchObject({ domain_id: native.domainId });
    expect(providerCalls.filter((call) => call.endsWith("/verify"))).toHaveLength(1);
  });

  it("reconciles and retires a sender that still has its project domain", async () => {
    const project = await seedProject(control),
      legacy = await seedReadyMailDomain(control, project, { receiving: false }),
      org = project.organizationId;
    providerDomains.set(legacy.providerDomainId, legacy.domain);
    providerKeys.add(`key_${legacy.domainId}`);
    await fundMail(control, org);
    await receipt(org, legacy.domainId, "create", "create-legacy");
    await receipt(org, legacy.domainId, "retire", "retire-legacy");
    // Retirement needs the project binding gone first, as the control plane leaves it.
    await control.core
      .prepare("DELETE FROM project_mail_domain_bindings WHERE project_id=?")
      .bind(project.projectId)
      .run();
    expect(
      await invokeD1WorkspaceMailManagement(
        environment(),
        "ensure",
        request(org, legacy.domainId, "create", "create-legacy"),
      ),
    ).toMatchObject({ domain_id: legacy.domainId, status: "active" });
    expect(
      await invokeD1WorkspaceMailManagement(
        environment(),
        "retire",
        request(org, legacy.domainId, "retire", "retire-legacy"),
      ),
    ).toMatchObject({ domain_id: legacy.domainId, status: "retired" });
    expect(providerDomains.has(legacy.providerDomainId)).toBe(false);
    expect(providerKeys.has(`key_${legacy.domainId}`)).toBe(false);
  });
});
