import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  ApplicationIdentityRuntime,
  CloudflareDomainRuntime,
  MailDnsRuntime,
  ScopedDnsRuntime,
} from "../../control-store/src/worker-main.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
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
import { createPaidDomainPolicySynchronizer } from "../src/d1-runtime.js";

let control: TestControl;
const lookups: string[] = [];
beforeAll(async () => {
  control = await createTestControl();
  // The DNS-over-HTTPS resolver answers with no body: nothing is published under any name.
  vi.stubGlobal("fetch", async (input: unknown) => {
    lookups.push(String(input));
    return new Response(null, { status: 204 });
  });
}, 60_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await control.dispose();
});
beforeEach(() => {
  providerLog.length = 0;
  lookups.length = 0;
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

it("asks DNS for an unpublished Paid challenge through the shipped Worker and shows it in the Paid status", async () => {
  const project = await seedProject(control, { handle: "paid-ownership-runtime" });
  await makePaid(control.core, project.organizationId);
  const service = new CloudflareDomainManagementService({} as never, environment() as never);
  const scope = { organizationId: project.organizationId, projectId: project.projectId };
  const hostname = "app.paid-ownership.example";

  await expect(
    service.applyPaidDomain({
      ...scope,
      actorId: "user:user_paid",
      hostname,
      idempotencyKeySha256: `sha256:${"a".repeat(64)}`,
      requestSha256: `sha256:${"b".repeat(64)}`,
    }),
  ).resolves.toMatchObject({ status: "conflict", code: "domain_ownership_required" });
  expect(
    lookups.some(
      (url) => url.includes(`name=_omh-project.${hostname}`) && url.includes("type=TXT"),
    ),
  ).toBe(true);

  await expect(
    service.getPaidDomain({ ...scope, actorId: "user:user_paid" }),
  ).resolves.toMatchObject({
    status: "awaiting_deployment",
    hostname,
    validationRecords: [
      {
        type: "TXT",
        name: `_omh-project.${hostname}`,
        content: expect.stringMatching(/^omh-domain-v1=[A-Za-z0-9_-]{43}$/u),
        purpose: "ownership",
      },
    ],
  });
});

it("applies a pending Native realm policy to its region, then acknowledges it, and acknowledges an unprovisioned one", async () => {
  const acknowledged: Record<string, unknown>[] = [];
  const applied: Record<string, unknown>[] = [];
  const pending = [
    {
      environmentId: "0".repeat(26),
      region: "us",
      configurationRevision: 2,
      revocationEpoch: 1,
      ownerEnabled: false,
      canonicalOrigin: null,
      registryVersion: 3,
    },
    {
      environmentId: "1".repeat(26),
      region: "eu",
      configurationRevision: 1,
      revocationEpoch: 1,
      ownerEnabled: true,
      canonicalOrigin: null,
      registryVersion: null,
    },
  ];
  const synchronize = createPaidDomainPolicySynchronizer(
    {
      readDomainPolicySync: async () => pending,
      ackDomainPolicySync: async (input) => {
        acknowledged.push(input as Record<string, unknown>);
        return "acknowledged";
      },
    },
    {
      NATIVE_AUTH_ADMIN_US: {
        applyRealmPolicy: async (policy: unknown) => {
          applied.push(policy as Record<string, unknown>);
          return { outcome: "applied" };
        },
      },
      NATIVE_AUTH_ADMIN_EU: {
        applyRealmPolicy: async () => {
          throw new Error("the unprovisioned realm is not applied");
        },
      },
    } as never,
  );
  await synchronize({
    organizationId: "2".repeat(26),
    projectId: "3".repeat(26),
    idempotencyKeySha256: `sha256:${"c".repeat(64)}`,
  });
  expect(applied).toEqual([
    expect.objectContaining({
      environmentId: "0".repeat(26),
      enabled: false,
      configurationRevision: 2,
    }),
  ]);
  expect(acknowledged.map((input) => input["acknowledgement"])).toEqual([
    "applied",
    "unprovisioned",
  ]);
});
