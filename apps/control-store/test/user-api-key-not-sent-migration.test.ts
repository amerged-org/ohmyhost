import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { D1Database } from "../src/d1-types.js";
import { activateTestCore, migrationFiles, type TestControl } from "./support/control-d1.js";
import { coreBootstrapWorker, initializeCoreFixture } from "./support/core-bootstrap.js";
import { splitStatements } from "./support/sql.js";
import { seedProject, type SeededProject } from "./support/platform-fixtures.js";

const MIGRATION = new URL("../migrations/core/0921_user_api_key_not_sent.sql", import.meta.url);

let miniflare: Miniflare;
let core: D1Database;
let project: SeededProject;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: coreBootstrapWorker,
    d1Databases: { CONTROL_CORE: "core-0921" },
  });
  // The schema before migration 0921, with the rows a live Core holds at that point.
  core = await initializeCoreFixture(
    miniflare,
    () => migrationFiles("core").filter((file) => file.name < "0921_"),
    activateTestCore,
  );
  const control = {
    core,
    bindings: { CONTROL_CORE: core },
    directory: core,
    shards: { CONTROL_SHARD_0000: core, CONTROL_SHARD_0001: core },
    dispose: () => miniflare.dispose(),
  } as unknown as TestControl;
  project = await seedProject(control);
  const insert = (
    requestId: string,
    idempotency: number,
    providerKeyId: string | null,
    failureCode: string | null,
    finishedAt: string | null,
  ) =>
    core
      .prepare(
        "INSERT INTO user_api_key_requests(organization_id, request_id, workos_user_id, workos_organization_id, idempotency_sha256, request_sha256, name, permissions, requested_at, expires_at, provider_key_id, failure_code, finished_at) VALUES(?1, ?2, 'user_0001', 'org_0001', ?3, ?4, 'ci key', '[\"auth:read\"]', '2026-10-28T10:00:00.000000Z', NULL, ?5, ?6, ?7)",
      )
      .bind(
        project.organizationId,
        requestId,
        new Uint8Array(32).fill(idempotency),
        new Uint8Array(32).fill(idempotency + 1),
        providerKeyId,
        failureCode,
        finishedAt,
      )
      .run();
  await insert(
    "01ARZ3NDEKTSV4RRFFQ69G5FA1",
    1,
    "api_key_created01",
    null,
    "2026-10-28T10:01:00.000000Z",
  );
  await insert(
    "01ARZ3NDEKTSV4RRFFQ69G5FA2",
    2,
    null,
    "KEY_PERMISSIONS_UNAVAILABLE",
    "2026-10-28T10:02:00.000000Z",
  );
  await insert("01ARZ3NDEKTSV4RRFFQ69G5FA3", 3, null, null, null);
}, 120_000);
afterAll(async () => miniflare.dispose());

const rows = async () =>
  (
    await core
      .prepare(
        "SELECT request_id, name, provider_key_id, failure_code, requested_at, finished_at FROM user_api_key_requests WHERE organization_id = ?1 ORDER BY request_id",
      )
      .bind(project.organizationId)
      .all()
  ).results;

it("rebuilds the request table with every row and admits the not-sent rejection", async () => {
  const before = await rows();
  expect(before).toHaveLength(3);
  await core.batch(
    splitStatements(readFileSync(MIGRATION, "utf8")).map((statement) => core.prepare(statement)),
  );
  expect(await rows()).toEqual(before);
  await expect(
    core
      .prepare(
        "UPDATE user_api_key_requests SET failure_code = 'KEY_CREATION_NOT_SENT', finished_at = '2026-10-28T10:03:00.000000Z' WHERE organization_id = ?1 AND request_id = '01ARZ3NDEKTSV4RRFFQ69G5FA3'",
      )
      .bind(project.organizationId)
      .run(),
  ).resolves.toMatchObject({ success: true });
  await expect(
    core
      .prepare(
        "UPDATE user_api_key_requests SET failure_code = 'KEY_BOGUS', finished_at = '2026-10-28T10:04:00.000000Z' WHERE organization_id = ?1 AND request_id = '01ARZ3NDEKTSV4RRFFQ69G5FA3'",
      )
      .bind(project.organizationId)
      .run(),
  ).rejects.toThrow();
});
