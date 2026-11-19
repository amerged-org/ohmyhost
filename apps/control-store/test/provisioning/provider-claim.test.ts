import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { parseProductCommandMessageV1 } from "../../../orchestrator/src/product-command.js";
import { createWorkflowContextReader } from "../../../project-provisioning-worker/src/workflow-context-reader.js";
import { createCoreDeploymentReaderPort } from "../../../project-provisioning-worker/src/core-deployment-reader.js";
import type { DeploymentWorkflowRuntimeBinding } from "../../../project-provisioning-worker/src/deployment-persistence-port.js";
import { DeploymentPersistenceConflictError } from "../../../../packages/database/src/deployment-persistence.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import { DeploymentWorkflowRuntime } from "../../src/worker-main.js";
import { createTestControl } from "../support/control-d1.js";
import { workflowFixture } from "./workflow-fixture.js";
import { claimProductProviderMutation } from "../../src/catalog/provisioning/provider-claim.js";
import { SharedCoreRouter } from "../../src/router.js";
import { beforeFirstWrite, losingWriteResponses } from "../support/platform-fixtures.js";
import { newUlid } from "../../src/catalog/common.js";
const context = (db: Awaited<ReturnType<typeof createTestControl>>["core"]) => ({
  directory: db,
  router: new SharedCoreRouter(db),
});
it("atomically claims the original run and starts its operation/deployment, replays the exact claim and observes a lost reply", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    expect(
      await claimProductProviderMutation(context(losingWriteResponses(c.core, 1)), r.input),
    ).toBe("existing");
    expect(await claimProductProviderMutation(context(c.core), r.input)).toBe("existing");
    expect(
      await c.core
        .prepare("SELECT state FROM operations WHERE operation_id=?")
        .bind(r.input.operationId)
        .first(),
    ).toEqual({ state: "running" });
    expect(
      await c.core
        .prepare("SELECT status FROM deployments WHERE deployment_id=?")
        .bind(r.deployment)
        .first(),
    ).toEqual({ status: "running" });
    const events = (
      await c.core
        .prepare(
          "SELECT event_id,event_type,idempotency_key,payload,occurred_at FROM operation_events WHERE operation_id=? ORDER BY revision",
        )
        .bind(r.input.operationId)
        .all()
    ).results;
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      event_id: r.input.claimId,
      event_type: "OperationStarted",
      idempotency_key: `${r.input.logicalWorkflowId}:start`,
      payload: "{}",
      occurred_at: "2026-10-28T11:00:05.000000Z",
    });
    await expect(
      claimProductProviderMutation(context(c.core), { ...r.input, claimId: newUlid() }),
    ).rejects.toThrow("Another product provider mutation");
    const fresh = await workflowFixture(c);
    const runtime = new DeploymentWorkflowRuntime({}, c.bindings);
    const port = createCoreDeploymentReaderPort(
      runtime as unknown as DeploymentWorkflowRuntimeBinding,
    );
    const domainInput = {
      ...fresh.input,
      claimId: parseUlid(fresh.input.claimId),
      organizationId: parseUlid(fresh.input.organizationId),
      projectId: parseUlid(fresh.input.projectId),
      environmentId: parseUlid(fresh.input.environmentId),
      operationId: parseUlid(fresh.input.operationId),
      eventId: parseUlid(fresh.input.eventId),
    };
    await expect(
      port.claimProviderMutation({
        ...domainInput,
        logicalWorkflowId: ` ${domainInput.logicalWorkflowId}`,
      }),
    ).rejects.toThrow();
    await expect(
      port.claimProviderMutation({ ...domainInput, claimId: parseUlid(r.input.claimId) }),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
    expect(await port.claimProviderMutation(domainInput)).toBe("created");
    const command = parseProductCommandMessageV1({
      version: 1,
      eventType: "DeploymentRequestedV1",
      eventId: domainInput.eventId,
      organizationId: domainInput.organizationId,
      projectId: domainInput.projectId,
      environmentId: domainInput.environmentId,
      operationId: domainInput.operationId,
      billingEpochId: fresh.p.billingEpochId,
      planId: fresh.plan,
    });
    if (command.eventType !== "DeploymentRequestedV1")
      throw new Error("Deployment fixture command differs");
    const read = createWorkflowContextReader(port),
      current = await read(command);
    expect(Buffer.isBuffer(current.intent.sourceDigest)).toBe(true);
    expect(Buffer.isBuffer(current.intent.buildPlanDigest)).toBe(true);
    expect(current.intent.sourceArtifactDigest).toBe(null);
    const { planId, ...sourceCommand } = command;
    void planId;
    await expect(
      read(parseProductCommandMessageV1({ ...sourceCommand, eventType: "SourceLinkRequestedV1" })),
    ).rejects.toThrow("no exact persisted command context");
    await expect(read({ ...command, operationId: parseUlid(newUlid()) })).rejects.toThrow(
      "no exact persisted command context",
    );
    await expect(
      port.claimProviderMutation({ ...domainInput, claimId: parseUlid(newUlid()) }),
    ).rejects.toBeInstanceOf(DeploymentPersistenceConflictError);
    expect(
      await port.readDatabaseTarget({
        organizationId: fresh.p.organizationId,
        projectId: fresh.p.projectId,
        physicalEnvironmentId: fresh.p.developmentDataEnvironmentId,
      }),
    ).toMatchObject({ providerTarget: null, databaseRegistration: null });
    const uncertain = new Error("RPC reply lost");
    const transport = createCoreDeploymentReaderPort({
      readProductWorkflowContext: (input) => runtime.readProductWorkflowContext(input),
      readProductWorkflowDatabaseTarget: async () => {
        throw uncertain;
      },
      claimProductProviderMutation: (input) => runtime.claimProductProviderMutation(input),
    });
    await expect(
      transport.readDatabaseTarget({
        organizationId: fresh.p.organizationId,
        projectId: fresh.p.projectId,
        physicalEnvironmentId: fresh.p.developmentDataEnvironmentId,
      }),
    ).rejects.toBe(uncertain);
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
it("rejects source/owner/lifecycle/consent changes at the actual claim batch and rolls every effect back on a late failure", async () => {
  const c = await createTestControl();
  try {
    const committed = await workflowFixture(c, { delegated: true, production: true });
    const losing = losingWriteResponses(c.core, 1);
    let revokedAfterCommit = false;
    const boundary = {
      prepare: (sql: string) => losing.prepare(sql),
      batch: async (statements: Parameters<typeof losing.batch>[0]) => {
        try {
          return await losing.batch(statements);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("Network connection lost") &&
            !revokedAfterCommit
          ) {
            await c.core
              .prepare(
                "UPDATE mcp_client_grants SET revoked_at='2026-10-28T11:00:06.000000Z' WHERE grant_id=?",
              )
              .bind(committed.grantId)
              .run();
            revokedAfterCommit = true;
          }
          throw error;
        }
      },
    };
    await expect(
      claimProductProviderMutation(context(boundary), committed.input),
    ).rejects.toMatchObject({
      name: "OperationAuthorizationConflictError",
      code: "operation_authorization_changed",
    });
    expect(revokedAfterCommit).toBe(true);
    expect(
      await c.core
        .prepare("SELECT count(*) n FROM product_provider_mutation_claims WHERE claim_id=?")
        .bind(committed.input.claimId)
        .first(),
    ).toEqual({ n: 1 });
    for (const mode of ["source", "owner", "lifecycle", "grant", "late-audit", "terminal-user"]) {
      const r = await workflowFixture(c, { delegated: true, production: true });
      let interleaved = false;
      const db = beforeFirstWrite(c.core, async () => {
        if (mode === "source")
          await c.core
            .prepare(
              "UPDATE project_source_bindings SET generation=generation+1 WHERE organization_id=? AND project_id=?",
            )
            .bind(r.input.organizationId, r.input.projectId)
            .run();
        if (mode === "owner")
          await c.core
            .prepare(
              "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
            )
            .bind(r.input.organizationId, r.input.projectId)
            .run();
        if (mode === "lifecycle")
          await c.core
            .prepare(
              "UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE organization_id=? AND project_id=?",
            )
            .bind(r.input.organizationId, r.input.projectId)
            .run();
        if (mode === "grant")
          await c.core
            .prepare(
              "UPDATE mcp_client_grants SET revoked_at='2026-10-28T11:00:06.000000Z' WHERE grant_id=?",
            )
            .bind(r.grantId)
            .run();
        if (mode === "terminal-user")
          await c.core
            .prepare(
              "INSERT INTO revocations(kind,resource_id,effective_at,source_event_id) VALUES('user','user_seed','2026-10-28T11:00:06.000000Z','evt_fixture_revoke')",
            )
            .run();
        if (mode === "late-audit")
          await c.core
            .prepare(
              "CREATE TRIGGER provider_claim_late_failure BEFORE INSERT ON audit_events WHEN NEW.event_type='OperationStarted' BEGIN SELECT RAISE(ABORT,'late claim audit'); END",
            )
            .run();
        interleaved = true;
      });
      await expect(claimProductProviderMutation(context(db), r.input), mode).rejects.toThrow();
      expect(interleaved, mode).toBe(true);
      expect(
        await c.core
          .prepare("SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?")
          .bind(r.input.operationId)
          .first(),
      ).toEqual({ n: 0 });
      expect(
        await c.core
          .prepare("SELECT state FROM operations WHERE operation_id=?")
          .bind(r.input.operationId)
          .first(),
      ).toEqual({ state: "queued" });
      if (mode === "late-audit")
        await c.core.prepare("DROP TRIGGER provider_claim_late_failure").run();
      // User revocations are terminal. Each fixture needs its own user; keep this case last within this authority.
    }
  } finally {
    await c.dispose();
  }
}, 60_000);

it("answers created for a first claim and existing for its replay, with exact start audit and claim rows", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c),
      p = r.p;
    expect(await claimProductProviderMutation(context(c.core), r.input)).toBe("created");
    expect(await claimProductProviderMutation(context(c.core), r.input)).toBe("existing");
    expect(
      (
        await c.core
          .prepare(
            "SELECT audit_event_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id FROM audit_events WHERE organization_id=?1 AND operation_id=?2 AND event_type='OperationStarted'",
          )
          .bind(p.organizationId, r.input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        audit_event_id: r.input.claimId,
        event_type: "OperationStarted",
        actor_type: "system",
        actor_id: "deployment-workflow",
        payload: "{}",
        occurred_at: "2026-10-28T11:00:05.000000Z",
        billing_epoch_id: p.billingEpochId,
      },
    ]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT claim_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version FROM product_provider_mutation_claims WHERE claim_id=?",
          )
          .bind(r.input.claimId)
          .all()
      ).results,
    ).toEqual([
      {
        claim_id: r.input.claimId,
        organization_id: p.organizationId,
        project_id: p.projectId,
        environment_id: r.input.environmentId,
        operation_id: r.input.operationId,
        billing_epoch_id: p.billingEpochId,
        event_id: r.input.eventId,
        logical_workflow_id: r.input.logicalWorkflowId,
        event_type: "DeploymentRequestedV1",
        accepted_lifecycle_version: 1,
      },
    ]);
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
