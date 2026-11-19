import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import {
  activateTestCore,
  migrationFiles,
  shardBinding,
  type TestControl,
} from "../support/control-d1.js";
import {
  seedBucketReservation,
  seedNativeDatabaseCreate,
  seedPlacementReservation,
  seedReconciliationAttempt,
  seedSupersededPush,
} from "../support/superseded-push.js";
import { splitStatements } from "../support/sql.js";
import { candidateResources } from "../support/provisioning-cleanup-fixtures.js";

// This test builds the pre-0647 history. The current cleanup commands require later schema, so
// write their already-completed historical fixture facts directly, under the original constraints.
// The migration and all of its before/after trigger checks still run against the untouched schema.
vi.mock("../../src/catalog/provisioning/deployment-cleanup.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/catalog/provisioning/deployment-cleanup.js")>();
  return {
    ...original,
    prepareProductCandidateCleanup: async (_context: unknown, raw: unknown) => {
      const input = raw as {
        cleanupRequestId: string;
        claimId: string;
        requestedAt: string;
        leaseExpiresAt: string;
        reason: string;
        supersededById: string;
        candidate: {
          candidateReceiptId: string;
          organizationId: string;
          projectId: string;
          operationId: string;
        };
      };
      const c = input.candidate;
      if (input.reason !== "superseded") throw new Error("Unexpected historical cleanup reason");
      const timestamp = (value: string) => value.replace(/Z$/u, "000Z");
      const resources = await candidateResources();
      await db.batch([
        db
          .prepare(
            "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES(?,?,?,?,?,'superseded',?)",
          )
          .bind(
            input.cleanupRequestId,
            c.candidateReceiptId,
            c.organizationId,
            c.projectId,
            c.operationId,
            timestamp(input.requestedAt),
          ),
        ...resources.map((r) =>
          db
            .prepare(
              "INSERT INTO wfp_candidate_cleanup_resource_expectations(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256) VALUES(?,?,?,?,?,?,?,?)",
            )
            .bind(
              input.cleanupRequestId,
              c.candidateReceiptId,
              c.organizationId,
              c.projectId,
              c.operationId,
              r.provider,
              r.resourceKind,
              r.resourceIdentityDigest,
            ),
        ),
        db
          .prepare(
            "UPDATE github_push_deployments SET state='cleanup_pending',superseded_by_id=?4,cleanup_required=1,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running') AND cleanup_required=0",
          )
          .bind(
            c.organizationId,
            c.projectId,
            c.operationId,
            input.supersededById,
            timestamp(input.requestedAt),
          ),
        db
          .prepare(
            "INSERT INTO wfp_candidate_cleanup_claims(candidate_receipt_id,organization_id,project_id,claim_id,attempt_number,claimed_at,lease_expires_at) VALUES(?,?,?,?,1,?,?)",
          )
          .bind(
            c.candidateReceiptId,
            c.organizationId,
            c.projectId,
            input.claimId,
            timestamp(input.requestedAt),
            timestamp(input.leaseExpiresAt),
          ),
      ]);
      const push = await db
        .prepare(
          "SELECT state,superseded_by_id,cleanup_required FROM github_push_deployments WHERE organization_id=? AND project_id=? AND operation_id=?",
        )
        .bind(c.organizationId, c.projectId, c.operationId)
        .first<{ state: string; superseded_by_id: string; cleanup_required: number }>();
      if (
        push?.state !== "cleanup_pending" ||
        push.superseded_by_id !== input.supersededById ||
        push.cleanup_required !== 1
      )
        throw new Error("Historical cleanup fixture did not mark its push");
    },
    recordProductCandidateCleanup: async (_context: unknown, raw: unknown) => {
      const input = raw as {
        receipt: {
          cleanupReceiptId: string;
          candidateReceiptId: string;
          organizationId: string;
          projectId: string;
          claimId: string;
          outcome: string;
          observedProviderTag: string;
          observedAt: string;
        };
        resources: Array<{
          operationCleanupReceiptId: string;
          candidateReceiptId: string;
          organizationId: string;
          projectId: string;
          operationId: string;
          provider: string;
          resourceKind: string;
          resourceIdentityDigest: Uint8Array;
          outcome: string;
          observedAt: string;
        }>;
      };
      const r = input.receipt;
      const parent = await db
        .prepare(
          "SELECT environment_id,operation_id,provider_tag FROM wfp_candidate_receipts WHERE candidate_receipt_id=? AND organization_id=? AND project_id=?",
        )
        .bind(r.candidateReceiptId, r.organizationId, r.projectId)
        .first<{ environment_id: string; operation_id: string; provider_tag: string }>();
      const request = await db
        .prepare(
          "SELECT cleanup_request_id FROM wfp_candidate_cleanup_requests WHERE candidate_receipt_id=? AND organization_id=? AND project_id=?",
        )
        .bind(r.candidateReceiptId, r.organizationId, r.projectId)
        .first<{ cleanup_request_id: string }>();
      if (!parent || !request) throw new Error("Historical cleanup fixture is missing its parents");
      if (r.observedProviderTag !== parent.provider_tag)
        throw new Error("Historical cleanup fixture provider tag changed");
      if (
        input.resources.some(
          (resource) =>
            resource.candidateReceiptId !== r.candidateReceiptId ||
            resource.organizationId !== r.organizationId ||
            resource.projectId !== r.projectId ||
            resource.operationId !== parent.operation_id,
        )
      )
        throw new Error("Historical cleanup fixture resource scope changed");
      const timestamp = (value: string) => value.replace(/Z$/u, "000Z");
      const written = await db.batch([
        db
          .prepare(
            "INSERT INTO wfp_candidate_cleanup_receipts(cleanup_receipt_id,candidate_receipt_id,organization_id,project_id,outcome,compensated_target_script_name,shared_gateway_revision,observed_provider_tag,observed_at,environment_id) VALUES(?,?,?,?,?,NULL,NULL,?,?,?)",
          )
          .bind(
            r.cleanupReceiptId,
            r.candidateReceiptId,
            r.organizationId,
            r.projectId,
            r.outcome,
            r.observedProviderTag,
            timestamp(r.observedAt),
            parent.environment_id,
          ),
        db
          .prepare(
            "DELETE FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=? AND organization_id=? AND project_id=? AND claim_id=?",
          )
          .bind(r.candidateReceiptId, r.organizationId, r.projectId, r.claimId),
        ...input.resources.map((resource) =>
          db
            .prepare(
              "INSERT INTO wfp_candidate_operation_cleanup_receipts(operation_cleanup_receipt_id,cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256,outcome,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              resource.operationCleanupReceiptId,
              request.cleanup_request_id,
              r.candidateReceiptId,
              r.organizationId,
              r.projectId,
              resource.operationId,
              resource.provider,
              resource.resourceKind,
              resource.resourceIdentityDigest,
              resource.outcome,
              timestamp(resource.observedAt),
            ),
        ),
      ]);
      if (written[1]?.meta.changes !== 1)
        throw new Error("Historical cleanup fixture did not release its claim");
      return "created" as const;
    },
  };
});

const RELEASE = migrationFiles("core").find(({ name }) =>
  name.endsWith("_cancelled_claim_release.sql"),
)?.name as string;
const REFUSED = "active product provider mutation claim cannot be deleted";
let miniflare: Miniflare;
let db: D1Database;
const control = (): TestControl => ({
  core: db,
  bindings: { CONTROL_CORE: db },
  directory: db,
  shards: { [shardBinding(0)]: db, [shardBinding(1)]: db },
  dispose: async () => undefined,
});
async function apply(select: (name: string) => boolean) {
  for (const file of migrationFiles("core").filter(({ name }) => select(name)))
    await db.batch(splitStatements(file.sql).map((statement) => db.prepare(statement)));
}
type Push = Awaited<ReturnType<typeof seedSupersededPush>>;
const sql = (statement: string, ...values: unknown[]) => db.prepare(statement).bind(...values);
const operationOf = (s: Push) => s.supersede.operationId;
/** The operation of a push, cancelled the way the code before the release did when a newer push superseded it. */
const cancelOperation = (s: Push) =>
  sql(
    "UPDATE operations SET state='cancelled',lease_expires_at=NULL WHERE operation_id=?",
    operationOf(s),
  ).run();
const markSuperseded = (s: Push) =>
  sql(
    "UPDATE github_push_deployments SET state='superseded',cleanup_required=0 WHERE push_deployment_id=?",
    s.first,
  ).run();
const stranded = async (open?: (s: Push) => Promise<unknown>) => {
  const s = await seedSupersededPush(control(), { claim: true });
  await open?.(s);
  await markSuperseded(s);
  await cancelOperation(s);
  return s;
};
const releaseClaim = (s: Push) =>
  sql("DELETE FROM product_provider_mutation_claims WHERE operation_id=?", operationOf(s));
const facts = async (s: Push) => ({
  claims: await sql(
    "SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?",
    operationOf(s),
  ).first(),
  run: await sql(
    "SELECT state,terminal_evidence,active_reconciliation_attempt_id,updated_at,completed_at FROM product_workflow_runs WHERE operation_id=?",
    operationOf(s),
  ).first(),
  deployment: await sql(
    "SELECT status,updated_at FROM deployments WHERE operation_id=?",
    operationOf(s),
  ).first(),
});
const outcome = async (s: Push) => {
  const f = await facts(s);
  return {
    claims: (f.claims as { n: number }).n,
    run: (f.run as { state: string }).state,
    deployment: (f.deployment as { status: string }).status,
  };
};
const candidateColumns = async () =>
  (
    await db.prepare("PRAGMA table_info(wfp_candidate_receipts)").all<{ name: string }>()
  ).results.map(({ name }) => name);
const cleanupEvidence = (s: Push) =>
  sql(
    `SELECT
      (SELECT count(*) FROM wfp_candidate_cleanup_requests WHERE candidate_receipt_id=?1 AND reason='superseded') requests,
      (SELECT count(*) FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?1) receipts,
      (SELECT count(*) FROM wfp_candidate_cleanup_resource_expectations WHERE candidate_receipt_id=?1) expected,
      (SELECT count(*) FROM wfp_candidate_operation_cleanup_receipts WHERE candidate_receipt_id=?1) settled,
      (SELECT count(*) FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?1) cleanup_claims`,
    s.c.candidateReceiptId,
  ).first();

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    d1Databases: { CONTROL_CORE: "cancelled-claims" },
  });
  db = (await miniflare.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  await apply((name) => name < RELEASE);
  await activateTestCore(db);
});
afterAll(async () => miniflare.dispose());

it("releases only the claims of superseded pushes whose run, deployment and provider outcome are closed, changes nothing twice, and guards the same", async () => {
  const historicalColumns = await candidateColumns();
  expect(historicalColumns).not.toContain("binding_set_digest");
  // (a) cancelled by the code before the release: the claim, the open run and the running deployment were left behind
  const open = await stranded();
  // (a) the same push with its run and deployment already closed
  const closed = await stranded(async (s) => {
    await sql(
      "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{\"errorCode\":\"OTHER\"}',completed_at=updated_at WHERE operation_id=?",
      operationOf(s),
    ).run();
    await sql("UPDATE deployments SET status='failed' WHERE operation_id=?", operationOf(s)).run();
  });
  // (b) the run awaits reconciliation, or the operation is cancelled without any evidence of a superseding push
  const reconciling = await stranded(async (s) => {
    await sql(
      "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_UNCERTAIN' WHERE operation_id=?",
      operationOf(s),
    ).run();
    await sql(
      "UPDATE deployments SET status='reconciliation_required' WHERE operation_id=?",
      operationOf(s),
    ).run();
  });
  const unproven = await seedSupersededPush(control(), { claim: true });
  await cancelOperation(unproven);
  // (c) a reservation of the operation, or a reconciliation outcome, is still unresolved
  const reserved = await stranded();
  await seedNativeDatabaseCreate(
    db,
    reserved.p,
    reserved.accepted as NonNullable<Push["accepted"]>,
    reserved.c.environmentId,
    "reserved",
  );
  const unknown = await stranded();
  await seedReconciliationAttempt(
    db,
    unknown.p,
    unknown.accepted as NonNullable<Push["accepted"]>,
    {
      outcome: "unknown",
      active: false,
    },
  );
  // (c) the reservations are also protected by their foreign keys, so only the guard text tells their refusals apart
  const placement = await stranded();
  await seedPlacementReservation(
    db,
    placement.p,
    placement.accepted as NonNullable<Push["accepted"]>,
  );
  const bucket = await stranded();
  await seedBucketReservation(
    db,
    bucket.p,
    bucket.accepted as NonNullable<Push["accepted"]>,
    bucket.c.environmentId,
  );
  const dispatched = await stranded();
  await seedNativeDatabaseCreate(
    db,
    dispatched.p,
    dispatched.accepted as NonNullable<Push["accepted"]>,
    dispatched.c.environmentId,
    "dispatched",
  );
  // (b) a completed run that still points at an active reconciliation attempt, with a closed deployment
  const pointed = await stranded(async (s) => {
    await seedReconciliationAttempt(db, s.p, s.accepted as NonNullable<Push["accepted"]>, {
      outcome: "prepared",
      active: true,
    });
    await sql(
      "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{\"errorCode\":\"OTHER\"}',completed_at=updated_at WHERE operation_id=?",
      operationOf(s),
    ).run();
    await sql("UPDATE deployments SET status='failed' WHERE operation_id=?", operationOf(s)).run();
  });
  // an operation that still runs
  const running = await seedSupersededPush(control(), { claim: true });
  const kept = [reconciling, unproven, reserved, unknown, placement, bucket, dispatched, pointed];
  const keptBefore = await Promise.all(kept.map(facts));
  const initial = [open, closed, ...kept, running];
  const completeCleanup = { requests: 1, receipts: 1, expected: 2, settled: 2, cleanup_claims: 0 };
  expect(await Promise.all(initial.map(cleanupEvidence))).toEqual(
    initial.map(() => completeCleanup),
  );

  // before: no claim of a cancelled operation can be released
  await expect(releaseClaim(open).run()).rejects.toThrow(REFUSED);
  expect(await outcome(open)).toEqual({ claims: 1, run: "queued", deployment: "running" });

  await apply((name) => name === RELEASE);
  expect(await candidateColumns()).toEqual(historicalColumns);
  expect(await Promise.all(initial.map(cleanupEvidence))).toEqual(
    initial.map(() => completeCleanup),
  );

  expect(await outcome(open)).toEqual({ claims: 0, run: "completed", deployment: "failed" });
  expect(
    JSON.parse(
      (
        await sql(
          "SELECT terminal_evidence FROM product_workflow_runs WHERE operation_id=?",
          operationOf(open),
        ).first<{ terminal_evidence: string }>()
      )?.terminal_evidence as string,
    ),
  ).toEqual({ errorCode: "SUPERSEDED", supersededById: open.second });
  expect(await outcome(closed)).toEqual({ claims: 0, run: "completed", deployment: "failed" });
  expect(await facts(closed)).toMatchObject({
    run: { terminal_evidence: '{"errorCode":"OTHER"}' },
  });
  // everything not provably closed keeps its claim, its run and its deployment exactly as they were
  expect(await Promise.all(kept.map(facts))).toEqual(keptBefore);
  const stillOpen = { claims: 1, run: "queued", deployment: "running" };
  expect(await Promise.all(kept.map(outcome))).toEqual([
    { claims: 1, run: "reconciliation_required", deployment: "reconciliation_required" },
    stillOpen,
    stillOpen,
    stillOpen,
    stillOpen,
    stillOpen,
    stillOpen,
    { claims: 1, run: "completed", deployment: "failed" },
  ]);
  // and the guard of the claim agrees: it refuses each of them and the claim of the running operation
  for (const s of [...kept, running])
    await expect(releaseClaim(s).run(), String(operationOf(s))).rejects.toThrow(REFUSED);

  // a second application changes nothing
  const all = [open, closed, ...kept, running];
  const settled = await Promise.all(all.map(facts));
  await apply((name) => name === RELEASE);
  expect(await Promise.all(all.map(facts))).toEqual(settled);

  // after: the claim of a superseded push whose run and deployment closed is releasable with its terminal state
  const later = await stranded(async (s) => {
    await sql(
      "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{\"errorCode\":\"SUPERSEDED\"}',completed_at=updated_at WHERE operation_id=?",
      operationOf(s),
    ).run();
    await sql("UPDATE deployments SET status='failed' WHERE operation_id=?", operationOf(s)).run();
  });
  await releaseClaim(later).run();
  expect((await outcome(later)).claims).toBe(0);
});
