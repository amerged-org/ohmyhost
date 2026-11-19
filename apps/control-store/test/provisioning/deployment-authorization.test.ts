import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import {
  assertProductOperationExecution,
  authorizeProductActivation,
} from "../../src/catalog/provisioning/deployment-authorization.js";
import { recordProductDeploymentCandidate } from "../../src/catalog/provisioning/deployment-candidate.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  beforeFirstWrite,
  losingWriteResponses,
  STORED_NOW,
} from "../support/platform-fixtures.js";
import {
  candidateRecord,
  claimedWorkflow,
  deploymentContext as context,
  type Workflow,
} from "../support/deployment-commands-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const scopeOf = (r: Workflow) => ({
  organizationId: r.input.organizationId,
  projectId: r.input.projectId,
  operationId: r.input.operationId,
});

/** One enabled auto-deployment configuration and its push reservations; the accepted operation is push 1. */
async function seedPushes(r: Workflow) {
  const db = control.core,
    push = (sequence: number, operationId: string | null) => ({
      id: newUlid(),
      inbox: newUlid(),
      sequence,
      operationId,
    }),
    first = push(1, r.input.operationId),
    newer = push(2, null);
  const row = (p: ReturnType<typeof push>) => [
    db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push','{}',?3,?4,'pending',5,?4,?5)",
      )
      .bind(p.inbox, p.id, new Uint8Array(32).fill(1), STORED_NOW, r.input.organizationId),
    db
      .prepare(
        "INSERT INTO github_push_deployments(push_deployment_id,inbox_event_id,organization_id,project_id,source_connection_id,config_generation,delivery_guid,github_installation_id,external_repository_id,branch_ref,commit_sha,sequence,operation_id,state,cleanup_required,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,'7','42','refs/heads/main',?7,?8,?9,?10,0,?11,?11)",
      )
      .bind(
        p.id,
        p.inbox,
        r.input.organizationId,
        r.input.projectId,
        r.source,
        `0000000${p.sequence}-0000-4000-8000-000000000000`,
        String(p.sequence).repeat(40),
        p.sequence,
        p.operationId,
        p.operationId === null ? "reserved" : "queued",
        STORED_NOW,
      ),
  ];
  await db
    .prepare(
      "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
    )
    .bind(r.input.organizationId, r.input.projectId, r.source, STORED_NOW)
    .run();
  await db.batch(row(first));
  return { newer: () => db.batch(row(newer)), newerId: newer.id };
}

it("asserts execution and decides activation against the GitHub push generation and the candidate scope", async () => {
  const r = await claimedWorkflow(control),
    scope = scopeOf(r);
  await expect(
    assertProductOperationExecution(context(control.core), scope),
  ).resolves.toBeUndefined();
  expect(await authorizeProductActivation(context(control.core), scope)).toEqual({ allowed: true });
  // The committed answer of a lost response is read back and re-guarded.
  expect(
    await authorizeProductActivation(context(losingWriteResponses(control.core, 1)), scope),
  ).toEqual({ allowed: true });
  await expect(
    authorizeProductActivation(context(control.core), { ...scope, candidateReceiptId: newUlid() }),
  ).rejects.toThrow("WFP candidate activation scope changed");
  await expect(
    assertProductOperationExecution(context(control.core), { ...scope, claimId: r.input.claimId }),
  ).rejects.toThrow();

  const input = candidateRecord(r),
    withCandidate = { ...scope, candidateReceiptId: input.candidate.candidateReceiptId };
  expect(await recordProductDeploymentCandidate(context(control.core), input)).toBe("created");
  const pushes = await seedPushes(r);
  // Operation is push 1 and the latest: allowed, with or without a candidate.
  expect(await authorizeProductActivation(context(control.core), scope)).toEqual({ allowed: true });
  expect(await authorizeProductActivation(context(control.core), withCandidate)).toEqual({
    allowed: true,
  });
  await pushes.newer();
  // A newer push supersedes this operation: the candidate scope names the newer push, the bare scope itself.
  expect(await authorizeProductActivation(context(control.core), scope)).toEqual({
    allowed: false,
    supersededById: r.input.operationId,
  });
  expect(await authorizeProductActivation(context(control.core), withCandidate)).toEqual({
    allowed: false,
    supersededById: pushes.newerId,
  });
  // Execution assertions are not push decisions.
  await expect(
    assertProductOperationExecution(context(control.core), scope),
  ).resolves.toBeUndefined();
}, 60_000);

it("maps consent revoked between the read and the batch to the typed authorization conflict", async () => {
  const r = await claimedWorkflow(control, { delegated: true }),
    scope = scopeOf(r);
  expect(await authorizeProductActivation(context(control.core), scope)).toEqual({ allowed: true });
  let revoked = false;
  const race = beforeFirstWrite(control.core, async () => {
    revoked = true;
    await control.core
      .prepare(
        "UPDATE mcp_client_grants SET revoked_at='2026-10-28T11:00:06.000000Z' WHERE grant_id=?",
      )
      .bind(r.grantId)
      .run();
  });
  await expect(assertProductOperationExecution(context(race), scope)).rejects.toMatchObject({
    name: "OperationAuthorizationConflictError",
    code: "operation_authorization_changed",
  });
  expect(revoked).toBe(true);
  await expect(authorizeProductActivation(context(control.core), scope)).rejects.toMatchObject({
    name: "OperationAuthorizationConflictError",
  });
}, 60_000);
