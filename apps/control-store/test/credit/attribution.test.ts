import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { createCreditCommands } from "../../src/catalog/credit/index.js";
import { createControlStore } from "../../src/store.js";
import { inventoryDigest } from "../../src/catalog/provisioning/lifecycle-inventory.js";
import type { CatalogContext } from "../../src/catalog/common.js";
import { newUlid } from "../../src/catalog/common.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { endPaid, makePaid } from "../support/credit-fixtures.js";
import { archiveDevEnvironment } from "../support/archived-dev-fixture.js";
import { seedOperation } from "../support/accepted-operation.js";
import { seedCandidate } from "../support/provisioning-cleanup-fixtures.js";
import { STORED_NOW, type SeededProject } from "../support/platform-fixtures.js";
import {
  addBucket,
  addHostname,
  cleanUpScript,
  completeDeletion,
  exec,
  markPlatformDatabase,
  servePgcf,
  transferProject,
} from "./attribution-fixtures.js";
import { newOrganization } from "./support.js";

let control: TestControl;
let credit: ReturnType<typeof createCreditCommands>;
beforeAll(async () => {
  control = await createTestControl();
  const context: CatalogContext = {
    directory: control.core,
    router: new SharedCoreRouter(control.core),
  };
  credit = createCreditCommands((command) => (input) => command(context, input));
}, 120_000);
afterAll(async () => control.dispose());

const run = (sql: string, ...binds: unknown[]) => exec(control, sql, ...binds);
const transfer = (p: SeededProject, at: string) => transferProject(control, p, at);

it("attributes actual PGCF hours once across immutable Dev archive boundaries and keeps shared Prod accounting", async () => {
  const archive = async (p: SeededProject, physical: string) => {
    const at = "2026-10-28T11:30:00.000000Z";
    await makePaid(
      control.core,
      p.organizationId,
      "2099-01-01T00:00:00.000Z",
      new Date().toISOString(),
    );
    const fresh = await archiveDevEnvironment(control.core, p, physical, at);
    await endPaid(control.core, p.organizationId, new Date().toISOString());
    return fresh;
  };
  const isolated = await newOrganization(control);
  const old = await servePgcf(control, isolated, {
    activatedAt: "2026-10-28T09:20:00.000000Z",
    endedAt: "2026-10-28T11:20:00.000000Z",
    assigned: [isolated.devEnvironmentId],
  });
  const current = await servePgcf(control, isolated, {
    activatedAt: "2026-10-28T11:30:00.000000Z",
    assigned: [],
  });
  const fresh = await archive(isolated, current.physical),
    ids = [old.databaseId, current.databaseId];
  expect(
    await credit.resolvePgcfDatabases({ databaseIds: ids, at: "2026-10-28T10:00:00.000Z" }),
  ).toEqual([
    {
      databaseId: old.databaseId,
      organizationId: isolated.organizationId,
      projectId: isolated.projectId,
      environmentId: isolated.devEnvironmentId,
    },
  ]);
  expect(
    await credit.resolvePgcfDatabases({ databaseIds: ids, at: "2026-10-28T11:00:00.000Z" }),
  ).toEqual([
    {
      databaseId: old.databaseId,
      organizationId: isolated.organizationId,
      projectId: isolated.projectId,
      environmentId: old.physical,
    },
  ]);
  expect(
    await credit.resolvePgcfDatabases({ databaseIds: ids, at: "2026-10-28T12:00:00.000Z" }),
  ).toEqual([
    {
      databaseId: current.databaseId,
      organizationId: isolated.organizationId,
      projectId: isolated.projectId,
      environmentId: fresh,
    },
  ]);
  const shared = await newOrganization(control),
    database = await servePgcf(control, shared, { activatedAt: "2026-10-28T09:20:00.000000Z" });
  await archive(shared, database.physical);
  for (const at of [
    "2026-10-28T10:00:00.000Z",
    "2026-10-28T11:00:00.000Z",
    "2026-10-28T12:00:00.000Z",
  ])
    expect(await credit.resolvePgcfDatabases({ databaseIds: [database.databaseId], at })).toEqual([
      {
        databaseId: database.databaseId,
        organizationId: shared.organizationId,
        projectId: shared.projectId,
        environmentId: database.physical,
      },
    ]);
  await expect(
    run(
      "UPDATE dev_environment_restorations SET archived_at='2026-10-28T12:00:00.000000Z' WHERE project_id=?",
      shared.projectId,
    ),
  ).rejects.toThrow("immutable");
});

describe("resolvePgcfDatabases", () => {
  const serve = (p: SeededProject, options: Parameters<typeof servePgcf>[2]) =>
    servePgcf(control, p, options);

  const resolve = (databaseIds: string[], at: string) =>
    credit.resolvePgcfDatabases({ databaseIds, at });

  it("holds the usage cursor at an unresolved Native database creation", async () => {
    const p = await newOrganization(control),
      operationId = newUlid(),
      claimId = newUlid();
    await run(
      `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at)
      VALUES(?1,?2,?3,?4,?5,'provider','name','eu-dev','r256-s500m',?6,'dispatched','2026-10-28T10:31:00.000000Z')`,
      p.organizationId,
      p.projectId,
      p.devEnvironmentId,
      operationId,
      claimId,
      newUlid(),
    );
    expect(
      await credit.readPendingNativeDatabaseCreates({
        from: "2026-10-28T09:00:00.000Z",
        to: "2026-10-28T13:00:00.000Z",
      }),
    ).toEqual({ holdFrom: "2026-10-28T10:00:00.000Z" });
    expect(
      await credit.readPendingNativeDatabaseCreates({
        from: "2026-10-28T11:00:00.000Z",
        to: "2026-10-28T13:00:00.000Z",
      }),
    ).toEqual({ holdFrom: "2026-10-28T11:00:00.000Z" });
    expect(
      await credit.readPendingNativeDatabaseCreates({
        from: "2026-10-28T09:00:00.000Z",
        to: "2026-10-28T10:00:00.000Z",
      }),
    ).toEqual({ holdFrom: null });
    await run(
      "UPDATE native_auth_database_operations SET state='observed',provider_operation_id='op',database_id='database' WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      p.organizationId,
      p.projectId,
      operationId,
    );
    expect(
      await credit.readPendingNativeDatabaseCreates({
        from: "2026-10-28T09:00:00.000Z",
        to: "2026-10-28T13:00:00.000Z",
      }),
    ).toEqual({ holdFrom: null });
  });

  it("attributes a Native Auth database to its project owner without inventing an environment", async () => {
    const p = await newOrganization(control),
      databaseId = "d1234567890123456789";
    await run(
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from)
      VALUES(?1,?2,'provider',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T09:20:00.000000Z','2026-10-28T09:00:00.000000Z')`,
      p.organizationId,
      p.projectId,
      databaseId,
    );
    const resources = createControlStore(control.bindings).identity;
    expect(
      await resources.readNativeAuthTarget({
        organizationId: p.organizationId,
        projectId: p.projectId,
      }),
    ).toMatchObject({ databaseId, regionId: "eu-dev", targetVersion: 1 });
    expect(await resolve([databaseId], "2026-10-28T09:00:00.000Z")).toEqual([]);
    expect(await resolve([databaseId], "2026-10-28T10:00:00.000Z")).toEqual([
      {
        databaseId,
        organizationId: p.organizationId,
        projectId: p.projectId,
        resourceKind: "native_auth_database",
      },
    ]);
    await expect(
      control.core
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId)
        .run(),
    ).rejects.toThrow("native auth deletion inventory unavailable");
    await expect(transfer(p, "2026-10-28T11:30:00.000000Z")).rejects.toThrow(
      "native auth custody transfer unavailable",
    );
    expect(
      await resources.readNativeAuthTarget({
        organizationId: p.organizationId,
        projectId: p.projectId,
      }),
    ).toMatchObject({ databaseId });
    expect(await resolve([databaseId], "2026-10-28T12:00:00.000Z")).toEqual([
      {
        databaseId,
        organizationId: p.organizationId,
        projectId: p.projectId,
        resourceKind: "native_auth_database",
      },
    ]);

    // Native bills the actual resource's first partial hour even when custody started during that hour.
    const moved = await newOrganization(control);
    const receiver = await transfer(moved, "2026-10-28T10:15:00.000000Z");
    const firstHourDatabase = "e1234567890123456789";
    await run(
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from)
      VALUES(?1,?2,'provider',?3,'operation','eu-dev','r256-s500m',1,'2026-10-28T10:16:00.000000Z','2026-10-28T10:00:00.000000Z')`,
      receiver,
      moved.projectId,
      firstHourDatabase,
    );
    const nativeOwner = [
      {
        databaseId: firstHourDatabase,
        organizationId: receiver,
        projectId: moved.projectId,
        resourceKind: "native_auth_database",
      },
    ];
    expect(await resolve([firstHourDatabase], "2026-10-28T09:00:00.000Z")).toEqual([]);
    expect(await resolve([firstHourDatabase], "2026-10-28T10:00:00.000Z")).toEqual(nativeOwner);
    expect(await resolve([firstHourDatabase], "2026-10-28T11:00:00.000Z")).toEqual(nativeOwner);
    // The final partial hour belongs to the same owner; an ended epoch must not erase real usage.
    await run(
      "UPDATE native_auth_database_targets SET ended_at='2026-10-28T10:45:00.000000Z' WHERE database_id=?1",
      firstHourDatabase,
    );
    await run(
      "UPDATE billing_epochs SET ended_at='2026-10-28T10:45:00.000000Z' WHERE organization_id=?1 AND project_id=?2 AND ended_at IS NULL",
      receiver,
      moved.projectId,
    );
    expect(await resolve([firstHourDatabase], "2026-10-28T10:00:00.000Z")).toEqual(nativeOwner);
    expect(await resolve([firstHourDatabase], "2026-10-28T11:00:00.000Z")).toEqual([]);
  });

  it("resolves a database to its owner for every hour from the first full hour after activation", async () => {
    const p = await newOrganization(control);
    const shared = await serve(p, { activatedAt: "2026-10-28T09:20:00.000000Z" });
    // both environments share the data: the physical environment is the environment of the line
    const owner = {
      databaseId: shared.databaseId,
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: shared.physical,
    };
    expect(await resolve([shared.databaseId], "2026-10-28T10:00:00.000Z")).toEqual([owner]);
    expect(await resolve([shared.databaseId], "2026-10-29T03:00:00.000Z")).toEqual([owner]);
    // the hour of the activation is not billable, the hours before it do not exist
    expect(await resolve([shared.databaseId], "2026-10-28T09:00:00.000Z")).toEqual([]);
    expect(await resolve([shared.databaseId], "2026-10-28T08:00:00.000Z")).toEqual([]);
    // the same instant in any precision
    expect(await resolve([shared.databaseId], "2026-10-28T10:00Z")).toEqual([owner]);
  });

  it("names the logical environment when exactly one points at the database all hour", async () => {
    const p = await newOrganization(control);
    const dev = await serve(p, {
      activatedAt: "2026-10-28T09:20:00.000000Z",
      assigned: [p.devEnvironmentId],
    });
    expect(await resolve([dev.databaseId], "2026-10-28T10:00:00.000Z")).toEqual([
      {
        databaseId: dev.databaseId,
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
      },
    ]);

    // prod is pointed away from the shared data at 10:30: within hour 10 only dev is stable, and from hour 11 on
    const q = await newOrganization(control);
    const both = await serve(q, { activatedAt: "2026-10-28T09:20:00.000000Z" });
    const elsewhere = newUlid();
    await run(
      "INSERT INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
      q.organizationId,
      q.projectId,
      elsewhere,
      STORED_NOW,
    );
    await run(
      "INSERT INTO environment_data_assignments(organization_id, project_id, environment_id, data_environment_id, assignment_version, assigned_at) VALUES (?1, ?2, ?3, ?4, 2, '2026-10-28T10:30:00.000000Z')",
      q.organizationId,
      q.projectId,
      q.prodEnvironmentId,
      elsewhere,
    );
    const only = (environmentId: string) => [
      {
        databaseId: both.databaseId,
        organizationId: q.organizationId,
        projectId: q.projectId,
        environmentId,
      },
    ];
    expect(await resolve([both.databaseId], "2026-10-28T10:00:00.000Z")).toEqual(
      only(q.devEnvironmentId),
    );
    expect(await resolve([both.databaseId], "2026-10-28T11:00:00.000Z")).toEqual(
      only(q.devEnvironmentId),
    );
    expect(await resolve([both.databaseId], "2026-10-28T09:00:00.000Z")).toEqual([]);
  });

  it("bills the hour in which the database stops serving, and no hour after it", async () => {
    const p = await newOrganization(control);
    const database = await serve(p, {
      activatedAt: "2026-10-28T09:20:00.000000Z",
      endedAt: "2026-10-28T12:30:00.000000Z",
    });
    const at = (hour: number) =>
      resolve([database.databaseId], `2026-10-28T${String(hour).padStart(2, "0")}:00:00.000Z`);
    expect(await at(11)).toHaveLength(1);
    expect(await at(12)).toHaveLength(1);
    expect(await at(13)).toEqual([]);
    // a database that stopped exactly on the hour does not serve the next hour
    const exact = await serve(p, {
      activatedAt: "2026-10-27T09:20:00.000000Z",
      endedAt: "2026-10-27T12:00:00.000000Z",
    });
    expect(await resolve([exact.databaseId], "2026-10-27T11:00:00.000Z")).toHaveLength(1);
    expect(await resolve([exact.databaseId], "2026-10-27T12:00:00.000Z")).toEqual([]);
  });

  it("leaves out platform databases, unknown databases and hours that two owners share", async () => {
    const p = await newOrganization(control);
    const platform = await serve(p, { activatedAt: "2026-10-28T09:20:00.000000Z" });
    await markPlatformDatabase(control, platform);
    expect(await resolve([platform.databaseId], "2026-10-28T10:00:00.000Z")).toEqual([]);

    // the same database id served by a second organization from 10:30 on: hour 10 is split, hour 11 is the new owner's
    const first = await newOrganization(control);
    const second = await newOrganization(control);
    const one = await serve(first, {
      activatedAt: "2026-10-28T08:20:00.000000Z",
      endedAt: "2026-10-28T10:30:00.000000Z",
    });
    await serve(second, {
      activatedAt: "2026-10-28T10:30:00.000000Z",
      databaseId: one.databaseId,
    });
    expect(await resolve([one.databaseId], "2026-10-28T09:00:00.000Z")).toEqual([
      expect.objectContaining({ organizationId: first.organizationId }),
    ]);
    expect(await resolve([one.databaseId], "2026-10-28T10:00:00.000Z")).toEqual([]);
    expect(await resolve([one.databaseId], "2026-10-28T11:00:00.000Z")).toEqual([
      expect.objectContaining({ organizationId: second.organizationId }),
    ]);
    expect(await resolve(["dunknownunknownunkno"], "2026-10-28T10:00:00.000Z")).toEqual([]);
  });

  it("resolves many databases in one call and refuses malformed input", async () => {
    const p = await newOrganization(control);
    const a = await serve(p, { activatedAt: "2026-10-28T09:20:00.000000Z" });
    const q = await newOrganization(control);
    const b = await serve(q, { activatedAt: "2026-10-28T09:20:00.000000Z" });
    const rows = await resolve(
      [b.databaseId, a.databaseId, a.databaseId, "dnobodynobodynobodyn"],
      "2026-10-28T10:00:00.000Z",
    );
    expect(rows.map((row) => row.databaseId)).toEqual([a.databaseId, b.databaseId].sort());
    expect(await resolve([], "2026-10-28T10:00:00.000Z")).toEqual([]);

    const ids = Array.from({ length: 101 }, (_, index) => `d${String(index).padStart(19, "z")}`);
    await expect(resolve(ids, "2026-10-28T10:00:00.000Z")).rejects.toBeInstanceOf(ZodError);
    await expect(resolve([a.databaseId], "2026-10-28T10:30:00.000Z")).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      credit.resolvePgcfDatabases({ databaseIds: [a.databaseId] }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("listR2Buckets", () => {
  const bucket = (
    p: SeededProject,
    environmentId: string,
    options?: Parameters<typeof addBucket>[3],
  ) => addBucket(control, p, environmentId, options);
  const list = async (day: string, mine: SeededProject[]) => {
    const names = new Set(mine.map((p) => p.projectId.toLowerCase()));
    const rows = [];
    let after: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof credit.listR2Buckets>> = await credit.listR2Buckets({
        day,
        after,
        limit: 1000,
      });
      rows.push(...page.buckets);
      after = page.next;
    } while (after !== null);
    return rows.filter((row) => names.has(row.projectId.toLowerCase()));
  };

  it("lists every bucket that existed during the day with its owner, project and environment", async () => {
    const p = await newOrganization(control);
    const dev = await bucket(p, p.devEnvironmentId);
    const prod = await bucket(p, p.prodEnvironmentId, { createdAt: "2026-10-30T09:00:00.000000Z" });
    const row = (bucketName: string, environmentId: string) => ({
      bucketName,
      jurisdiction: "eu",
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId,
    });
    expect(await list("2026-10-29T00:00:00.000Z", [p])).toEqual([row(dev, p.devEnvironmentId)]);
    // a bucket created during the day exists in it; one created at the next midnight does not
    expect(await list("2026-10-30T00:00:00.000Z", [p])).toEqual(
      [row(dev, p.devEnvironmentId), row(prod, p.prodEnvironmentId)].sort((a, b) =>
        a.bucketName < b.bucketName ? -1 : 1,
      ),
    );
    expect(await list("2026-10-27T00:00:00.000Z", [p])).toEqual([]);
  });

  it("pages in jurisdiction and name order with an opaque cursor", async () => {
    const projects = [await newOrganization(control), await newOrganization(control)];
    for (const p of projects) {
      await bucket(p, p.prodEnvironmentId, { jurisdiction: "us" });
      await bucket(p, p.devEnvironmentId, { jurisdiction: "eu" });
    }
    const day = "2026-10-30T00:00:00.000Z";
    const everything = await list(day, projects);
    expect(everything).toHaveLength(4);
    const order = everything.map((row) => `${row.jurisdiction}/${row.bucketName}`);
    expect(order).toEqual([...order].sort());
    expect(everything.map((row) => row.jurisdiction)).toEqual(["eu", "eu", "us", "us"]);

    // walk the whole list two buckets at a time: no bucket twice and none missing
    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof credit.listR2Buckets>> = await credit.listR2Buckets({
        day,
        after,
        limit: 2,
      });
      expect(page.buckets.length).toBeLessThanOrEqual(2);
      seen.push(...page.buckets.map((row) => `${row.jurisdiction}/${row.bucketName}`));
      after = page.next;
      pages += 1;
    } while (after !== null);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const key of order) expect(seen).toContain(key);
    expect(pages).toBeGreaterThan(1);
  });

  it("belongs to the owner at the end of the day and ends with the deleted project", async () => {
    const p = await newOrganization(control);
    const name = await bucket(p, p.devEnvironmentId);
    const receiver = await transfer(p, "2026-10-29T12:00:00.000000Z");
    expect(await list("2026-10-28T00:00:00.000Z", [p])).toEqual([
      expect.objectContaining({ bucketName: name, organizationId: p.organizationId }),
    ]);
    // the receiving organization holds the project when 2026-10-29 closes
    expect(await list("2026-10-29T00:00:00.000Z", [p])).toEqual([
      expect.objectContaining({ bucketName: name, organizationId: receiver }),
    ]);
    expect(await list("2026-10-30T00:00:00.000Z", [p])).toEqual([
      expect.objectContaining({ bucketName: name, organizationId: receiver }),
    ]);

    await run(
      "UPDATE projects SET lifecycle_state = 'deleted', updated_at = '2026-10-30T12:00:00.000000Z' WHERE organization_id = ?1 AND project_id = ?2",
      receiver,
      p.projectId,
    );
    // deleted during 2026-10-30 it still stored data that day, and nothing the day after
    expect(await list("2026-10-30T00:00:00.000Z", [p])).toHaveLength(1);
    expect(await list("2026-10-31T00:00:00.000Z", [p])).toEqual([]);
  });

  it("bills the day a deletion completes through the real completion, and no later day", async () => {
    const p = await newOrganization(control);
    const name = await bucket(p, p.devEnvironmentId);
    await completeDeletion(control, p, "2026-10-30T12:00:00.000Z");
    expect(await list("2026-10-30T00:00:00.000Z", [p])).toEqual([
      expect.objectContaining({ bucketName: name, organizationId: p.organizationId }),
    ]);
    expect(await list("2026-10-31T00:00:00.000Z", [p])).toEqual([]);
  });

  it("refuses a day that is not a UTC midnight and a page outside its bounds", async () => {
    const page = (input: Record<string, unknown>) =>
      credit.listR2Buckets({ day: "2026-10-30T00:00:00.000Z", after: null, limit: 10, ...input });
    await expect(page({ day: "2026-10-30T01:00:00.000Z" })).rejects.toBeInstanceOf(ZodError);
    await expect(page({ limit: 0 })).rejects.toBeInstanceOf(ZodError);
    await expect(page({ limit: 1001 })).rejects.toBeInstanceOf(ZodError);
    await expect(page({ after: undefined })).rejects.toBeInstanceOf(ZodError);
    await expect(page({ extra: true })).rejects.toBeInstanceOf(ZodError);
  });
});

describe("readResources", () => {
  const script = (p: SeededProject, environmentId: string, stagedAt: string) =>
    seedCandidate(p, { environmentId, stagedAt });
  const cleanup = (
    p: SeededProject,
    receiptId: string,
    environmentId: string,
    observedAt: string,
  ) => cleanUpScript(control, p, receiptId, environmentId, observedAt);
  const hostname = (p: SeededProject, name: string, provisioned: string, deletedAt?: string) =>
    addHostname(control, p, name, provisioned, deletedAt);
  const read = async (day: string, mine: SeededProject[]) => {
    const ids = new Set(mine.map((p) => p.projectId));
    const rows = [];
    let after: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof credit.readResources>> = await credit.readResources({
        day,
        after,
        limit: 1000,
      });
      rows.push(...page.rows);
      after = page.next;
    } while (after !== null);
    return rows.filter((row) => ids.has(row.projectId));
  };

  it("counts the scripts staged and not cleaned up when the day closes, per environment", async () => {
    const p = await newOrganization(control);
    await script(p, p.devEnvironmentId, "2026-10-28T10:00:00.000000Z");
    const superseded = await script(p, p.devEnvironmentId, "2026-10-28T11:00:00.000000Z");
    await script(p, p.prodEnvironmentId, "2026-10-29T08:00:00.000000Z");
    await script(p, p.prodEnvironmentId, "2026-10-31T08:00:00.000000Z");
    await cleanup(
      p,
      superseded.candidateReceiptId,
      p.devEnvironmentId,
      "2026-10-29T12:00:00.000000Z",
    );
    const row = (environmentId: string, scripts: number) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId,
      scripts,
      hostnames: 0,
    });
    // 2026-10-28: both dev scripts; the superseded one is still there when the day closes
    expect(await read("2026-10-28T00:00:00.000Z", [p])).toEqual([row(p.devEnvironmentId, 2)]);
    // 2026-10-29 closes after the cleanup, and the prod script was staged that day
    expect(await read("2026-10-29T00:00:00.000Z", [p])).toEqual(
      [row(p.devEnvironmentId, 1), row(p.prodEnvironmentId, 1)].sort((a, b) =>
        a.environmentId < b.environmentId ? -1 : 1,
      ),
    );
    // the script staged on 2026-10-31 does not exist yet on 2026-10-30
    expect(await read("2026-10-30T00:00:00.000Z", [p])).toHaveLength(2);
    expect(await read("2026-10-27T00:00:00.000Z", [p])).toEqual([]);
  });

  it("leaves out the scripts that a stalled project deletion already removed", async () => {
    const p = await newOrganization(control);
    const removed = await script(p, p.prodEnvironmentId, "2026-10-28T10:00:00.000000Z");
    await script(p, p.prodEnvironmentId, "2026-10-28T11:00:00.000000Z");
    // the deletion stalls after it removed one script; the project is still owned until it completes
    await run(
      "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = lifecycle_version + 1 WHERE organization_id = ?1 AND project_id = ?2",
      p.organizationId,
      p.projectId,
    );
    const operationId = await seedOperation(p, { state: "running" });
    const locator = `ohmyho-production/${removed.script}`;
    const digest = await inventoryDigest("cloudflare", "wfp-script", locator);
    await run(
      "INSERT INTO run_resource_inventory(resource_record_id, organization_id, project_id, operation_id, provider, resource_kind, external_ref_hash, recorded_at, cleanup_locator) VALUES (?1, ?2, ?3, ?4, 'cloudflare', 'wfp-script', ?5, ?6, ?7)",
      newUlid(),
      p.organizationId,
      p.projectId,
      operationId,
      digest,
      "2026-10-29T10:00:00.000000Z",
      `encoded/${Buffer.from(locator).toString("base64url")}`,
    );
    await run(
      "INSERT INTO run_cleanup_attempts(cleanup_attempt_id, organization_id, project_id, operation_id, provider, resource_kind, external_ref_hash, outcome, attempted_at) VALUES (?1, ?2, ?3, ?4, 'cloudflare', 'wfp-script', ?5, 'removed', ?6)",
      newUlid(),
      p.organizationId,
      p.projectId,
      operationId,
      digest,
      "2026-10-29T12:00:00.000000Z",
    );
    const alive = (environmentId: string, scripts: number) => ({
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId,
      scripts,
      hostnames: 0,
    });
    // the removal happened before 29 Oct closed, so only the other script is still there
    expect(await read("2026-10-29T00:00:00.000Z", [p])).toEqual([alive(p.prodEnvironmentId, 1)]);
    // on 28 Oct the removal had not happened yet
    expect(await read("2026-10-28T00:00:00.000Z", [p])).toEqual([alive(p.prodEnvironmentId, 2)]);
  });

  it("leaves a project out of the rows once a stalled deletion has removed its only script", async () => {
    const p = await newOrganization(control);
    const removed = await script(p, p.prodEnvironmentId, "2026-10-28T10:00:00.000000Z");
    await run(
      "UPDATE projects SET lifecycle_state = 'deleting', lifecycle_version = lifecycle_version + 1 WHERE organization_id = ?1 AND project_id = ?2",
      p.organizationId,
      p.projectId,
    );
    const operationId = await seedOperation(p, { state: "running" });
    const locator = `ohmyho-production/${removed.script}`;
    const digest = await inventoryDigest("cloudflare", "wfp-script", locator);
    await run(
      "INSERT INTO run_resource_inventory(resource_record_id, organization_id, project_id, operation_id, provider, resource_kind, external_ref_hash, recorded_at, cleanup_locator) VALUES (?1, ?2, ?3, ?4, 'cloudflare', 'wfp-script', ?5, ?6, ?7)",
      newUlid(),
      p.organizationId,
      p.projectId,
      operationId,
      digest,
      "2026-10-29T10:00:00.000000Z",
      `encoded/${Buffer.from(locator).toString("base64url")}`,
    );
    await run(
      "INSERT INTO run_cleanup_attempts(cleanup_attempt_id, organization_id, project_id, operation_id, provider, resource_kind, external_ref_hash, outcome, attempted_at) VALUES (?1, ?2, ?3, ?4, 'cloudflare', 'wfp-script', ?5, 'removed', ?6)",
      newUlid(),
      p.organizationId,
      p.projectId,
      operationId,
      digest,
      "2026-10-29T12:00:00.000000Z",
    );
    // the script was billed on 28 Oct; once its removal is counted, the project has nothing to bill on 29 Oct
    expect(await read("2026-10-28T00:00:00.000Z", [p])).toEqual([
      {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
        scripts: 1,
        hostnames: 0,
      },
    ]);
    expect(await read("2026-10-29T00:00:00.000Z", [p])).toEqual([]);
  });

  it("counts custom hostnames in the prod environment while they are provisioned and not deleted", async () => {
    const p = await newOrganization(control);
    await hostname(
      p,
      `shop-${p.projectId.toLowerCase()}.example.com`,
      "2026-10-29T09:00:00.000000Z",
    );
    const gone = await newOrganization(control);
    await hostname(
      gone,
      `old-${gone.projectId.toLowerCase()}.example.com`,
      "2026-10-27T09:00:00.000000Z",
      "2026-10-29T10:00:00.000000Z",
    );
    const hostnames = (project: SeededProject, count: number) => ({
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
      scripts: 0,
      hostnames: count,
    });
    expect(await read("2026-10-28T00:00:00.000Z", [p, gone])).toEqual([hostnames(gone, 1)]);
    // deleted at 10:00 on 2026-10-29: gone when the day closes
    expect(await read("2026-10-29T00:00:00.000Z", [p, gone])).toEqual([hostnames(p, 1)]);
    expect(await read("2026-10-30T00:00:00.000Z", [p, gone])).toEqual([hostnames(p, 1)]);
  });

  it("adds scripts and hostnames of one environment, follows a transfer and skips deleted projects", async () => {
    const p = await newOrganization(control);
    await script(p, p.prodEnvironmentId, "2026-10-28T10:00:00.000000Z");
    await hostname(
      p,
      `both-${p.projectId.toLowerCase()}.example.com`,
      "2026-10-28T10:00:00.000000Z",
    );
    expect(await read("2026-10-28T00:00:00.000Z", [p])).toEqual([
      {
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
        scripts: 1,
        hostnames: 1,
      },
    ]);
    const receiver = await transfer(p, "2026-10-29T12:00:00.000000Z");
    const owners = async (day: string) => (await read(day, [p])).map((row) => row.organizationId);
    expect(await owners("2026-10-28T00:00:00.000Z")).toEqual([p.organizationId]);
    expect(await owners("2026-10-29T00:00:00.000Z")).toEqual([receiver]);

    await run(
      "UPDATE projects SET lifecycle_state = 'deleted', updated_at = '2026-10-30T12:00:00.000000Z' WHERE organization_id = ?1 AND project_id = ?2",
      receiver,
      p.projectId,
    );
    // alive when 2026-10-29 closes, deleted before 2026-10-30 closes
    expect(await owners("2026-10-29T00:00:00.000Z")).toEqual([receiver]);
    expect(await owners("2026-10-30T00:00:00.000Z")).toEqual([]);
  });

  it("pages in organization, project and environment order", async () => {
    const projects = [await newOrganization(control), await newOrganization(control)];
    for (const p of projects) {
      await script(p, p.devEnvironmentId, "2026-10-28T10:00:00.000000Z");
      await script(p, p.prodEnvironmentId, "2026-10-28T10:00:00.000000Z");
    }
    const keys: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof credit.readResources>> = await credit.readResources({
        day: "2026-10-28T00:00:00.000Z",
        after,
        limit: 3,
      });
      expect(page.rows.length).toBeLessThanOrEqual(3);
      keys.push(
        ...page.rows.map((row) => `${row.organizationId}/${row.projectId}/${row.environmentId}`),
      );
      after = page.next;
      pages += 1;
    } while (after !== null);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(pages).toBeGreaterThan(1);
    for (const p of projects) {
      expect(keys).toContain(`${p.organizationId}/${p.projectId}/${p.devEnvironmentId}`);
      expect(keys).toContain(`${p.organizationId}/${p.projectId}/${p.prodEnvironmentId}`);
    }

    await expect(
      credit.readResources({ day: "2026-10-28T06:00:00.000Z", after: null, limit: 10 }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
