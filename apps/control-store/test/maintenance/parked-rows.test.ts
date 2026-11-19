import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { listParkedRows } from "../../src/catalog/maintenance/parked-rows.js";
import { createTestControl } from "../support/control-d1.js";
import { seedAcceptedOperation } from "../support/accepted-operation.js";
import { seedProject } from "../support/platform-fixtures.js";
import { SharedCoreRouter } from "../../src/router.js";

it("lists every parked row across the Stripe inbox, outbox, reservations and operations for an operator", async () => {
  const c = await createTestControl();
  try {
    const project = await seedProject(c);
    const accepted = await seedAcceptedOperation(project, project.devEnvironmentId);
    const at = "2026-10-28T12:00:00.000000Z";
    // a Stripe event parked by its tenth failed attempt
    const inbox = newUlid();
    await c.core
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,attempt_count,max_attempts,available_at,last_error_code) VALUES(?1,'stripe',?2,'invoice.paid','{\"accountId\":\"acct_parked\",\"mode\":\"test\"}',zeroblob(32),?3,'reconciliation_required',10,10,?3,'STRIPE_REJECTED')",
      )
      .bind(inbox, `evt_${inbox}`, at)
      .run();
    // the accepted operation's outbox event parked after its final Queue send failed
    await c.core
      .prepare(
        "UPDATE outbox_events SET attempt_count=5,max_attempts=5,last_error_code='PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN',reconciliation_required_at=?2 WHERE event_id=?1",
      )
      .bind(accepted.eventId, at)
      .run();

    const rows = await listParkedRows(
      { directory: c.core, router: new SharedCoreRouter(c.core) },
      { organizationId: project.organizationId, limit: 50 },
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "stripe_inbox", id: inbox, errorCode: "STRIPE_REJECTED" }),
        expect.objectContaining({
          kind: "outbox_event",
          id: accepted.eventId,
          errorCode: "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN",
        }),
        expect.objectContaining({ kind: "operation", id: accepted.operationId }),
      ]),
    );
  } finally {
    await c.dispose();
  }
});

it("lists a bucket reservation whose operation ended without a receipt", async () => {
  const c = await createTestControl();
  try {
    const project = await seedProject(c);
    const accepted = await seedAcceptedOperation(project, project.devEnvironmentId);
    const bucketName = `ohmyho-${project.projectId.toLowerCase()}-${project.devEnvironmentId.toLowerCase()}`;
    await c.core
      .prepare(
        "INSERT INTO project_r2_bucket_reservations(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,jurisdiction,storage_class,public_access) VALUES(?1,?2,?3,?4,?5,?6,'eu','Standard',0)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        project.devEnvironmentId,
        accepted.operationId,
        accepted.claimId,
        bucketName,
      )
      .run();
    await c.core
      .prepare("UPDATE operations SET state='failed' WHERE organization_id=?1 AND operation_id=?2")
      .bind(project.organizationId, accepted.operationId)
      .run();

    const rows = await listParkedRows(
      { directory: c.core, router: new SharedCoreRouter(c.core) },
      { organizationId: project.organizationId, limit: 50 },
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "r2_bucket_reservation",
        id: accepted.claimId,
        state: "failed",
      }),
    ]);
  } finally {
    await c.dispose();
  }
});
