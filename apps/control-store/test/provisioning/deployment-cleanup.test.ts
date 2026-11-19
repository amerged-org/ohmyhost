import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import {
  claimProductCandidateCleanup,
  markProductCandidateSuperseded,
  prepareProductCandidateCleanup,
  recordProductCandidateCleanup,
} from "../../src/catalog/provisioning/deployment-cleanup.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  losingWriteResponses,
  seedProject,
  type SeededProject,
} from "../support/platform-fixtures.js";
import {
  leaseOperation,
  seedAcceptedOperation,
  seedOperation,
} from "../support/accepted-operation.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";
import { createControlStore } from "../../src/store.js";
import { candidateResources, seedCandidate } from "../support/provisioning-cleanup-fixtures.js";
import {
  cleanupPrepareInput as prepareInput,
  cleanupRecordInput as recordInput,
  seedAttachedPush,
  seedBucketReservation,
  seedNativeDatabaseCreate,
  seedPlacementReservation,
  seedReconciliationAttempt,
  seedSupersededPush,
} from "../support/superseded-push.js";
import type { D1Database } from "../../src/d1-types.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

type Accepted = NonNullable<Awaited<ReturnType<typeof seedSupersededPush>>["accepted"]>;
const context = (db: D1Database) => ({ directory: db, router: new SharedCoreRouter(db) });
const T0 = "2026-10-28T12:00:00.000Z";
const LEASE = "2026-10-28T12:05:00.000Z";
const rows = async (sql: string, ...values: unknown[]) =>
  (
    await control.core
      .prepare(sql)
      .bind(...values)
      .all<Record<string, unknown>>()
  ).results;

type Candidate = Awaited<ReturnType<typeof seedCandidate>>;

describe("candidate cleanup request and lease", () => {
  let p: SeededProject;
  let c: Candidate;
  let prepared: ReturnType<typeof prepareInput>;
  beforeAll(async () => {
    p = await seedProject(control);
    c = await seedCandidate(p);
    prepared = prepareInput(c);
  });

  it("records the request, the captured resource expectations and the first lease in one batch, observes a lost reply and replays", async () => {
    const resources = await candidateResources();
    const claim = {
      candidateReceiptId: c.candidateReceiptId,
      claimId: prepared.claimId,
      attemptNumber: 1,
      claimedAt: T0,
      leaseExpiresAt: LEASE,
      candidate: c.candidate,
      expectedResources: resources,
    };
    expect(
      await prepareProductCandidateCleanup(
        context(losingWriteResponses(control.core, 1)),
        prepared,
      ),
    ).toEqual(claim);
    expect(await prepareProductCandidateCleanup(context(control.core), prepared)).toEqual(claim);

    expect(
      await rows(
        "SELECT cleanup_request_id,reason,requested_at,operation_id FROM wfp_candidate_cleanup_requests WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([
      {
        cleanup_request_id: prepared.cleanupRequestId,
        reason: "failed",
        requested_at: "2026-10-28T12:00:00.000000Z",
        operation_id: c.operationId,
      },
    ]);
    expect(
      (
        await rows(
          "SELECT resource_kind,lower(hex(resource_identity_sha256)) digest FROM wfp_candidate_cleanup_resource_expectations WHERE candidate_receipt_id=? ORDER BY resource_kind",
          c.candidateReceiptId,
        )
      ).map((r) => [r["resource_kind"], r["digest"]]),
    ).toEqual(
      resources.map((r) => [
        r.resourceKind,
        Array.from(r.resourceIdentityDigest, (b) => b.toString(16).padStart(2, "0")).join(""),
      ]),
    );
    expect(
      await rows(
        "SELECT claim_id,attempt_number FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([{ claim_id: prepared.claimId, attempt_number: 1 }]);
  });

  it("refuses a changed request, a live foreign lease, an unknown or altered candidate", async () => {
    await expect(
      prepareProductCandidateCleanup(context(control.core), {
        ...prepared,
        cleanupRequestId: newUlid(),
      }),
    ).rejects.toThrow("WFP candidate cleanup request changed");
    await expect(
      prepareProductCandidateCleanup(context(control.core), { ...prepared, claimId: newUlid() }),
    ).rejects.toThrow("WFP candidate cleanup claim is unavailable");
    await expect(
      prepareProductCandidateCleanup(context(control.core), {
        ...prepared,
        candidate: { ...c.candidate, candidateReceiptId: newUlid() },
      }),
    ).rejects.toThrow("WFP candidate cleanup scope changed");
    await expect(
      prepareProductCandidateCleanup(context(control.core), {
        ...prepared,
        candidate: { ...c.candidate, providerTag: "other-tag" },
      }),
    ).rejects.toThrow("guard_operation_conflict");
    // a superseding request must name what superseded it, any other reason must not
    await expect(
      prepareProductCandidateCleanup(context(control.core), { ...prepared, reason: "superseded" }),
    ).rejects.toThrow();
  });

  it("hands the pending candidate to exactly one live claimant and takes the lease over after it expired", async () => {
    const other = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      claimId: newUlid(),
      claimedAt: "2026-10-28T12:01:00.000Z",
      leaseExpiresAt: "2026-10-28T12:06:00.000Z",
    };
    // the lease of the first claimant is still live: nothing to do for the second one
    expect(await claimProductCandidateCleanup(context(control.core), other)).toBeNull();
    // after the lease expired the next claimant takes over with the next attempt number
    const later = {
      ...other,
      candidateReceiptId: c.candidateReceiptId,
      claimedAt: "2026-10-28T12:10:00.000Z",
      leaseExpiresAt: "2026-10-28T12:15:00.000Z",
    };
    const taken = {
      candidateReceiptId: c.candidateReceiptId,
      claimId: other.claimId,
      attemptNumber: 2,
      claimedAt: later.claimedAt,
      leaseExpiresAt: later.leaseExpiresAt,
      candidate: c.candidate,
      expectedResources: await candidateResources(),
    };
    expect(
      await claimProductCandidateCleanup(context(losingWriteResponses(control.core, 1)), later),
    ).toEqual(taken);
    expect(await claimProductCandidateCleanup(context(control.core), later)).toEqual(taken);
    expect(
      await rows(
        "SELECT claim_id,attempt_number,lease_expires_at FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([
      {
        claim_id: other.claimId,
        attempt_number: 2,
        lease_expires_at: "2026-10-28T12:15:00.000000Z",
      },
    ]);
    // the old claimant lost the lease and cannot get it back while the new one is live
    expect(
      await claimProductCandidateCleanup(context(control.core), {
        ...other,
        claimId: prepared.claimId,
        claimedAt: "2026-10-28T12:11:00.000Z",
        leaseExpiresAt: "2026-10-28T12:16:00.000Z",
      }),
    ).toBeNull();
    // a scope without any pending candidate has no work
    const idle = await seedProject(control);
    expect(
      await claimProductCandidateCleanup(context(control.core), {
        ...later,
        organizationId: idle.organizationId,
        projectId: idle.projectId,
        candidateReceiptId: undefined,
      }),
    ).toBeNull();
  });
});

/** Prepares the cleanup request of `c` and returns the claim that holds its first lease. */
async function prepare(c: Candidate, extra: Record<string, unknown> = {}) {
  const input = prepareInput(c, extra);
  await prepareProductCandidateCleanup(context(control.core), input);
  return input;
}

describe("candidate cleanup receipt", () => {
  let p: SeededProject;
  beforeAll(async () => {
    p = await seedProject(control);
  });

  it("refuses a receipt from a foreign claimant, for another provider tag or for foreign resources", async () => {
    const c = await seedCandidate(p);
    const claim = await prepare(c);
    const input = await recordInput(c, claim.claimId);
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        receipt: { ...input.receipt, claimId: newUlid() },
      }),
    ).rejects.toThrow("WFP candidate cleanup claim or provider tag changed");
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        receipt: { ...input.receipt, observedProviderTag: "other-tag" },
      }),
    ).rejects.toThrow("WFP candidate cleanup claim or provider tag changed");
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        resources: input.resources.map((r) => ({ ...r, candidateReceiptId: newUlid() })),
      }),
    ).rejects.toThrow("Candidate operation cleanup scope changed");
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        resources: input.resources.map((r) => ({ ...r, operationId: newUlid() })),
      }),
    ).rejects.toThrow("Candidate cleanup producing operation changed");
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        receipt: { ...input.receipt, candidateReceiptId: newUlid() },
        resources: [],
      }),
    ).rejects.toThrow("WFP candidate cleanup scope changed");
    expect(
      await rows(
        "SELECT cleanup_receipt_id FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([]);
  });

  it("settles the observed absence, the resource receipts and the lease release in one batch and replays them exactly", async () => {
    const c = await seedCandidate(p);
    const claim = await prepare(c);
    const input = await recordInput(c, claim.claimId);
    expect(await recordProductCandidateCleanup(context(control.core), input)).toBe("created");
    expect(await recordProductCandidateCleanup(context(control.core), input)).toBe("existing");
    expect(
      await rows(
        "SELECT cleanup_receipt_id,outcome,compensated_target_script_name,shared_gateway_revision,observed_provider_tag,environment_id FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([
      {
        cleanup_receipt_id: input.receipt.cleanupReceiptId,
        outcome: "removed",
        compensated_target_script_name: null,
        shared_gateway_revision: null,
        observed_provider_tag: "exact-fixture-tag",
        environment_id: c.environmentId,
      },
    ]);
    expect(
      await rows(
        "SELECT claim_id FROM wfp_candidate_cleanup_claims WHERE candidate_receipt_id=?",
        c.candidateReceiptId,
      ),
    ).toEqual([]);
    expect(
      (
        await rows(
          "SELECT resource_kind,outcome FROM wfp_candidate_operation_cleanup_receipts WHERE candidate_receipt_id=? ORDER BY resource_kind",
          c.candidateReceiptId,
        )
      ).map((r) => [r["resource_kind"], r["outcome"]]),
    ).toEqual([
      ["build-artifact", "removed"],
      ["source-archive", "not_found"],
    ]);
    // the released candidate is no longer pending, and a different receipt for it is refused
    expect(
      await claimProductCandidateCleanup(context(control.core), {
        organizationId: p.organizationId,
        projectId: p.projectId,
        candidateReceiptId: c.candidateReceiptId,
        claimId: newUlid(),
        claimedAt: "2026-10-28T12:03:00.000Z",
        leaseExpiresAt: "2026-10-28T12:08:00.000Z",
      }),
    ).toBeNull();
    await expect(
      recordProductCandidateCleanup(context(control.core), {
        ...input,
        receipt: { ...input.receipt, outcome: "not_found" },
      }),
    ).rejects.toThrow("WFP candidate cleanup receipt changed");
  });

  it("observes a lost reply of the receipt batch through its exact stored evidence", async () => {
    const c = await seedCandidate(p);
    const claim = await prepare(c);
    const input = await recordInput(c, claim.claimId, {
      outcome: "not_found",
      gateway: { compensatedTargetScriptName: null, sharedGatewayRevision: null },
    });
    expect(
      await recordProductCandidateCleanup(context(losingWriteResponses(control.core, 1)), input),
    ).toBe("existing");
    expect(
      await rows(
        "SELECT outcome FROM wfp_candidate_cleanup_receipts WHERE cleanup_receipt_id=?",
        input.receipt.cleanupReceiptId,
      ),
    ).toEqual([{ outcome: "not_found" }]);
  });
});

describe("candidate cleanup and the shared gateway route", () => {
  it("restores the live target for a candidate that was never routed, and reverts a route it holds to its predecessor", async () => {
    const p = await seedProject(control);
    const live = await seedWfpPublication(p, {
      operationId: await seedOperation(p),
      environmentId: p.devEnvironmentId,
    });
    const liveScript = `p-${p.projectId.toLowerCase()}-dev-${live.deploymentId.toLowerCase()}`;
    const route = (revision: string) =>
      rows(
        "SELECT revision,predecessor_revision,action,active,candidate_receipt_id FROM shared_gateway_route_revisions WHERE organization_id=? AND project_id=? AND environment_id=? AND revision=?",
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        revision,
      );

    // a failed candidate next to the live deployment: the receipt names the target the gateway keeps serving
    const stray = await seedCandidate(p);
    const strayClaim = await prepare(stray);
    expect(
      await recordProductCandidateCleanup(
        context(control.core),
        await recordInput(stray, strayClaim.claimId),
      ),
    ).toBe("created");
    expect(
      await rows(
        "SELECT compensated_target_script_name,shared_gateway_revision FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?",
        stray.candidateReceiptId,
      ),
    ).toEqual([{ compensated_target_script_name: liveScript, shared_gateway_revision: 1 }]);

    // a candidate whose activation reached the gateway but never published: its route is compensated to the live one
    const held = await seedCandidate(p);
    await control.core
      .prepare(
        "INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,observed_at) SELECT organization_id,project_id,environment_id,2,1,?4,?5,'activate',1,handle,public_origin,'[]','2026-10-28T12:01:00.000000Z' FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND revision=1",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        held.operationId,
        held.candidateReceiptId,
      )
      .run();
    const heldClaim = await prepare(held);
    expect(
      await recordProductCandidateCleanup(
        context(control.core),
        await recordInput(held, heldClaim.claimId),
      ),
    ).toBe("created");
    expect(await route("3")).toEqual([
      {
        revision: 3,
        predecessor_revision: 2,
        action: "compensate",
        active: 1,
        candidate_receipt_id: live.candidateReceiptId,
      },
    ]);
    expect(
      await rows(
        "SELECT compensated_target_script_name,shared_gateway_revision FROM wfp_candidate_cleanup_receipts WHERE candidate_receipt_id=?",
        held.candidateReceiptId,
      ),
    ).toEqual([{ compensated_target_script_name: liveScript, shared_gateway_revision: 3 }]);
  });
});

describe("superseded GitHub push", () => {
  const supersededPush = (options: { readonly claim?: boolean } = {}) =>
    seedSupersededPush(control, options);
  const push = (id: string) =>
    rows(
      "SELECT state,superseded_by_id,cleanup_required FROM github_push_deployments WHERE push_deployment_id=?",
      id,
    );
  const state = async (organizationId: string, operationId: string) =>
    (
      await rows(
        "SELECT state FROM operations WHERE organization_id=? AND operation_id=?",
        organizationId,
        operationId,
      )
    )[0]?.["state"];

  it("terminates the push and cancels its operation once the candidate's cleanup evidence is complete", async () => {
    const s = await supersededPush();
    expect(await push(s.first)).toEqual([
      { state: "cleanup_pending", superseded_by_id: s.second, cleanup_required: 1 },
    ]);
    // neither evidence of another cleanup nor another superseding push is accepted
    await expect(
      markProductCandidateSuperseded(context(control.core), {
        ...s.supersede,
        cleanupReceiptId: newUlid(),
      }),
    ).rejects.toThrow("WFP candidate cleanup evidence is unavailable");
    await expect(
      markProductCandidateSuperseded(context(control.core), {
        ...s.supersede,
        supersededById: newUlid(),
      }),
    ).rejects.toThrow("WFP candidate terminal push state changed");
    expect(await state(s.p.organizationId, s.supersede.operationId)).toBe("queued");

    // The running push Workflow holds the operation's lease when its superseding command runs.
    await leaseOperation(control.core, s.supersede.operationId);
    expect(await markProductCandidateSuperseded(context(control.core), s.supersede)).toBe(
      "superseded",
    );
    expect(await markProductCandidateSuperseded(context(control.core), s.supersede)).toBe(
      "existing",
    );
    expect(await push(s.first)).toEqual([
      { state: "superseded", superseded_by_id: s.second, cleanup_required: 0 },
    ]);
    expect(
      await control.core
        .prepare("SELECT state,lease_expires_at FROM operations WHERE operation_id=?1")
        .bind(s.supersede.operationId)
        .first(),
    ).toEqual({ state: "cancelled", lease_expires_at: null });
  });

  it("releases the project's provider-mutation claim, the Workflow run and the deployment with the cancellation, so the next push is dispatched", async () => {
    const s = await supersededPush({ claim: true });
    const next = await seedAcceptedOperation(s.p, s.c.environmentId, {
      operationId: await seedOperation(s.p, { state: "queued" }),
      claim: false,
    });
    const dispatch = (attemptId: string) =>
      createControlStore(control.bindings).operations.claimOutboxEvent({
        eventScope: {
          eventId: next.eventId,
          organizationId: s.p.organizationId,
          projectId: s.p.projectId,
          operationId: next.operationId,
        },
        now: "2026-10-28T12:11:00.000Z",
        leaseMilliseconds: 60_000,
        attemptId,
        supportedEventTypes: ["DeploymentRequestedV1"],
        excludeProjectsWithActiveProviderMutation: true,
      });
    const held = () =>
      rows(
        "SELECT (SELECT count(*) FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2) claims,(SELECT state FROM product_workflow_runs WHERE organization_id=?1 AND operation_id=?3) run,(SELECT status FROM deployments WHERE organization_id=?1 AND operation_id=?3) deployment,(SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?3) operation",
        s.p.organizationId,
        s.p.projectId,
        s.supersede.operationId,
      );
    // the claim of the superseded push keeps the next push out of every dispatch
    expect(await dispatch(newUlid())).toBeNull();
    expect(await held()).toEqual([
      { claims: 1, run: "queued", deployment: "running", operation: "running" },
    ]);

    await leaseOperation(control.core, s.supersede.operationId);
    expect(await markProductCandidateSuperseded(context(control.core), s.supersede)).toBe(
      "superseded",
    );
    expect(await held()).toEqual([
      { claims: 0, run: "completed", deployment: "failed", operation: "cancelled" },
    ]);
    expect(
      await rows(
        "SELECT terminal_evidence,active_reconciliation_attempt_id,active_replay_attempt_id FROM product_workflow_runs WHERE operation_id=?",
        s.supersede.operationId,
      ),
    ).toEqual([
      {
        terminal_evidence: JSON.stringify({ errorCode: "SUPERSEDED", supersededById: s.second }),
        active_reconciliation_attempt_id: null,
        active_replay_attempt_id: null,
      },
    ]);
    const attemptId = newUlid();
    expect(await dispatch(attemptId)).toMatchObject({ attemptNumber: 1, attemptId });
    // a replay of the terminal batch changes nothing
    expect(await markProductCandidateSuperseded(context(control.core), s.supersede)).toBe(
      "existing",
    );
  });

  it("refuses to release the claim while the run, the deployment or the provider outcome is not closed, and changes nothing", async () => {
    const open: [
      string,
      (s: Awaited<ReturnType<typeof supersededPush>>) => Promise<unknown>,
      string?,
    ][] = [
      [
        "a Workflow run that awaits reconciliation",
        (s) =>
          control.core
            .prepare(
              "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_UNCERTAIN' WHERE operation_id=?",
            )
            .bind(s.supersede.operationId)
            .run(),
      ],
      [
        "a run with an active reconciliation attempt",
        (s) =>
          seedReconciliationAttempt(control.core, s.p, s.accepted as Accepted, {
            outcome: "prepared",
            active: true,
          }),
      ],
      [
        "a deployment that awaits reconciliation",
        (s) =>
          control.core
            .prepare("UPDATE deployments SET status='reconciliation_required' WHERE operation_id=?")
            .bind(s.supersede.operationId)
            .run(),
      ],
      [
        "a reconciliation attempt whose provider outcome stayed unknown",
        (s) =>
          seedReconciliationAttempt(control.core, s.p, s.accepted as Accepted, {
            outcome: "unknown",
            active: false,
          }),
      ],
      [
        "a Native database create that is not resolved",
        (s) =>
          seedNativeDatabaseCreate(
            control.core,
            s.p,
            s.accepted as Accepted,
            s.c.environmentId,
            "reserved",
          ),
      ],
      [
        "an open Neon placement reservation",
        (s) => seedPlacementReservation(control.core, s.p, s.accepted as Accepted),
      ],
      [
        "an open R2 bucket reservation",
        (s) => seedBucketReservation(control.core, s.p, s.accepted as Accepted, s.c.environmentId),
      ],
      [
        // the cancelling statement itself is refused by the Native trigger, before the closure guard is reached
        "a dispatched Native database create",
        (s) =>
          seedNativeDatabaseCreate(
            control.core,
            s.p,
            s.accepted as Accepted,
            s.c.environmentId,
            "dispatched",
          ),
        "native auth create outcome unresolved",
      ],
    ];
    for (const [reason, arrange, refusal] of open) {
      const s = await supersededPush({ claim: true });
      await leaseOperation(control.core, s.supersede.operationId);
      await arrange(s);
      await expect(
        markProductCandidateSuperseded(context(control.core), s.supersede),
        reason,
      ).rejects.toThrow(refusal ?? "guard_operation_conflict");
      expect(
        await rows(
          "SELECT (SELECT count(*) FROM product_provider_mutation_claims WHERE operation_id=?1) claims,(SELECT state FROM operations WHERE operation_id=?1) operation,(SELECT state FROM github_push_deployments WHERE push_deployment_id=?2) push",
          s.supersede.operationId,
          s.first,
        ),
        reason,
      ).toEqual([{ claims: 1, operation: "running", push: "cleanup_pending" }]);
    }
  });

  it("observes a lost reply of the terminal batch and reports a cleaned candidate without a linked push", async () => {
    const s = await supersededPush();
    expect(
      await markProductCandidateSuperseded(
        context(losingWriteResponses(control.core, 1)),
        s.supersede,
      ),
    ).toBe("existing");
    expect(await push(s.first)).toEqual([
      { state: "superseded", superseded_by_id: s.second, cleanup_required: 0 },
    ]);

    const p = await seedProject(control);
    const c = await seedCandidate(p);
    const claim = await prepare(c);
    const recorded = await recordInput(c, claim.claimId);
    await recordProductCandidateCleanup(context(control.core), recorded);
    expect(
      await markProductCandidateSuperseded(context(control.core), {
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: c.operationId,
        candidateReceiptId: c.candidateReceiptId,
        cleanupReceiptId: recorded.receipt.cleanupReceiptId,
        supersededById: newUlid(),
        terminalAt: "2026-10-28T12:10:00.000Z",
      }),
    ).toBe("not_linked");
  });
});

describe("candidate cleanup of a failed or compensated candidate with a queued push", () => {
  it("prepares the cleanup and leaves the attached push queued, because only a newer push supersedes it", async () => {
    for (const reason of ["failed", "compensate"] as const) {
      const p = await seedProject(control);
      const operationId = await seedOperation(p, { state: "queued" });
      const c = await seedCandidate(p, { operationId });
      const pushDeploymentId = await seedAttachedPush(control, p, operationId);
      const input = prepareInput(c, { reason });
      expect(await prepareProductCandidateCleanup(context(control.core), input)).toMatchObject({
        candidateReceiptId: c.candidateReceiptId,
        claimId: input.claimId,
        attemptNumber: 1,
      });
      expect(
        await rows(
          "SELECT state,superseded_by_id,cleanup_required FROM github_push_deployments WHERE push_deployment_id=?",
          pushDeploymentId,
        ),
      ).toEqual([{ state: "queued", superseded_by_id: null, cleanup_required: 0 }]);
    }
  });
});
