import { afterAll, beforeAll, expect, it } from "vitest";
import { issueProductDatabaseAccess } from "../../src/catalog/database/product-access.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { ulidOf, NOW } from "../support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>["productDatabase"];
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings).productDatabase;
}, 120000);
afterAll(async () => {
  await control?.dispose();
});

const LATER = "2026-10-28T10:05:00.000Z";
const operationId = (letter: string) => `op_${letter.repeat(20)}`;

async function scenario(index = 0) {
  const f = await seedProductRuntimeFixture(control);
  const accessId = ulidOf("delete-operation-access", f.n * 10 + index);
  const accepted = await issueProductDatabaseAccess(f.context, {
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev",
    mode: "read",
    ttlSeconds: 3600,
    label: "delete operation fixture",
    principalId: "user:fixture",
    now: NOW,
    roleSuffix: String(index).padStart(8, "0"),
    accessId,
    auditEventId: ulidOf("delete-operation-issue", f.n * 10 + index),
  });
  expect(accepted.status).toBe("accepted");
  return {
    f,
    accessId,
    scope: { organizationId: f.organizationId, projectId: f.projectId, accessId },
  };
}

function revocation(label: string, revokedAt = NOW) {
  return {
    revokedAt,
    revokedBy: "user:fixture",
    reason: "principal" as const,
    roleDropped: false,
    auditEventId: ulidOf(`delete-operation-revoke-${label}`, 1),
  };
}

async function row(accessId: string) {
  return control.core
    .prepare(
      "SELECT provider_delete_operation_id,revoked_at,role_dropped_at,revoked_by FROM project_database_access WHERE access_id=?",
    )
    .bind(accessId)
    .first<{
      provider_delete_operation_id: string | null;
      revoked_at: string | null;
      role_dropped_at: string | null;
      revoked_by: string | null;
    }>();
}

async function revokedEvents(organizationId: string): Promise<number> {
  const found = await control.core
    .prepare(
      "SELECT count(*) n FROM audit_events WHERE organization_id=? AND event_type='DatabaseAccessRevoked'",
    )
    .bind(organizationId)
    .first<{ n: number }>();
  return found?.n ?? 0;
}

it("replaces the delete operation of a revoking access by compare-and-set on the failed id", async () => {
  const { f, accessId, scope } = await scenario();
  const A = operationId("a"),
    B = operationId("b"),
    C = operationId("c");
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: A,
    revocation: revocation("first"),
  });
  const revoked = await row(accessId);
  expect(revoked).toEqual({
    provider_delete_operation_id: A,
    revoked_at: revoked?.revoked_at,
    role_dropped_at: null,
    revoked_by: "user:fixture",
  });
  expect(await revokedEvents(f.organizationId)).toBe(1);

  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: B,
    previousOperationId: A,
    revocation: revocation("second", LATER),
  });
  expect(await row(accessId)).toEqual({
    provider_delete_operation_id: B,
    revoked_at: revoked?.revoked_at,
    role_dropped_at: null,
    revoked_by: "user:fixture",
  });
  expect(await revokedEvents(f.organizationId)).toBe(1);

  // The same call again is a replay: no error and no second write.
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: B,
    previousOperationId: A,
    revocation: revocation("second", LATER),
  });
  expect((await row(accessId))?.provider_delete_operation_id).toBe(B);

  // The third pass records a further failure without revocation: A -> B -> C.
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: C,
    previousOperationId: B,
  });
  expect((await row(accessId))?.provider_delete_operation_id).toBe(C);
  expect(await revokedEvents(f.organizationId)).toBe(1);
});

it("refuses a replacement whose previous id is not the stored id", async () => {
  const { scope, accessId } = await scenario();
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
    revocation: revocation("stale"),
  });
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("b"),
    previousOperationId: operationId("a"),
  });
  await expect(
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: operationId("c"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  expect((await row(accessId))?.provider_delete_operation_id).toBe(operationId("b"));
});

it("refuses a replacement that names no previous id, so the write-once rule still holds", async () => {
  const { scope, accessId } = await scenario();
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
    revocation: revocation("no-previous"),
  });
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("b"),
    previousOperationId: operationId("a"),
  });
  await expect(
    store.recordAccessOperation({ ...scope, kind: "delete", operationId: operationId("c") }),
  ).rejects.toThrow("scope");
  expect((await row(accessId))?.provider_delete_operation_id).toBe(operationId("b"));
});

it("refuses a previous id while no delete operation is stored", async () => {
  const { scope, accessId } = await scenario();
  await store.revokeAccess({ ...scope, ...revocation("no-operation") });
  await expect(
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: operationId("a"),
      previousOperationId: operationId("x"),
    }),
  ).rejects.toThrow("scope");
  expect(await row(accessId)).toMatchObject({ provider_delete_operation_id: null });
});

it("refuses a replacement of the delete operation of an active access", async () => {
  const { scope, accessId } = await scenario();
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
  });
  await expect(
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: operationId("b"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  expect(await row(accessId)).toMatchObject({
    provider_delete_operation_id: operationId("a"),
    revoked_at: null,
  });
});

it("refuses a replacement of the delete operation of a fully revoked access", async () => {
  const { scope, accessId } = await scenario();
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
    revocation: revocation("dropped"),
  });
  await store.revokeAccess({ ...scope, ...revocation("dropped-done"), roleDropped: true });
  expect((await row(accessId))?.role_dropped_at).not.toBeNull();
  await expect(
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: operationId("b"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  expect((await row(accessId))?.provider_delete_operation_id).toBe(operationId("a"));
});

it("refuses a replacement that names another access or another organization", async () => {
  const first = await scenario(0);
  const second = await scenario(1);
  await store.recordAccessOperation({
    ...first.scope,
    kind: "delete",
    operationId: operationId("a"),
    revocation: revocation("first-access"),
  });
  await store.recordAccessOperation({
    ...second.scope,
    kind: "delete",
    operationId: operationId("c"),
    revocation: revocation("second-access"),
  });
  // Another revoking access whose stored id differs from the named previous id.
  await expect(
    store.recordAccessOperation({
      ...second.scope,
      kind: "delete",
      operationId: operationId("b"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  // An unknown access id.
  await expect(
    store.recordAccessOperation({
      ...first.scope,
      accessId: ulidOf("unknown-access", 1),
      kind: "delete",
      operationId: operationId("b"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  // The first project and access under another organization.
  const other = await seedProductRuntimeFixture(control);
  await expect(
    store.recordAccessOperation({
      organizationId: other.organizationId,
      projectId: first.scope.projectId,
      accessId: first.scope.accessId,
      kind: "delete",
      operationId: operationId("b"),
      previousOperationId: operationId("a"),
    }),
  ).rejects.toThrow("scope");
  expect((await row(first.accessId))?.provider_delete_operation_id).toBe(operationId("a"));
  expect((await row(second.accessId))?.provider_delete_operation_id).toBe(operationId("c"));
});

it("rejects a previous id on a create operation", async () => {
  const { scope, accessId } = await scenario();
  await expect(
    store.recordAccessOperation({
      ...scope,
      kind: "create",
      operationId: operationId("a"),
      previousOperationId: operationId("b"),
    }),
  ).rejects.toThrow();
  expect(await row(accessId)).toMatchObject({ revoked_at: null });
});

it("keeps the delete operation id immutable in the store except while the access is revoking", async () => {
  const { scope, accessId } = await scenario();
  const update = (value: string | null) =>
    control.core
      .prepare(
        "UPDATE project_database_access SET provider_delete_operation_id=? WHERE access_id=?",
      )
      .bind(value, accessId)
      .run();
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
  });
  await expect(update(operationId("b"))).rejects.toThrow(/immutable/u);

  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: operationId("a"),
    revocation: revocation("trigger"),
  });
  await update(operationId("b"));
  expect((await row(accessId))?.provider_delete_operation_id).toBe(operationId("b"));
  await expect(update(null)).rejects.toThrow(/immutable/u);

  await store.revokeAccess({ ...scope, ...revocation("trigger-done"), roleDropped: true });
  await expect(update(operationId("c"))).rejects.toThrow(/immutable/u);
  expect((await row(accessId))?.provider_delete_operation_id).toBe(operationId("b"));
});

it("lets exactly one of two concurrent replacements of the same failed id win", async () => {
  const { f, accessId, scope } = await scenario();
  const A = operationId("a"),
    B = operationId("b"),
    C = operationId("c");
  await store.recordAccessOperation({
    ...scope,
    kind: "delete",
    operationId: A,
    revocation: revocation("race"),
  });
  const outcomes = await Promise.allSettled([
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: B,
      previousOperationId: A,
    }),
    store.recordAccessOperation({
      ...scope,
      kind: "delete",
      operationId: C,
      previousOperationId: A,
    }),
  ]);
  const winner = outcomes.findIndex((outcome) => outcome.status === "fulfilled");
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const loser = outcomes[winner === 0 ? 1 : 0] as PromiseRejectedResult;
  expect(loser.status).toBe("rejected");
  expect(loser.reason).toMatchObject({ message: "scope" });
  expect((await row(accessId))?.provider_delete_operation_id).toBe(winner === 0 ? B : C);
  expect(await revokedEvents(f.organizationId)).toBe(1);
});

it("keeps the create operation id write-once", async () => {
  const { scope, accessId } = await scenario();
  await store.recordAccessOperation({
    ...scope,
    kind: "create",
    operationId: operationId("a"),
  });
  await expect(
    control.core
      .prepare(
        "UPDATE project_database_access SET provider_create_operation_id=? WHERE access_id=?",
      )
      .bind(operationId("b"), accessId)
      .run(),
  ).rejects.toThrow(/immutable/u);
});
