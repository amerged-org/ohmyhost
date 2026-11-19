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
import { createControlStore } from "../apps/control-store/dist/store.js";
import { SPINE_COLUMNS, readSpineSourceFacts } from "../scripts/control-d1-spine-mappings.mjs";
import { tableProof, canonical, sha256 } from "../scripts/control-d1-codec.mjs";
import { importPlan, splitSql, schemaFingerprint } from "../scripts/control-d1-target.mjs";

const id = (n) => String(n).padStart(26, "0"),
  at = (day, minute = 0) =>
    `2027-02-${String(day).padStart(2, "0")}T00:${String(minute).padStart(2, "0")}:00.000Z`;
const A = id(10001),
  B = id(10006),
  project = id(10002),
  oldEpoch = id(10003),
  epoch = id(10303),
  dev = id(10004);
let fixture, image, plan, store;
const api = (org, billingEpoch, n, day) => ({
  organizationId: org,
  projectId: project,
  environmentId: dev,
  billingEpochId: billingEpoch,
  operationId: id(n),
  operationEventId: id(n + 1),
  auditEventId: id(n + 2),
  outboxEventId: id(n + 3),
  principalId: "service:spine",
  actorType: "service",
  requestId: `request-${n}`,
  httpMethod: "PUT",
  routeTemplate: "/v1/projects/{project_id}/handle",
  idempotencyKey: `scope-${n}`,
  canonicalRequestDigest: Buffer.alloc(32, n % 255),
  eventType: "ProjectHandleChangeRequestedV1",
  occurredAt: at(day),
});
const old = api(A, oldEpoch, 10011, 1),
  current = api(B, epoch, 10211, 3);
const eventScope = {
  organizationId: B,
  projectId: project,
  operationId: current.operationId,
  eventId: current.outboxEventId,
};
const failure = (attemptId, auditId, failedAt, nextAvailableAt) => ({
  eventId: current.outboxEventId,
  attemptId,
  errorCode: "FIXTURE_RETRY",
  failedAt,
  nextAvailableAt,
  audit: {
    eventId: auditId,
    projectId: project,
    operationId: current.operationId,
    eventType: "OutboxRetryScheduled",
    actorType: "service",
    actorId: "spine-fixture",
    payload: { opaque: "Über 😀" },
    occurredAt: failedAt,
  },
});

// The next retry of a claimed delivery attempt as the original PostgreSQL outbox records it, as plain SQL.
async function scheduleRetry(db, input, attemptNumber) {
  const { audit } = input;
  await db.query(
    "UPDATE outbox_events SET last_error_code=$3,available_at=$4,current_attempt_id=NULL,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=$1 AND current_attempt_id=$2",
    [input.eventId, input.attemptId, input.errorCode, input.nextAvailableAt],
  );
  await db.query(
    "UPDATE delivery_attempts SET failed_at=$3,next_available_at=$4,error_code=$5,status='retry_scheduled' WHERE event_id=$1 AND attempt_id=$2 AND status='claimed'",
    [input.eventId, input.attemptId, input.failedAt, input.nextAvailableAt, input.errorCode],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) SELECT organization_id,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,billing_epoch_id FROM outbox_events WHERE event_id=$9",
    [
      audit.eventId,
      audit.projectId,
      audit.operationId,
      audit.eventType,
      audit.actorType,
      audit.actorId,
      JSON.stringify({
        ...audit.payload,
        eventId: input.eventId,
        attemptId: input.attemptId,
        attemptNumber,
        errorCode: input.errorCode,
        nextAvailableAt: input.nextAvailableAt,
      }),
      audit.occurredAt,
      input.eventId,
    ],
  );
}
// One claimed delivery attempt as the original PostgreSQL outbox records it, as plain SQL.
async function claimDelivery(db, input) {
  const leaseExpiresAt = new Date(Date.parse(input.claimedAt) + input.leaseMilliseconds);
  const claimed = await db.query(
    "UPDATE outbox_events SET attempt_count=attempt_count+1,current_attempt_id=$2,claimed_at=$3,lease_expires_at=$4 WHERE event_id=$1 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL AND attempt_count<max_attempts AND available_at<=$3 AND (lease_expires_at IS NULL OR lease_expires_at<=$3)",
    [input.eventId, input.attemptId, input.claimedAt, leaseExpiresAt],
  );
  assert.equal(claimed.rowCount, 1);
  await db.query(
    "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,status) SELECT $2,event_id,attempt_count,$3,$4,'claimed' FROM outbox_events WHERE event_id=$1",
    [input.eventId, input.attemptId, input.claimedAt, leaseExpiresAt],
  );
}
// The acknowledgement of a claimed delivery attempt as the original PostgreSQL outbox records it, as plain SQL.
async function acknowledgeDelivery(db, input) {
  const acknowledged = await db.query(
    "UPDATE outbox_events SET acknowledged_at=$3 WHERE event_id=$1 AND current_attempt_id=$2 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL",
    [input.eventId, input.attemptId, input.acknowledgedAt],
  );
  assert.equal(acknowledged.rowCount, 1);
  await db.query(
    "UPDATE delivery_attempts SET acknowledged_at=$3,status='acknowledged' WHERE event_id=$1 AND attempt_id=$2 AND status='claimed'",
    [input.eventId, input.attemptId, input.acknowledgedAt],
  );
}
// An accepted API operation (created path) as the original PostgreSQL store records it, as plain SQL.
async function acceptOperation(db, input) {
  const key = [
    input.organizationId,
    input.principalId,
    input.httpMethod,
    input.routeTemplate,
    input.idempotencyKey,
  ];
  await db.query(
    "INSERT INTO api_idempotency_records(organization_id,principal_id,http_method,route_template,idempotency_key,canonical_request_sha256,canonicalization_version,request_id,created_at) VALUES($1,$2,$3,$4,$5,$6::bytea,'rfc8785-v1',$7,$8)",
    [...key, Buffer.from(input.canonicalRequestDigest), input.requestId, input.occurredAt],
  );
  await db.query(
    "INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES($1,$2,$3,'queued',$4,$4,$5)",
    [
      input.organizationId,
      input.operationId,
      input.projectId,
      input.occurredAt,
      input.billingEpochId,
    ],
  );
  await db.query(
    "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,0,'OperationQueued','{}'::jsonb,$5)",
    [
      input.organizationId,
      input.operationEventId,
      input.operationId,
      input.projectId,
      input.occurredAt,
    ],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,$4,$5,$9,$6,'{}'::jsonb,$7,$8)",
    [
      input.organizationId,
      input.auditEventId,
      input.projectId,
      input.operationId,
      input.eventType,
      input.principalId,
      input.occurredAt,
      input.billingEpochId,
      input.actorType,
    ],
  );
  await db.query(
    "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id) VALUES($1,$2,$3,$4,$5,jsonb_build_object('environmentId',$6::text),$7,$9,$9,5,$8)",
    [
      input.organizationId,
      input.outboxEventId,
      input.projectId,
      input.operationId,
      input.eventType,
      input.environmentId,
      input.occurredAt,
      input.billingEpochId,
      input.occurredAt,
    ],
  );
  await db.query(
    "UPDATE api_idempotency_records SET operation_id=$6::ulid,http_status=202,response_headers=jsonb_build_object('Location',$7::text),response_body=jsonb_build_object('operation_id',$6::text),completed_at=$8::timestamptz,expires_at=$8::timestamptz+interval '24 hours' WHERE organization_id=$1 AND principal_id=$2 AND http_method=$3 AND route_template=$4 AND idempotency_key=$5",
    [...key, input.operationId, `/v1/operations/${input.operationId}`, input.occurredAt],
  );
}
// One operation transition (projection, event and audit) as the original PostgreSQL store records it, as plain SQL.
async function transitionOperationRow(db, step) {
  await db.query(
    "UPDATE operations SET state=$3,failure=$4::jsonb,updated_at=$5,lease_expires_at=CASE WHEN $3 IN ('queued','running') THEN $5::timestamptz+interval '15 minutes' ELSE NULL END WHERE organization_id=$1 AND operation_id=$2",
    [
      step.organizationId,
      step.operationId,
      step.state,
      step.failure === undefined ? null : JSON.stringify(step.failure),
      step.occurredAt,
    ],
  );
  await db.query(
    "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,event_type,revision,idempotency_key,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
    [
      step.organizationId,
      step.eventId,
      step.operationId,
      project,
      step.eventType,
      step.revision,
      step.idempotencyKey,
      JSON.stringify(step.failure === undefined ? {} : { failure: step.failure }),
      step.occurredAt,
    ],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,$4,$5,'service','spine','{}'::jsonb,$6,$7)",
    [
      step.organizationId,
      step.auditEventId,
      project,
      step.operationId,
      step.eventType,
      step.occurredAt,
      step.billingEpochId,
    ],
  );
}
// The frozen transfer A -> B (transfer 10101) as the original PostgreSQL stores record it, as plain SQL.
async function freezeTransfer(db) {
  const frozen = at(2);
  await db.query(
    "UPDATE environments SET dev_access_epoch=dev_access_epoch+1 WHERE project_id=$1 AND name='dev'",
    [project],
  );
  await db.query(
    "UPDATE project_ownerships SET state='transfer_pending_frozen',ownership_version=2,updated_at=$2 WHERE project_id=$1",
    [project, frozen],
  );
  await db.query(
    "INSERT INTO project_transfer_intents(transfer_id,project_id,source_organization_id,target_organization_id,state,expected_ownership_version,initiated_by_principal_id,created_at,completed_at,cancelled_at,failure_code) VALUES($1,$2,$3,$4,'pending_frozen',2,'service:spine',$5,NULL,NULL,NULL)",
    [id(10101), project, A, B, frozen],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,NULL,'ProjectTransferFrozen','principal','service:spine',$4::jsonb,$5,$6)",
    [
      A,
      id(10103),
      project,
      JSON.stringify({ transferId: id(10101), outcome: "pending_frozen", failureCode: null }),
      frozen,
      oldEpoch,
    ],
  );
}
// The completed frozen transfer A -> B (transfer 10101) as the original PostgreSQL stores record it, as plain SQL.
async function completeTransfer(db) {
  const transferred = at(2),
    transfer = { transferId: id(10101), outcome: "completed" };
  await db.query("UPDATE billing_epochs SET ended_at=$2 WHERE billing_epoch_id=$1", [
    oldEpoch,
    transferred,
  ]);
  await db.query(
    "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES($1,$2,$3,$4,'service:spine')",
    [epoch, project, B, transferred],
  );
  await db.query(
    "UPDATE project_ownerships SET organization_id=$2,state='active',ownership_version=ownership_version+1,active_billing_epoch_id=$3,updated_at=$4 WHERE project_id=$1",
    [project, B, epoch, transferred],
  );
  await db.query(
    "UPDATE project_transfer_intents SET state='completed',completed_at=$2 WHERE transfer_id=$1",
    [id(10101), transferred],
  );
  await db.query(
    "INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES($1,$2,$3,'queued',$4,$4,$5)",
    [B, id(10108), project, transferred, epoch],
  );
  await db.query(
    "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,0,'OperationQueued','{}'::jsonb,$5)",
    [B, id(10109), id(10108), project, transferred],
  );
  await db.query(
    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,NULL,'ProjectOwnershipTransferred','principal','service:spine',$4::jsonb,$5,$6),($7,$8,$3,$9,'ProjectOwnershipTransferred','system','redacted',$10::jsonb,$5,$11)",
    [
      A,
      id(10104),
      project,
      JSON.stringify({ transferId: id(10101), sourceOrganizationId: A, targetOrganizationId: B }),
      transferred,
      oldEpoch,
      B,
      id(10105),
      id(10108),
      JSON.stringify(transfer),
      epoch,
    ],
  );
  await db.query(
    "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id) VALUES($1,$2,$3,$4,'ProjectOwnershipTransferred',$5::jsonb,$6,$6,$6,3,$7)",
    [B, id(10106), project, id(10108), JSON.stringify(transfer), transferred, epoch],
  );
}

async function priorWithParents(through, label) {
  const prior = await coreFixtureThrough(through);
  try {
    const tables = new Set([
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
    ]);
    const { digest, ...body } = plan;
    void digest;
    const value = {
      ...body,
      targetPin: prior.pin,
      records: plan.records.filter((record) => tables.has(record.table)),
      sequenceRestores: [],
      requiredTemporalTables: ["operations"],
      verdict: "INCOMPLETE",
      runtimeGates: ["LOCAL-POPULATED-FORWARD-MIGRATION-ONLY"],
    };
    await importPlan({
      db: prior.db,
      plan: { ...value, digest: sha256(Buffer.from(canonical(value))) },
      key: fixture.key,
      targetId: label,
      journal: join(fixture.directory, `${label}.journal`),
      currentPin: prior.pin,
    });
    return prior;
  } catch (error) {
    await prior.dispose();
    throw error;
  }
}
async function insertRow(db, table, row) {
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(...Object.values(row))
    .run();
}
async function provePopulatedAuditSplit() {
  const sql = await readFile(
    join(repositoryRoot, "apps/control-store/migrations/core/0383_original_audit_namespaces.sql"),
    "utf8",
  );
  const organization = image.rows.get("organization_audit_events")[0],
    projectAudit = image.rows
      .get("audit_events")
      .find((row) => row.audit_event_id !== organization.audit_event_id);
  for (const variant of ["unambiguous", "scope", "export", "horizon"]) {
    const prior = await priorWithParents("0382_original_delivery_attempts.sql", `audit-${variant}`);
    try {
      const prototype = {
        ...organization,
        project_id: null,
        operation_id: variant === "scope" ? old.operationId : null,
        billing_epoch_id: null,
      };
      await insertRow(prior.db, "audit_events", prototype);
      await insertRow(prior.db, "audit_events", projectAudit);
      if (variant === "export")
        await prior.db
          .prepare(
            "INSERT INTO evidence_exports VALUES(?,?, 'audit_events','2027-01-01T00:00:00.000000Z','2027-03-01T00:00:00.000000Z',1,unhex(?),'unqualified-prototype','2027-02-01T00:00:00.000000Z')",
          )
          .bind(id(11001), A, "11".repeat(32))
          .run();
      if (variant === "horizon")
        await prior.db
          .prepare(
            "INSERT INTO retention_horizon VALUES('audit_events','2099-01-01T00:00:00.000000Z','2027-02-01T00:00:00.000000Z')",
          )
          .run();
      const before = canonical(
          (await prior.db.prepare("SELECT * FROM audit_events ORDER BY audit_event_id").all())
            .results,
        ),
        schema = await schemaFingerprint(prior.db);
      const apply = () =>
        prior.db.batch(splitSql(sql).map((statement) => prior.db.prepare(statement)));
      if (variant === "unambiguous") {
        await apply();
        assert.deepEqual(
          await prior.db.prepare("SELECT * FROM organization_audit_events").first(),
          organization,
        );
        assert.deepEqual(
          await prior.db.prepare("SELECT * FROM audit_events").first(),
          projectAudit,
        );
        const same = image.rows
          .get("audit_events")
          .find((row) => row.audit_event_id === organization.audit_event_id);
        await insertRow(prior.db, "audit_events", same);
        assert.equal(
          (
            await prior.db
              .prepare("SELECT count(*) n FROM audit_events WHERE audit_event_id=?")
              .bind(organization.audit_event_id)
              .first()
          ).n,
          1,
        );
        assert.equal(
          (
            await prior.db
              .prepare("SELECT count(*) n FROM organization_audit_events WHERE audit_event_id=?")
              .bind(organization.audit_event_id)
              .first()
          ).n,
          1,
        );
      } else {
        await assert.rejects(apply(), /precondition_changed/u);
        assert.equal(await schemaFingerprint(prior.db), schema);
        assert.equal(
          canonical(
            (await prior.db.prepare("SELECT * FROM audit_events ORDER BY audit_event_id").all())
              .results,
          ),
          before,
        );
      }
    } finally {
      await prior.dispose();
    }
  }
}
async function provePopulatedAssignmentRepair() {
  const prior = await priorWithParents("0383_original_audit_namespaces.sql", "assignment-forward");
  try {
    const currentRows = image.rows
      .get("environment_data_assignments")
      .filter((row) => row.organization_id === B);
    for (const row of currentRows) await insertRow(prior.db, "environment_data_assignments", row);
    const before = canonical(
      (
        await prior.db
          .prepare(
            "SELECT organization_id,project_id,environment_id,data_environment_id,CAST(assignment_version AS TEXT) assignment_version,assigned_at,operation_id FROM environment_data_assignments ORDER BY environment_id",
          )
          .all()
      ).results,
    );
    const sql = await readFile(
      join(
        repositoryRoot,
        "apps/control-store/migrations/core/0384_original_assignment_history.sql",
      ),
      "utf8",
    );
    await prior.db.batch(splitSql(sql).map((statement) => prior.db.prepare(statement)));
    assert.equal(
      canonical(
        (
          await prior.db
            .prepare(
              "SELECT organization_id,project_id,environment_id,data_environment_id,CAST(assignment_version AS TEXT) assignment_version,assigned_at,operation_id FROM environment_data_assignments ORDER BY environment_id",
            )
            .all()
        ).results,
      ),
      before,
    );
    assert.equal((await prior.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
    assert.equal(
      (await prior.db.prepare("PRAGMA defer_foreign_keys").first()).defer_foreign_keys,
      0,
    );
  } finally {
    await prior.dispose();
  }
}
async function proveNoInventedDeliveryHistory() {
  const sql = await readFile(
    join(repositoryRoot, "apps/control-store/migrations/core/0382_original_delivery_attempts.sql"),
    "utf8",
  );
  for (const history of [false, true]) {
    const prior = await priorWithParents(
      "0381_original_operation_history_admission.sql",
      `delivery-forward-${history}`,
    );
    try {
      const original = image.rows
        .get("outbox_events")
        .find((row) =>
          history ? row.event_id === current.outboxEventId : row.attempt_count === "0",
        );
      await insertRow(prior.db, "outbox_events", {
        ...original,
        last_attempt_status: history ? "retry_scheduled" : null,
      });
      const before = canonical(
          (await prior.db.prepare("SELECT * FROM outbox_events").all()).results,
        ),
        schema = await schemaFingerprint(prior.db);
      const apply = () =>
        prior.db.batch(splitSql(sql).map((statement) => prior.db.prepare(statement)));
      if (history) {
        await assert.rejects(apply(), /precondition_changed/u);
        assert.equal(await schemaFingerprint(prior.db), schema);
        assert.equal(
          await prior.db
            .prepare("SELECT name FROM sqlite_master WHERE name='delivery_attempts'")
            .first(),
          null,
        );
      } else {
        await apply();
        assert.equal(
          (await prior.db.prepare("SELECT count(*) n FROM delivery_attempts").first()).n,
          0,
        );
      }
      assert.equal(
        canonical((await prior.db.prepare("SELECT * FROM outbox_events").all()).results),
        before,
      );
    } finally {
      await prior.dispose();
    }
  }
}

before(
  async () => {
    fixture = await originalControlFixture("spine");
    await inTransaction(fixture.pool, async (db) => {
      for (const [org, workos] of [
        [A, "org_spine_a"],
        [B, "org_spine_b"],
      ])
        await db.query(
          "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at,beta_admitted_at) VALUES($1,$2,'active',1,decode(repeat('aa',32),'hex'),$3,$3,$3,$3)",
          [org, workos, at(1)],
        );
      await db.query(
        "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at) VALUES($1,$2,'spine','spine-fixture','customer-chosen-v1',0,$3,$4)",
        [project, A, id(10007), at(1)],
      );
      await db.query("INSERT INTO billing_epochs VALUES($1,$2,$3,$4,NULL,'service:spine')", [
        oldEpoch,
        project,
        A,
        at(1),
      ]);
      await db.query("INSERT INTO project_ownerships VALUES($1,$2,'active',1,$3,$4)", [
        project,
        A,
        oldEpoch,
        at(1),
      ]);
      await db.query(
        "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$4,$4),($1,$5,$3,'prod','{}',$4,$4)",
        [A, dev, project, at(1), id(10005)],
      );
      await acceptOperation(db, old);
      for (const step of [
        {
          state: "running",
          eventType: "OperationStarted",
          revision: 1,
          idempotencyKey: "old-start",
          eventId: id(10015),
          auditEventId: id(10016),
          occurredAt: at(1, 1),
        },
        {
          state: "failed",
          eventType: "OperationFailed",
          revision: 2,
          idempotencyKey: "old-fail",
          failure: { code: "RETAINED_FAILURE", message: "Original Über 😀" },
          eventId: id(10017),
          auditEventId: id(10018),
          occurredAt: at(1, 2),
        },
      ])
        await transitionOperationRow(db, {
          ...step,
          organizationId: A,
          operationId: old.operationId,
          billingEpochId: oldEpoch,
        });
      await freezeTransfer(db);
      await completeTransfer(db);
      await acceptOperation(db, current);
      // The two ORIGINAL audit namespaces may retain the SAME global id/org/instant with distinct opaque bytes.
      await db.query(
        "INSERT INTO organization_audit_events(organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES($1,$2,'OrganizationFixture','service','spine',$3::jsonb,$4)",
        [A, old.auditEventId, JSON.stringify({ original: "Org namespace Über" }), old.occurredAt],
      );
    });
    await inTransaction(fixture.pool, (db) =>
      claimDelivery(db, {
        eventId: eventScope.eventId,
        attemptId: id(10215),
        claimedAt: at(3, 1),
        leaseMilliseconds: 60_000,
      }),
    );
    await inTransaction(fixture.pool, (db) =>
      scheduleRetry(
        db,
        failure(id(10215), id(10216), at(3, 1).replace(":00.000Z", ":10.000Z"), at(3, 2)),
        1,
      ),
    );
    image = await fixture.image("initial");
    plan = await fixture.import(image, "spine");
    store = createControlStore({ CONTROL_CORE: fixture.db });
  },
  { timeout: 240_000 },
);
after(async () => fixture?.dispose());

test("original history, two independent audit namespaces, exact HTTP receipts and every delivery fact survive import", async () => {
  assert.deepEqual(plan.gaps, []);
  const facts = await readSpineSourceFacts(fixture.db);
  for (const table of Object.keys(SPINE_COLUMNS)) {
    const columns = image.manifest.tables.find((entry) => entry.name === table).columns,
      values = (rows) => rows.map((row) => columns.map((column) => row[column.name]));
    assert.equal(plan.mapped.includes(table), true, table);
    assert.deepEqual(
      tableProof(columns, values(facts.get(table))),
      tableProof(columns, values(image.rows.get(table))),
      table,
    );
  }
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT owner_state FROM projects WHERE organization_id=? AND project_id=?")
        .bind(A, project)
        .first()
    ).owner_state,
    "transferred",
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT count(*) n FROM environments WHERE organization_id=?")
        .bind(A)
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT count(*) n FROM environment_data_assignments WHERE organization_id=?")
        .bind(A)
        .first()
    ).n,
    2,
  );
  // A named operations import exception never admits the wrong original organization/epoch tuple.
  await assert.rejects(
    fixture.db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)",
      )
      .bind(
        B,
        id(10701),
        project,
        oldEpoch,
        at(3).replace(/Z$/u, "000Z"),
        at(3).replace(/Z$/u, "000Z"),
      )
      .run(),
    /original project epoch|FOREIGN KEY/u,
  );
  await fixture.activate("source-spine-comparison");
  for (const receipt of [old, current]) {
    const key = {
      organizationId: receipt.organizationId,
      principalId: receipt.principalId,
      httpMethod: receipt.httpMethod,
      routeTemplate: receipt.routeTemplate,
      idempotencyKey: receipt.idempotencyKey,
    };
    assert.deepEqual(await store.operations.readStoredIdempotencyResponse(key), {
      httpStatus: 202,
      responseHeaders: { Location: `/v1/operations/${receipt.operationId}` },
      responseBody: { operation_id: receipt.operationId },
    });
  }
  assert.equal(
    (await store.operations.loadOperation({ organizationId: A, operationId: old.operationId }))
      .state,
    "failed",
  );
  assert.equal(
    (
      await store.operations.readAuditEvents({
        organizationId: A,
        scope: "organization",
        limit: 100,
      })
    ).events.some((event) => event.eventId === old.auditEventId),
    true,
  );
  assert.equal(
    (
      await store.operations.readAuditEvents({ organizationId: A, scope: "project", limit: 100 })
    ).events.some((event) => event.eventId === old.auditEventId),
    true,
  );
});

test("the NEXT operation transition, idempotent retry and next claimed delivery/failure/ACK continue the imported history", async () => {
  const now = at(3, 2),
    attempt = id(10217);
  await inTransaction(fixture.pool, (db) =>
    claimDelivery(db, {
      eventId: eventScope.eventId,
      attemptId: attempt,
      claimedAt: now,
      leaseMilliseconds: 60_000,
    }),
  );
  const d1Claim = await store.operations.claimOutboxEvent({
    eventScope,
    attemptId: attempt,
    now,
    leaseMilliseconds: 60_000,
  });
  assert.deepEqual(d1Claim, {
    eventId: current.outboxEventId,
    organizationId: B,
    projectId: project,
    operationId: current.operationId,
    billingEpochId: epoch,
    eventType: "ProjectHandleChangeRequestedV1",
    payload: { environmentId: dev },
    attemptId: attempt,
    attemptNumber: 2,
    maxAttempts: 5,
    claimedAt: now,
    leaseExpiresAt: at(3, 3),
  });
  const next = failure(attempt, id(10218), at(3, 3), at(3, 4));
  await inTransaction(fixture.pool, (db) => scheduleRetry(db, next, 2));
  const { eventId: auditEventId, ...audit } = next.audit;
  const d1Fail = await store.operations.recordOutboxDeliveryFailure({
    ...next,
    organizationId: B,
    audit: { ...audit, auditEventId },
  });
  assert.deepEqual(d1Fail, { outcome: "retry_scheduled", attemptNumber: 2 });
  const finalAttempt = id(10219),
    ackTime = at(3, 5);
  await inTransaction(fixture.pool, (db) =>
    claimDelivery(db, {
      eventId: eventScope.eventId,
      attemptId: finalAttempt,
      claimedAt: at(3, 4),
      leaseMilliseconds: 60_000,
    }),
  );
  await store.operations.claimOutboxEvent({
    eventScope,
    attemptId: finalAttempt,
    now: at(3, 4),
    leaseMilliseconds: 60_000,
  });
  const acknowledgements = new WeakSet();
  let lostAck = false;
  const uncertain = {
    prepare: (sql) => {
      const statement = fixture.db.prepare(sql);
      if (sql.startsWith("UPDATE outbox_events AS event SET acknowledged_at="))
        return {
          bind: (...values) => {
            const bound = statement.bind(...values);
            acknowledgements.add(bound);
            return bound;
          },
        };
      return statement;
    },
    batch: async (statements) => {
      const result = await fixture.db.batch(statements);
      if (!lostAck && statements.some((statement) => acknowledgements.has(statement))) {
        lostAck = true;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  const recoveredAckStore = createControlStore({ CONTROL_CORE: uncertain });
  await inTransaction(fixture.pool, (db) =>
    acknowledgeDelivery(db, {
      eventId: current.outboxEventId,
      attemptId: finalAttempt,
      acknowledgedAt: ackTime,
    }),
  );
  assert.equal(
    await recoveredAckStore.operations.acknowledgeOutboxEvent({
      organizationId: B,
      eventId: current.outboxEventId,
      attemptId: finalAttempt,
      now: ackTime,
    }),
    true,
  );
  assert.equal(lostAck, true);
  const transitionedAt = at(3, 6),
    transitionEvent = id(10220),
    transitionAudit = id(10221);
  await inTransaction(fixture.pool, (db) =>
    transitionOperationRow(db, {
      organizationId: B,
      operationId: current.operationId,
      billingEpochId: epoch,
      state: "running",
      eventType: "OperationStarted",
      revision: 1,
      idempotencyKey: "spine-start",
      eventId: transitionEvent,
      auditEventId: transitionAudit,
      occurredAt: transitionedAt,
    }),
  );
  const transition = {
    organizationId: B,
    operationId: current.operationId,
    expected: { state: "queued", eventCount: 1 },
    event: {
      eventId: transitionEvent,
      type: "OperationStarted",
      idempotencyKey: "spine-start",
      occurredAt: transitionedAt,
    },
    audit: {
      auditEventId: transitionAudit,
      projectId: project,
      operationId: current.operationId,
      eventType: "OperationStarted",
      actorType: "service",
      actorId: "spine",
      payload: {},
      occurredAt: transitionedAt,
    },
  };
  assert.equal((await store.operations.transitionOperation(transition)).state, "running");
  assert.equal((await store.operations.transitionOperation(transition)).outcome, "replayed");
  const coreOperation = await store.operations.loadOperation({
    organizationId: B,
    operationId: current.operationId,
  });
  assert.equal(coreOperation.state, "running");
  assert.deepEqual(
    coreOperation.events.map(({ eventId, type, projectId, occurredAt }) => ({
      eventId,
      type,
      projectId,
      occurredAt,
    })),
    [
      {
        eventId: current.operationEventId,
        type: "OperationQueued",
        projectId: project,
        occurredAt: at(3),
      },
      {
        eventId: transitionEvent,
        type: "OperationStarted",
        projectId: project,
        occurredAt: transitionedAt,
      },
    ],
  );
  const captured = await fixture.image("after-next");
  const target = await readSpineSourceFacts(fixture.db);
  for (const table of ["outbox_events", "delivery_attempts"]) {
    const columns = captured.manifest.tables.find((entry) => entry.name === table).columns,
      values = (rows) => rows.map((row) => columns.map((column) => row[column.name]));
    assert.deepEqual(
      tableProof(columns, values(target.get(table))),
      tableProof(columns, values(captured.rows.get(table))),
      table,
    );
  }
});

test("evidence stays immutable after export/horizon metadata and old ownership cannot create new operations", async () => {
  await proveNoInventedDeliveryHistory();
  await provePopulatedAuditSplit();
  await provePopulatedAssignmentRepair();
  const late = api(B, epoch, 10601, 4),
    scope = {
      organizationId: B,
      projectId: project,
      operationId: late.operationId,
      eventId: late.outboxEventId,
    };
  await store.operations.acceptApiOperation({
    ...late,
    canonicalRequestDigest: Buffer.from(late.canonicalRequestDigest).toString("hex"),
  });
  await fixture.db
    .prepare(
      "CREATE TRIGGER fail_spine_attempt BEFORE INSERT ON delivery_attempts BEGIN SELECT RAISE(ABORT,'fixture_late_attempt'); END",
    )
    .run();
  const attempt = id(10605),
    now = at(4, 1);
  await assert.rejects(
    store.operations.claimOutboxEvent({
      eventScope: scope,
      attemptId: attempt,
      now,
      leaseMilliseconds: 60_000,
    }),
    /fixture_late_attempt/u,
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT attempt_count FROM outbox_events WHERE event_id=?")
        .bind(scope.eventId)
        .first()
    ).attempt_count,
    0,
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT count(*) n FROM delivery_attempts WHERE attempt_id=?")
        .bind(attempt)
        .first()
    ).n,
    0,
  );
  await fixture.db.prepare("DROP TRIGGER fail_spine_attempt").run();
  for (const table of ["audit_events", "organization_audit_events", "operation_events"]) {
    await fixture.db
      .prepare(
        "INSERT INTO retention_horizon VALUES(?,'2099-01-01T00:00:00.000000Z','2027-01-01T00:00:00.000000Z')",
      )
      .bind(table)
      .run();
    await assert.rejects(fixture.db.prepare(`DELETE FROM ${table}`).run(), /append-only/u);
    await assert.rejects(fixture.pool.query(`DELETE FROM ${table}`), /append-only/u);
    await assert.rejects(
      fixture.db.prepare(`UPDATE ${table} SET occurred_at='2098-01-01T00:00:00.000000Z'`).run(),
      /append-only/u,
    );
    await assert.rejects(
      fixture.pool.query(`UPDATE ${table} SET occurred_at='2098-01-01T00:00:00Z'`),
      /append-only/u,
    );
    await assert.rejects(
      store.maintenance.purgeEvidenceBelowHorizon({
        organizationId: A,
        tableName: table,
        limit: 100,
      }),
      (error) => error.code === "evidence_immutable",
    );
  }
  const historical = image.rows
    .get("environment_data_assignments")
    .find((row) => row.organization_id === A);
  const staleAssignment = { ...historical, assignment_version: "99" },
    columns = Object.keys(staleAssignment);
  await assert.rejects(
    fixture.db
      .prepare(
        `INSERT INTO environment_data_assignments(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      )
      .bind(...Object.values(staleAssignment))
      .run(),
    /current environment scope/u,
  );
  await assert.rejects(
    fixture.pool.query(
      `INSERT INTO environment_data_assignments(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      Object.values(staleAssignment),
    ),
    /current environment scope/u,
  );
  const foreign = api(A, oldEpoch, 10501, 4);
  await assert.rejects(
    store.operations.acceptApiOperation({
      ...foreign,
      canonicalRequestDigest: Buffer.from(foreign.canonicalRequestDigest).toString("hex"),
    }),
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT count(*) n FROM operations WHERE operation_id=?")
        .bind(foreign.operationId)
        .first()
    ).n,
    0,
  );
});
