import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../../src/catalog/common.js";
import { authenticateStorageGateway } from "../../src/catalog/storage-gateway/auth.js";
import type { D1Database } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization } from "../support/seed.js";

const TIME = "2026-10-28T12:00:00.000000Z";

let control: TestControl;
let db: D1Database;
let context: CatalogContext;
let store: ReturnType<typeof createControlStore>;
let organizationId: string;

beforeAll(async () => {
  control = await createTestControl(1);
  db = control.core;
  context = { directory: db, router: new SharedCoreRouter(db) };
  store = createControlStore(control.bindings);
  organizationId = await seedOrganization(store, 1, 0);
}, 60_000);
afterAll(async () => control.dispose());

const digestOf = (byte: number) => new Uint8Array(32).fill(byte);
const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

/** An isolated project whose development environment owns a bucket receipt and its first storage key version. */
async function seedStorageKey(first: number) {
  const project = projectInput(organizationId, `keyver-${newUlid().toLowerCase()}`, false);
  await store.projects.createInitialProject(project);
  const scope = {
    organizationId,
    projectId: project.projectId,
    environmentId: project.developmentEnvironmentId,
    dataEnvironmentId: project.developmentDataEnvironmentId,
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
      )
      .bind(
        organizationId,
        scope.projectId,
        scope.environmentId,
        newUlid(),
        newUlid(),
        `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
        crypto.randomUUID().replaceAll("-", ""),
        TIME,
      ),
    db
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, digestOf(first), TIME),
  ]);
  return scope;
}

const identityOf = (scope: { projectId: string; environmentId: string }, key: Uint8Array) =>
  authenticateStorageGateway(context, {
    scope: null,
    input: { projectId: scope.projectId, environmentId: scope.environmentId, keySha256: key },
  });

it("admits a later storage key version and authorizes only the newest one", async () => {
  const scope = await seedStorageKey(0x41);
  const later = digestOf(0x42);
  // The second version is a new row: the first one stays as the append-only record of what was installed.
  await db
    .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,2,?4,?5)")
    .bind(organizationId, scope.projectId, scope.environmentId, later, TIME)
    .run();
  expect(
    (
      await db
        .prepare(
          "SELECT key_version, lower(hex(key_sha256)) hash FROM storage_gateway_keys WHERE project_id = ?1 ORDER BY key_version",
        )
        .bind(scope.projectId)
        .all()
    ).results,
  ).toEqual([
    { key_version: 1, hash: hexOf(digestOf(0x41)) },
    { key_version: 2, hash: hexOf(later) },
  ]);
  expect(await identityOf(scope, digestOf(0x41))).toBeNull();
  expect(await identityOf(scope, later)).toMatchObject({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  });
});

it("refuses a storage key version of zero or a duplicate of the same version", async () => {
  const scope = await seedStorageKey(0x51);
  await expect(
    db
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,0,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, digestOf(0x52), TIME)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, digestOf(0x53), TIME)
      .run(),
  ).rejects.toThrow();
});

it("refuses a storage key version that skips the next one of its environment", async () => {
  const scope = await seedStorageKey(0x81);
  await expect(
    db
      .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,3,?4,?5)")
      .bind(organizationId, scope.projectId, scope.environmentId, digestOf(0x82), TIME)
      .run(),
  ).rejects.toThrow("Storage gateway key version is not the next one");
});

it("keeps the storage key history append-only after the table is rebuilt", async () => {
  const scope = await seedStorageKey(0x61);
  await expect(
    db
      .prepare(
        "UPDATE storage_gateway_keys SET key_sha256 = ?3 WHERE project_id = ?1 AND environment_id = ?2",
      )
      .bind(scope.projectId, scope.environmentId, digestOf(0x62))
      .run(),
  ).rejects.toThrow("Storage gateway keys are append-only");
  await expect(
    db
      .prepare("DELETE FROM storage_gateway_keys WHERE project_id = ?1")
      .bind(scope.projectId)
      .run(),
  ).rejects.toThrow("Storage gateway keys are append-only");
});
