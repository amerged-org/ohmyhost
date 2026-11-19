import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { rig } from "../support/pgcf-rig.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";

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
const h = (c: string) => c.repeat(64);

it("retains an activation receipt and tombstones its old generation across deactivation and reactivation", async () => {
  const f = await rig(control, undefined, null),
    store = f.store.productDatabase;
  const base = {
    organizationId: f.project.organizationId,
    projectId: f.project.projectId,
    environment: "dev" as const,
    physicalEnvironmentId: f.physical,
    providerProjectId: f.providerProjectId,
    databaseId: f.databaseId,
    subscriptionId: newUlid(),
  };
  const first = { ...base, generation: 1, keyHash: h("1"), requestHash: h("2"), now: time };
  expect(await store.beginWebhookActivation({ ...first, providerIds: null })).toEqual({
    outcome: "capacity_required",
  });
  const lossyBegin = createControlStore({
    ...control.bindings,
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  }).productDatabase;
  expect(await lossyBegin.beginWebhookActivation({ ...first, providerIds: [] })).toMatchObject({
    outcome: "ok",
    head: { state: "creating", generation: 1 },
  });
  expect(
    await store.beginWebhookDeactivation({ ...base, generation: 1, keyHash: h("3"), now: time }),
  ).toEqual({ outcome: "pending" });
  const ciphertext = "ab".repeat(32),
    nonce = "cd".repeat(12),
    secretDigest = h("e");
  const lossyFinish = createControlStore({
    ...control.bindings,
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  }).productDatabase;
  await lossyFinish.finishWebhookActivation({
    ...first,
    providerId: webhook("a"),
    ciphertext,
    nonce,
    valueSha256: secretDigest,
    keyVersion: 1,
  });
  const retry = await store.beginWebhookActivation({ ...first, providerIds: null });
  expect(retry).toMatchObject({
    outcome: "ok",
    head: { state: "active" },
    receipt: { ciphertext, nonce, value_sha256: secretDigest },
  });
  expect(await store.readWebhookSubscription(base)).toMatchObject({
    outcome: "ok",
    head: { state: "active", provider_id: webhook("a") },
  });
  expect(JSON.stringify(await store.readWebhookSubscription(base))).not.toContain(ciphertext);
  expect(
    await store.beginWebhookActivation({ ...first, requestHash: h("4"), providerIds: null }),
  ).toEqual({ outcome: "idempotency_key_reused" });
  const del = { ...base, generation: 1, keyHash: h("3"), now: time };
  const concurrent = await Promise.all([
    store.beginWebhookDeactivation(del),
    store.beginWebhookDeactivation(del),
  ]);
  expect(concurrent).toEqual([
    expect.objectContaining({
      outcome: "ok",
      head: expect.objectContaining({ state: "deactivating" }),
    }),
    expect.objectContaining({
      outcome: "ok",
      head: expect.objectContaining({ state: "deactivating" }),
    }),
  ]);
  expect(
    await store.beginWebhookActivation({
      ...first,
      generation: 2,
      keyHash: h("5"),
      providerIds: [],
    }),
  ).toEqual({ outcome: "pending" });
  await store.finishWebhookDeactivation(del);
  expect(await store.beginWebhookActivation({ ...first, providerIds: null })).toEqual({
    outcome: "idempotency_key_reused",
  });
  const second = { ...first, generation: 2, keyHash: h("5") };
  expect(await store.beginWebhookActivation({ ...second, providerIds: [] })).toMatchObject({
    outcome: "ok",
    head: { state: "creating", generation: 2 },
  });
  await store.finishWebhookActivation({
    ...second,
    providerId: webhook("b"),
    ciphertext,
    nonce,
    valueSha256: h("f"),
    keyVersion: 1,
  });
  expect(
    await store.beginWebhookDeactivation({ ...base, generation: 2, keyHash: h("3"), now: time }),
  ).toEqual({
    outcome: "idempotency_key_reused",
  });
  const nextDelete = { ...base, generation: 2, keyHash: h("6"), now: time };
  expect(await store.beginWebhookDeactivation(nextDelete)).toMatchObject({
    outcome: "ok",
    head: { state: "deactivating" },
  });
  await store.finishWebhookDeactivation(nextDelete);
  const parallel = ["7", "8"].map((digit) => ({
    ...first,
    subscriptionId: newUlid(),
    keyHash: h(digit),
  }));
  for (const [index, item] of parallel.entries()) {
    await store.beginWebhookActivation({ ...item, providerIds: [] });
    await store.finishWebhookActivation({
      ...item,
      providerId: webhook(index === 0 ? "c" : "d"),
      ciphertext,
      nonce,
      valueSha256: h(index === 0 ? "a" : "b"),
      keyVersion: 1,
    });
  }
  const raced = await Promise.all(
    parallel.map((item) =>
      store.beginWebhookDeactivation({
        ...base,
        subscriptionId: item.subscriptionId,
        generation: 1,
        keyHash: h("c"),
        now: time,
      }),
    ),
  );
  expect(raced.filter((result) => result.outcome === "ok")).toHaveLength(1);
  expect(raced.filter((result) => result.outcome === "idempotency_key_reused")).toHaveLength(1);
  expect(await store.beginWebhookActivation({ ...first, providerIds: null })).toEqual({
    outcome: "idempotency_key_reused",
  });
  expect(await store.readWebhookSubscription({ ...base, organizationId: newUlid() })).toEqual({
    outcome: "absent",
  });
});

it("serializes capacity reservations while admitting exact retries even at the cap", async () => {
  const f = await rig(control, undefined, null),
    store = f.store.productDatabase;
  const base = {
    organizationId: f.project.organizationId,
    projectId: f.project.projectId,
    environment: "dev" as const,
    physicalEnvironmentId: f.physical,
    providerProjectId: f.providerProjectId,
    databaseId: f.databaseId,
    generation: 1,
    now: time,
    providerIds: [],
  };
  const calls = Array.from({ length: 6 }, (_, i) => ({
    ...base,
    subscriptionId: newUlid(),
    keyHash: h(String(i + 1)),
    requestHash: h("a"),
  }));
  const outcomes = await Promise.all(calls.map((input) => store.beginWebhookActivation(input)));
  expect(outcomes.filter((result) => result.outcome === "ok")).toHaveLength(5);
  expect(outcomes.filter((result) => result.outcome === "webhook_limit")).toHaveLength(1);
  const successful = calls[outcomes.findIndex((result) => result.outcome === "ok")];
  if (!successful) throw new Error("Expected a successful reservation");
  expect(await store.beginWebhookActivation({ ...successful, providerIds: null })).toMatchObject({
    outcome: "ok",
    head: { state: "creating" },
  });
});
