import { expect, it, vi } from "vitest";
import { GithubAutoDeployTargetDeniedError, OrganizationCreditError } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import { quoteBuildCost } from "@ohmyhost/platform";

import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import { ProductSurfaceConflictError } from "../src/contracts.js";
import {
  createD1GithubAutoDeployDatabase,
  createD1GithubAutoDeployments,
  createD1GithubPushConsumer,
  isD1GithubAutoDeployRuntime,
  isD1InboxClaimRuntime,
  isD1InboxRuntime,
} from "../src/d1-github-auto-deploy.js";
import { createGithubAutoDeployConsumer, drainGithubPushes } from "../src/github-auto-deploy.js";

async function seedPushTarget(control: Awaited<ReturnType<typeof createTestControl>>) {
  const store = createControlStore(control.bindings),
    db = control.core,
    project = await seedProject(control),
    connection = newUlid(),
    grantId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
      )
      .bind(
        project.organizationId,
        connection,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','octo','app','contents:read',?6)",
      )
      .bind(
        project.organizationId,
        grantId,
        project.projectId,
        project.billingEpochId,
        connection,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
      )
      .bind(project.organizationId, project.projectId, connection, STORED_NOW),
  ]);
  const push = async (guid: string, commit: string, ref = "refs/heads/main") =>
    db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push',?3,?4,?5,'pending',5,?5,?6)",
      )
      .bind(
        newUlid(),
        guid,
        JSON.stringify({
          installationId: "42",
          repositoryId: "77",
          repositoryFullName: "octo/app",
          ref,
          commitSha: commit,
          deleted: false,
        }),
        new Uint8Array(32).fill(2),
        STORED_NOW,
        project.organizationId,
      )
      .run();
  return { store, db, project, connection, grantId, push };
}

it("claims a push, reserves it once, accepts the deployment and records an unplannable commit as a failed operation", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project, connection, push } = await seedPushTarget(control);
    let clockMs = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((clockMs += 1)) },
      ids = { next: () => parseUlid(newUlid()) };
    let planned = 0;
    let rejectNext = false;
    const surface = {
      async planDeployment(request: { environment?: "dev" | "prod" }) {
        expect(request.environment).toBe("dev");
        planned += 1;
        if (rejectNext) throw new ProductSurfaceConflictError("mail_domain_required");
        return { status: 200, body: { id: newUlid() } };
      },
      createDeployment: async (request: {
        idempotencyKey: string;
      }): Promise<{ status: number; body: { id: string } }> => {
        void request;
        throw new Error("replaced below");
      },
    };
    const accepted = new Map<string, string>();
    // The stand-in surface is idempotent by key like the real acceptance, with its own map.
    surface.createDeployment = async (request) => {
      const known = accepted.get(request.idempotencyKey);
      if (known) return { status: 202, body: { id: known } };
      const operationId = newUlid(),
        planId = newUlid(),
        deploymentId = newUlid(),
        bytes = new Uint8Array(32).fill(3);
      await db.batch([
        db
          .prepare(
            "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
          )
          .bind(
            project.organizationId,
            project.projectId,
            operationId,
            project.billingEpochId,
            STORED_NOW,
            STORED_NOW,
          ),
        db
          .prepare(
            "INSERT INTO deployment_plans(organization_id,plan_id,project_id,source_connection_id,commit_sha,source_sha256,build_plan_sha256,runtime,impacts,risks,cost_estimate,created_at,expires_at,plan_sha256,framework_plan,environment_id,source_generation) VALUES(?1,?2,?3,?4,?5,?6,?6,'cloudflare_workers_edge_ssr','[]','[]',?7,?8,'2026-10-29T09:00:00.000000Z',?6,?9,?10,1)",
          )
          .bind(
            project.organizationId,
            planId,
            project.projectId,
            connection,
            "a".repeat(40),
            bytes,
            JSON.stringify(quoteBuildCost("2026-10-28T10:00:00.000Z")),
            STORED_NOW,
            JSON.stringify(sourceFrameworkPlan(false)),
            project.devEnvironmentId,
          ),
        db
          .prepare(
            "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'deploy','queued',?,?)",
          )
          .bind(
            project.organizationId,
            deploymentId,
            project.projectId,
            project.devEnvironmentId,
            operationId,
            STORED_NOW,
            STORED_NOW,
          ),
        db
          .prepare(
            "INSERT INTO product_command_intents(organization_id,operation_id,event_type,project_id,environment_id,billing_epoch_id,plan_id,source_connection_id,deployment_id,created_at) VALUES(?1,?2,'DeploymentRequestedV1',?3,?4,?5,?6,?7,?8,?9)",
          )
          .bind(
            project.organizationId,
            operationId,
            project.projectId,
            project.devEnvironmentId,
            project.billingEpochId,
            planId,
            connection,
            deploymentId,
            STORED_NOW,
          ),
      ]);
      accepted.set(request.idempotencyKey, operationId);
      return { status: 202, body: { id: operationId } };
    };
    const consumer = createGithubAutoDeployConsumer({
      database: createD1GithubAutoDeployDatabase({
        github: store.github as never,
        inbox: store.operations as never,
        drain: store.maintenance as never,
        clock,
        ids,
        billingEpochOf: async () => project.billingEpochId,
        acceptPreview: async () => {},
      }),
      deployments: createD1GithubAutoDeployments({
        surface: surface as never,
        github: store.github as never,
        clock,
      }),
    });

    // The Worker accepts exactly the Core capabilities the push consumer needs.
    expect(isD1GithubAutoDeployRuntime(store.github)).toBe(true);
    expect(isD1InboxRuntime(store.operations)).toBe(true);
    expect(isD1InboxClaimRuntime(store.maintenance)).toBe(true);
    for (const check of [isD1GithubAutoDeployRuntime, isD1InboxRuntime, isD1InboxClaimRuntime])
      expect(check({}), check.name).toBe(false);
    expect(await consumer.pollOne()).toEqual({ status: "idle" });
    await push("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "a".repeat(40));
    const first = await consumer.pollOne();
    expect(first).toMatchObject({ status: "queued", deniedProjectIds: [] });
    const operationId = (first as { operationIds: string[] }).operationIds[0] as string;
    expect(
      await db
        .prepare("SELECT state,operation_id FROM github_push_deployments WHERE delivery_guid=?")
        .bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .first(),
    ).toEqual({ state: "queued", operation_id: operationId });
    expect(await consumer.pollOne()).toEqual({ status: "idle" });

    // Another branch is ignored. A new delivery of a commit already pushed (a reset back to it) is a push of its own,
    // and it supersedes the still queued push of that commit.
    await push("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b".repeat(40), "refs/heads/other");
    expect(await consumer.pollOne()).toMatchObject({ status: "ignored", reason: "branch" });
    await push("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "a".repeat(40));
    const reset = await consumer.pollOne();
    expect(reset).toMatchObject({ status: "queued", deniedProjectIds: [] });
    const resetOperationId = (reset as { operationIds: string[] }).operationIds[0] as string;
    expect(resetOperationId).not.toBe(operationId);
    expect(
      await db
        .prepare(
          "SELECT state,superseded_by_id IS NOT NULL AS superseded FROM github_push_deployments WHERE delivery_guid=?",
        )
        .bind("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .first(),
    ).toEqual({ state: "cleanup_pending", superseded: 1 });
    expect(planned).toBe(2);

    // A commit that cannot be planned leaves a failed operation with the public planning code.
    rejectNext = true;
    await push("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "d".repeat(40));
    expect(await consumer.pollOne()).toMatchObject({ status: "failed" });
    const failed = await db
      .prepare(
        "SELECT operation.state,operation.failure FROM github_push_deployments push JOIN operations operation ON operation.operation_id=push.operation_id WHERE push.delivery_guid=?",
      )
      .bind("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
      .first<{ state: string; failure: string }>();
    expect(failed?.state).toBe("failed");
    expect(JSON.parse(failed?.failure ?? "{}")).toMatchObject({
      code: "AUTO_DEPLOY_PLAN_REJECTED",
    });
  } finally {
    await control.dispose();
  }
});

it("records credit refusals, retries a faulty planner and denies a revoked or stale grant", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project, grantId, push } = await seedPushTarget(control);
    let clockMs = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((clockMs += 1)) },
      ids = { next: () => parseUlid(newUlid()) },
      faults: Error[] = [],
      log = vi.spyOn(console, "log").mockImplementation(() => undefined),
      surface = {
        async planDeployment() {
          const fault = faults.shift();
          if (fault) throw fault;
          return { status: 200, body: { id: newUlid() } };
        },
        async createDeployment() {
          throw new Error("the planner always faults in this test");
        },
      },
      database = createD1GithubAutoDeployDatabase({
        github: store.github as never,
        inbox: store.operations as never,
        drain: store.maintenance as never,
        clock,
        ids,
        billingEpochOf: async () => project.billingEpochId,
        acceptPreview: async () => {},
      }),
      consumer = createD1GithubPushConsumer({
        bindings: {
          GITHUB_RUNTIME: store.github,
          CONTROL_RUNTIME: store.operations,
          CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
          PRODUCT_API_RUNTIME: store.productApi as never,
          PREVIEW_API_RUNTIME: { readGithubCandidates: async () => [] } as never,
          SOURCE_INSPECTOR: {
            resolvePreviewGithubHead: async () => {
              throw new Error("no preview candidates");
            },
          },
        },
        surface: surface as never,
        clock,
        ids,
      }),
      failures = async () =>
        (
          await db
            .prepare(
              "SELECT push.state,operation.failure FROM github_push_deployments push JOIN operations operation ON operation.operation_id=push.operation_id ORDER BY push.sequence",
            )
            .all<{ state: string; failure: string }>()
        ).results.map((row) => ({ state: row.state, code: JSON.parse(row.failure).code }));

    // Each credit refusal is a planning failure with its public code; the push is acknowledged, not retried.
    for (const [index, code] of [
      "paid_plan_required",
      "project_budget_exceeded",
      "insufficient_organization_credits",
    ].entries()) {
      faults.push(new OrganizationCreditError(code as never));
      await push(`${index}0000000-0000-4000-8000-000000000000`, `${index + 1}`.repeat(40));
      expect(await consumer.pollOne()).toMatchObject({
        status: "failed",
        failedProjectIds: [project.projectId],
      });
    }
    expect(await failures()).toHaveLength(3);

    // Any other planner fault is a platform fault: the event is released for retry under its own code.
    faults.push(new Error("planner unavailable"));
    await push("40000000-0000-4000-8000-000000000000", "4".repeat(40));
    expect(await consumer.pollOne()).toEqual({
      status: "retry",
      code: "GITHUB_AUTO_DEPLOY_REQUEST_FAILED",
    });

    // The transient refusals of the Core are released for retry, not ended as a rejected push: a provider cutover that
    // is still unreleased, a project operation that is still running and a data change that is still running.
    const transient = [
      "cutover_pending",
      "project_operation_in_progress",
      "data_change_in_progress",
    ] as const;
    for (const [index, reason] of transient.entries()) {
      faults.push(new ProductSurfaceConflictError(reason));
      await push(`${7 + index}0000000-0000-4000-8000-000000000000`, `${7 + index}`.repeat(40));
      expect(await consumer.pollOne(), reason).toEqual({
        status: "retry",
        code: "GITHUB_AUTO_DEPLOY_REQUEST_FAILED",
      });
    }

    // A grant revoked between the target read and the reservation is refused by the Core as a denial.
    await push("50000000-0000-4000-8000-000000000000", "5".repeat(40));
    const claim = await database.claimOne();
    if (claim === null) throw new Error("the fresh push must be claimable");
    const [target] = await database.targetsFor(claim);
    await db
      .prepare(
        "INSERT INTO repository_grant_revocations(organization_id,revocation_id,grant_id,project_id,reason,revoked_at) VALUES(?1,?2,?3,?4,'permission_revoked',?5)",
      )
      .bind(project.organizationId, newUlid(), grantId, project.projectId, STORED_NOW)
      .run();
    await expect(
      database.reserve({ ...claim, ...(target as NonNullable<typeof target>) }),
    ).rejects.toBeInstanceOf(GithubAutoDeployTargetDeniedError);
    expect(await database.acknowledge(claim)).toBe(true);

    // The next push finds the grant revoked at the target read and is denied without a reservation.
    await push("60000000-0000-4000-8000-000000000000", "6".repeat(40));
    expect(await consumer.pollOne()).toMatchObject({
      status: "denied",
      deniedProjectIds: [project.projectId],
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"github_push_target_denied"'),
    );
    log.mockRestore();
    expect(() =>
      createD1GithubPushConsumer({ bindings: {}, surface: surface as never, clock, ids }),
    ).toThrow("GitHub auto-deploy is unavailable");
  } finally {
    await control.dispose();
  }
});

it("ends a push that the Core refuses for an inactive project as rejected, never as a retry", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project, push } = await seedPushTarget(control);
    let clockMs = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((clockMs += 1)) },
      ids = { next: () => parseUlid(newUlid()) };
    // The product surface answers every generic Core refusal of an accepted deployment (an inactive scope, a billing
    // epoch change or a grant change) with deployment_plan_expired. Such a refusal is a real rejection of the push.
    const surface = {
      async planDeployment() {
        return { status: 200, body: { id: newUlid() } };
      },
      async createDeployment() {
        throw new ProductSurfaceConflictError("deployment_plan_expired");
      },
    };
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
      },
      surface: surface as never,
      clock,
      ids,
    });
    const guid = "90000000-0000-4000-8000-000000000000";
    await push(guid, "9".repeat(40));
    expect(await consumer.pollOne()).toMatchObject({
      status: "failed",
      failedProjectIds: [project.projectId],
    });
    // The inbox row is acknowledged, not released for a retry, and the push operation ends as rejected.
    expect(
      await db
        .prepare("SELECT state FROM webhook_inbox WHERE external_event_id=?")
        .bind(guid)
        .first(),
    ).toEqual({ state: "acknowledged" });
    const failed = await db
      .prepare(
        "SELECT operation.failure FROM github_push_deployments push JOIN operations operation ON operation.operation_id=push.operation_id WHERE push.delivery_guid=?",
      )
      .bind(guid)
      .first<{ failure: string }>();
    expect(JSON.parse(failed?.failure ?? "{}")).toMatchObject({
      code: "AUTO_DEPLOY_PLAN_REJECTED",
      message: "The pushed commit could not be planned.",
    });
  } finally {
    await control.dispose();
  }
});

// The record the ingress Worker stores for a verified push: a global fact with no organization.
function receivedPush(guid: string, commit: string) {
  return {
    inboxEventId: newUlid(),
    externalEventId: guid,
    eventType: "push",
    payload: {
      schemaVersion: "github.push.v1",
      installationId: 42,
      repositoryId: 77,
      repositoryFullName: "octo/app",
      ref: "refs/heads/main",
      beforeCommitSha: "1".repeat(40),
      commitSha: commit,
      deleted: false,
    },
    bodyDigest: "02".repeat(32),
    receivedAt: "2026-10-29T10:00:00.000Z",
    maxAttempts: 5,
  };
}

it("routes a push recorded without an organization to the consumer and acknowledges it", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project } = await seedPushTarget(control);
    const clock = { now: () => new Date(Date.parse("2026-10-29T10:00:00.000Z")) },
      ids = { next: () => parseUlid(newUlid()) },
      surface = {
        async planDeployment() {
          throw new ProductSurfaceConflictError("mail_domain_required");
        },
        async createDeployment() {
          throw new Error("the planner rejects every commit in this test");
        },
      },
      guid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(await store.ingress.recordGithubWebhook(receivedPush(guid, "a".repeat(40)))).toBe(
      "created",
    );
    expect(
      await db
        .prepare("SELECT organization_id FROM webhook_inbox WHERE external_event_id=?")
        .bind(guid)
        .first(),
    ).toEqual({ organization_id: null });
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
        PREVIEW_API_RUNTIME: { readGithubCandidates: async () => [] } as never,
        SOURCE_INSPECTOR: {
          resolvePreviewGithubHead: async () => {
            throw new Error("no preview candidates");
          },
        },
      },
      surface: surface as never,
      clock,
      ids,
    });
    expect(await consumer.pollOne()).toMatchObject({
      status: "failed",
      failedProjectIds: [project.projectId],
    });
    expect(
      await db
        .prepare("SELECT state FROM webhook_inbox WHERE external_event_id=?")
        .bind(guid)
        .first(),
    ).toEqual({ state: "acknowledged" });
    expect(
      await db
        .prepare("SELECT state FROM github_push_deployments WHERE delivery_guid=?")
        .bind(guid)
        .first(),
    ).toEqual({ state: "failed" });
  } finally {
    await control.dispose();
  }
});

it("re-claims a push without an organization after its lease lapses and acknowledges it on the retry", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project } = await seedPushTarget(control);
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date(now) },
      ids = { next: () => parseUlid(newUlid()) },
      surface = {
        async planDeployment() {
          throw new ProductSurfaceConflictError("mail_domain_required");
        },
        async createDeployment() {
          throw new Error("the planner rejects every commit in this test");
        },
      },
      guid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      database = createD1GithubAutoDeployDatabase({
        github: store.github as never,
        inbox: store.operations as never,
        drain: store.maintenance as never,
        clock,
        ids,
        billingEpochOf: async () => project.billingEpochId,
        acceptPreview: async () => {},
      });
    await store.ingress.recordGithubWebhook(receivedPush(guid, "b".repeat(40)));
    // The first attempt claims the push and never answers: its lease lapses without an outcome.
    expect(await database.claimOne()).toMatchObject({ deliveryGuid: guid, attemptNumber: 1 });
    now += 120_000;
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
        PREVIEW_API_RUNTIME: { readGithubCandidates: async () => [] } as never,
        SOURCE_INSPECTOR: {
          resolvePreviewGithubHead: async () => {
            throw new Error("no preview candidates");
          },
        },
      },
      surface: surface as never,
      clock,
      ids,
    });
    expect(await consumer.pollOne()).toMatchObject({
      status: "failed",
      failedProjectIds: [project.projectId],
    });
    expect(
      await db
        .prepare("SELECT state, attempt_count FROM webhook_inbox WHERE external_event_id=?")
        .bind(guid)
        .first(),
    ).toEqual({ state: "acknowledged", attempt_count: 2 });
  } finally {
    await control.dispose();
  }
});

it("drains the pushes of one scheduled tick past ignored and unreadable rows to the configured branch", async () => {
  const control = await createTestControl();
  try {
    const { store, db, project, push } = await seedPushTarget(control);
    const clockMs = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date(clockMs) },
      ids = { next: () => parseUlid(newUlid()) };
    const surface = {
      async planDeployment() {
        throw new ProductSurfaceConflictError("mail_domain_required");
      },
      async createDeployment() {
        throw new Error("the planner rejects every commit in this test");
      },
    };
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
        PREVIEW_API_RUNTIME: { readGithubCandidates: async () => [] } as never,
        SOURCE_INSPECTOR: {
          resolvePreviewGithubHead: async () => {
            throw new Error("no preview candidates");
          },
        },
      },
      surface: surface as never,
      clock,
      ids,
    });
    // Three ignored-branch pushes and one row whose payload cannot be read sit before the two configured pushes.
    for (const index of [1, 2, 3])
      await push(`0000000${index}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, "e".repeat(40), "refs/heads/other");
    await db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push',?3,?4,?5,'pending',5,?5,NULL)",
      )
      .bind(
        newUlid(),
        "00000009-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        JSON.stringify({
          installationId: "42",
          repositoryId: "77",
          repositoryFullName: "octo/app",
          ref: "refs/tags/release",
          commitSha: "f".repeat(40),
          deleted: false,
        }),
        new Uint8Array(32).fill(4),
        STORED_NOW,
      )
      .run();
    await push("00000010-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "a".repeat(40));
    await push("00000011-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "b".repeat(40));

    await drainGithubPushes(consumer, { now: () => clockMs });

    const configured = await db
      .prepare(
        "SELECT delivery_guid,state FROM github_push_deployments WHERE organization_id=?1 ORDER BY delivery_guid",
      )
      .bind(project.organizationId)
      .all<{ delivery_guid: string; state: string }>();
    expect(configured.results.map((row) => row.delivery_guid)).toEqual([
      "00000010-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "00000011-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(configured.results.every((row) => row.state === "failed")).toBe(true);
  } finally {
    await control.dispose();
  }
});

it("acknowledges a tag push as ignored instead of stalling the queue behind it", async () => {
  const control = await createTestControl();
  try {
    const { store, db, push } = await seedPushTarget(control);
    const guid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await push(guid, "b".repeat(40), "refs/tags/v1.0.0");
    const consumer = createD1GithubPushConsumer({
      bindings: {
        GITHUB_RUNTIME: store.github,
        CONTROL_RUNTIME: store.operations,
        CONTROL_MAINTENANCE_RUNTIME: store.maintenance,
        PRODUCT_API_RUNTIME: store.productApi as never,
        PREVIEW_API_RUNTIME: { readGithubCandidates: async () => [] } as never,
        SOURCE_INSPECTOR: {
          resolvePreviewGithubHead: async () => {
            throw new Error("no preview candidates");
          },
        },
      },
      surface: {
        async planDeployment() {
          throw new Error("a tag push plans no deployment");
        },
        async createDeployment() {
          throw new Error("a tag push creates no deployment");
        },
      } as never,
      clock: { now: () => new Date(Date.parse("2026-10-29T10:00:00.000Z")) },
      ids: { next: () => parseUlid(newUlid()) },
    });
    await expect(consumer.pollOne()).resolves.toMatchObject({ status: "ignored" });
    expect(
      await db
        .prepare("SELECT state FROM webhook_inbox WHERE external_event_id=?")
        .bind(guid)
        .first(),
    ).toEqual({ state: "acknowledged" });
  } finally {
    await control.dispose();
  }
});
