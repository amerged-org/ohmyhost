import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import type { D1Database } from "../../src/d1-types.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { seedOriginalGateway } from "../gateway/pg-gateway.fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
let pg: TestPostgres, control: TestControl;
const tables = [
  "ses_tenant_receipts",
  "ses_project_mail_resource_receipts",
  "ses_event_destination_receipts",
  "legacy_aws_mail_absence",
];
beforeAll(async () => {
  pg = await startTestPostgres();
  control = await createTestControl();
}, 240000);
afterAll(async () => Promise.all([control?.dispose(), pg?.stop()]));
async function fixture() {
  const f = await gatewayFixture(control);
  await seedOriginalGateway(pg, f);
  const now = new Date().toISOString().replace("Z", "456Z"),
    name = `ohmyho-${f.scope.projectId.toLowerCase()}`,
    arnName = `ohmyho-${newUlid().toLowerCase()}`,
    scope = {
      organization_id: f.scope.organizationId,
      project_id: f.scope.projectId,
      environment_id: f.scope.environmentId,
      operation_id: f.accepted.operationId,
      claim_id: f.accepted.claimId,
      accepted_lifecycle_version: 2147483647,
    };
  return {
    f,
    now,
    tenant: {
      ...scope,
      provider: "aws-ses-v2",
      region: "us-gov-west-1",
      tenant_name: name,
      tenant_id: `Tenant_${newUlid()}`,
      tenant_arn: `arn:aws:ses:eu-central-1:000000000001:tenant/${arnName}/Other_Tenant`,
      sending_status: "enabled",
      reputation_policy_arn: "arn:aws:ses:us-gov-west-1:aws:reputation-policy/standard",
      aws_managed_status: "unknown",
      customer_managed_status: "unknown",
      aggregate_sending_status: "enabled",
      provider_created_at: now,
      reputation_observed_at: now,
      observed_at: now,
      created_at: now,
    },
    resource: {
      ...scope,
      region: "us-iso-east-1",
      configuration_set_name: name,
      configuration_set_arn: `arn:aws:ses:ap-southeast-2:000000000001:configuration-set/${arnName}`,
      tenant_name: name,
      tenant_id: "Other_Tenant",
      associated_at: now,
      observed_at: now,
      created_at: now,
    },
    event: {
      organization_id: scope.organization_id,
      project_id: scope.project_id,
      configuration_set_name: name,
      event_destination_name: "ohmyho-events",
      event_bus_arn: "arn:aws:events:us-gov-west-1:000000000001:event-bus/default",
      matching_event_types: String.raw`["\u0042OUNCE","COMPLAINT","DELIVERY","DELIVERY_DELAY","REJECT","RENDERING_FAILURE","SEND"]`,
      observed_at: now,
    },
    absence: {
      organization_id: scope.organization_id,
      project_id: scope.project_id,
      resource_kind: "ses-event-destination",
      locator: "x".repeat(1024),
      observed_at: now,
      evidence_sha256: Buffer.alloc(32, 0x17),
      recorded_by: "operator:fixture",
      recorded_at: now,
    },
  };
}
async function nativeInsert(table: string, row: Record<string, unknown>, db = control.core) {
  const names = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table}(${names.join(",")})VALUES(${names.map(() => "?").join(",")})`)
    .bind(
      ...Object.values(row).map((v) =>
        typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(v) ? storedTimestamp(v) : v,
      ),
    )
    .run();
}
function originalInsert(table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);
  return pg.pool.query(
    `INSERT INTO ${table}(${names.join(",")})VALUES(${names.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row),
  );
}
async function both(table: string, row: Record<string, unknown>) {
  await originalInsert(table, row);
  await nativeInsert(table, row);
}
async function refuses(table: string, row: Record<string, unknown>) {
  await expect(originalInsert(table, row)).rejects.toThrow();
  await expect(nativeInsert(table, row)).rejects.toThrow();
}
it("preserves all original historical columns, final unknown status, unconstrained ARN relations, escaped JSON and1024-character absence evidence", async () => {
  const x = await fixture();
  for (const table of tables) {
    const native = (
        await control.core.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      ).results.map((r) => r.name),
      source = (
        await pg.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows.map((r) => r.column_name);
    expect(native).toEqual(source);
  }
  for (const [table, row] of [
    [tables[0], x.tenant],
    [tables[1], x.resource],
    [tables[2], x.event],
    [tables[3], x.absence],
  ] as const)
    await both(table as string, row);
  for (const table of tables) {
    const target = await control.core
      .prepare(
        `SELECT * ${table === "legacy_aws_mail_absence" ? ",lower(hex(evidence_sha256)) AS proof_hex" : ""} FROM ${table} WHERE project_id=?`,
      )
      .bind(x.f.scope.projectId)
      .first<Record<string, unknown>>();
    if (!target) throw new Error("Historical target row missing");
    // Original PG timestamp text is read at its full microsecond precision, never through pg's Date truncation.
    const columns = Object.keys(target)
      .filter((key) => key !== "proof_hex")
      .map((key) =>
        key.endsWith("_at")
          ? `to_char(${key} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${key}`
          : key,
      );
    const source = (
      await pg.pool.query(`SELECT ${columns.join(",")} FROM ${table} WHERE project_id=$1`, [
        x.f.scope.projectId,
      ])
    ).rows[0] as Record<string, unknown>;
    if (!target || !source) throw new Error("Historical source row missing");
    if (table === "legacy_aws_mail_absence") {
      target["evidence_sha256"] = target["proof_hex"];
      delete target["proof_hex"];
      source["evidence_sha256"] = (source["evidence_sha256"] as Buffer).toString("hex");
    }
    for (const [key, value] of Object.entries(source))
      if (value instanceof Date) source[key] = storedTimestamp(value.toISOString());
    if (typeof target["matching_event_types"] === "string")
      target["matching_event_types"] = JSON.parse(target["matching_event_types"] as string);
    expect(target).toEqual(source);
  }
  const other = await fixture();
  for (const duplicate of [
    { tenant_arn: x.tenant.tenant_arn },
    { tenant_id: x.tenant.tenant_id },
    { tenant_name: x.tenant.tenant_name },
  ])
    await refuses("ses_tenant_receipts", { ...other.tenant, ...duplicate });
  const target = await control.core
    .prepare(
      "SELECT aws_managed_status,customer_managed_status,accepted_lifecycle_version,tenant_arn FROM ses_tenant_receipts WHERE project_id=?",
    )
    .bind(x.f.scope.projectId)
    .first();
  expect(target).toEqual(
    (
      await pg.pool.query(
        "SELECT aws_managed_status,customer_managed_status,accepted_lifecycle_version,tenant_arn FROM ses_tenant_receipts WHERE project_id=$1",
        [x.f.scope.projectId],
      )
    ).rows[0],
  );
  for (const table of tables) {
    await expect(
      control.core
        .prepare(`UPDATE ${table} SET project_id=project_id WHERE project_id=?`)
        .bind(x.f.scope.projectId)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      pg.pool.query(`UPDATE ${table} SET project_id=project_id WHERE project_id=$1`, [
        x.f.scope.projectId,
      ]),
    ).rejects.toThrow();
    await expect(
      control.core
        .prepare(`DELETE FROM ${table} WHERE project_id=?`)
        .bind(x.f.scope.projectId)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      pg.pool.query(`DELETE FROM ${table} WHERE project_id=$1`, [x.f.scope.projectId]),
    ).rejects.toThrow();
  }
}, 120000);
it("matches original invalid region/ARN/status/int4, exact ordered event list, scope and absence-time refusals with native guards enabled", async () => {
  const x = await fixture();
  for (const bad of [
    { region: "us--west-1" },
    { tenant_arn: x.tenant.tenant_arn + "/extra" },
    { aws_managed_status: "unobserved" },
    { accepted_lifecycle_version: 2147483648 },
    { tenant_name: "ohmyho-8" + "0".repeat(25) },
  ])
    await refuses(tables[0] as string, { ...x.tenant, ...bad });
  await both(tables[0] as string, x.tenant);
  for (const bad of [
    { configuration_set_arn: x.resource.configuration_set_arn + "/extra" },
    { observed_at: "2020-01-01T00:00:00.000Z" },
  ])
    await refuses(tables[1] as string, { ...x.resource, ...bad });
  await both(tables[1] as string, x.resource);
  for (const bad of [
    {
      matching_event_types:
        '[null,"COMPLAINT","DELIVERY","DELIVERY_DELAY","REJECT","RENDERING_FAILURE","SEND"]',
    },
    { event_bus_arn: "arn:aws:events:us-east-1:000000000001:event-bus/other" },
    {
      matching_event_types:
        '["COMPLAINT","BOUNCE","DELIVERY","DELIVERY_DELAY","REJECT","RENDERING_FAILURE","SEND"]',
    },
  ])
    await refuses(tables[2] as string, { ...x.event, ...bad });
  await refuses(tables[3] as string, { ...x.absence, recorded_at: "2020-01-01T00:00:00.000Z" });
  await refuses(tables[3] as string, { ...x.absence, organization_id: newUlid() });
  await refuses(tables[3] as string, { ...x.absence, evidence_sha256: Buffer.alloc(31) });
}, 120000);
it("rejects a populated folded legacy target before any schema or row byte changes, without fabricating absence", async () => {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('local');}}",
    d1Databases: { CORE: "historical-before" },
  });
  try {
    const db = (await engine.getD1Database("CORE")) as unknown as D1Database,
      files = migrationFiles("core"),
      migration = files.find((f) => f.name === "0463_mail_historical_ses_receipts.sql");
    if (!migration) throw new Error("Historical migration missing");
    for (const file of files.filter((f) => f.name !== migration.name))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    await db
      .prepare(
        "INSERT INTO legacy_aws_mail_receipts VALUES(?,?,'ses_tenant','synthetic-retained',?,?)",
      )
      .bind(
        newUlid(),
        newUlid(),
        JSON.stringify({ original: "retained synthetic prototype" }),
        storedTimestamp(new Date().toISOString()),
      )
      .run();
    const before = JSON.stringify({
      schema: (await db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).results,
      rows: (await db.prepare("SELECT * FROM legacy_aws_mail_receipts").all()).results,
    });
    await expect(
      db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql))),
    ).rejects.toThrow();
    const after = JSON.stringify({
      schema: (await db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).results,
      rows: (await db.prepare("SELECT * FROM legacy_aws_mail_receipts").all()).results,
    });
    expect(after).toBe(before);
    for (const name of tables)
      expect(
        await db.prepare("SELECT name FROM sqlite_master WHERE name=?").bind(name).first(),
      ).toBeNull();
  } finally {
    await engine.dispose();
  }
}, 120000);
