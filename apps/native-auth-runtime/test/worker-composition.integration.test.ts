import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import type { NativeAuthRegistryReceipt } from "../src/registry.js";
import { createNativeLatencyProfile, nativeCapturedDurations } from "../src/latency-profile.js";

// Workerd owns these base classes; only their constructor state is supplied by this adapter.
vi.mock("cloudflare:workers", () => {
  class Base {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  }
  return { WorkerEntrypoint: Base, DurableObject: Base };
});
const fixture = vi.hoisted(() => ({
  connectionString: "",
  schema: "",
  pools: [] as Pool[],
  registrations: [] as Array<{ connectionString: string; secret: string }>,
}));
// The production factory is separately tested over PGCF WSS. This test substitutes only its
// external transport so the actual DO, engine and SQL policy run against local PostgreSQL.
vi.mock("../src/realm-pool.js", () => ({
  createNativeRealmPool: (registration: { connectionString: string; secret: string }) => {
    fixture.registrations.push({
      connectionString: registration.connectionString,
      secret: registration.secret,
    });
    const pool = new Pool({
      connectionString: fixture.connectionString,
      options: `-c search_path=${fixture.schema}`,
    });
    fixture.pools.push(pool);
    return pool;
  },
}));
import worker, {
  NativeAdminService,
  NativePolicyService,
  NativeSessionService,
} from "../src/worker-main.js";
import {
  NativeAuthEnvironment,
  NativePublicService,
  NativePreviewService,
  NativeRegistryAdminService,
} from "../src/realm-worker.js";

const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const environmentId = "01K2F3G4H5J6K7M8N9P0QRSTVZ";
const deploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const origin = "https://native.example.test";
const sealedKeyVersion = (payload: Buffer | undefined) => {
  if (!payload) throw new Error("missing_sealed_payload");
  return (JSON.parse(payload.toString()) as { keyVersion: number }).keyVersion;
};
const receipt: NativeAuthRegistryReceipt = {
  organizationId,
  projectId,
  environmentId,
  operationId: projectId,
  claimId: projectId,
  providerProjectId: "prj_12345678901234567890",
  databaseId: "a1234567890123456789",
  regionId: "eu-dev",
  originHost: "pgcf.example.com",
  schema: `omh_auth_${environmentId.toLowerCase()}`,
  role: `omh_ar_${environmentId.toLowerCase()}`,
  targetVersion: 1,
  registryVersion: 1,
  registryReference: `${projectId}:${environmentId}`,
  status: "active",
};

it("composes scoped registry, PostgreSQL policy, public password flow, session and owner administration", async () => {
  const db = await startTestPostgres();
  fixture.connectionString = db.pool.options.connectionString as string;
  fixture.schema = receipt.schema;
  await db.pool.query(`create schema ${fixture.schema}`);
  const setup = new Pool({
    connectionString: fixture.connectionString,
    options: `-c search_path=${fixture.schema}`,
  });
  const values = new Map<string, unknown>();
  let liveReceipt: NativeAuthRegistryReceipt | null = receipt;
  let enabled = true;
  let revocationEpoch = 1;
  let ownerAllowed = true;
  let providerEnabled = true;
  let edgeAllowed = true;
  let githubId = 12345;
  let githubEmail = "github@example.test";
  const observedProviderSuccess: unknown[] = [];
  const messages: Array<{ kind: string; to: string; url: string }> = [];
  const previewMessages: Array<{ kind: string; to: string; url: string }> = [];
  const previewId = "a".repeat(32);
  const previewOrigin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
  let authGeneration = 1;
  let previewAllowed = true;
  let previewReads = 0;
  let denyPreviewRead = 0;
  const realmContext = {
    projectId,
    environmentId,
    canonicalOrigin: origin,
    realmGeneration: 1,
    configurationRevision: 1,
  };
  const authority = () => ({
    organizationId,
    deploymentId,
    region: "eu" as const,
    storageReady: true,
    realm: realmContext,
    revocationEpoch,
    enabled,
    ownerEnabled: enabled,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: true,
    applicationName: "Test",
    signupPolicy: "open" as const,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  });
  const limit = { limit: async () => ({ success: edgeAllowed }) };
  let instance: NativeAuthEnvironment;
  const bindings = {
    NATIVE_AUTH_REGION_ID: "eu-dev" as const,
    NATIVE_AUTH_QA_PREVIEW_ENABLED: "development-only-v1",
    NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE: undefined as string | undefined,
    NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
    NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
    NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON: undefined as string | undefined,
    NATIVE_AUTH_GENERAL_LIMITER: limit,
    NATIVE_AUTH_REALM_LIMITER: limit,
    NATIVE_AUTH_SIGNIN_LIMITER: limit,
    NATIVE_AUTH_SIGNUP_LIMITER: limit,
    NATIVE_AUTH_RESET_LIMITER: limit,
    NATIVE_AUTH_ENVIRONMENTS: { jurisdiction: () => ({ getByName: () => instance }) },
    NATIVE_AUTH_REGISTRY_AUTHORITY: {
      authorizeRegistration: async () => true,
      readRegistration: async () => liveReceipt,
      authorizeRevocation: async () => true,
      authorizeDeletion: async () => true,
      authorizeDeletionQuiescence: async () => true,
    },
    NATIVE_AUTH_AUTHORITY: {
      resolveAtomic: new Proxy(
        vi.fn(async (input: unknown) => {
          expect(input).toEqual({
            projectId,
            environmentId,
            deploymentId,
            organizationHint: organizationId,
          });
          return { authority: authority(), registration: liveReceipt };
        }),
        {
          get(target, property, receiver) {
            if (property === "call" || property === "bind") throw new Error("rpc_method_property");
            return Reflect.get(target, property, receiver);
          },
        },
      ),
      resolve: async (input: unknown) => {
        expect(input).toEqual({ projectId, environmentId, deploymentId });
        return authority();
      },
      recordProviderSuccess: async (input: unknown) => {
        observedProviderSuccess.push(input);
      },
    },
    NATIVE_AUTH_PREVIEW_AUTHORITY: {
      resolveForNative: async (identity: { previewId: string; authGeneration: number }) => {
        previewReads += 1;
        if (
          !previewAllowed ||
          (denyPreviewRead > 0 && previewReads === denyPreviewRead) ||
          identity.previewId !== previewId ||
          identity.authGeneration !== authGeneration
        )
          throw new Error("auth_unavailable");
        const { deploymentId: deployedId, ...current } = authority();
        expect(deployedId).toBe(deploymentId);
        return {
          ...current,
          realm: { ...realmContext, canonicalOrigin: previewOrigin },
          preview: identity,
        };
      },
    },
    NATIVE_AUTH_PREVIEW_MAIL: {
      sendNativePreviewAuthMail: async (message: { kind: string; to: string; url: string }) => {
        previewMessages.push(message);
        return { status: "accepted" as const };
      },
    },
    NATIVE_AUTH_ADMIN_AUTHORITY: {
      resolve: async () => authority(),
      resolveProvider: async ({ provider }: { provider: "google" | "github" }) => ({
        organizationId,
        projectId,
        environmentId,
        provider,
        configurationRevision: 1,
        enabled: providerEnabled,
      }),
      authorizeOwnerOperation: async () => ownerAllowed,
      authorizeAcceptedOperation: async () => true,
      readNativeRestoreForSanitization: async (input: { restoreId: string; claimId: string }) => ({
        scope: { organizationId, projectId, environmentId },
        restoreId: input.restoreId,
        claimId: input.claimId,
        databaseId: receipt.databaseId,
        offline: true,
        revocationEpoch: 4,
        configurationRevision: 4,
        acceptedMutationEpoch: 4,
      }),
    },
    NATIVE_AUTH_MAIL_AUTHORITY: { authorizeNativeMail: async () => ({ canonicalOrigin: origin }) },
    NATIVE_AUTH_MAIL: {
      sendNativeAuthMail: async (message: { kind: string; to: string; url: string }) => {
        messages.push(message);
        return { status: "accepted" as const };
      },
    },
    NATIVE_AUTH_PROVIDER_SECRETS: {
      resolve: async () => ({
        clientId: "fixture-client",
        clientSecret: "fixture-secret",
        configurationRevision: 1,
      }),
    },
  };
  try {
    for (const name of [
      "../schema.sql",
      "../migrations/002-invitation-receipt-digest.sql",
      "../migrations/003-social-flow.sql",
    ])
      await setup.query(await readFile(new URL(name, import.meta.url), "utf8"));
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    };
    instance = new NativeAuthEnvironment({ storage } as never, bindings as never);
    const registry = new NativeRegistryAdminService({} as never, bindings as never);
    const { status, ...metadata } = receipt;
    expect(status).toBe("active");
    const registered = await registry.register({
      ...metadata,
      connectionString: `postgres://${receipt.role}:private@${receipt.originHost}/${receipt.databaseId}?sslmode=require`,
    });
    expect(registered).toEqual(receipt);
    expect(JSON.stringify([...values.values()])).not.toContain("private@");
    const policy = new NativePolicyService({} as never, bindings as never);
    const scope = { organizationId, projectId, environmentId };
    const policyInput = {
      ...scope,
      configurationRevision: 1,
      revocationEpoch: 1,
      enabled: true,
      canonicalOrigin: origin,
    };
    expect(await policy.applyRealmPolicy(policyInput)).toEqual({ outcome: "applied" });
    const preview = new NativePreviewService({} as never, bindings as never);
    const identity = { previewId, authGeneration };
    const previewRequest = (path: string, body?: object, cookie?: string) =>
      new Request(
        `${previewOrigin}/api/auth/v1${path}`,
        body === undefined
          ? { headers: cookie ? { cookie } : {} }
          : {
              method: "POST",
              headers: {
                origin: previewOrigin,
                "content-type": "application/json",
                "idempotency-key": randomUUID(),
              },
              body: JSON.stringify(body),
            },
      );
    const previewSend = (request: Request, id = identity) =>
      preview.fetchStablePreview(request, id, { clientAddress: "127.0.0.1" });
    const previewPassword = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    const previewEmails = [
      `preview-a-${randomUUID()}@example.test`,
      `preview-b-${randomUUID()}@example.test`,
    ];
    for (const email of previewEmails) {
      expect(
        (
          await previewSend(
            previewRequest("/sign-up/email", { email, password: previewPassword, name: "QA" }),
          )
        ).status,
      ).toBe(200);
      const message = previewMessages.at(-1);
      if (!message) throw new Error("missing_preview_verification");
      expect(new URL(message.url).origin).toBe(previewOrigin);
      expect((await previewSend(new Request(message.url))).status).toBeLessThan(400);
    }
    const previewLogin = await previewSend(
      previewRequest("/sign-in/email", { email: previewEmails[0], password: previewPassword }),
    );
    expect(previewLogin.status).toBe(200);
    const previewCookie = previewLogin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
    expect(previewCookie).toContain(`__Host-omh_native_preview_${previewId}.session_token=`);
    expect(await preview.validateStablePreviewSession(identity, previewCookie)).toMatchObject({
      user: { email: previewEmails[0] },
    });
    expect(await preview.validateStablePreviewSession(identity, previewCookie)).toMatchObject({
      user: { email: previewEmails[0] },
    });
    const otherLogin = await previewSend(
      previewRequest("/sign-in/email", { email: previewEmails[1], password: previewPassword }),
    );
    const otherCookie = otherLogin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; ");
    expect(await preview.validateStablePreviewSession(identity, otherCookie)).toMatchObject({
      user: { email: previewEmails[1] },
    });
    expect(otherCookie).not.toBe(previewCookie);
    const beforeRevokedSignup = (await setup.query('select count(*)::int as n from "user"')).rows[0]
      ?.n;
    previewReads = 0;
    denyPreviewRead = 4;
    expect(
      (
        await previewSend(
          previewRequest("/sign-up/email", {
            email: `revoked-${randomUUID()}@example.test`,
            password: previewPassword,
            name: "QA",
          }),
        )
      ).status,
    ).toBe(503);
    denyPreviewRead = 0;
    expect((await setup.query('select count(*)::int as n from "user"')).rows[0]?.n).toBe(
      beforeRevokedSignup,
    );
    const deployedSession = new NativeSessionService(
      { props: { projectId, environmentId, deploymentId } } as never,
      bindings as never,
    );
    expect(await deployedSession.validateSession({ cookie: previewCookie })).toBeNull();
    previewAllowed = false;
    await expect(preview.validateStablePreviewSession(identity, previewCookie)).rejects.toThrow(
      "auth_unavailable",
    );
    previewAllowed = true;
    authGeneration = 2;
    await expect(preview.validateStablePreviewSession(identity, previewCookie)).rejects.toThrow(
      "auth_unavailable",
    );
    expect(
      await preview.validateStablePreviewSession({ previewId, authGeneration }, previewCookie),
    ).toBeNull();
    // The rest of this combined test uses the same synthetic client and exercises independent deployment behavior.
    await setup.query('delete from "rateLimit"');
    await setup.query("delete from native_password_rate_limit");
    expect(
      await policy.applyProviderPolicy({
        ...scope,
        provider: "google",
        configurationRevision: 1,
        enabled: true,
      }),
    ).toEqual({ outcome: "applied" });
    providerEnabled = false;
    await expect(
      policy.applyProviderPolicy({
        ...scope,
        provider: "google",
        configurationRevision: 1,
        enabled: true,
      }),
    ).rejects.toThrow("auth_unavailable");
    providerEnabled = true;
    await expect(policy.applyRealmPolicy({ ...policyInput, revocationEpoch: 2 })).rejects.toThrow(
      "auth_unavailable",
    );
    const publicService = new NativePublicService({} as never, bindings as never);
    const publicScope = { ...realmContext, deploymentId };
    const request = (path: string, body?: object) =>
      new Request(
        `${origin}/api/auth/v1${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin,
                "content-type": "application/json",
                "idempotency-key": randomUUID(),
              },
              body: JSON.stringify(body),
            },
      );
    const send = (r: Request) =>
      publicService.fetchPublic(r, publicScope, { clientAddress: "127.0.0.1" });
    expect((await send(request("/unknown"))).status).toBe(404);
    expect(
      (
        await publicService.fetchPublic(
          request("/get-session"),
          { ...publicScope, deploymentId: "bad" },
          { clientAddress: "127.0.0.1" },
        )
      ).status,
    ).toBe(503);
    edgeAllowed = false;
    expect((await send(request("/get-session"))).status).toBe(429);
    edgeAllowed = true;
    expect(
      (
        await publicService.fetchPublic(request("/get-session"), publicScope, {
          clientAddress: "forged",
        })
      ).status,
    ).toBe(503);
    expect(
      (await send(request("/accept-invitation", { token: 123, password: "test" }))).status,
    ).toBe(400);
    providerEnabled = false;
    expect(
      (await send(request("/sign-in/social", { provider: "google", callbackURL: "/login" })))
        .status,
    ).toBe(403);
    providerEnabled = true;
    const social = await send(
      request("/sign-in/social", { provider: "google", callbackURL: "/login" }),
    );
    expect(social.status).toBe(200);
    expect((await social.json()).url).toContain("accounts.google.com");
    vi.stubGlobal("fetch", async (target: string | URL | Request) => {
      const url = String(target instanceof Request ? target.url : target);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({
          access_token: "transient-provider-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      if (url === "https://api.github.com/user")
        return Response.json({ id: githubId, login: "tester", email: null });
      if (url === "https://api.github.com/user/emails")
        return Response.json([{ email: githubEmail, primary: true, verified: true }]);
      throw new Error("unexpected_provider_request");
    });
    const githubStart = await send(
      request("/sign-in/social", { provider: "github", callbackURL: "/login" }),
    );
    expect(githubStart.status).toBe(200);
    const githubState = new URL((await githubStart.json()).url).searchParams.get("state");
    if (!githubState) throw new Error("missing_github_state");
    const githubCookie = githubStart.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const githubCallback = await send(
      new Request(
        `${origin}/api/auth/v1/callback/github?code=test-code&state=${encodeURIComponent(githubState)}`,
        { headers: { cookie: githubCookie } },
      ),
    );
    expect(githubCallback.status).toBe(302);
    expect(observedProviderSuccess).toMatchObject([
      { provider: "github", configurationRevision: 1, revocationEpoch: 1 },
    ]);
    expect(
      (
        await setup.query(
          'select "accessToken", "refreshToken", "idToken" from "account" where "providerId" = $1',
          ["github"],
        )
      ).rows,
    ).toEqual([{ accessToken: null, refreshToken: null, idToken: null }]);
    const email = `test-${randomUUID()}@example.test`,
      password = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    expect((await send(request("/sign-up/email", { email, password, name: "Test" }))).status).toBe(
      200,
    );
    expect(messages).toHaveLength(1);
    const verification = messages[0];
    if (!verification) throw new Error("missing_verification");
    expect((await send(new Request(verification.url))).status).toBeLessThan(400);
    const login = await send(request("/sign-in/email", { email, password }));
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("omh_native");
    const session = new NativeSessionService(
      { props: { projectId, environmentId, deploymentId } } as never,
      bindings as never,
    );
    const authorityReads = vi.spyOn(bindings.NATIVE_AUTH_AUTHORITY, "resolve");
    const registrationReads = vi.spyOn(bindings.NATIVE_AUTH_REGISTRY_AUTHORITY, "readRegistration");
    expect(await session.validateSession({ cookie })).toMatchObject({ user: { email } });
    // One initial snapshot and the existing transaction-entry and pre-commit fresh checks.
    expect(authorityReads).toHaveBeenCalledTimes(3);
    expect(registrationReads).toHaveBeenCalledTimes(4);
    authorityReads.mockClear();
    registrationReads.mockClear();
    bindings.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE = "v1";
    expect(await session.validateSession({ cookie })).toMatchObject({ user: { email } });
    expect(bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic).toHaveBeenCalledTimes(4);
    expect(authorityReads).not.toHaveBeenCalled();
    expect(registrationReads).not.toHaveBeenCalled();
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic.mockResolvedValueOnce({
      authority: authority(),
      registration: { ...receipt, registryVersion: 2 },
    });
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic.mockRejectedValueOnce(new Error("unavailable"));
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    const good = { authority: authority(), registration: receipt };
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic.mockResolvedValueOnce({
      ...good,
      authority: { ...good.authority, unexpected: "private" },
    } as never);
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic.mockResolvedValueOnce({
      ...good,
      authority: { ...good.authority, realm: { ...good.authority.realm, projectId: "wrong" } },
    });
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic.mockResolvedValueOnce({
      ...good,
      authority: {
        ...good.authority,
        realm: { ...good.authority.realm, canonicalOrigin: "https://native.example.test/path" },
      },
    });
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    const changed = { authority: authority(), registration: { ...receipt, registryVersion: 2 } };
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(changed);
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(changed);
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_AUTHORITY.resolveAtomic
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(good)
      .mockResolvedValueOnce(changed);
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE = "invalid";
    await expect(session.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    bindings.NATIVE_AUTH_ATOMIC_SNAPSHOT_MODE = undefined;
    authorityReads.mockRestore();
    registrationReads.mockRestore();
    expect(await session.validateSession({ cookie })).toMatchObject({ user: { email } });
    const badSession = new NativeSessionService(
      { props: { projectId, environmentId, deploymentId: "bad" } } as never,
      bindings as never,
    );
    await expect(badSession.validateSession({ cookie })).rejects.toThrow("auth_unavailable");
    const admin = new NativeAdminService({} as never, bindings as never);
    expect(await admin.applyRealmPolicy(policyInput)).toEqual({ outcome: "applied" });
    expect(
      await admin.applyProviderPolicy({
        ...scope,
        provider: "github",
        configurationRevision: 1,
        enabled: true,
      }),
    ).toEqual({ outcome: "applied" });
    const owner = { ...scope, principalId: "user:owner", requestId: randomUUID() };
    expect(await admin.listUsers({ ...owner, search: email })).toMatchObject([
      { email, status: "active" },
    ]);
    ownerAllowed = false;
    await expect(admin.listUsers(owner)).rejects.toThrow();
    ownerAllowed = true;
    const user = (await admin.listUsers({ ...owner, search: email }))[0];
    if (!user) throw new Error("missing_user");
    expect(await admin.getUser({ ...owner, userId: user.id })).toMatchObject({ email });
    githubId = 12346;
    githubEmail = email;
    const linkStart = await send(
      new Request(`${origin}/api/auth/v1/link-social`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/login" }),
      }),
    );
    expect(linkStart.status).toBe(200);
    const linkState = new URL((await linkStart.json()).url).searchParams.get("state");
    if (!linkState) throw new Error("missing_link_state");
    const linkCookie = [
      cookie,
      ...linkStart.headers.getSetCookie().map((v) => v.split(";", 1)[0]),
    ].join("; ");
    expect(
      (
        await send(
          new Request(
            `${origin}/api/auth/v1/callback/github?code=test-code&state=${encodeURIComponent(linkState)}`,
            { headers: { cookie: linkCookie } },
          ),
        )
      ).status,
    ).toBe(302);
    const accounts = (await (
      await send(new Request(`${origin}/api/auth/v1/list-accounts`, { headers: { cookie } }))
    ).json()) as Array<{ id: string; providerId: string }>;
    const credential = accounts.find((account) => account.providerId === "credential");
    if (!credential) throw new Error("missing_credential");
    expect(
      (
        await send(
          new Request(`${origin}/api/auth/v1/unlink-account`, {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: JSON.stringify({ accountId: credential.id }),
          }),
        )
      ).status,
    ).toBe(200);
    const inviteKey = randomUUID(),
      digest = new Uint8Array(32).fill(8),
      inviteEmail = `invite-${randomUUID()}@example.test`;
    const invited = await admin.mutateUser({
      ...owner,
      idempotencyKey: inviteKey,
      canonicalRequestDigest: digest,
      mutation: { action: "create-invite", email: inviteEmail },
    });
    expect(invited.user).toMatchObject({ email: inviteEmail, status: "pending" });
    const oldInvitation = (
      await setup.query<{ sealed_payload: Buffer }>(
        "select sealed_payload from native_mail_outbox where user_id=$1",
        [invited.userId],
      )
    ).rows[0];
    expect(sealedKeyVersion(oldInvitation?.sealed_payload)).toBe(1);
    const originalRegistry = structuredClone(values.get("registration")) as {
      credential: { keyVersion: number };
      engineSecret: { keyVersion: number };
    };
    expect(originalRegistry.credential.keyVersion).toBe(1);
    expect(originalRegistry.engineSecret.keyVersion).toBe(1);
    const originalResolution = fixture.registrations[0];
    expect(originalResolution?.connectionString).toBe(
      `postgres://${receipt.role}:private@${receipt.originHost}/${receipt.databaseId}?sslmode=require`,
    );
    const persisted = structuredClone([...values.entries()]);
    for (const pool of fixture.pools.splice(0)) await pool.end();
    values.clear();
    for (const [key, value] of persisted) values.set(key, value);
    bindings.NATIVE_AUTH_CUSTODY_KEY_BASE64 = btoa("z".repeat(32));
    bindings.NATIVE_AUTH_CUSTODY_KEY_VERSION = 20261106;
    bindings.NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON = JSON.stringify({
      1: btoa("k".repeat(32)),
    });
    instance = new NativeAuthEnvironment({ storage } as never, bindings as never);
    // A new DO instance must decrypt the persisted legacy URI and engine secret. The old cookie
    // also authenticates the unchanged engine secret through the actual password/session path.
    expect(await session.validateSession({ cookie })).toMatchObject({ user: { email } });
    expect(fixture.registrations).toHaveLength(2);
    expect(fixture.registrations[1]).toEqual(originalResolution);
    expect(values.get("registration")).toEqual(originalRegistry);
    expect(
      await admin.deliverInvitation({
        ...owner,
        idempotencyKey: inviteKey,
        canonicalRequestDigest: digest,
        userId: invited.userId,
        action: "create-invite",
      }),
    ).toEqual({ status: "accepted" });
    const invitation = messages.find((message) => message.kind === "invitation");
    expect(invitation?.to).toBe(inviteEmail);
    if (!invitation) throw new Error("missing_invitation");
    const token = new URL(invitation.url).searchParams.get("token");
    expect(token).toBeTruthy();
    expect(
      (await send(request("/accept-invitation", { token, password, name: "Invitee" }))).status,
    ).toBe(200);
    const inviteLogin = await send(request("/sign-in/email", { email: inviteEmail, password }));
    expect(inviteLogin.status).toBe(200);
    const inviteCookie = inviteLogin.headers
      .getSetCookie()
      .map((v) => v.split(";", 1)[0])
      .join("; ");
    const currentInviteEmail = `current-invite-${randomUUID()}@example.test`;
    const currentInviteKey = randomUUID();
    const currentDigest = new Uint8Array(32).fill(9);
    const currentInvite = await admin.mutateUser({
      ...owner,
      idempotencyKey: currentInviteKey,
      canonicalRequestDigest: currentDigest,
      mutation: { action: "create-invite", email: currentInviteEmail },
    });
    const currentInvitation = (
      await setup.query<{ sealed_payload: Buffer }>(
        "select sealed_payload from native_mail_outbox where user_id=$1",
        [currentInvite.userId],
      )
    ).rows[0];
    expect(sealedKeyVersion(currentInvitation?.sealed_payload)).toBe(20261106);
    expect(
      await admin.deliverInvitation({
        ...owner,
        idempotencyKey: currentInviteKey,
        canonicalRequestDigest: currentDigest,
        userId: currentInvite.userId,
        action: "create-invite",
      }),
    ).toEqual({ status: "accepted" });
    expect(
      messages.some(
        (message) => message.kind === "invitation" && message.to === currentInviteEmail,
      ),
    ).toBe(true);
    expect((await send(request("/request-password-reset", { email: inviteEmail }))).status).toBe(
      200,
    );
    expect(
      messages.some((message) => message.kind === "password-reset" && message.to === inviteEmail),
    ).toBe(true);
    const currentMail = (
      await setup.query<{ sealed_payload: Buffer; delivered: boolean }>(
        "select sealed_payload, delivered_at is not null as delivered from native_auth_mail_outbox where user_id=$1 and kind='password-reset'",
        [invited.userId],
      )
    ).rows[0];
    expect(currentMail?.delivered).toBe(true);
    expect(sealedKeyVersion(currentMail?.sealed_payload)).toBe(20261106);
    expect((values.get("registration") as typeof originalRegistry).engineSecret).toEqual(
      originalRegistry.engineSecret,
    );
    const revoked = await admin.mutateUser({
      ...owner,
      idempotencyKey: randomUUID(),
      canonicalRequestDigest: new Uint8Array(32).fill(7),
      mutation: { action: "revoke-sessions", userId: user.id },
    });
    expect(revoked.userId).toBe(user.id);
    expect(await session.validateSession({ cookie })).toBeNull();
    expect(await session.validateSession({ cookie: inviteCookie })).toMatchObject({
      user: { email: inviteEmail },
    });
    const lock = await setup.connect();
    try {
      await lock.query("begin");
      await lock.query("select 1 from native_realm_policy where singleton=true for update");
      const staleApply = admin.applyRealmPolicy(policyInput).then(
        () => "applied",
        () => "rejected",
      );
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const waiting = await setup.query(
          "select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%insert into native_realm_policy%'",
        );
        blocked = (waiting.rowCount ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      enabled = false;
      revocationEpoch = 2;
      realmContext.configurationRevision = 2;
      await lock.query("commit");
      expect(await staleApply).toBe("rejected");
    } finally {
      await lock.query("rollback").catch(() => {});
      lock.release();
    }
    await expect(session.validateSession({ cookie: inviteCookie })).rejects.toThrow(
      "auth_unavailable",
    );
    expect(
      await admin.applyRealmPolicy({
        ...policyInput,
        enabled: false,
        revocationEpoch: 2,
        configurationRevision: 2,
      }),
    ).toEqual({ outcome: "applied" });
    await expect(session.validateSession({ cookie: inviteCookie })).rejects.toThrow(
      "auth_unavailable",
    );
    enabled = true;
    revocationEpoch = 3;
    realmContext.configurationRevision = 3;
    expect(
      await admin.applyRealmPolicy({
        ...policyInput,
        revocationEpoch: 3,
        configurationRevision: 3,
      }),
    ).toEqual({ outcome: "applied" });
    expect(await session.validateSession({ cookie: inviteCookie })).toBeNull();
    expect((await send(request("/sign-in/email", { email: inviteEmail, password }))).status).toBe(
      200,
    );
    const restore = { ...scope, restoreId: randomUUID(), claimId: randomUUID() };
    const sanitized = await admin.sanitizeRestore(restore);
    expect(sanitized).toEqual({
      status: "sanitized",
      revocationEpoch: 4,
      configurationRevision: 4,
    });
    const priorReceipts = (
      await setup.query(
        "select request_id,request_digest,response from native_admin_receipt order by request_id",
      )
    ).rows;
    for (const pool of fixture.pools.splice(0)) await pool.end();
    bindings.NATIVE_AUTH_CUSTODY_KEY_BASE64 = btoa("y".repeat(32));
    bindings.NATIVE_AUTH_CUSTODY_KEY_VERSION = 20261107;
    bindings.NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON = JSON.stringify({
      1: btoa("k".repeat(32)),
      20261106: btoa("z".repeat(32)),
    });
    instance = new NativeAuthEnvironment({ storage } as never, bindings as never);
    // The actual DO/admin composition must pass historical HMAC keys to restore replay.
    // The receipt authenticated by the previous current key is reused without a new SQL receipt.
    expect(await admin.sanitizeRestore(restore)).toEqual(sanitized);
    expect(
      (
        await setup.query(
          "select request_id,request_digest,response from native_admin_receipt order by request_id",
        )
      ).rows,
    ).toEqual(priorReceipts);
    expect((values.get("registration") as typeof originalRegistry).engineSecret).toEqual(
      originalRegistry.engineSecret,
    );
    expect((await setup.query('select count(*)::int as n from "user"')).rows[0].n).toBe(6);
    enabled = false;
    expect((await send(request("/get-session"))).status).toBe(503);
    liveReceipt = null;
    await expect(admin.listUsers(owner)).rejects.toThrow();
    liveReceipt = receipt;
    await registry.revoke({
      receipt,
      operationId: projectId,
      claimId: projectId,
      registryVersion: 2,
    });
    await expect(admin.listUsers(owner)).rejects.toThrow();
    const deletion = {
      ...scope,
      operationId: projectId,
      registryVersion: 1,
      registryReference: receipt.registryReference,
    };
    await registry.quiesceForDeletion(deletion);
    await registry.purgeForDeletion(deletion);
    expect(values.get("registration")).toEqual({ deleted: deletion });
  } finally {
    vi.unstubAllGlobals();
    for (const pool of fixture.pools.splice(0)) await pool.end().catch(() => {});
    fixture.registrations.splice(0);
    await setup.end();
    await db.stop();
  }
}, 120_000);

it("times out stalled public and private session calls", async () => {
  vi.useFakeTimers();
  try {
    const stalled = new Promise<never>(() => {});
    const namespace = {
      jurisdiction: () => ({ getByName: () => ({ validateSession: () => stalled }) }),
    };
    const bindings = {
      NATIVE_AUTH_REGION_ID: "us-dev",
      NATIVE_AUTH_ENVIRONMENTS: namespace,
      NATIVE_AUTH_GENERAL_LIMITER: { limit: () => stalled },
    };
    const scope = { projectId, environmentId, deploymentId };
    const session = new NativeSessionService({ props: scope } as never, bindings as never);
    const sessionResult = session
      .validateSession({ cookie: "" })
      .catch((error: Error) => error.message);
    const publicService = new NativePublicService({} as never, bindings as never);
    const publicResult = publicService.fetchPublic(
      new Request(`${origin}/api/auth/v1/get-session`),
      { ...scope, canonicalOrigin: origin, configurationRevision: 1, realmGeneration: 1 },
      { clientAddress: "127.0.0.1" },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await sessionResult).toBe("auth_unavailable");
    const response = await publicResult;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(worker.fetch().status).toBe(404);
  } finally {
    vi.useRealTimers();
  }
});

it("refuses cookies that are not the native session token before any authority work", async () => {
  const resolve = vi.fn(async () => {
    throw new Error("synthetic-authority-read");
  });
  const binding = {
    NATIVE_AUTH_REGION_ID: "eu-dev" as const,
    NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
    NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
    NATIVE_AUTH_REGISTRY_AUTHORITY: {},
    NATIVE_AUTH_AUTHORITY: { resolve },
    NATIVE_AUTH_ENVIRONMENTS: {} as unknown,
  };
  const c5 = {
    projectId: "01M6PG6R7A0B8YJ9PBMZ9AB565",
    environmentId: "01M6PG6R7A0B8YJ9PBMZ9AB56A",
    deploymentId,
  };
  const instance = new NativeAuthEnvironment({ storage: {} } as never, binding as never);
  binding.NATIVE_AUTH_ENVIRONMENTS = { jurisdiction: () => ({ getByName: () => instance }) };
  for (const cookie of [
    "omh_native.junk=x",
    "__Secure-omh_native.junk=x",
    "other=omh_native.session_token=x",
  ]) {
    expect(await instance.validateSession(c5, cookie)).toBeNull();
  }
  expect(resolve).not.toHaveBeenCalled();
  // The session token itself, under each prefix the engine emits, still reaches the check.
  for (const cookie of [
    "__Host-omh_native.session_token=x",
    "__Secure-omh_native.session_token=x",
    "omh_native.session_token=x",
  ]) {
    await expect(instance.validateSession(c5, cookie)).rejects.toThrow("synthetic-authority-read");
  }
  expect(resolve).toHaveBeenCalledTimes(3);
});

it("keeps legacy DO calls and closes gated errors across the private envelope", async () => {
  const cause = new Error("synthetic-private-error");
  const binding = {
    NATIVE_AUTH_REGION_ID: "eu-dev" as const,
    NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
    NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
    NATIVE_AUTH_LATENCY_PROFILE: "c5-development-v1" as string | undefined,
    NATIVE_AUTH_REGISTRY_AUTHORITY: {},
    NATIVE_AUTH_AUTHORITY: {
      resolve: async () => {
        throw cause;
      },
    },
    NATIVE_AUTH_ENVIRONMENTS: {} as unknown,
  };
  const c5 = {
    projectId: "01M6PG6R7A0B8YJ9PBMZ9AB565",
    environmentId: "01M6PG6R7A0B8YJ9PBMZ9AB56A",
    deploymentId,
  };
  const instance = new NativeAuthEnvironment({ storage: {} } as never, binding as never);
  binding.NATIVE_AUTH_ENVIRONMENTS = { jurisdiction: () => ({ getByName: () => instance }) };
  const logger = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    // Old outer -> new DO: legacy three-argument callers retain the exact failure, no envelope.
    await expect(
      instance.validateSession(c5, "__Secure-omh_native.session_token=private-cookie"),
    ).rejects.toBe(cause);
    expect(logger).not.toHaveBeenCalled();
    const privateResult = await instance.validateSession(
      c5,
      "__Secure-omh_native.session_token=private-cookie",
      undefined,
      {
        kind: "native_private_latency_request_v2",
      },
    );
    expect(privateResult).toMatchObject({
      kind: "native_private_session_v2",
      status: "unavailable",
      session: null,
    });
    expect(JSON.stringify(privateResult)).not.toContain("synthetic-private-error");
    expect(logger).not.toHaveBeenCalled();
    // New outer emits a closed record and preserves the unavailable error, never anonymous null.
    const session = new NativeSessionService({ props: c5 } as never, binding as never);
    await expect(
      session.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).rejects.toThrow("auth_unavailable");
    expect(logger).toHaveBeenCalledTimes(1);
    const message = String(logger.mock.calls[0]?.[0]);
    expect(JSON.parse(message)).toMatchObject({
      kind: "native_private_latency_v3",
      outerServiceMs: expect.any(Number),
      outcome: "unavailable",
      timingsAreNonAdditive: true,
    });
    expect(message).not.toContain(c5.projectId);
    expect(message).not.toContain(c5.environmentId);
    expect(message).not.toContain("__Secure-omh_native.session_token=private-cookie");
    expect(message).not.toContain("synthetic-private-error");
    binding.NATIVE_AUTH_LATENCY_PROFILE = undefined;
    await expect(
      instance.validateSession(c5, "__Secure-omh_native.session_token=private-cookie", undefined, {
        kind: "native_private_latency_request_v2",
      }),
    ).rejects.toBe(cause);
    expect(logger).toHaveBeenCalledTimes(1);
  } finally {
    logger.mockRestore();
  }
});

it("new outer accepts old DO result once and never retries or emits a diagnostic", async () => {
  const c5 = {
    projectId: "01M6PG6R7A0B8YJ9PBMZ9AB565",
    environmentId: "01M6PG6R7A0B8YJ9PBMZ9AB56A",
    deploymentId,
  };
  const legacy = {
    user: { id: "u", email: "u@example.test" },
    session: { id: "s", expiresAt: "2030-01-01T00:00:00.000Z" },
  };
  const validate = vi.fn(async () => legacy);
  const binding = {
    NATIVE_AUTH_REGION_ID: "us-dev",
    NATIVE_AUTH_LATENCY_PROFILE: "c5-development-v1",
    NATIVE_AUTH_ENVIRONMENTS: {
      jurisdiction: () => ({ getByName: () => ({ validateSession: validate }) }),
    },
  };
  const service = new NativeSessionService({ props: c5 } as never, binding as never);
  const logger = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(
      await service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).toEqual(legacy);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate.mock.calls[0]).toHaveLength(4);
    expect(logger).not.toHaveBeenCalled();
    validate.mockResolvedValueOnce(null as never);
    expect(
      await service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).toBeNull();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(logger).not.toHaveBeenCalled();
    validate.mockRejectedValueOnce(new Error("private-error"));
    await expect(
      service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).rejects.toThrow("auth_unavailable");
    expect(validate).toHaveBeenCalledTimes(3);
    expect(logger).not.toHaveBeenCalled();
    let captured: unknown;
    createNativeLatencyProfile({
      clock: () => 1,
      emit: (value) => {
        captured = JSON.parse(value);
      },
    }).finish("active");
    const profile = nativeCapturedDurations(captured, "active");
    const envelope = {
      kind: "native_private_session_v2",
      status: "active",
      session: legacy,
      profile,
    };
    validate.mockResolvedValueOnce(envelope as never);
    expect(
      await service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).toEqual(legacy);
    expect(validate).toHaveBeenCalledTimes(4);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logger.mock.calls[0]?.[0]))).toMatchObject({
      kind: "native_private_latency_v3",
      outerServiceMs: expect.any(Number),
      timingsAreNonAdditive: true,
    });
    validate.mockResolvedValueOnce({
      ...envelope,
      profile: { ...profile, secret: "private" },
    } as never);
    expect(
      await service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).toEqual(legacy);
    expect(validate).toHaveBeenCalledTimes(5);
    expect(logger).toHaveBeenCalledTimes(1);
    logger.mockImplementation(() => {
      throw new Error("synthetic-logger-failure");
    });
    validate.mockResolvedValueOnce(envelope as never);
    expect(
      await service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).toEqual(legacy);
    expect(validate).toHaveBeenCalledTimes(6);
    validate.mockResolvedValueOnce({ ...envelope, session: null } as never);
    await expect(
      service.validateSession({ cookie: "__Secure-omh_native.session_token=private-cookie" }),
    ).rejects.toThrow("auth_unavailable");
    expect(validate).toHaveBeenCalledTimes(7);
    const disabled = new NativeSessionService(
      { props: c5 } as never,
      { ...binding, NATIVE_AUTH_LATENCY_PROFILE: undefined } as never,
    );
    expect(
      await disabled.validateSession({
        cookie: "__Secure-omh_native.session_token=private-cookie",
      }),
    ).toEqual(legacy);
    expect(validate).toHaveBeenCalledTimes(8);
    expect(validate.mock.calls.at(-1)).toHaveLength(3);
  } finally {
    logger.mockRestore();
  }
});

it("cancels an abandoned preview body and bounds a stalled authority before acquiring its realm", async () => {
  const previewId = "a".repeat(32);
  const previewOrigin = `https://${previewId}-${"b".repeat(24)}.preview.dev.omh.st`;
  const identity = { previewId, authGeneration: 1 };
  const authority = () => ({
    organizationId,
    region: "eu" as const,
    realm: {
      projectId,
      environmentId,
      canonicalOrigin: previewOrigin,
      realmGeneration: 1,
      configurationRevision: 1,
    },
    revocationEpoch: 1,
    enabled: true,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: true,
    applicationName: "QA",
    signupPolicy: "open" as const,
    allowedRedirectPaths: ["/", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
    preview: identity,
  });
  const acquire = vi.fn(() => {
    throw new Error("request must not acquire its Auth realm");
  });
  const limit = vi.fn(async () => ({ success: true }));
  const resolve = vi.fn(async () => authority());
  const bindings = {
    NATIVE_AUTH_REGION_ID: "eu-dev",
    NATIVE_AUTH_QA_PREVIEW_ENABLED: "development-only-v1",
    NATIVE_AUTH_PREVIEW_AUTHORITY: { resolveForNative: resolve },
    NATIVE_AUTH_GENERAL_LIMITER: { limit },
    NATIVE_AUTH_REALM_LIMITER: { limit },
    NATIVE_AUTH_SIGNIN_LIMITER: { limit },
    NATIVE_AUTH_ENVIRONMENTS: { jurisdiction: () => ({ getByName: acquire }) },
  };
  const preview = new NativePreviewService({} as never, bindings as never);
  let readingBody: () => void = () => undefined;
  const bodyStarted = new Promise<void>((resolve) => {
    readingBody = resolve;
  });
  const cancel = vi.fn();
  // A zero high-water mark makes this handshake identify the runtime's actual body read.
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        readingBody();
        return new Promise<void>(() => undefined);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const aborted = new AbortController();
  const pending = preview.fetchStablePreview(
    new Request(`${previewOrigin}/api/auth/v1/sign-in/email`, {
      method: "POST",
      headers: { origin: previewOrigin, "content-type": "application/json" },
      body,
      signal: aborted.signal,
      duplex: "half",
    } as RequestInit),
    identity,
    { clientAddress: "127.0.0.1" },
  );
  await bodyStarted;
  aborted.abort();
  const response = await pending;
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "auth_unavailable" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(acquire).not.toHaveBeenCalled();

  limit.mockClear();
  let rejectAuthority: (error: Error) => void = () => undefined;
  const blocked = new Promise<ReturnType<typeof authority>>((_resolve, reject) => {
    rejectAuthority = reject;
  });
  bindings.NATIVE_AUTH_PREVIEW_AUTHORITY.resolveForNative = vi.fn(() => blocked);
  vi.useFakeTimers();
  try {
    let settled = false;
    const timedOut = preview.fetchStablePreview(
      new Request(`${previewOrigin}/api/auth/v1/get-session`),
      identity,
      { clientAddress: "127.0.0.1" },
    );
    void timedOut.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const unavailable = await timedOut;
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "auth_unavailable" });
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("set-cookie")).toBeNull();
    expect(bindings.NATIVE_AUTH_PREVIEW_AUTHORITY.resolveForNative).toHaveBeenCalledOnce();
    expect(limit).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  } finally {
    rejectAuthority(new Error("late private authority failure"));
    await Promise.resolve();
    vi.useRealTimers();
  }
});
