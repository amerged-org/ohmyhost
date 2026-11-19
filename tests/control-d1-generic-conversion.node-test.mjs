import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { originalControlFixture, repositoryRoot } from "./support/control-conversion-fixture.mjs";
import {
  openLocalTarget,
  importPlan,
  compareRecords,
  compareGenericSourceProofs,
} from "../scripts/control-d1-migration.mjs";
import { compareDispositions } from "../scripts/control-d1-target.mjs";
import {
  archiveNdjson,
  archiveGzip,
  REMOVED_SOURCE_TABLES,
} from "../scripts/control-d1-dispositions.mjs";
import { sha256 } from "../scripts/control-d1-codec.mjs";

const id = (n) => String(n).padStart(26, "0"),
  org = id(18001),
  project = id(18002),
  epoch = id(18003),
  env = id(18004),
  operation = id(18005),
  AT = "2026-10-01T12:00:00.123456Z";
let fixture, image, plan;

before(
  async () => {
    fixture = await originalControlFixture("generic-families");
    const client = await fixture.pool.connect();
    const q = (sql, values) => client.query(sql, values);
    try {
      await q("BEGIN");
      await q(
        "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at) VALUES($1,'org_generic','active',1,decode(repeat('ab',32),'hex'),$2,$2,$2)",
        [org, AT],
      );
      await q(
        "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at) VALUES($1,$2,'Generic','generic','customer-chosen-v1',0,$3,$4)",
        [project, org, id(18006), AT],
      );
      await q("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,NULL,'service:generic')", [
        epoch,
        project,
        org,
        AT,
      ]);
      await q("INSERT INTO project_ownerships VALUES($1,$2,'active',1,$3,$4)", [
        project,
        org,
        epoch,
        AT,
      ]);
      await q(
        "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)",
        [org, project, env, id(18011), AT],
      );
      // Original migration 013: a deleted deployment leaves head_version above zero with both pointers null.
      await q("UPDATE environments SET head_version=3 WHERE environment_id=$1", [id(18011)]);
      await q(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES($1,$2,$3,'running',$4,$5,$5)",
        [org, operation, project, epoch, AT],
      );
      // bytea, bigint above 2^53 and a derived Core organization column.
      await q(
        "INSERT INTO dev_share_links(project_id,organization_id,environment_id,token_sha256,ciphertext,nonce,key_version,generation,created_at) VALUES($1,$2,$3,decode(repeat('11',32),'hex'),decode(repeat('22',20),'hex'),decode(repeat('33',12),'hex'),1,9007199254740993,$4)",
        [project, org, env, AT],
      );
      await q(
        "INSERT INTO dev_share_link_rotations VALUES($1,decode(repeat('44',32),'hex'),9007199254740993,$2)",
        [project, AT],
      );
      // text[] with a quoted element, and a stored generated archive key.
      await q(
        "INSERT INTO project_recovery_jobs(operation_id,organization_id,project_id,environment_id,input_expires_at,requested_at,claim_id,started_at,archive_bucket,archive_bytes,archive_sha256,captured_at,archive_expires_at,verified_at,finished_at,sql_files) VALUES($1,$2,$3,$4,$5::timestamptz+interval '1 hour',$5,'12345678-1234-4123-8123-123456789012',$5,'ohmyho-development-backups',10,decode(repeat('55',32),'hex'),$5,$5::timestamptz+interval '7 days',$5,$5,ARRAY['dev.sql','prod.sql'])",
        [operation, org, project, env, AT],
      );
      await q(
        "INSERT INTO run_resource_inventory VALUES($1,$2,$3,$4,'cloudflare','worker',decode(repeat('66',32),'hex'),$5,'script-é')",
        [id(18007), org, project, operation, AT],
      );
      // Expired OAuth state and Neon-era history have no Core table: they are accounted, not imported.
      await q(
        "INSERT INTO github_connection_authorizations(authorization_id,organization_id,principal_id,session_id,workos_organization_id,token_expires_at,idempotency_key,state_sha256,ciphertext,nonce,value_sha256,key_version,state,created_at,expires_at) VALUES($1,$2,$3,'session','org_generic',1,'key',decode(repeat('77',32),'hex'),decode(repeat('88',20),'hex'),decode(repeat('99',12),'hex'),decode(repeat('aa',32),'hex'),1,'failed','2026-01-01T00:00:00Z','2026-01-01T00:10:00Z')",
        [id(18008), org, id(18009)],
      );
      await q(
        "INSERT INTO project_hyperdrive_receipts VALUES($1,$2,$3,$4,$5,'prj-neon','br-neon',$6,'host.example','neondb','ohmyho_runtime',repeat('ab',16),$7,$7)",
        [org, project, env, operation, id(18010), `ohmyho-${project.toLowerCase()}`, AT],
      );
      // The credit configuration and Stripe relations the Core keeps next to the removed credit history.
      await q(
        `INSERT INTO published_credit_rate_cards VALUES('card-1',$1,$1,'[{"meter":"wfp.requests","unit":"request"}]')`,
        [AT],
      );
      await q("INSERT INTO usage_meter_activations VALUES('wfp.requests','card-1',$1,$1)", [AT]);
      await q(
        "INSERT INTO stripe_billing_customers VALUES($1,$2,'acct_test1','test','user:one',$3,'cus_test1',$3)",
        [org, id(18020), AT],
      );
      await q(
        "INSERT INTO stripe_recharge_policies VALUES($1,'acct_test1','test',true,1,5000,'on',$2,NULL,'pm_test1',$3,NULL)",
        [org, id(18021), AT],
      );
      await q(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES($1,$2,'paid.example.com','awaiting_deployment','user:one',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),$3,$3)",
        [org, project, AT],
      );
      await q("COMMIT");
    } catch (error) {
      await q("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    image = await fixture.image("generic-families");
    plan = await fixture.import(image, "generic-families");
  },
  { timeout: 300000 },
);
after(async () => fixture?.dispose());

test("generic 1:1 families, derived columns and archived or dropped tables import, replay and compare exactly", async () => {
  assert.deepEqual(plan.gaps, []);
  assert.deepEqual(plan.unhandled, []);
  const kinds = Object.fromEntries(plan.dispositions.map((entry) => [entry.table, entry.kind]));
  assert.equal(kinds.github_connection_authorizations, "expired");
  assert.equal(kinds.project_hyperdrive_receipts, "archive");
  assert.equal(kinds.shared_gateway_receipt_migration_restore, "scaffold");
  assert.equal(kinds.project_transfer_intents, "consumed");
  // Every removed credit, metering and billing table of the original schema is declared, none is also converted.
  assert.deepEqual(
    plan.dispositions
      .filter((entry) => entry.kind === "removed")
      .map((entry) => entry.table)
      .sort(),
    [...REMOVED_SOURCE_TABLES].sort(),
  );
  assert.equal(
    plan.mapped.some((table) => REMOVED_SOURCE_TABLES.includes(table)),
    false,
  );
  for (const table of [
    "dev_share_links",
    "project_recovery_jobs",
    "run_resource_inventory",
    "published_credit_rate_cards",
    "usage_meter_activations",
    "stripe_billing_customers",
    "stripe_recharge_policies",
    "paid_project_domains",
  ])
    assert.equal(plan.mapped.includes(table), true);
  assert.equal(
    plan.records.filter((record) => record.table === "stripe_recharge_policies").length,
    1,
  );
  assert.deepEqual(await compareRecords(fixture.db, plan.records), []);
  assert.deepEqual(await compareGenericSourceProofs(fixture.db, image, plan.mapped), []);
  assert.deepEqual(await compareDispositions(fixture.db, plan, "generic-families"), []);
  const rotation = await fixture.db
    .prepare(
      "SELECT organization_id,CAST(generation AS TEXT) generation FROM dev_share_link_rotations",
    )
    .first();
  assert.deepEqual(rotation, { organization_id: org, generation: "9007199254740993" });
  const job = await fixture.db
    .prepare("SELECT archive_key,sql_files FROM project_recovery_jobs")
    .first();
  assert.equal(job.archive_key, `snapshots/${org}/${project}/${operation}.zip`);
  assert.equal(job.sql_files, '["dev.sql","prod.sql"]');

  // The archive bytes are deterministic and match the digest receipt the plan carries.
  const entry = plan.dispositions.find((item) => item.table === "project_hyperdrive_receipts");
  const definition = image.manifest.tables.find((table) => table.name === entry.table);
  const ndjson = archiveNdjson(entry.table, definition, image.rows.get(entry.table));
  assert.equal(sha256(ndjson), entry.ndjsonSha256);
  assert.equal(sha256(archiveGzip(ndjson)), entry.gzipSha256);
  assert.equal(gunzipSync(archiveGzip(ndjson)).toString().split("\n").length, 3);

  // Second target restored from the same encrypted capture replays to the same proofs; a drifted row is detected.
  const second = await openLocalTarget({ repositoryRoot });
  try {
    await importPlan({
      db: second.db,
      plan,
      targetId: "generic-second",
      key: fixture.key,
      journal: join(fixture.directory, "generic-second.journal"),
      currentPin: plan.targetPin,
      repositoryRoot,
    });
    assert.deepEqual(await compareGenericSourceProofs(second.db, image, plan.mapped), []);
    const drifted = {
      manifest: {
        tables: image.manifest.tables.map((table) =>
          table.name === "run_resource_inventory" ? { ...table, sha256: "00".repeat(32) } : table,
        ),
      },
    };
    assert.deepEqual(await compareGenericSourceProofs(second.db, drifted, plan.mapped), [
      "run_resource_inventory",
    ]);
  } finally {
    await second.dispose();
  }
});
