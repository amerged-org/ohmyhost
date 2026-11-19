import { expect, it, vi } from "vitest";
import { classifyMailDomain } from "@ohmyhost/platform";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      public readonly env: unknown,
    ) {}
  },
}));
vi.mock("@ohmyhost/provider-cloudflare", async (original) => {
  const fake = await import("./support/cloudflare-fake.js");
  return {
    ...(await original<Record<string, unknown>>()),
    CloudflareCustomerDnsProvider: fake.FakeCustomerDnsProvider,
  };
});
import {
  createCloudflareDomainManagementEntrypoint,
  createLegacyProductionCloudflareDomainManagementEntrypoint,
  createCloudflareDomainManagementService,
} from "../src/worker-main.js";
import {
  requireCloudflareDomainManagementBindings,
  requireLegacyProductionCloudflareDomainManagementBindings,
} from "../src/bindings.js";
import { createD1ScopedDnsPersistence } from "../src/d1-scoped-dns-persistence.js";
import { createLegacyProductionD1PaidDomainPersistence } from "../src/d1-paid-persistence.js";
import { createPaidDomainRuntime } from "../src/paid-domains.js";
import { createApplicationDomainIdentityRuntime } from "../src/application-domain-identity.js";
import {
  parseScopedDnsDelegation,
  parseLegacyProductionScopedDnsDelegation,
} from "../src/scoped-dns-authorization.js";
import { createCloudflareDomainSecrets } from "../src/secrets.js";
import productionWorker, {
  CloudflareDomainManagementService as ProductionService,
} from "../src/production-keyring-worker.js";

const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  project = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const oldKey = Buffer.alloc(32, 0x41).toString("base64"),
  newKey = Buffer.alloc(32, 0x43).toString("base64");
const nativeMethods = [
  "readDomainPolicySync",
  "ackDomainPolicySync",
  "beginPaidDomainRecovery",
  "completePaidDomainRecovery",
];
const methods = [
  "beginAuthorization",
  "getStatus",
  "configureDomains",
  "completeAuthorization",
  "ensureEnvironment",
  "deleteMailRecords",
  "ensureMailRecords",
  "ensureWorkspaceMailRecords",
  "retireWorkspaceMailRecords",
  "deleteProject",
  "planPaidDomain",
  "applyPaidDomain",
  "getPaidDomain",
  "deletePaidDomain",
  "readApplicationDomainIdentity",
  "revalidateApplicationDomainIdentity",
  "declareApplicationDomainIdentity",
  "verifyApplicationDomainIdentity",
  "revokeApplicationDomainIdentity",
  "beginApplicationIdentityAuthorization",
  "getApplicationIdentityAuthorizationStatus",
  "beginWorkspaceMailAuthorization",
  "getWorkspaceMailAuthorizationStatus",
  "revokeApplicationIdentityAuthorization",
  "revokeWorkspaceMailAuthorization",
  "sweepRevokedGrants",
].sort();
const base = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_PLATFORM_ZONE_ID: "c".repeat(32),
  CLOUDFLARE_SAAS_ZONE_ID: "b".repeat(32),
  CLOUDFLARE_SAAS_CNAME_TARGET: "customers.ohmyho.st",
  CLOUDFLARE_SAAS_API_TOKEN: "fixture-saas-domain-token-value",
  CLOUDFLARE_OAUTH_CLIENT_ID: "fixture-client",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "fixture-client-secret",
  CLOUDFLARE_OAUTH_REDIRECT_URI: "https://app.ohmyho.st/v1/cloudflare/oauth/callback",
  CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1",
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: oldKey,
  CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "1",
  CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: "fixture-platform-domain-token",
  DEV_ACCESS: { issueRuntimeProbe: async () => ({}) },
  RUNTIME_PROBES: { beginProbe: async () => ({}) },
  GENERAL_CF_RUNTIME: {},
  SCOPED_DNS_RUNTIME: {},
  APPLICATION_IDENTITY_RUNTIME: {},
  MAIL_DNS_RUNTIME: {},
});

it("keeps the original 25 RPCs plus the revoked-grant sweep and private 404 while the full composition still requires Native", async () => {
  const bindings = new Proxy(base(), {
    get(target, key, receiver) {
      if (key === "NATIVE_AUTH_ADMIN_US" || key === "NATIVE_AUTH_ADMIN_EU")
        throw new Error("Native service was accessed");
      return Reflect.get(target, key, receiver);
    },
  });
  expect(requireLegacyProductionCloudflareDomainManagementBindings(bindings)).toBe(bindings);
  expect(() => requireCloudflareDomainManagementBindings(bindings)).toThrow("bindings are invalid");
  const invoked: string[] = [];
  const factory = vi.fn(
    async () =>
      Object.fromEntries(
        methods.map((name) => [
          name,
          async (input: unknown) => {
            invoked.push(name);
            return input;
          },
        ]),
      ) as never,
  );
  const entrypoint = createLegacyProductionCloudflareDomainManagementEntrypoint({
    runtimeFactory: factory,
  });
  const Service = createCloudflareDomainManagementService(entrypoint);
  expect(
    Object.getOwnPropertyNames(Service.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
  ).toEqual(methods);
  const service = new Service({}, bindings);
  for (const method of methods)
    expect(await service[method as keyof typeof service]({ marker: method })).toEqual({
      marker: method,
    });
  expect(invoked).toEqual(methods);
  expect(factory).toHaveBeenCalledTimes(26);
  const fullFactory = vi.fn();
  await expect(
    createCloudflareDomainManagementEntrypoint({ runtimeFactory: fullFactory }).getStatus(
      bindings,
      {},
    ),
  ).rejects.toThrow();
  expect(fullFactory).not.toHaveBeenCalled();
  const response = await productionWorker.fetch();
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(() =>
    requireLegacyProductionCloudflareDomainManagementBindings({
      ...base(),
      CLOUDFLARE_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback",
      CLOUDFLARE_SAAS_CNAME_TARGET: "customers.omh.st",
    }),
  ).toThrow();
});

it("preserves legacy delete wire, classification and delegation ceilings without Native callbacks", async () => {
  const wire: unknown[] = [];
  const binding = {
    readPaidDomainRecord: async () => null,
    claimPaidDomainDelete: async (input: unknown) => {
      wire.push(input);
      return null;
    },
    markPaidDomainDeleted: async (input: unknown) => {
      wire.push(input);
    },
  };
  const persistence = createLegacyProductionD1PaidDomainPersistence(binding as never, {
    next: () => id,
  });
  const raw = {
    organizationId: id,
    projectId: project,
    actorId: "user:owner",
    hostname: "app.example.com",
    idempotencyKeySha256: `sha256:${"a".repeat(64)}`,
    requestSha256: `sha256:${"b".repeat(64)}`,
  };
  const runtime = createPaidDomainRuntime({
    persistence,
    cnameTarget: "customers.ohmyho.st",
    observeTxt: async () => false,
    clock: { now: () => new Date("2026-11-06T00:00:00.000Z") },
    routes: {} as never,
    customHostnames: {} as never,
  });
  expect(await runtime.deletePaidDomain(raw)).toMatchObject({ status: "deleted" });
  expect(Object.keys(wire[0] as object).sort()).toEqual(
    [
      "organizationId",
      "projectId",
      "hostname",
      "idempotencyKeySha256",
      "requestSha256",
      "now",
    ].sort(),
  );
  await persistence.markDeleted({
    organizationId: id as never,
    projectId: project as never,
    hostname: raw.hostname,
    now: "2026-11-06T00:00:00.000Z",
    idempotencyKeySha256: raw.idempotencyKeySha256,
  });
  expect(Object.keys(wire[1] as object).sort()).toEqual(
    ["organizationId", "projectId", "hostname", "now"].sort(),
  );
  await expect(runtime.deletePaidDomain({ ...raw, delegation: {} })).rejects.toThrow();
  const delegation = {
    grantId: "6f1c1b0e-9f3a-4c53-8d57-3d5a9f0f3a11",
    grantRevision: 1,
    clientId: "client",
    consentHash: "c".repeat(64),
  };
  for (const value of [
    { ...delegation, action: "auth:read" },
    { ...delegation, authorizationRestriction: { actions: ["auth:manage"] } },
  ]) {
    expect(() => parseLegacyProductionScopedDnsDelegation(value)).toThrow();
    expect(parseScopedDnsDelegation(value)).toMatchObject(delegation);
  }
  expect(
    parseLegacyProductionScopedDnsDelegation({ ...delegation, action: "projects:write" }),
  ).toMatchObject({ action: "projects:write" });
  const scopedNames = [
    "readAuthorization",
    "issue",
    "status",
    "revoke",
    "listRevokedGrants",
    "wipeRevokedGrantTokens",
    "listDisplacedTokens",
    "completeDisplacedToken",
    "consume",
    "saveGrant",
    "claimUse",
    "renewUse",
    "authorizeUse",
    "finishUse",
    "releaseUse",
    "readCleanup",
    "completeEmptyCleanup",
  ];
  const scoped = Object.fromEntries(
    scopedNames.map((name) => [
      name,
      async (input: unknown) =>
        name === "readAuthorization"
          ? null
          : { ...(input as object), signedDelegation: { ...delegation, action: "auth:read" } },
    ]),
  );
  const scopedPersistence = await createD1ScopedDnsPersistence(
    scoped,
    parseLegacyProductionScopedDnsDelegation,
  );
  await expect(
    scopedPersistence.issue({
      organizationId: id,
      purpose: "application_identity",
      resourceId: project,
      resourceRevision: 1,
      authorizationId: id,
      principalId: "user:owner",
      zoneName: "example.com",
      idempotencyKeySha256: Buffer.alloc(32),
      requestSha256: Buffer.alloc(32),
      stateSha256: Buffer.alloc(32),
      issuedAt: "2026-11-06T00:00:00.000000Z",
      expiresAt: "2026-11-06T00:10:00.000000Z",
      delegation: null,
    } as never),
  ).rejects.toThrow("delegation action");
  const row = {
    organizationId: id,
    projectId: project,
    hostname: "legacy.omh.st",
    registrableDomain: "omh.st",
    state: "pending",
    revision: 1,
    challengeName: "_omh-project.legacy.omh.st",
    challengeValue: "fixture",
    verifiedAt: null,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const ensure = vi.fn(async () => {});
  const identityInput = {
    persistence: {
      declare: async () => row,
      replay: async () => null,
      readForVerification: async () => row,
      verify: async () => ({ status: "verified" }),
    } as never,
    clock: { now: () => new Date("2026-11-06T00:00:00.000Z") },
    observeTxt: async () => true,
    ensureChallenge: ensure,
  };
  const identity = createApplicationDomainIdentityRuntime({
    ...identityInput,
    identityPolicy: { classify: classifyMailDomain },
    parseDelegation: parseLegacyProductionScopedDnsDelegation,
  });
  expect(
    await identity.declareApplicationDomainIdentity({ ...raw, hostname: row.hostname }),
  ).toMatchObject({ hostname: row.hostname });
  const verify = {
    organizationId: id,
    projectId: project,
    actorId: raw.actorId,
    idempotencyKeySha256: raw.idempotencyKeySha256,
    requestSha256: raw.requestSha256,
    expectedRevision: 1,
  };
  await expect(identity.verifyApplicationDomainIdentity(verify)).resolves.toMatchObject({
    status: "verified",
  });
  await expect(
    createApplicationDomainIdentityRuntime(identityInput).verifyApplicationDomainIdentity(verify),
  ).rejects.toThrow("customer mail domain");
});

it("reads old v1 grants and writes the dated key through the bounded runtime without touching Native Core", async () => {
  const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const aad = `ohmyhost.cloudflare-project-grant/v1:${id}:${project}:${grantId}`;
  const old = createCloudflareDomainSecrets({ keyBase64: oldKey, keyVersion: 1, crypto });
  const [access, refresh] = await Promise.all([
    old.tokenCipher.seal("fixture-old-access-token", `${aad}:access`),
    old.tokenCipher.seal("fixture-old-refresh-token", `${aad}:refresh`),
  ]);
  let grant = {
    organizationId: id,
    projectId: project,
    authorizationId: grantId,
    principalId: "user:owner",
    zoneId: "d".repeat(32),
    zoneName: "example.com",
    accountId: "e".repeat(32),
    scopes: ["dns.write", "zone.read"],
    keyVersion: 1,
    accessExpiresAt: "2000-01-01T00:00:00.000Z",
    connectedAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000000Z",
    status: "active",
    revokedAt: null,
    accessCiphertext: Buffer.from(access.ciphertext, "base64"),
    accessNonce: Buffer.from(access.nonce, "base64"),
    refreshCiphertext: Buffer.from(refresh.ciphertext, "base64"),
    refreshNonce: Buffer.from(refresh.nonce, "base64"),
  };
  let sealed: Record<string, unknown> | null = null;
  const compositionProbes: string[] = [];
  const coreNames = [
    "claimAuthorization",
    "consumeAuthorization",
    "putGrant",
    "readStatus",
    "configureDomains",
    "readGrant",
    "claimGrantUse",
    "renewGrantUse",
    "finishGrantUse",
    "releaseGrantUse",
    "admitPaidProjectDomain",
    "readPaidDomainTarget",
    "claimPaidDomainApply",
    "putPaidDomainActive",
    "readPaidDomainRecord",
    "readPaidDomainProof",
    "ensurePaidDomainProof",
    "verifyPaidDomainProof",
    "claimPaidDomainDelete",
    "markPaidDomainDeleted",
    "claimPaidProjectDeletion",
    "readReconciliation",
    "rotateGrant",
    "readDeletion",
    "rotateDeletionGrant",
    "prepareRevocation",
    "restartRevocation",
    "finalizeDeletion",
    "finalizePlatformDeletion",
    "readAuthorization",
    "issue",
    "status",
    "revoke",
    "listRevokedGrants",
    "wipeRevokedGrantTokens",
    "listDisplacedTokens",
    "completeDisplacedToken",
    "consume",
    "saveGrant",
    "claimUse",
    "renewUse",
    "authorizeUse",
    "finishUse",
    "releaseUse",
    "readCleanup",
    "completeEmptyCleanup",
    "read",
    "declare",
    "replay",
    "readForVerification",
    "completeAction",
    "readAutomatic",
    "completeAutomatic",
    "workspace",
    "legacy",
    "deletion",
    "requirePaid",
    "saveWorkspace",
    "saveLegacy",
  ];
  const core = new Proxy(
    Object.fromEntries(
      coreNames.map((name) => [
        name,
        async (input: Record<string, unknown>) => {
          if (["readAuthorization", "read", "legacy"].includes(name)) {
            compositionProbes.push(name);
            return null;
          }
          if (name === "readStatus")
            return {
              status: sealed === null ? "expired" : "authorized",
              zone: grant.zoneName,
              scopes: grant.scopes,
              expiresAt: grant.accessExpiresAt,
            };
          if (name === "readGrant") return grant;
          if (name === "claimGrantUse") return { status: "claimed", grant };
          if (name === "renewGrantUse" || name === "releaseGrantUse") return;
          if (name === "finishGrantUse") {
            sealed = input;
            grant = {
              ...grant,
              keyVersion: Number(input["keyVersion"]),
              accessExpiresAt: String(input["accessExpiresAt"]),
              accessCiphertext: Buffer.from(String(input["accessCiphertext"]), "base64"),
              accessNonce: Buffer.from(String(input["accessNonce"]), "base64"),
              refreshCiphertext: Buffer.from(String(input["refreshCiphertext"]), "base64"),
              refreshNonce: Buffer.from(String(input["refreshNonce"]), "base64"),
            };
            return grant;
          }
          throw new Error(`Unexpected Core call: ${name}`);
        },
      ]),
    ),
    {
      get(target, key, receiver) {
        if (nativeMethods.includes(String(key))) throw new Error("Native Core was accessed");
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const previous = globalThis.fetch;
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  try {
    const runtime = new ProductionService({}, {
      ...base(),
      GENERAL_CF_RUNTIME: core,
      SCOPED_DNS_RUNTIME: core,
      APPLICATION_IDENTITY_RUNTIME: core,
      MAIL_DNS_RUNTIME: core,
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: newKey,
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: "20261106",
      CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON: JSON.stringify({ 1: oldKey }),
    } as never);
    expect(
      await runtime.getStatus({ organizationId: id, projectId: project, actorId: "user:owner" }),
    ).toMatchObject({ status: "authorized" });
    expect(compositionProbes.sort()).toEqual(["legacy", "read", "readAuthorization"]);
    if (sealed === null) throw new Error("Missing new grant write");
    expect(grant.keyVersion).toBe(20261106);
    const current = createCloudflareDomainSecrets({
      keyBase64: newKey,
      keyVersion: 20261106,
      crypto,
    });
    expect(
      await current.tokenCipher.open({
        ciphertext: grant.accessCiphertext.toString("base64"),
        nonce: grant.accessNonce.toString("base64"),
        keyVersion: grant.keyVersion,
        associatedData: `${aad}:access`,
      }),
    ).toMatch(/^fixture-access-token-/);
  } finally {
    vi.stubGlobal("fetch", previous);
  }
});
