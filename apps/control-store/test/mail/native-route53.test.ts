import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import type { D1Database } from "../../src/d1-types.js";
import { mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { legacyMailResourcesStatement } from "../../src/catalog/mail/legacy-resources.js";
import { storedTimestamp } from "../../src/timestamps.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
const nameservers = [
  "ns-1.awsdns-1.com",
  "ns-22.awsdns-22.net",
  "ns-333.awsdns-33.org",
  "ns-4444.awsdns-99.co.uk",
];
async function nativeInsert(table: string, row: Record<string, unknown>, db = control.core) {
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(
      ...Object.values(row).map((v) =>
        typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(v) ? storedTimestamp(v) : v,
      ),
    )
    .run();
}
async function fixture() {
  const f = await mailFixture(control),
    now = f.now.replace("Z", "456Z"),
    name = `ohmyho-${f.scope.projectId.toLowerCase()}`,
    scope = {
      organization_id: f.scope.organizationId,
      project_id: f.scope.projectId,
      environment_id: f.scope.environmentId,
      operation_id: f.fixture.accepted.operationId,
      claim_id: f.fixture.accepted.claimId,
      accepted_lifecycle_version: 1,
    };
  await f.insert("ses_tenant_receipts", {
    ...scope,
    provider: "aws-ses-v2",
    region: "eu-central-1",
    tenant_name: name,
    tenant_id: `Tenant_${newUlid()}`,
    tenant_arn: `arn:aws:ses:eu-central-1:000000000001:tenant/${name}/Tenant`,
    sending_status: "enabled",
    reputation_policy_arn: "arn:aws:ses:eu-central-1:aws:reputation-policy/standard",
    aws_managed_status: "unknown",
    customer_managed_status: "unknown",
    aggregate_sending_status: "enabled",
    provider_created_at: now,
    reputation_observed_at: now,
    observed_at: now,
    created_at: now,
  });
  await f.insert("ses_project_mail_resource_receipts", {
    ...scope,
    region: "eu-central-1",
    configuration_set_name: name,
    configuration_set_arn: `arn:aws:ses:eu-central-1:000000000001:configuration-set/${name}`,
    tenant_name: name,
    tenant_id: "Tenant",
    associated_at: now,
    observed_at: now,
    created_at: now,
  });
  const domain = f.domain,
    records = [
      {
        type: "CNAME",
        name: `${"a".repeat(32)}._domainkey.${domain}`,
        value: `${"a".repeat(32)}.dkim.amazonses.com`,
      },
      {
        type: "CNAME",
        name: `${"b".repeat(64)}._domainkey.extra.adomainkey.${domain}`,
        value: `${"b".repeat(64)}.dkim.amazonses.com`,
      },
      {
        type: "CNAME",
        name: `${"c".repeat(40)}._domainkey.${domain}`,
        value: `${"c".repeat(40)}.dkim.amazonses.com`,
      },
    ],
    change = {
      ...scope,
      domain,
      caller_reference: `ohmyho-${f.scope.projectId}`,
      hosted_zone_id: `Z${newUlid()}`,
      records: JSON.stringify(records),
      change_id: `C${newUlid()}`,
      submitted_at: now,
      observed_at: now,
      created_at: now,
    };
  return {
    f,
    now,
    records,
    change,
    receipt: {
      organization_id: scope.organization_id,
      project_id: scope.project_id,
      change_id: change.change_id,
      insync_at: now,
      identity_verified_at: now,
      observed_at: now,
      created_at: now,
    },
  };
}
/** A PostgreSQL array keeps its lower bound; the Core stores it as `{lowerBound, values}`. */
async function insertChange(
  x: Awaited<ReturnType<typeof fixture>>,
  lowerBound: number,
  values: (string | null)[],
  override: Record<string, unknown> = {},
  refuse = false,
) {
  const row = { ...x.change, ...override, name_servers: JSON.stringify({ lowerBound, values }) };
  if (refuse) await expect(nativeInsert("route53_dkim_change_receipts", row)).rejects.toThrow();
  else await nativeInsert("route53_dkim_change_receipts", row);
}
it("preserves all 22 original fields, array bounds, index-only checks, LIKE underscore semantics and microseconds", async () => {
  for (const lowerBound of [1, 0, 5]) {
    const x = await fixture(),
      values =
        lowerBound === 0
          ? ['opaque,quoted "outside"', ...nameservers.slice(1)]
          : lowerBound === 5
            ? ["outside", "outside", "outside", "outside"]
            : nameservers;
    await insertChange(x, lowerBound, values);
    await nativeInsert("route53_dkim_receipts", x.receipt);
    for (const [table, expected] of [
      [
        "route53_dkim_change_receipts",
        { ...x.change, records: x.records, name_servers: { lowerBound, values } },
      ],
      ["route53_dkim_receipts", x.receipt],
    ] as const) {
      const target = await control.core
        .prepare(`SELECT * FROM ${table} WHERE project_id=?`)
        .bind(x.f.scope.projectId)
        .first<Record<string, unknown>>();
      if (!target) throw new Error("Missing DKIM target");
      for (const c of ["name_servers", "records"])
        if (typeof target[c] === "string") target[c] = JSON.parse(target[c] as string);
      // All fields return as stored, with the microseconds of every observation time.
      expect(target).toEqual(expected);
      await expect(
        control.core
          .prepare(`UPDATE ${table} SET project_id=project_id WHERE project_id=?`)
          .bind(x.f.scope.projectId)
          .run(),
      ).rejects.toThrow("append-only");
      await expect(
        control.core
          .prepare(`DELETE FROM ${table} WHERE project_id=?`)
          .bind(x.f.scope.projectId)
          .run(),
      ).rejects.toThrow("append-only");
    }
  }
}, 120000);
it("refuses malformed labels/nameservers/record keys/value/order/scope and observation-time refusals", async () => {
  const x = await fixture();
  for (const bad of [
    { domain: "bad-.example.com" },
    { domain: "example.c0m" },
    { domain: `${"x".repeat(64)}.example.com` },
    { hosted_zone_id: "z12345678" },
    { caller_reference: "different" },
  ])
    await insertChange(x, 1, nameservers, bad, true);
  for (const values of [
    [...nameservers.slice(0, 3), nameservers[0] as string],
    ["ns-12345.awsdns-1.com", ...nameservers.slice(1)],
    [null, ...nameservers.slice(1)],
    nameservers.slice(1),
  ])
    await insertChange(x, 1, values, {}, true);
  // A multidimensional array is not a list of four name servers.
  await expect(
    nativeInsert("route53_dkim_change_receipts", {
      ...x.change,
      name_servers: JSON.stringify({
        lowerBound: 1,
        values: [nameservers.slice(0, 2), nameservers.slice(2)],
      }),
    }),
  ).rejects.toThrow();
  for (const records of [
    [{ ...x.records[0], extra: true }, ...x.records.slice(1)],
    [x.records[0], x.records[0], x.records[2]],
    [{ ...x.records[0], value: `${"a".repeat(31)}.dkim.amazonses.com` }, ...x.records.slice(1)],
    [{ ...x.records[0], name: (x.records[0]?.name ?? "").toUpperCase() }, ...x.records.slice(1)],
  ])
    await insertChange(x, 1, nameservers, { records: JSON.stringify(records) }, true);
  await insertChange(x, 1, nameservers);
  for (const bad of [{ change_id: `C${newUlid()}` }, { observed_at: "2020-01-01T00:00:00.000Z" }]) {
    await expect(nativeInsert("route53_dkim_receipts", { ...x.receipt, ...bad })).rejects.toThrow();
  }
}, 120000);
it("keeps the retired Route 53 receipts out of the resources that deletion must prove absent", async () => {
  const x = await fixture();
  await insertChange(x, 1, nameservers);
  const rows = (
    await legacyMailResourcesStatement(control.core, {
      organizationId: x.f.scope.organizationId,
      projectId: x.f.scope.projectId,
    }).all()
  ).results;
  expect(rows.map((row) => row["resource_kind"])).toEqual(["ses-configuration-set", "ses-tenant"]);
}, 120000);
it("rejects any populated folded legacy prototype without schema/row changes and seeds no Route53 history", async () => {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('local');}}",
    d1Databases: { CORE: "before-route53" },
  });
  try {
    const db = (await engine.getD1Database("CORE")) as unknown as D1Database,
      files = migrationFiles("core"),
      migration = files.find((f) => f.name === "0464_mail_historical_route53_receipts.sql");
    if (!migration) throw new Error("Route53 migration missing");
    for (const f of files.filter((f) => f.name !== migration.name))
      await db.batch(splitStatements(f.sql).map((sql) => db.prepare(sql)));
    await db
      .prepare(
        "INSERT INTO legacy_aws_mail_receipts VALUES(?,?,'route53_dkim','synthetic-retained',?,?)",
      )
      .bind(
        newUlid(),
        newUlid(),
        JSON.stringify({ original: "retained" }),
        storedTimestamp(new Date().toISOString()),
      )
      .run();
    const snapshot = async () =>
        JSON.stringify({
          schema: (await db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all())
            .results,
          rows: (await db.prepare("SELECT * FROM legacy_aws_mail_receipts").all()).results,
        }),
      before = await snapshot();
    await expect(
      db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql))),
    ).rejects.toThrow();
    expect(await snapshot()).toBe(before);
    for (const table of ["route53_dkim_change_receipts", "route53_dkim_receipts"])
      expect(
        await db.prepare("SELECT name FROM sqlite_master WHERE name=?").bind(table).first(),
      ).toBeNull();
  } finally {
    await engine.dispose();
  }
}, 120000);
