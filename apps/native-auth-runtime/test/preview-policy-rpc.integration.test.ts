import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import type { NativeAuthRegistryReceipt } from "../src/registry.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
const local = vi.hoisted(() => ({ connectionString: "", schema: "", pools: [] as Pool[] }));
vi.mock("../src/realm-pool.js", () => ({
  createNativeRealmPool: () => {
    const pool = new Pool({
      connectionString: local.connectionString,
      options: `-c search_path=${local.schema}`,
    });
    local.pools.push(pool);
    return pool;
  },
}));
import {
  NativeAuthEnvironment,
  NativeProductPreviewPolicyService,
  NativeProductPreviewService,
  NativeRegistryAdminService,
} from "../src/realm-worker.js";

it("applies and drains the product preview policy through its actual Realm DO and PostgreSQL", async () => {
  const db = await startTestPostgres();
  const previewId = "01J00000000000000000000001";
  const projectId = "01J00000000000000000000002";
  const environmentId = "01J00000000000000000000003";
  const organizationId = "01J00000000000000000000004";
  const fence = { previewId, runtimeGeneration: 1, tokenGeneration: 1 };
  const token = "a".repeat(52),
    publicOrigin = `https://${token}.preview.dev.omh.st`,
    tokenHash = createHash("sha256").update(token).digest("hex");
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
  local.connectionString = db.pool.options.connectionString as string;
  local.schema = receipt.schema;
  await db.pool.query(`create schema ${local.schema}`);
  const setup = new Pool({
    connectionString: local.connectionString,
    options: `-c search_path=${local.schema}`,
  });
  const values = new Map<string, unknown>();
  let instance: NativeAuthEnvironment;
  let retirement = false;
  let edgeAllowed = true;
  const drains: unknown[] = [];
  const messages: { kind: string; to: string; url: string }[] = [];
  const source = {
    sourceConnectionId: previewId,
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  const preview = {
    ...fence,
    authGeneration: 1,
    organizationId,
    projectId,
    environmentId,
    region: "eu" as const,
    retirement: "none" as const,
    targetSource: source,
    appliedSource: source,
  };
  const authority = {
    organizationId,
    realm: {
      projectId,
      environmentId,
      canonicalOrigin: null,
      realmGeneration: 1,
      configurationRevision: 1,
    },
    ownerEnabled: true,
    storageReady: true,
    paidAllowed: true,
    runtimeAllowed: true,
    revocationEpoch: 1,
    applicationName: "Preview",
    signupPolicy: "open" as const,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  };
  const bindings = {
    NATIVE_AUTH_REGION_ID: "eu-dev",
    PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
    PREVIEW_CONTROL: {
      resolveTokenHash: async (input: { tokenHash: string }) =>
        !retirement && input.tokenHash === tokenHash ? preview : null,
    },
    ...Object.fromEntries(
      ["GENERAL", "REALM", "SIGNIN", "SIGNUP", "RESET"].map((name) => [
        `NATIVE_AUTH_${name}_LIMITER`,
        { limit: async () => ({ success: edgeAllowed }) },
      ]),
    ),
    NATIVE_AUTH_PRODUCT_PREVIEW_MAIL: {
      sendNativePreviewAuthMail: async (message: { kind: string; to: string; url: string }) => {
        messages.push(message);
        return { status: "accepted" as const };
      },
    },
    NATIVE_AUTH_MAIL_AUTHORITY: {
      authorizeNativeMail: async () => ({ canonicalOrigin: publicOrigin }),
    },
    NATIVE_AUTH_CUSTODY_KEY_BASE64: btoa("k".repeat(32)),
    NATIVE_AUTH_CUSTODY_KEY_VERSION: 1,
    NATIVE_AUTH_ENVIRONMENTS: { jurisdiction: () => ({ getByName: () => instance }) },
    NATIVE_AUTH_REGISTRY_AUTHORITY: {
      authorizeRegistration: async () => true,
      readRegistration: async () => (retirement ? null : receipt),
      authorizeRevocation: async () => true,
      authorizeDeletion: async () => true,
      authorizeDeletionQuiescence: async () => true,
    },
    NATIVE_AUTH_PRODUCT_PREVIEW_AUTHORITY: {
      resolve: async () =>
        retirement ? null : { preview, authority, registration: receipt, launchAllowed: true },
      resolveDrain: async () =>
        retirement ? { ...preview, hasRegistration: true, registration: receipt } : null,
      recordDrain: async (value: unknown) => {
        drains.push(value);
      },
    },
  };
  try {
    for (const file of [
      "../schema.sql",
      "../migrations/002-invitation-receipt-digest.sql",
      "../migrations/003-social-flow.sql",
      "../migrations/004-preview-policy.sql",
    ])
      await setup.query(await readFile(new URL(file, import.meta.url), "utf8"));
    await setup.query(
      "insert into native_realm_policy(enabled,revocation_epoch,configuration_revision) values(false,1,1)",
    );
    instance = new NativeAuthEnvironment(
      {
        storage: {
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => {
            values.set(key, structuredClone(value));
          },
        },
      } as never,
      bindings as never,
    );
    const registry = new NativeRegistryAdminService({} as never, bindings as never);
    const { status: _status, ...metadata } = receipt;
    void _status;
    await registry.register({
      ...metadata,
      connectionString: `postgres://${receipt.role}:private@${receipt.originHost}/${receipt.databaseId}?sslmode=require`,
    });
    const policy = new NativeProductPreviewPolicyService({} as never, bindings as never);
    expect(
      await policy.applyPreviewRealmPolicy({
        fence,
        authGeneration: 1,
        revocationEpoch: 1,
        configurationRevision: 1,
      }),
    ).toEqual({ outcome: "applied" });
    expect(
      (
        await setup.query(
          "select enabled from native_preview_realm_policy where preview_id=$1 and auth_generation=1",
          [previewId],
        )
      ).rows,
    ).toEqual([{ enabled: true }]);
    expect((await setup.query("select enabled from native_realm_policy")).rows).toEqual([
      { enabled: false },
    ]);
    const product = new NativeProductPreviewService({} as never, bindings as never);
    const input = { fence, publicOrigin, clientAddress: "127.0.0.1" };
    const send = (path: string, body?: object) =>
      product.fetchPreview(
        new Request(
          `${publicOrigin}/api/auth/v1${path}`,
          body === undefined
            ? {}
            : {
                method: "POST",
                headers: {
                  origin: publicOrigin,
                  "content-type": "application/json",
                  "idempotency-key": randomUUID(),
                },
                body: JSON.stringify(body),
              },
        ),
        input,
      );
    const email = "product-preview@example.test";
    const password = "correct-horse-battery-123"; // gitleaks:allow -- disposable local test password
    expect((await send("/sign-up/email", { email, password, name: "Preview" })).status).toBe(200);
    const verification = messages.at(-1);
    if (!verification) throw new Error("verification missing");
    expect(verification.to).toBe(email);
    expect(new URL(verification.url).origin).toBe(publicOrigin);
    expect((await product.fetchPreview(new Request(verification.url), input)).status).toBeLessThan(
      400,
    );
    const login = await send("/sign-in/email", { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get("referrer-policy")).toBe("no-referrer");
    expect(login.headers.get("cache-control")).toBe("no-store");
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain(`__Host-omh_native_preview_${previewId}.session_token=`);
    expect(await product.validatePreviewSession({ fence, publicOrigin, cookie })).toMatchObject({
      user: { email },
    });
    expect(
      await product.validatePreviewSession({
        fence,
        publicOrigin,
        cookie: `application=value; ${cookie}`,
      }),
    ).toMatchObject({ user: { email } });
    const changed = { ...source, sequence: 2, commitSha: "b".repeat(40) };
    preview.targetSource = changed;
    preview.appliedSource = changed;
    expect(await product.validatePreviewSession({ fence, publicOrigin, cookie })).toMatchObject({
      user: { email },
    });
    await expect(
      product.validatePreviewSession({ fence, publicOrigin: "https://foreign.example", cookie }),
    ).rejects.toThrow("auth_unavailable");
    edgeAllowed = false;
    expect((await send("/get-session")).status).toBe(429);
    edgeAllowed = true;
    let beganRead: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      beganRead = resolve;
    });
    let bodyCancelled = false;
    const controller = new AbortController();
    const init: RequestInit = {
      method: "POST",
      headers: { origin: publicOrigin, "content-type": "application/json" },
      signal: controller.signal,
      body: new ReadableStream<Uint8Array>(
        {
          pull() {
            beganRead();
          },
          cancel() {
            bodyCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    };
    Reflect.set(init, "duplex", "half");
    const aborted = product.fetchPreview(
      new Request(`${publicOrigin}/api/auth/v1/sign-in/email`, init),
      input,
    );
    await reading;
    controller.abort();
    expect((await aborted).status).toBe(503);
    expect(bodyCancelled).toBe(true);
    retirement = true;
    await expect(product.validatePreviewSession({ fence, publicOrigin, cookie })).rejects.toThrow(
      "auth_unavailable",
    );
    expect((await send("/get-session")).status).toBe(503);
    await product.drainPreview({ fence });
    expect(drains).toEqual([{ ...fence, authGeneration: 1 }]);
  } finally {
    for (const pool of local.pools.splice(0)) await pool.end();
    await setup.end();
    await db.pool.query(`drop schema ${local.schema} cascade`);
    await db.stop();
  }
}, 30_000);
