/* global URL, structuredClone */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { testPostgresEnvironment } from "../scripts/test-postgres-path.mjs";
import { openLocalTarget, targetPin } from "../scripts/control-d1-target.mjs";
import { captureExpression, columnKind, tableProof, sha256 } from "../scripts/control-d1-codec.mjs";
import {
  ENTITLEMENT_COLUMNS,
  ENTITLEMENT_KINDS,
  ENTITLEMENT_MIGRATIONS,
  ENTITLEMENT_SOURCE_MIGRATIONS,
  ENTITLEMENT_TARGETS,
  ENTITLEMENT_DERIVED_TRIGGERS,
  mapProductEntitlements,
} from "../scripts/control-d1-product-entitlement-mappings.mjs";
import {
  readProductEntitlementFacts,
  ENTITLEMENT_READBACK_KEYS,
} from "../scripts/control-d1-product-entitlement-readback.mjs";
import { bucketOf } from "../apps/control-store/dist/router.js";
const require = createRequire(new URL("../packages/database/package.json", import.meta.url)),
  { Pool } = require("pg"),
  { runner } = require("node-pg-migrate"),
  execute = promisify(execFile),
  root = fileURLToPath(new URL("..", import.meta.url)),
  id = (n) => String(n).padStart(26, "0"),
  AT = "2026-10-28T12:00:00.123456Z",
  MAX = "9223372036854775807",
  org = id(1),
  project = id(2),
  epoch = id(3),
  env = id(4),
  prod = id(5),
  provider = "prj_abcdefghijklmnopqrst",
  op = "op_abcdefghijklmnopqrst";
let directory, environment, pool, local, rows, manifest, proofs;
before(async () => {
  environment = testPostgresEnvironment();
  directory = await mkdtemp(join(tmpdir(), "omh-entitlement-native-"));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const data = join(directory, "pg");
  await execute("initdb", ["-D", data, "-A", "trust", "-U", "postgres"], { env: environment });
  await execute(
    "pg_ctl",
    [
      "-D",
      data,
      "-l",
      join(directory, "pg.log"),
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ],
    { env: environment },
  );
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  await runner({
    databaseUrl: url,
    dir: join(root, "packages/database/migrations"),
    direction: "up",
    migrationsTable: "control_db_migrations",
    schema: "public",
    migrationsSchema: "public",
    log: () => undefined,
  });
  pool = new Pool({ connectionString: url, max: 1 });
  await pool.query("BEGIN");
  await pool.query(
    "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at) VALUES($1,'org_entitlement_map','active',1,decode(repeat('12',32),'hex'),$2,$2,$2)",
    [org, AT],
  );
  await pool.query(
    "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at) VALUES($1,$2,'Entitlement mapper','calm-otter-entitlement-map','human-id-4.2.0-sha256-project-handle-words-v1',0,$3,$4)",
    [project, org, id(6), AT],
  );
  await pool.query(
    "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES($1,$2,$3,$4,'user:entitlement-map')",
    [epoch, project, org, AT],
  );
  await pool.query(
    "INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at) VALUES($1,$2,'active',1,$3,$4)",
    [project, org, epoch, AT],
  );
  await pool.query(
    "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)",
    [org, project, env, prod, AT],
  );
  await pool.query(
    "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES($1,$2,$3,$4,'pgcf',$5,'abcdefghijklmnopqrst','us-dev','r512-s1g',$6,$7,$8)",
    [org, project, env, MAX, provider, "ohmyho_rw_" + env, "registry:" + env, AT],
  );
  for (let n = 0; n < 132; n++) {
    const db = "a" + String(n).padStart(19, "0"),
      held = n % 2 === 0;
    await pool.query(
      "INSERT INTO pgcf_database_entitlement_policies VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [org, project, env, db, held, held ? op : null, held ? MAX : null, AT],
    );
    await pool.query(
      "INSERT INTO pgcf_database_entitlement_actions(action_id,organization_id,project_id,physical_environment_id,billing_epoch_id,target_version,provider_project_id,database_id,action,expected_generation,idempotency_key,state,provider_operation_id,provider_generation,claim_id,claim_expires_at,created_at,dispatched_at,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18)",
      [
        id(1000 + n),
        org,
        project,
        env,
        epoch,
        MAX,
        provider,
        db,
        n % 2 === 0 ? "suspend" : "resume",
        MAX,
        "omh-entitlement-" + sha256(String(n)),
        n % 3 === 0 ? "succeeded" : n % 3 === 1 ? "failed" : "superseded",
        n % 3 === 0 ? op : null,
        n % 3 === 0 ? MAX : null,
        id(2000 + n),
        AT,
        n % 2 === 0 ? AT : null,
        n % 3 === 0 ? AT : null,
      ],
    );
  }
  await pool.query("COMMIT");
  rows = new Map();
  proofs = new Map();
  manifest = { targetPin: await targetPin(root), tables: [] };
  for (const [table, fields] of Object.entries(ENTITLEMENT_COLUMNS)) {
    const metadata = (
      await pool.query(
        `SELECT a.attname name,format_type(CASE WHEN t.typtype='d' THEN t.typbasetype ELSE a.atttypid END,CASE WHEN t.typtype='d' THEN t.typtypmod ELSE a.atttypmod END) AS "pgType",format_type(a.atttypid,a.atttypmod) AS "sourceType" FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [table],
      )
    ).rows.map((c) => ({ ...c, kind: columnKind(c.pgType) }));
    assert.deepEqual(
      metadata.map((c) => c.name),
      fields.split(","),
    );
    const values = (
      await pool.query(
        "SELECT " +
          metadata.map((c) => captureExpression(c) + " AS " + c.name).join(",") +
          " FROM " +
          table,
      )
    ).rows;
    rows.set(table, values);
    manifest.tables.push({ name: table, columns: metadata });
    proofs.set(
      table,
      tableProof(
        metadata,
        values.map((r) => metadata.map((c) => r[c.name])),
      ),
    );
  }
  local = await openLocalTarget({ repositoryRoot: root });
  const db = local.db,
    bucket = await bucketOf(org);
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_directory(organization_id,workos_organization_id,bucket,state,created_at,updated_at) VALUES(?1,'org_entitlement_map',?2,'active',?3,?3)",
      )
      .bind(org, bucket, AT),
    db
      .prepare(
        "INSERT INTO project_directory(project_id,organization_id,handle,state,created_at) VALUES(?1,?2,'calm-otter-entitlement-map','active',?3)",
      )
      .bind(project, org, AT),
    db
      .prepare(
        "INSERT INTO organizations(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,created_at,updated_at,bucket) VALUES(?1,'org_entitlement_map','active',1,unhex(?2),?3,?3,?3,?3,?4)",
      )
      .bind(org, "12".repeat(32), AT, bucket),
    db
      .prepare(
        "INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at) VALUES(?1,?2,?1,'Entitlement mapper',?3,'calm-otter-entitlement-map','customer-chosen-v1',0,'active',1,'active',1,?4,'shared','eu','protected',?5,?5)",
      )
      .bind(org, project, id(6), epoch, AT),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,?4,'user:entitlement-map')",
      )
      .bind(org, epoch, project, AT),
    ...[
      [env, "dev"],
      [prod, "prod"],
    ].map(([environmentId, name]) =>
      db
        .prepare(
          "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,'{}',0,1,?5,?5)",
        )
        .bind(org, project, environmentId, name, AT),
    ),
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(org, project, env, AT),
    db
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,CAST(?4 AS INTEGER),'pgcf',?5,'abcdefghijklmnopqrst','us-dev','r512-s1g',?6,?7,?8)",
      )
      .bind(org, project, env, MAX, provider, "ohmyho_rw_" + env, "registry:" + env, AT),
  ]);
});
after(async () => {
  await local?.dispose();
  await pool?.end();
  if (directory) {
    await execute("pg_ctl", ["-D", join(directory, "pg"), "-m", "fast", "-w", "stop"], {
      env: environment,
    }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualifies both unchanged original226 families, exact typed PG18/Core proof, native keys and populated immutability with foreign keys ON", async (t) => {
  const db = local.db,
    originalJSON = JSON.stringify([...rows]),
    triggers = (
      await db
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all()
    ).results;
  for (const [name, pin] of Object.entries(ENTITLEMENT_MIGRATIONS))
    assert.equal(
      sha256(await readFile(join(root, "apps/control-store/migrations/core", name))),
      pin,
    );
  for (const [name, pin] of Object.entries(ENTITLEMENT_SOURCE_MIGRATIONS))
    assert.equal(sha256(await readFile(join(root, "packages/database/migrations", name))), pin);
  assert.deepEqual(ENTITLEMENT_TARGETS, Object.keys(ENTITLEMENT_COLUMNS));
  assert.deepEqual(ENTITLEMENT_DERIVED_TRIGGERS, []);
  const mapped = mapProductEntitlements(rows, manifest);
  assert.equal(mapped.length, 264);
  assert.equal(JSON.stringify([...rows]), originalJSON);
  for (let start = 0; start < mapped.length; start += 64)
    await db.batch(
      mapped.slice(start, start + 64).map(({ table, row }) => {
        const fields = Object.keys(row);
        return db
          .prepare(
            "INSERT INTO " +
              table +
              "(" +
              fields.join(",") +
              ") VALUES(" +
              fields
                .map((c) =>
                  ENTITLEMENT_KINDS[table][c] === "integer" ||
                  ENTITLEMENT_KINDS[table][c] === "boolean"
                    ? "CAST(? AS INTEGER)"
                    : "?",
                )
                .join(",") +
              ")",
          )
          .bind(...fields.map((c) => row[c]));
      }),
    );
  const facts = await readProductEntitlementFacts(db);
  for (const table of ENTITLEMENT_TARGETS) {
    const columns = manifest.tables.find((t) => t.name === table).columns;
    assert.deepEqual(
      tableProof(
        columns,
        facts.get(table).map((r) => columns.map((c) => r[c.name])),
      ),
      proofs.get(table),
    );
    assert.deepEqual(
      tableProof(
        columns,
        rows.get(table).map((r) => columns.map((c) => r[c.name])),
      ),
      proofs.get(table),
    );
    const keys = ENTITLEMENT_READBACK_KEYS[table],
      keySql = keys.join(","),
      projection = ENTITLEMENT_COLUMNS[table]
        .split(",")
        .map((c) =>
          ENTITLEMENT_KINDS[table][c] === "integer"
            ? `CAST(${c} AS TEXT) AS ${c}`
            : ENTITLEMENT_KINDS[table][c] === "boolean"
              ? `CASE ${c} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END AS ${c}`
              : c,
        )
        .join(",");
    const plan = (
      await db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT ${keys.join(",")} FROM (SELECT ${projection} FROM ${table}) original WHERE (${keySql})>(${keys.map(() => "?").join(",")}) ORDER BY ${keySql} LIMIT 128`,
        )
        .bind(...keys.map((c) => (c === "database_id" ? "a0000000000000000000" : org)))
        .all()
    ).results;
    assert.ok(
      plan.some((p) => /SEARCH .*USING PRIMARY KEY/.test(p.detail)),
      JSON.stringify(plan),
    );
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.deepEqual(
    (
      await db
        .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all()
    ).results,
    triggers,
  );
  const terminal = id(1000),
    old = await db
      .prepare("SELECT * FROM pgcf_database_entitlement_actions WHERE action_id=?")
      .bind(terminal)
      .first();
  for (const sql of [
    "DELETE FROM pgcf_database_entitlement_actions WHERE action_id=?1",
    "UPDATE pgcf_database_entitlement_actions SET claim_id='00000000000000000000000999' WHERE action_id=?1",
    "UPDATE pgcf_database_entitlement_actions SET expected_generation=2 WHERE action_id=?1",
    "UPDATE pgcf_database_entitlement_actions SET provider_operation_id='op_aaaaaaaaaaaaaaaaaaaa' WHERE action_id=?1",
    "UPDATE pgcf_database_entitlement_actions SET dispatched_at='2026-01-01T00:00:00.000000Z' WHERE action_id=?1",
    "UPDATE pgcf_database_entitlement_actions SET observed_at='2026-01-01T00:00:00.000000Z' WHERE action_id=?1",
  ]) {
    await assert.rejects(() => db.prepare(sql).bind(terminal).run(), /immutable/);
    await assert.rejects(() => pool.query(sql.replaceAll("?1", "$1"), [terminal]), /immutable/);
  }
  assert.deepEqual(
    await db
      .prepare("SELECT * FROM pgcf_database_entitlement_actions WHERE action_id=?")
      .bind(terminal)
      .first(),
    old,
  );
  for (const invalid of [
    "2026-02-30T00:00:00.000000Z",
    "2026-01-01T1x:00:00.000000Z",
    "2026-01-01T00:2x:00.000000Z",
    "2026-01-01T24:00:00.000000Z",
    "2026-01-01T00:00:00.00000xZ",
  ]) {
    await assert.rejects(
      () =>
        db
          .prepare(
            "UPDATE pgcf_database_entitlement_policies SET last_checked_at=? WHERE organization_id=?",
          )
          .bind(invalid, org)
          .run(),
      /CHECK/,
    );
  }
  await assert.rejects(
    () =>
      db
        .prepare(
          "UPDATE pgcf_database_entitlement_policies SET suspension_generation=NULL WHERE suspended_by_entitlement=1",
        )
        .run(),
    /CHECK/,
  );
  for (const [column, value] of [
    ["database_id", "a".repeat(20) + "\0tail"],
    ["suspension_operation_id", op + "\0tail"],
  ])
    await assert.rejects(
      () =>
        db
          .prepare(
            `UPDATE pgcf_database_entitlement_policies SET ${column}=? WHERE suspended_by_entitlement=1`,
          )
          .bind(value)
          .run(),
      /CHECK/,
    );
  const sample = mapped.find((r) => r.table.endsWith("actions"));
  const bad = {
    ...sample.row,
    action_id: id(9999),
    billing_epoch_id: id(9999),
    idempotency_key: "omh-entitlement-" + sha256("bad epoch"),
  };
  const fields = Object.keys(bad);
  await assert.rejects(
    () =>
      db.batch([
        db
          .prepare(
            "UPDATE pgcf_database_entitlement_policies SET last_checked_at='2026-10-29T00:00:00.000000Z' WHERE organization_id=?",
          )
          .bind(org),
        db
          .prepare(
            "INSERT INTO pgcf_database_entitlement_actions(" +
              fields.join(",") +
              ") VALUES(" +
              fields
                .map((c) =>
                  ENTITLEMENT_KINDS[sample.table][c] === "integer" ? "CAST(? AS INTEGER)" : "?",
                )
                .join(",") +
              ")",
          )
          .bind(...fields.map((c) => bad[c])),
      ]),
    /FOREIGN KEY/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT last_checked_at FROM pgcf_database_entitlement_policies LIMIT 1")
        .first()
    ).last_checked_at,
    AT,
  );
  assert.throws(() => mapProductEntitlements(null, manifest), /MANIFEST/);
  assert.throws(
    () => mapProductEntitlements(rows, { ...manifest, targetPin: { migrations: [] } }),
    /PREREQUISITE/,
  );
  assert.throws(() => mapProductEntitlements(new Map(), manifest), /SOURCE_REQUIRED/);
  const wrongTypes = structuredClone(manifest);
  wrongTypes.tables[0].columns[0].pgType = "bigint";
  assert.throws(() => mapProductEntitlements(rows, wrongTypes), /SOURCE_TYPE/);
  const changed = () => new Map([...rows].map(([t, rs]) => [t, rs.map((r) => ({ ...r }))]));
  let invalid = changed();
  delete invalid.get(ENTITLEMENT_TARGETS[0])[0].database_id;
  assert.throws(() => mapProductEntitlements(invalid, manifest), /ROW_SHAPE/);
  invalid = changed();
  invalid.get(ENTITLEMENT_TARGETS[0])[0].database_id = 1;
  assert.throws(() => mapProductEntitlements(invalid, manifest), /ROW_VALUE/);
  invalid = changed();
  invalid.get(ENTITLEMENT_TARGETS[0])[0].suspended_by_entitlement = "1";
  assert.throws(() => mapProductEntitlements(invalid, manifest), /BOOLEAN/);
  invalid = changed();
  invalid.get(ENTITLEMENT_TARGETS[0])[0].last_checked_at = "2026-02-30T00:00:00.000000Z";
  assert.throws(() => mapProductEntitlements(invalid, manifest), /TIMESTAMP/);
  invalid = changed();
  invalid.get(ENTITLEMENT_TARGETS[0])[0].suspension_generation = "9223372036854775808";
  assert.throws(() => mapProductEntitlements(invalid, manifest), /INTEGER_RANGE/);
  assert.equal(JSON.stringify([...rows]), originalJSON);
  t.diagnostic(
    JSON.stringify({
      kind: "w32-entitlement-raw-proof",
      postgres: (await pool.query("SHOW server_version")).rows[0].server_version,
      sourceMigrations: ENTITLEMENT_SOURCE_MIGRATIONS,
      targetMigrations: ENTITLEMENT_MIGRATIONS,
      proofs: Object.fromEntries(proofs),
      sourceRowsUnchanged: true,
      foreignKeys: true,
      staticTriggersUnchanged: true,
    }),
  );
});
