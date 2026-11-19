import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PgcfProviderError, type PgcfWebhook } from "@ohmyhost/provider-pgcf";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { rig } from "../../control-store/test/support/pgcf-rig.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createPgcfWebhookSubscriptions,
  createWebhookLifecycleCipher,
} from "../src/pgcf-webhook-subscriptions.js";
import type { DatabaseEventsProvider } from "../src/pgcf-database-events.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
const time = "2026-11-14T12:00:00.000Z";
const webhook = (c: string) => `whk_${c.repeat(20)}`;

it("recovers a lost provider reply and its real signing secret at the cap, then signs with a fresh generation after confirmed deletion", async () => {
  const f = await rig(control, undefined, null),
    store = f.store.productDatabase;
  const envelope = {
    organizationId: f.project.organizationId,
    projectId: f.project.projectId,
    environment: "dev" as const,
    subscriptionId: newUlid(),
  };
  const saved = new Map<string, { webhook: PgcfWebhook; secret: string }>(),
    byId = new Map<string, PgcfWebhook>();
  const initial = Array.from({ length: 4 }, (_, i) => ({
    id: webhook(String(i)),
    projectId: f.providerProjectId,
    databaseIds: [f.databaseId],
    url: "https://example.test/old",
    eventTypes: ["data.*"],
    headerNames: [],
    createdAt: time,
  }));
  for (const item of initial) byId.set(item.id, item);
  let lost = true,
    creates = 0,
    listCalls = 0,
    currentTime = new Date(time);
  const provider = {
    projectId: f.providerProjectId,
    listWebhooks: async () => {
      listCalls++;
      return { items: [...byId.values()], nextCursor: null };
    },
    getWebhook: async (id: string) => {
      const found = byId.get(id);
      if (!found) throw new PgcfProviderError("rejected", 404);
      return found;
    },
    createWebhook: async (_input: unknown, options: { key: string }) => {
      let result = saved.get(options.key);
      if (!result) {
        creates++;
        const item = {
          id: webhook(creates === 1 ? "a" : "b"),
          projectId: f.providerProjectId,
          databaseIds: [f.databaseId],
          url: "https://example.test/hook",
          eventTypes: ["data.*"],
          headerNames: ["x-token"],
          createdAt: time,
        };
        result = {
          webhook: item,
          secret: creates === 1 ? "whsec_first_signing_secret" : "whsec_second_signing_secret",
        };
        saved.set(options.key, result);
        byId.set(item.id, item);
        if (lost) {
          lost = false;
          throw new PgcfProviderError("transport");
        }
      }
      return { ...result.webhook, secret: result.secret };
    },
    deleteWebhook: async (id: string) => {
      byId.delete(id);
    },
  } as unknown as DatabaseEventsProvider;
  const custody = createWebhookLifecycleCipher({
    keyBase64: Buffer.alloc(32, 4).toString("base64"),
    keyVersion: 1,
  });
  const service = createPgcfWebhookSubscriptions({
    provider,
    runtime: store,
    readScope: async () => ({
      physicalEnvironmentId: f.physical,
      target: {
        provider: "pgcf",
        organizationId: f.project.organizationId,
        projectId: f.project.projectId,
        physicalEnvironmentId: f.physical,
        targetVersion: 1,
        providerProjectId: f.providerProjectId,
        databaseId: f.databaseId,
        regionId: "us-dev",
        runtimeRole: "runtime",
        credentialReference: "fixture",
        activatedAt: null,
        sizeClassId: "small",
      },
    }),
    ...custody,
    now: () => currentTime,
  });
  const first = {
    ...envelope,
    operation: "subscription.activate" as const,
    generation: 1,
    idempotencyKey: "activation-1",
    webhook: {
      url: "https://example.test/hook",
      event_types: ["data.*"] as const,
      headers: { "x-token": "private-header" },
    },
  };
  await expect(service.run(first)).rejects.toMatchObject({ code: "transport" });
  currentTime = new Date(Date.parse(time) + (23 * 60 + 56) * 60_000);
  expect(await service.run(first)).toEqual({ status: "rejected", code: "pending" });
  expect(creates).toBe(1);
  currentTime = new Date(time);
  const recovered = await service.run(first);
  expect(recovered).toMatchObject({
    status: "ok",
    value: {
      id: envelope.subscriptionId,
      generation: 1,
      state: "active",
      secret: "whsec_first_signing_secret",
    },
  });
  expect(creates).toBe(1);
  expect(listCalls).toBe(2);
  const sealed = await control.core
    .prepare(
      `SELECT lower(hex(secret_ciphertext)) ciphertext,lower(hex(secret_nonce)) nonce,
    lower(hex(secret_sha256)) digest,secret_key_version key_version FROM database_webhook_activation_receipts
    WHERE organization_id=?1 AND project_id=?2 AND environment='dev' AND subscription_id=?3 AND generation=1`,
    )
    .bind(envelope.organizationId, envelope.projectId, envelope.subscriptionId)
    .first<{ ciphertext: string; nonce: string; digest: string; key_version: number }>();
  if (!sealed) throw new Error("Missing sealed receipt");
  const identity = {
    organizationId: envelope.organizationId,
    projectId: envelope.projectId,
    environmentId: f.physical,
    name: `DATABASE_WEBHOOK_DEV_${envelope.subscriptionId}_GEN_1`,
    ciphertext: Uint8Array.from(Buffer.from(sealed.ciphertext, "hex")),
    nonce: Uint8Array.from(Buffer.from(sealed.nonce, "hex")),
    valueSha256: Uint8Array.from(Buffer.from(sealed.digest, "hex")),
    keyVersion: sealed.key_version,
  };
  expect(await custody.cipher.decrypt(identity)).toBe("whsec_first_signing_secret");
  await expect(
    custody.cipher.decrypt({
      ...identity,
      name: `DATABASE_WEBHOOK_DEV_${envelope.subscriptionId}_GEN_2`,
    }),
  ).rejects.toThrow();
  await expect(custody.cipher.decrypt({ ...identity, projectId: newUlid() })).rejects.toThrow();
  await expect(
    custody.cipher.decrypt({
      ...identity,
      name: `DATABASE_WEBHOOK_PROD_${envelope.subscriptionId}_GEN_1`,
    }),
  ).rejects.toThrow();
  const body = '{"event":"data.order"}',
    timestamp = "1794657600";
  const signature = createHmac("sha256", "whsec_first_signing_secret")
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const verify = async (secret: string, signed: string) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(Buffer.from(signed, "hex")),
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
  };
  expect(
    await verify(
      (recovered as { status: "ok"; value: { secret: string } }).value.secret,
      signature,
    ),
  ).toBe(true);
  const status = await service.run({ ...envelope, operation: "subscription.status" });
  expect(JSON.stringify(status)).not.toMatch(/secret|ciphertext|private-header/u);
  const currentProvider = byId.get(webhook("a"));
  if (!currentProvider) throw new Error("Expected the active provider webhook");
  byId.delete(webhook("a"));
  await expect(service.run({ ...envelope, operation: "subscription.status" })).rejects.toThrow(
    "Webhook provider state unavailable",
  );
  byId.set(currentProvider.id, currentProvider);
  const deactivate = {
    ...envelope,
    operation: "subscription.deactivate" as const,
    generation: 1,
    idempotencyKey: "delete-1",
  };
  expect(await service.run(deactivate)).toMatchObject({
    status: "ok",
    value: { state: "inactive" },
  });
  expect(await service.run(first)).toEqual({ status: "rejected", code: "idempotency_key_reused" });
  const next = await service.run({ ...first, generation: 2, idempotencyKey: "activation-2" });
  expect(next).toMatchObject({
    status: "ok",
    value: { id: envelope.subscriptionId, generation: 2, secret: "whsec_second_signing_secret" },
  });
  expect(
    await verify((next as { status: "ok"; value: { secret: string } }).value.secret, signature),
  ).toBe(false);
  const nextSignature = createHmac("sha256", "whsec_second_signing_secret")
    .update(`${timestamp}.${body}`)
    .digest("hex");
  expect(
    await verify((next as { status: "ok"; value: { secret: string } }).value.secret, nextSignature),
  ).toBe(true);
  expect(
    await verify(
      (recovered as { status: "ok"; value: { secret: string } }).value.secret,
      nextSignature,
    ),
  ).toBe(false);
  expect(creates).toBe(2);
  expect(
    await service.run({ ...envelope, organizationId: newUlid(), operation: "subscription.status" }),
  ).toEqual({ status: "absent" });

  // A legacy create can race after the capacity observation. Fence the losing activation before deletion;
  // even a lost deletion reply is reconciled without returning a stale signing secret.
  const other = await rig(control, undefined, null),
    initialOther = Array.from({ length: 4 }, (_, i) => ({
      id: webhook(String(i)),
      projectId: other.providerProjectId,
      databaseIds: [other.databaseId],
      url: "https://example.test/old",
      eventTypes: ["data.*"],
      headerNames: [],
      createdAt: time,
    }));
  const active = new Map(initialOther.map((item) => [item.id, item]));
  let loseDelete = true;
  const racingProvider = {
    projectId: other.providerProjectId,
    listWebhooks: async () => ({ items: [...active.values()], nextCursor: null }),
    getWebhook: async (id: string) => {
      const item = active.get(id);
      if (!item) throw new PgcfProviderError("rejected", 404);
      return item;
    },
    createWebhook: async () => {
      const firstExisting = initialOther[0];
      if (!firstExisting) throw new Error("Expected a legacy webhook");
      const late = { ...firstExisting, id: webhook("e") },
        created = { ...late, id: webhook("z") };
      active.set(late.id, late);
      active.set(created.id, created);
      return { ...created, secret: "whsec_over_cap" };
    },
    deleteWebhook: async (id: string) => {
      active.delete(id);
      if (loseDelete) {
        loseDelete = false;
        throw new PgcfProviderError("transport");
      }
    },
  } as unknown as DatabaseEventsProvider;
  const racing = createPgcfWebhookSubscriptions({
    provider: racingProvider,
    runtime: other.store.productDatabase,
    readScope: async () => ({
      physicalEnvironmentId: other.physical,
      target: {
        provider: "pgcf",
        organizationId: other.project.organizationId,
        projectId: other.project.projectId,
        physicalEnvironmentId: other.physical,
        targetVersion: 1,
        providerProjectId: other.providerProjectId,
        databaseId: other.databaseId,
        regionId: "us-dev",
        runtimeRole: "runtime",
        credentialReference: "fixture",
        activatedAt: null,
        sizeClassId: "small",
      },
    }),
    ...createWebhookLifecycleCipher({
      keyBase64: Buffer.alloc(32, 4).toString("base64"),
      keyVersion: 1,
    }),
    now: () => new Date(time),
  });
  const racingRequest = {
    ...first,
    organizationId: other.project.organizationId,
    projectId: other.project.projectId,
    subscriptionId: newUlid(),
  };
  await expect(racing.run(racingRequest)).rejects.toMatchObject({ code: "transport" });
  expect(await racing.run(racingRequest)).toEqual({ status: "rejected", code: "webhook_limit" });
  expect(active.size).toBe(5);
  expect(await racing.run(racingRequest)).toEqual({
    status: "rejected",
    code: "idempotency_key_reused",
  });
});

it("replays reordered webhook headers through the worker without creating another subscription or exposing the secret in status", async () => {
  const f = await rig(control, undefined, null);
  const id = webhook("w");
  const secret = `whsec_${"a".repeat(24)}`;
  const stored = {
    id,
    project_id: f.providerProjectId,
    url: "https://example.test/hook",
    event_types: ["data.*"],
    database_ids: [f.databaseId],
    header_names: ["x-alpha", "x-zeta"],
    created_at: time,
  };
  let exists = false,
    creates = 0;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== "https://pgcf.fixture") throw new Error("Unexpected provider origin");
    if (url.pathname === "/v1/webhooks" && init?.method === "GET")
      return Response.json({ data: exists ? [stored] : [], next_cursor: null });
    if (url.pathname === "/v1/webhooks" && init?.method === "POST") {
      creates++;
      const body = JSON.parse(String(init.body)) as { headers: Record<string, string> };
      expect(body.headers).toEqual({ "x-alpha": "private-a", "x-zeta": "private-z" });
      exists = true;
      return Response.json({ ...stored, secret }, { status: 201 });
    }
    if (url.pathname === `/v1/webhooks/${id}` && init?.method === "GET" && exists)
      return Response.json(stored);
    throw new Error("Unexpected provider request");
  });
  try {
    const { NeonManagementService } = await import("../src/pgcf-worker-main.js");
    const { DatabaseProductRuntime } = await import("../../control-store/src/worker-main.js");
    const coreRuntime = new DatabaseProductRuntime({}, control.bindings);
    const service = new NeonManagementService(
      {},
      {
        RUNTIME_CONFIGURATION_STATE: "configured",
        PGCF_API_URL: "https://pgcf.fixture",
        PGCF_APPS_PROJECT_ID: f.providerProjectId,
        PGCF_APPS_API_KEY: "fixture-only-provider-key",
        DATABASE_WEBHOOK_SECRET_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
        DATABASE_WEBHOOK_SECRET_KEY_VERSION: "1",
        DATABASE_PRODUCT_RUNTIME: coreRuntime,
      },
    );
    const subscriptionId = newUlid();
    const input = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      environment: "dev",
      operation: "subscription.activate",
      subscriptionId,
      generation: 1,
      idempotencyKey: "header-order-retry",
      url: stored.url,
      eventTypes: ["data.*"],
      headers: { "x-zeta": "private-z", "x-alpha": "private-a" },
    };
    const activated = await service.databaseEvents(input);
    expect(activated).toMatchObject({
      status: "ok",
      value: { id: subscriptionId, state: "active", generation: 1, secret },
    });
    const replay = await service.databaseEvents({
      ...input,
      headers: { "x-alpha": "private-a", "x-zeta": "private-z" },
    });
    expect(replay).toEqual(activated);
    expect(creates).toBe(1);
    expect(
      await service.databaseEvents({
        ...input,
        headers: { "x-alpha": "changed", "x-zeta": "private-z" },
      }),
    ).toEqual({ status: "rejected", code: "idempotency_key_reused" });
    const status = await service.databaseEvents({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      operation: "subscription.status",
      subscriptionId,
    });
    expect(status).toMatchObject({ status: "ok", value: { id: subscriptionId, state: "active" } });
    expect(JSON.stringify(status)).not.toMatch(/secret|private-a|private-z/u);
  } finally {
    fetcher.mockRestore();
  }
});
