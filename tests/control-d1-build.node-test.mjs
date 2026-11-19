/* global structuredClone */
import { before, after, test } from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { join } from "node:path";
import { originalControlFixture, repositoryRoot } from "./support/control-conversion-fixture.mjs";
import {
  BUILD_COLUMNS,
  BUILD_SCHEMA_PINS,
  mapBuild,
  readBuildSourcePages,
  readBuildSourceFacts,
} from "../scripts/control-d1-build-mappings.mjs";
import { proveFixedProjectionPages } from "../scripts/control-d1-readback-pages.mjs";
import { buildPlan, importPlan, openLocalTarget } from "../scripts/control-d1-migration.mjs";
import { canonical, sha256, tableProof } from "../scripts/control-d1-codec.mjs";
import { createControlStore } from "../apps/control-store/dist/store.js";
import { inTransaction } from "./support/source-transaction.mjs";

const id = (n) => String(n).padStart(26, "0"),
  org = id(16001),
  project = id(16002),
  epoch = id(16003),
  env = id(16004),
  AT = "2026-10-01T12:00:00.123456Z",
  claim = "12345678-1234-4123-8123-123456789012";
let fixture, image, plan;
const input = (db, value, label) => ({
  db,
  plan: value,
  key: fixture.key,
  targetId: label,
  journal: join(fixture.directory, `${label}.journal`),
  currentPin: value.targetPin,
  repositoryRoot,
});
before(
  async () => {
    fixture = await originalControlFixture("build-facts");
    await inTransaction(fixture.pool, async (db) => {
      await db.query(
        "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at) VALUES($1,'org_build_mapper','active',1,decode(repeat('ab',32),'hex'),$2,$2,$2)",
        [org, AT],
      );
      await db.query(
        "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at) VALUES($1,$2,'Build mapper','build-mapper','customer-chosen-v1',0,$3,$4)",
        [project, org, id(16006), AT],
      );
      await db.query("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,NULL,'service:build-mapper')", [
        epoch,
        project,
        org,
        AT,
      ]);
      await db.query("INSERT INTO project_ownerships VALUES($1,$2,'active',1,$3,$4)", [
        project,
        org,
        epoch,
        AT,
      ]);
      await db.query(
        "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)",
        [org, project, env, id(16005), AT],
      );
      for (let n = 0; n < 130; n++) {
        const operation = id(16100 + n),
          cid = `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`;
        await db.query(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES($1,$2,$3,'running',$4,$5,$5)",
          [org, operation, project, epoch, AT],
        );
        await db.query(
          "INSERT INTO build_input_reservations VALUES($1,$2,$3,$4,decode(repeat('34',32),'hex'),$5,'observe',$6,$6::timestamptz+interval '60 seconds',2147483647,$6,$6::timestamptz+interval '4 minutes')",
          [org, project, env, operation, cid, AT],
        );
        await db.query(
          "INSERT INTO build_receipts(organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,created_at,input_fingerprint,build_claim_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            org,
            project,
            env,
            operation,
            `sandbox:${n}:Über😀`,
            "建".repeat(255),
            AT,
            n === 129 ? null : Buffer.alloc(32, 0x34),
            n === 129 ? null : cid,
          ],
        );
        await db.query(
          "INSERT INTO build_usage VALUES($1,$2,$3,$4,$5,$6,$7,'cloudflare-build-sandbox','standard-3',$8,$9,$10,$9::timestamptz+interval '2 seconds',$9::timestamptz+interval '3 seconds')",
          [
            org,
            project,
            env,
            operation,
            epoch,
            `sandbox:${n}:Über😀`,
            "建".repeat(255),
            n % 2 ? "FAILED" : "SUCCEEDED",
            AT,
            n % 2 ? null : AT,
          ],
        );
      }
    });
    image = await fixture.image("build-native");
    plan = await fixture.import(image, "build-native");
  },
  { timeout: 240000 },
);
after(async () => fixture?.dispose());

async function compare(db) {
  for (const table of Object.keys(BUILD_COLUMNS)) {
    const columns = image.manifest.tables.find((entry) => entry.name === table).columns;
    assert.deepEqual(
      await proveFixedProjectionPages(columns, readBuildSourcePages(db, table)),
      tableProof(
        columns,
        image.rows.get(table).map((row) => columns.map((column) => row[column.name])),
      ),
      table,
    );
  }
}
test("all three original Build families are centrally registered and streamed typed proof survives a second restore and replay", async () => {
  assert.deepEqual(plan.gaps, []);
  for (const table of Object.keys(BUILD_COLUMNS)) {
    assert.equal(plan.mapped.includes(table), true, table);
    assert.equal(image.rows.get(table).length, 130);
    assert.equal(plan.records.filter((record) => record.table === table).length, 130);
  }
  assert.equal(plan.verdict, "MAPPED_QUALIFICATION_ONLY");
  await compare(fixture.db);
  const facts = await readBuildSourceFacts(fixture.db);
  assert.equal(
    facts.get("build_usage").filter((row) => row.provisioning_started_at === null).length,
    65,
  );
  const restore = await openLocalTarget({ repositoryRoot });
  try {
    await importPlan({ ...input(restore.db, plan, "build-restore"), batchRows: 128 });
    await compare(restore.db);
    await importPlan({ ...input(restore.db, plan, "build-restore"), batchRows: 128 });
    assert.equal((await restore.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally {
    await restore.dispose();
  }
  // Inspect the actual bounded reader's continuation SQL, including its key-only length/window selection.
  const calls = [],
    observed = {
      prepare(sql) {
        const statement = fixture.db.prepare(sql);
        return {
          bind(...values) {
            calls.push({ sql, values });
            return statement.bind(...values);
          },
        };
      },
    };
  for await (const page of readBuildSourcePages(observed, "build_usage"))
    assert.equal(page.length <= 128, true);
  const continuation = calls.find(
    (call) => call.sql.startsWith("WITH candidates") && call.values.length === 4,
  );
  assert.ok(continuation);
  const explain = await fixture.db
    .prepare("EXPLAIN QUERY PLAN " + continuation.sql)
    .bind(...continuation.values)
    .all();
  assert.match(
    explain.results.map((row) => row.detail).join("\n"),
    /SEARCH build_usage USING PRIMARY KEY/u,
  );
});

test("wrong schema, incomplete rows and unrepresentable original values remain named blockers before target writes", () => {
  const one = new Map([...image.rows].map(([name, rows]) => [name, rows.slice(0, 1)]));
  for (const [name, code] of [
    ["pin", "BUILD_SCHEMA_PREREQUISITE"],
    ["definition", "BUILD_SOURCE_COLUMNS"],
    ["table", "BUILD_SOURCE_TABLE"],
    ["shape", "BUILD_ROW_SHAPE"],
    ["value", "BUILD_ROW_VALUE"],
    ["time", "BUILD_TIMESTAMP_UNREPRESENTABLE"],
    ["bytes", "BUILD_BYTEA_UNREPRESENTABLE"],
    ["integer", "INTEGER"],
  ]) {
    const rows = structuredClone(one),
      manifest = structuredClone(image.manifest),
      row = rows.get("build_input_reservations")[0];
    if (name === "pin")
      manifest.targetPin.migrations.find(
        (entry) => entry.name === Object.keys(BUILD_SCHEMA_PINS)[0],
      ).sha256 = "0".repeat(64);
    if (name === "definition")
      manifest.tables.find((entry) => entry.name === "build_receipts").columns.pop();
    if (name === "table") rows.delete("build_receipts");
    if (name === "shape") delete row.claim_id;
    if (name === "value") row.claim_id = 42;
    if (name === "time") row.claimed_at = "+infinity";
    if (name === "bytes") row.input_fingerprint = "zz";
    if (name === "integer") row.attempt_number = "1.2";
    assert.throws(() => mapBuild(rows, manifest), new RegExp(`CONTROL_D1_${code}$`, "u"), name);
  }
  assert.throws(() => readBuildSourcePages(fixture.db, "foreign"), /BUILD_READBACK_TABLE/u);
  const damaged = structuredClone(image.manifest);
  damaged.tables.find((entry) => entry.name === "build_usage").columns.pop();
  const blocked = buildPlan({ ...image, manifest: damaged }, damaged.targetPin, {
    role: "postgres",
    database: "postgres",
  });
  assert.equal(blocked.unhandled.includes("build_usage"), true);
  assert.equal(blocked.verdict, "INCOMPLETE");
});

test("late native Build faults roll back the import unit and the actual next caller observes the retained completed receipt without launch permission", async () => {
  const parents = plan.records.filter((record) => !Object.hasOwn(BUILD_COLUMNS, record.table)),
    records = mapBuild(image.rows, image.manifest)
      .slice(0, 2)
      .map((record) => ({ ...record, atomicGroup: "build.failure" }));
  records.push({ ...records[0], row: { ...records[0].row, operation_id: id(999999) } });
  const body = { ...plan, records: [...parents, ...records], sequenceRestores: [] };
  delete body.digest;
  const combined = { ...body, digest: sha256(Buffer.from(canonical(body))) },
    fresh = await openLocalTarget({ repositoryRoot });
  try {
    await assert.rejects(
      importPlan(input(fresh.db, combined, "build-failure")),
      /IMPORT_UNCONFIRMED/u,
    );
    assert.equal(
      (await fresh.db.prepare("SELECT count(*) n FROM build_input_reservations").first()).n,
      0,
    );
    assert.equal(
      (
        await fresh.db
          .prepare(
            "SELECT count(*) n FROM command_log WHERE name='control-d1.import' AND result LIKE '%build.failure%'",
          )
          .first()
      ).n,
      0,
    );
  } finally {
    await fresh.dispose();
  }
  await fixture.activate("build-facts-native");
  const scope = { projectId: project, environmentId: env, operationId: id(16100) },
    request = {
      scope,
      inputFingerprint: `sha256:${"34".repeat(32)}`,
      claimId: claim,
      leaseMilliseconds: 60000,
    },
    store = createControlStore({ CONTROL_CORE: fixture.db });
  // The imported receipt keeps its own claim id (operation 0), not the one the caller presents now.
  assert.deepEqual(await store.build.claimBuildInput(request), {
    status: "completed",
    envelope: {
      receipt: { buildId: "sandbox:0:Über😀", projectName: "建".repeat(255), scope },
      inputFingerprint: `sha256:${"34".repeat(32)}`,
      claimId: "12345678-1234-4123-8123-000000000000",
    },
  });
  assert.equal(await store.build.authorizeBuildStart({ scope, claimId: claim }), false);
  await assert.rejects(
    store.build.claimBuildInput({ ...request, inputFingerprint: `sha256:${"ff".repeat(32)}` }),
    /build_input_conflict/u,
  );
});
