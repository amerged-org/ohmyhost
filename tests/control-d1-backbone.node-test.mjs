/* global structuredClone */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  originalControlFixture,
  coreFixtureThrough,
  repositoryRoot,
} from "./support/control-conversion-fixture.mjs";
import { inTransaction } from "./support/source-transaction.mjs";
import {
  BACKBONE_COLUMNS,
  mapPrincipalMappings,
  mapGlobalInbox,
  mapOperationDelegations,
  readBackboneSourceFacts,
} from "../scripts/control-d1-backbone-mappings.mjs";
import { tableProof, canonical, sha256 } from "../scripts/control-d1-codec.mjs";
import { buildPlan, openLocalTarget, importPlan } from "../scripts/control-d1-migration.mjs";
import { splitSql, schemaFingerprint } from "../scripts/control-d1-target.mjs";
import { REMOVED_SOURCE_VIEWS } from "../scripts/control-d1-dispositions.mjs";

const id = (n) => String(n).padStart(26, "0"),
  now = "2027-03-01T00:00:00.123456Z",
  later = "2027-03-01T00:01:00.654321Z",
  org = id(11001),
  other = id(11002),
  project = id(11003),
  epoch = id(11004),
  dev = id(11005),
  grant = "30000000-0000-4000-8000-000000000001",
  ownGrant = "30000000-0000-4000-8000-000000000002";
let fixture, image, plan;
const signed = (body) => ({ ...body, digest: sha256(Buffer.from(canonical(body))) });
async function insert(db, table, row) {
  const columns = Object.keys(row);
  await db
    .prepare(`INSERT INTO ${table}(${columns}) VALUES(${columns.map(() => "?")})`)
    .bind(...Object.values(row))
    .run();
}
// An accepted API operation as the original PostgreSQL spine records it, written as plain SQL.
async function acceptOperation(db, n) {
  const at = now.replace(".123456Z", ".123Z"),
    identity = [
      org,
      "user:backbone",
      "POST",
      "/v1/projects/{project_id}/deployments",
      `backbone-key-${n}`,
    ];
  await db.query(
    "INSERT INTO api_idempotency_records(organization_id,principal_id,http_method,route_template,idempotency_key,canonical_request_sha256,canonicalization_version,request_id,created_at) VALUES($1,$2,$3,$4,$5,decode(repeat('2a',32),'hex'),'rfc8785-v1',$6,$7)",
    [...identity, `backbone-${n}`, at],
  );
  await db.query(
    "INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES($1,$2,$3,'queued',$4,$4,$5)",
    [org, id(n), project, at, epoch],
  );
  await db.query(
    "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,0,'OperationQueued','{}'::jsonb,$5)",
    [org, id(n + 1), id(n), project, at],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,$4,'DeploymentRequestedV1','principal','user:backbone','{}'::jsonb,$5,$6)",
    [org, id(n + 2), project, id(n), at, epoch],
  );
  await db.query(
    "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id) VALUES($1,$2,$3,$4,'DeploymentRequestedV1',jsonb_build_object('environmentId',$5::text),$6,$6,$6,5,$7)",
    [org, id(n + 3), project, id(n), dev, at, epoch],
  );
  await db.query(
    "UPDATE api_idempotency_records SET operation_id=$6::ulid,http_status=202,response_headers=jsonb_build_object('Location',$7::text),response_body=jsonb_build_object('operation_id',$6::text),completed_at=$8::timestamptz,expires_at=$8::timestamptz+interval '24 hours' WHERE organization_id=$1 AND principal_id=$2 AND http_method=$3 AND route_template=$4 AND idempotency_key=$5",
    [...identity, id(n), `/v1/operations/${id(n)}`, at],
  );
}
async function proveFacts(db) {
  const facts = await readBackboneSourceFacts(db);
  for (const table of Object.keys(BACKBONE_COLUMNS)) {
    const columns = image.manifest.tables.find((entry) => entry.name === table).columns,
      values = (rows) => rows.map((row) => columns.map((column) => row[column.name]));
    assert.deepEqual(
      tableProof(columns, values(facts.get(table))),
      tableProof(columns, values(image.rows.get(table))),
      table,
    );
  }
}
before(
  async () => {
    fixture = await originalControlFixture("identity-backbone");
    await inTransaction(fixture.pool, async (db) => {
      for (const [organization, workos] of [
        [org, "org_backbone"],
        [other, "org_other_backbone"],
      ])
        await db.query(
          "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at) VALUES($1,$2,'active',1,decode(repeat('ab',32),'hex'),$3,$3,$3)",
          [organization, workos, now],
        );
      await db.query(
        "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at) VALUES($1,$2,'backbone','backbone-native','customer-chosen-v1',0,$3,$4)",
        [project, org, id(11006), now],
      );
      await db.query("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,NULL,'user:backbone')", [
        epoch,
        project,
        org,
        now,
      ]);
      await db.query("INSERT INTO project_ownerships VALUES($1,$2,'active',1,$3,$4)", [
        project,
        org,
        epoch,
        now,
      ]);
      await db.query(
        "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$4,$4),($1,$5,$3,'prod','{}',$4,$4)",
        [org, dev, project, now, id(11007)],
      );
      for (const [grantId, organization] of [
        [grant, other],
        [ownGrant, org],
      ])
        await db.query(
          "INSERT INTO mcp_client_grants(grant_id,user_id,client_id,consent_hash,organization_id,project_id,ownership_version,billing_epoch_id,allow_publish,created_at,revision) VALUES($1,'user_backbone','client',repeat('ac',32),$2,NULL,NULL,NULL,true,$3,1)",
          [grantId, organization, now],
        );
      for (const n of [11100, 11200, 11500]) {
        await acceptOperation(db, n);
        if (n === 11500) continue;
        await db.query(
          "INSERT INTO operation_mcp_delegations VALUES($1,$2,$3,$4,$5,'user:backbone',$6,'client',repeat('ad',32),$7,'DeploymentRequestedV1',$8)",
          [id(n), org, project, dev, epoch, n === 11100 ? grant : ownGrant, n === 11100, now],
        );
      }
      await db.query(
        "INSERT INTO principal_mappings(provider,provider_principal_id,principal_id,organization_id,first_observed_at,last_observed_at) VALUES('workos','',$1,$2,$3,$3)",
        ["opaque Über 😀\n", id(11999), now],
      );
      // These are legal original facts: no organization parent and no first<=last SQL constraint.
      await db.query("UPDATE principal_mappings SET last_observed_at=$1", [
        now.replace("03-01", "02-28"),
      ]);
      for (const [index, state, provider, attempts] of [
        [1, "pending", "workos", 0],
        [2, "processing", "github", 1],
        [3, "retry_wait", "stripe", 1],
        [4, "acknowledged", "workos", 0],
        [5, "reconciliation_required", "github", 2147483647],
      ])
        await db.query(
          "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at,last_error_code,acknowledged_at) VALUES($1,$2,$3,'opaque.event',$4,decode(repeat('af',32),'hex'),$5,$6,$7,$8,$9,$5,$10,$11,$12,$13,$14)",
          [
            id(11300 + index),
            provider,
            `original-${index}`,
            '{"opaque": "Über 😀", "nested": [null, {"x": 1}]}',
            now,
            provider === "workos" ? now : null,
            state,
            attempts,
            state === "reconciliation_required" ? attempts : 5,
            state === "processing" ? id(11400 + index) : null,
            state === "processing" ? now : null,
            state === "processing" ? later : null,
            ["retry_wait", "reconciliation_required"].includes(state) ? "ORIGINAL_FAILURE" : null,
            state === "acknowledged" ? later : null,
          ],
        );
    });
    image = await fixture.image("identity-backbone");
    plan = await fixture.import(image, "identity-backbone");
  },
  { timeout: 240_000 },
);
after(async () => fixture?.dispose());

test("native original identity/delegation/global-inbox facts import, read back and restore with exact typed proofs", async () => {
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.verdict, "MAPPED_QUALIFICATION_ONLY");
  for (const table of Object.keys(BACKBONE_COLUMNS))
    assert.equal(plan.mapped.includes(table), true);
  await proveFacts(fixture.db);
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT count(*) n FROM webhook_inbox WHERE organization_id IS NULL")
        .first()
    ).n,
    5,
  );
  const restore = await openLocalTarget({ repositoryRoot });
  try {
    let lost = false;
    const receipts = new WeakSet();
    const unknown = {
      prepare: (sql) => {
        const statement = restore.db.prepare(sql);
        if (sql.includes("'control-d1.import'"))
          return {
            bind: (...values) => {
              const bound = statement.bind(...values);
              receipts.add(bound);
              return bound;
            },
          };
        return statement;
      },
      batch: async (statements) => {
        const result = await restore.db.batch(statements);
        if (!lost && statements.some((statement) => receipts.has(statement))) {
          lost = true;
          throw new Error("Network connection lost");
        }
        return result;
      },
    };
    await importPlan({
      db: unknown,
      plan,
      key: fixture.key,
      targetId: "backbone-restore",
      journal: join(fixture.directory, "restore.journal"),
      currentPin: image.manifest.targetPin,
    });
    assert.equal(lost, true);
    await proveFacts(restore.db);
    assert.equal((await restore.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally {
    await restore.dispose();
  }
});

test("native global PK/static FK/immutable evidence survives preserving migration and incompatible prototypes refuse atomically", async () => {
  const migration = await readFile(
    join(repositoryRoot, "apps/control-store/migrations/core/0410_original_identity_backbone.sql"),
    "utf8",
  );
  const sourceRow = image.rows
    .get("operation_mcp_delegations")
    .find((row) => row.grant_id === ownGrant);
  for (const incompatible of [false, true]) {
    const prior = await coreFixtureThrough("0385_original_spine_static_scopes.sql");
    try {
      const parents = new Set([
        "org_directory",
        "organizations",
        "project_directory",
        "projects",
        "billing_epochs",
        "project_scope_history",
        "environments",
        "project_data_environments",
        "operations",
        "operation_events",
        "mcp_client_grants",
      ]);
      const { digest, ...body } = plan;
      void digest;
      await importPlan({
        db: prior.db,
        plan: signed({
          ...body,
          targetPin: prior.pin,
          records: plan.records.filter((record) => parents.has(record.table)),
          sequenceRestores: [],
          requiredTemporalTables: ["operations"],
        }),
        key: fixture.key,
        targetId: `backbone-prior-${incompatible}`,
        journal: join(fixture.directory, `prior-${incompatible}.journal`),
        currentPin: prior.pin,
      });
      await insert(prior.db, "operation_mcp_delegations", {
        ...sourceRow,
        requires_publication: "0",
        project_id: incompatible ? id(11998) : project,
      });
      const before = canonical(
          (await prior.db.prepare("SELECT * FROM operation_mcp_delegations").all()).results,
        ),
        schema = await schemaFingerprint(prior.db),
        apply = () => prior.db.batch(splitSql(migration).map((sql) => prior.db.prepare(sql)));
      if (incompatible) {
        await assert.rejects(apply(), /FOREIGN KEY/u);
        assert.equal(await schemaFingerprint(prior.db), schema);
      } else {
        await apply();
        assert.equal((await prior.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
      }
      assert.equal(
        canonical(
          (await prior.db.prepare("SELECT * FROM operation_mcp_delegations").all()).results,
        ),
        before,
      );
    } finally {
      await prior.dispose();
    }
  }
  const original = image.rows.get("operation_mcp_delegations")[0],
    targetRow = {
      ...original,
      requires_publication: original.requires_publication === "true" ? "1" : "0",
    };
  const nativeForeignKeys = (
    await fixture.pool
      .query(`SELECT array_agg(source.attname::text ORDER BY key.ordinality) columns,
      parent.relname parent,array_agg(target.attname::text ORDER BY key.ordinality) "parentColumns"
      FROM pg_constraint constraint_record
      JOIN pg_class parent ON parent.oid=constraint_record.confrelid
      CROSS JOIN LATERAL unnest(constraint_record.conkey,constraint_record.confkey) WITH ORDINALITY key(source_number,target_number,ordinality)
      JOIN pg_attribute source ON source.attrelid=constraint_record.conrelid AND source.attnum=key.source_number
      JOIN pg_attribute target ON target.attrelid=constraint_record.confrelid AND target.attnum=key.target_number
      WHERE constraint_record.conrelid='operation_mcp_delegations'::regclass AND constraint_record.contype='f'
      GROUP BY constraint_record.oid,parent.relname`)
  ).rows;
  const targetForeignKeys = new Map();
  for (const key of (
    await fixture.db.prepare("PRAGMA foreign_key_list(operation_mcp_delegations)").all()
  ).results) {
    if (!targetForeignKeys.has(key.id))
      targetForeignKeys.set(key.id, { columns: [], parent: key.table, parentColumns: [] });
    targetForeignKeys.get(key.id).columns[key.seq] = key.from;
    targetForeignKeys.get(key.id).parentColumns[key.seq] = key.to;
  }
  assert.deepEqual(
    [...targetForeignKeys.values()].map(canonical).sort(),
    nativeForeignKeys.map(canonical).sort(),
  );
  assert.equal(nativeForeignKeys.length, 4);
  const nativeInsert = (row) =>
    fixture.pool.query(
      `INSERT INTO operation_mcp_delegations(${Object.keys(row)}) VALUES(${Object.keys(row).map((_, index) => `$${index + 1}`)})`,
      Object.values(row),
    );
  await assert.rejects(nativeInsert(original), (error) => error.code === "23505");
  await assert.rejects(insert(fixture.db, "operation_mcp_delegations", targetRow), /UNIQUE/u);
  for (const field of [
    "project_id",
    "environment_id",
    "billing_epoch_id",
    "grant_id",
    "operation_id",
  ]) {
    const value = field === "grant_id" ? "30000000-0000-4000-8000-000000000099" : id(11997);
    await assert.rejects(
      nativeInsert({ ...original, operation_id: id(11500), [field]: value }),
      (error) => error.code === "23503",
    );
    await assert.rejects(
      insert(fixture.db, "operation_mcp_delegations", {
        ...targetRow,
        operation_id: id(11500),
        [field]: value,
      }),
      /FOREIGN KEY/u,
    );
  }
  for (const command of [
    "UPDATE operation_mcp_delegations SET event_type='changed'",
    "DELETE FROM operation_mcp_delegations",
  ]) {
    await assert.rejects(fixture.pool.query(command), /append-only/u);
    await assert.rejects(fixture.db.prepare(command).run(), /append-only/u);
  }
  assert.equal((await fixture.db.prepare("PRAGMA foreign_keys").first()).foreign_keys, 1);
});

test("closed schema/value/source gates remain blocking and no absent routing identity is manufactured", () => {
  for (const mapper of [mapPrincipalMappings, mapGlobalInbox, mapOperationDelegations]) {
    const changed = structuredClone(image.manifest);
    changed.targetPin.migrations = [];
    assert.throws(() => mapper(image.rows, changed), /BACKBONE_SCHEMA_PREREQUISITE/u);
  }
  for (const [table, mapper, column] of [
    ["principal_mappings", mapPrincipalMappings, "first_observed_at"],
    ["webhook_inbox", mapGlobalInbox, "received_at"],
    ["operation_mcp_delegations", mapOperationDelegations, "created_at"],
  ]) {
    const values = new Map(image.rows);
    values.set(table, [{ ...values.get(table)[0], [column]: "infinity" }]);
    assert.throws(() => mapper(values, image.manifest), /BACKBONE_TIMESTAMP_UNREPRESENTABLE/u);
  }
  const values = new Map(image.rows);
  values.set("operation_mcp_delegations", [
    { ...values.get("operation_mcp_delegations")[0], requires_publication: "1" },
  ]);
  assert.throws(() => mapOperationDelegations(values, image.manifest), /BACKBONE_BOOLEAN/u);
  const damaged = structuredClone(image.manifest);
  damaged.tables.find((table) => table.name === "principal_mappings").columns.pop();
  const incomplete = buildPlan({ ...image, manifest: damaged }, damaged.targetPin, {
    role: "postgres",
    database: "postgres",
  });
  assert.equal(incomplete.unhandled.includes("principal_mappings"), true);
  assert.equal(incomplete.verdict, "INCOMPLETE");
  assert.equal(
    plan.unhandledViews.length + plan.qualifiedViews.length + REMOVED_SOURCE_VIEWS.length,
    image.manifest.views.length,
  );
  assert.deepEqual(plan.unhandledSequences, []);
  assert.equal(plan.qualificationOnly, true);
});
