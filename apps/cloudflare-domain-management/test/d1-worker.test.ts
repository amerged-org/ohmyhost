import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  ApplicationIdentityRuntime,
  CloudflareDomainRuntime,
  MailDnsRuntime,
  ScopedDnsRuntime,
} from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { bytes, seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { deletingProject, digest, iso } from "./support/cloudflare-core.js";
import { providerLog } from "./support/cloudflare-fake.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("@ohmyhost/provider-cloudflare", async (original) => {
  const fake = await import("./support/cloudflare-fake.js");
  return {
    ...(await original<Record<string, unknown>>()),
    CloudflareCustomerDnsProvider: fake.FakeCustomerDnsProvider,
    createCloudflarePlatformDomainProvider: fake.fakePlatformDomains,
    createCloudflareWorkerRouteProvider: fake.fakeRoutes,
    createCloudflareCustomHostnameProvider: fake.fakeCustomHostnames,
  };
});
import { CloudflareDomainManagementService } from "../src/worker-main.js";
import { createD1MailComponents } from "../src/d1-mail-components.js";
import { createD1ProductionCloudflareRuntime } from "../src/d1-runtime.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await control.dispose();
});
beforeEach(() => {
  providerLog.length = 0;
});

const environment = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured" as const,
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
  CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
  CLOUDFLARE_SAAS_API_TOKEN: "fixture-saas-domain-token-value",
  CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-oauth-client-id",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "fixture-oauth-client-secret",
  CLOUDFLARE_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback",
  CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x42).toString("base64"),
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
  CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "fixture-platform-web-domain-token",
  GENERAL_CF_RUNTIME: new CloudflareDomainRuntime({} as never, control.bindings as never),
  NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
  NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: async () => ({ outcome: "applied" }) },
  SCOPED_DNS_RUNTIME: new ScopedDnsRuntime({} as never, control.bindings as never),
  APPLICATION_IDENTITY_RUNTIME: new ApplicationIdentityRuntime(
    {} as never,
    control.bindings as never,
  ),
  MAIL_DNS_RUNTIME: new MailDnsRuntime({} as never, control.bindings as never),
  DEV_ACCESS: { issueRuntimeProbe: async () => ({}) },
  RUNTIME_PROBES: { beginProbe: async () => ({}) },
});

it("serves the authorization, refresh and project deletion of a project through the shipped D1 Worker", async () => {
  const service = new CloudflareDomainManagementService({} as never, environment() as never),
    project = await seedProject(control, { handle: "worker-check" }),
    scope = { organizationId: project.organizationId, projectId: project.projectId },
    actor = { ...scope, actorId: "user:user_consent" };
  await control.core
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.worker.test',NULL,'awaiting_deployment','user:user_consent',?3,?4,?5,?5,NULL)",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      bytes(32, 1),
      bytes(32, 2),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();

  // The general flow: ticket, callback (the scoped table does not know it, so the general one answers), status.
  const begun = await service.beginAuthorization({
    ...actor,
    zone: "worker.test",
    idempotencyKeySha256: digest("worker key"),
    requestSha256: digest("worker request"),
  });
  const state = new URL((begun as { authorizationUrl: string }).authorizationUrl).searchParams.get(
    "state",
  );
  expect(
    await service.completeAuthorization({
      code: "fixture-code-1",
      state,
      principalId: actor.actorId,
    }),
  ).toEqual({
    status: "authorized",
  });
  expect(providerLog).toEqual(["exchange-code", "observe-zone"]);
  expect(await service.getStatus(actor)).toMatchObject({
    status: "authorized",
    zone: "worker.test",
  });
  // An expired token is renewed under the Core's lease; the request hook renews that lease first.
  await control.core
    .prepare(
      "UPDATE cloudflare_project_dns_grants SET access_expires_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(scope.organizationId)
    .run();
  expect(
    await service.configureDomains({
      ...actor,
      projectHandle: project.handle,
      idempotencyKeySha256: digest("configure"),
      requestSha256: digest("configure request"),
    }),
  ).toMatchObject({ status: 202 });
  const rotated = new CloudflareDomainManagementService(
    {} as never,
    {
      ...environment(),
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "20261106",
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON: JSON.stringify({
        1: environment().CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64,
      }),
    } as never,
  );
  expect(await rotated.getStatus(actor)).toMatchObject({ status: "authorized" });
  expect(
    (
      await control.core
        .prepare(
          "SELECT key_version FROM cloudflare_project_dns_grants WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(scope.organizationId, scope.projectId)
        .first<{ key_version: number }>()
    )?.key_version,
  ).toBe(20261106);
  expect(providerLog.slice(2)).toEqual(["observe-refresh-token"]);
  // State issued by an old invocation is consumed by its persisted digest after the primary changes.
  const pendingProject = await seedProject(control, { handle: "old-primary-callback" });
  const pendingActor = {
    organizationId: pendingProject.organizationId,
    projectId: pendingProject.projectId,
    actorId: "user:user_consent",
  };
  await control.core
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.pending.test',NULL,'awaiting_deployment','user:user_consent',?3,?4,?5,?5,NULL)",
    )
    .bind(
      pendingActor.organizationId,
      pendingActor.projectId,
      bytes(32, 3),
      bytes(32, 4),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
  const pendingRequest = {
    ...pendingActor,
    zone: "pending.test",
    idempotencyKeySha256: digest("old-primary-pending"),
    requestSha256: digest("old-primary-pending-request"),
  };
  const oldPrimaryAuthorization = await service.beginAuthorization(pendingRequest);
  await expect(rotated.beginAuthorization(pendingRequest)).rejects.toThrow(
    "Cloudflare domain-management state conflicts with the requested operation",
  );
  const oldPrimaryState = new URL(
    (oldPrimaryAuthorization as { authorizationUrl: string }).authorizationUrl,
  ).searchParams.get("state");
  expect(
    await rotated.completeAuthorization({
      code: "fixture-code-2",
      state: oldPrimaryState,
      principalId: pendingActor.actorId,
    }),
  ).toEqual({ status: "authorized" });
  expect(
    (
      await control.core
        .prepare(
          "SELECT key_version FROM cloudflare_project_dns_grants WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(pendingActor.organizationId, pendingActor.projectId)
        .first<{ key_version: number }>()
    )?.key_version,
  ).toBe(20261106);
  // The scoped table answers its own callbacks first.
  expect(await service.readApplicationDomainIdentity(actor)).toBeNull();

  // Project deletion removes the Paid domain first, then the platform records, route and the customer grant.
  const doomed = await deletingProject(control, "worker-doomed", { grant: "fresh" }),
    hostname = `${doomed.handle}.example.test`;
  await control.core
    .prepare(
      "UPDATE paid_project_domains SET state='active',gateway_script_name='ohmyho-gateway-production',provisioning_started_at=created_at,hostname_proven_at=created_at,custom_hostname_receipt=?3,worker_route_receipt=?4 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(
      doomed.request.organizationId,
      doomed.request.projectId,
      JSON.stringify({
        customHostnameId: "1".repeat(32),
        hostname,
        customerCnameTarget: "customers.omh.st",
        dnsRecords: [
          { purpose: "traffic", type: "CNAME", name: hostname, content: "customers.omh.st" },
        ],
        observedAt: iso(0),
      }),
      JSON.stringify({
        routeId: "2".repeat(32),
        hostname,
        scriptName: "ohmyho-gateway-production",
        pattern: `${hostname}/*`,
        observedAt: iso(0),
      }),
    )
    .run();
  providerLog.length = 0;
  expect(await service.deleteProject(doomed.request)).toMatchObject({
    outcome: "deleted",
    oauthGrant: "revoked",
  });
  expect(providerLog).toEqual([
    "reconcile-records",
    "delete-records",
    "delete-route",
    "delete-hostname",
    "platform-delete-records",
    "delete-route",
    "revoke:fixture-refresh-token-1",
  ]);
});

it("refuses an incomplete Core capability before any provider is built", async () => {
  const withoutMethod = {
    ...environment(),
    GENERAL_CF_RUNTIME: { claimAuthorization: async () => null },
  };
  await expect(
    new CloudflareDomainManagementService({} as never, withoutMethod as never).getStatus({}),
  ).rejects.toThrow("Cloudflare D1 capability is incomplete");
});

it("composes a runtime operation for every RPC the Worker serves", async () => {
  const served = Object.getOwnPropertyNames(CloudflareDomainManagementService.prototype).filter(
    (name) => name !== "constructor",
  );
  const runtime = await createD1ProductionCloudflareRuntime(
    environment() as never,
    createD1MailComponents,
  );
  expect(served.length).toBeGreaterThan(20);
  expect(Object.keys(runtime)).toEqual(expect.arrayContaining(served));
});

it("rejects a foreign Native policy recovery receipt before a Paid deletion can take effect", async () => {
  const project = await seedProject(control, { handle: "native-recovery-scope" });
  const real = new CloudflareDomainRuntime({} as never, control.bindings as never);
  const begin = vi.fn(async () => ({
    organizationId: project.organizationId,
    projectId: "00000000000000000000000001",
    kind: "paid_delete",
    identity: "a".repeat(64),
    recoveryId: "b".repeat(64),
  }));
  const complete = vi.fn(async () => "completed");
  const binding = new Proxy(real, {
    get(target, key) {
      if (key === "beginPaidDomainRecovery") return begin;
      if (key === "completePaidDomainRecovery") return complete;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new CloudflareDomainManagementService(
    {} as never,
    { ...environment(), GENERAL_CF_RUNTIME: binding } as never,
  );
  await expect(
    service.deletePaidDomain({
      organizationId: project.organizationId,
      projectId: project.projectId,
      hostname: "auth.example.test",
      actorId: "user:user_consent",
      idempotencyKeySha256: `sha256:${"b".repeat(64)}`,
      requestSha256: `sha256:${"c".repeat(64)}`,
    }),
  ).rejects.toThrow("Native domain recovery unavailable");
  expect(begin).toHaveBeenCalledOnce();
  expect(complete).not.toHaveBeenCalled();
  expect(providerLog).toEqual([]);
});
