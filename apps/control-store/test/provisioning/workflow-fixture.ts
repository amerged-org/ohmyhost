import { quoteBuildCost } from "@ohmyhost/platform";
import type { TestControl } from "../support/control-d1.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { projectInput, seedOrganization, acceptInput, digest } from "../support/seed.js";
import { sourceFrameworkPlan } from "../support/provider-fixtures.js";

export async function workflowFixture(
  control: TestControl,
  options: {
    delegated?: boolean;
    production?: boolean;
    frameworkPlan?: unknown;
    bindingSnapshot?: (ids: {
      project: ReturnType<typeof projectInput>;
      planId: string;
      deploymentId: string;
    }) => string;
  } = {},
) {
  const store = createControlStore(control.bindings),
    organizationId = await seedOrganization(store, 2, 0),
    p = projectInput(organizationId, `workflow-${newUlid().toLowerCase()}`),
    db = control.core;
  p.outbox.eventType = "ProjectProvisioningRequested";
  p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
  await store.projects.createInitialProject(p);
  await store.provisioning.completeHello({
    organizationId,
    projectId: p.projectId,
    operationId: p.operation.operationId,
    requestEventId: p.outbox.eventId,
    workflowId: `project-provisioning-v1-${p.outbox.eventId}-${p.operation.operationId}`,
    serviceActorId: "project-provisioning-worker",
    started: {
      eventId: newUlid(),
      auditEventId: newUlid(),
      occurredAt: "2026-10-28T10:00:01.000Z",
    },
    succeeded: {
      eventId: newUlid(),
      auditEventId: newUlid(),
      occurredAt: "2026-10-28T10:00:01.001Z",
    },
  });
  const grantId = crypto.randomUUID(),
    clientId = "workflow-fixture",
    consentHash = digest(99),
    environmentId = options.production ? p.productionEnvironmentId : p.developmentEnvironmentId;
  if (options.delegated) {
    const org = await db
      .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
      .bind(organizationId)
      .first<{ workos_organization_id: string }>();
    if (!org) throw new Error("Fixture organization missing");
    await store.identity.applyOrganizationSnapshot({
      organizationId,
      workosOrganizationId: org.workos_organization_id,
      state: "active",
      snapshotDigest: digest(71),
      snapshotFetchedAt: "2026-10-28T10:30:00.000Z",
      synchronizedAt: "2026-10-28T10:30:00.000Z",
      triggerEventId: "evt_workflow_owner",
      memberships: [
        { workosUserId: "user_seed", role: "admin", status: "active", digest: digest(72) },
      ],
      auditEventId: newUlid(),
    });
    await db.batch([
      db
        .prepare(
          "UPDATE organizations SET beta_admitted_at='2026-10-28T09:00:00.000000Z' WHERE organization_id=?",
        )
        .bind(organizationId),
      db
        .prepare(
          `INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES(?,?,'user_seed',?,?,?,1,?,1,1,'2026-10-28T10:45:00.000000Z')`,
        )
        .bind(organizationId, grantId, clientId, consentHash, p.projectId, p.billingEpochId),
    ]);
  }
  const accepted = acceptInput(p, {
    environmentId,
    ...(options.delegated
      ? { delegation: { grantId, clientId, consentHash, action: "deployments:create" } }
      : {}),
  });
  await store.operations.acceptApiOperation(accepted);
  const source = newUlid(),
    sourceGrant = newUlid(),
    plan = newUlid(),
    deployment = newUlid(),
    claimId = newUlid(),
    logicalWorkflowId = `product-command-v1-deploy-${accepted.outboxEventId}-${accepted.operationId}`,
    stamp = "2026-10-28T11:00:00.000000Z",
    bytes = new Uint8Array(32).fill(3);
  const bindingSnapshot =
    options.bindingSnapshot?.({ project: p, planId: plan, deploymentId: deployment }) ?? null;
  await db.batch([
    db
      .prepare(
        `INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?,?,?,?,'github','42',?)`,
      )
      .bind(organizationId, source, p.projectId, p.billingEpochId, stamp),
    db
      .prepare(
        `INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?,?,?,?,?,'github','7','42','o','r','contents:read',?)`,
      )
      .bind(organizationId, sourceGrant, p.projectId, p.billingEpochId, source, stamp),
    db
      .prepare(
        `INSERT INTO deployment_plans(organization_id,plan_id,project_id,source_connection_id,commit_sha,source_sha256,build_plan_sha256,runtime,impacts,risks,cost_estimate,created_at,expires_at,plan_sha256,framework_plan,environment_id,source_generation) VALUES(?,?,?,?,?,?,?,'cloudflare_workers_edge_ssr','[]','[]',?,?,'2026-10-28T12:00:00.000000Z',?,?,?,1)`,
      )
      .bind(
        organizationId,
        plan,
        p.projectId,
        source,
        "a".repeat(40),
        bytes,
        bytes,
        JSON.stringify(quoteBuildCost("2026-10-28T11:00:00.000Z")),
        stamp,
        bytes,
        JSON.stringify(options.frameworkPlan ?? sourceFrameworkPlan(false)),
        environmentId,
      ),
    db
      .prepare(
        `INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'deploy','queued',?,?)`,
      )
      .bind(
        organizationId,
        deployment,
        p.projectId,
        environmentId,
        accepted.operationId,
        stamp,
        stamp,
      ),
    db
      .prepare(
        `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,plan_id,source_connection_id,deployment_id,source_generation,binding_refresh_snapshot,created_at) VALUES(?,?,?,?,?,'DeploymentRequestedV1',?,?,?,1,?,?)`,
      )
      .bind(
        organizationId,
        p.projectId,
        environmentId,
        accepted.operationId,
        p.billingEpochId,
        plan,
        source,
        deployment,
        bindingSnapshot,
        stamp,
      ),
    db
      .prepare(
        `INSERT INTO product_workflow_runs(workflow_id,event_id,organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'DeploymentRequestedV1','queued','2026-10-28T11:00:05.000000Z','2026-10-28T11:00:05.000000Z')`,
      )
      .bind(
        logicalWorkflowId,
        accepted.outboxEventId,
        organizationId,
        p.projectId,
        environmentId,
        accepted.operationId,
        p.billingEpochId,
      ),
  ]);
  return {
    control,
    store,
    db,
    p,
    accepted,
    source,
    sourceGrant,
    plan,
    deployment,
    grantId,
    clientId,
    consentHash,
    input: {
      claimId,
      organizationId,
      projectId: p.projectId,
      environmentId,
      operationId: accepted.operationId,
      eventId: accepted.outboxEventId,
      logicalWorkflowId,
      eventType: "DeploymentRequestedV1" as const,
      acceptedLifecycleVersion: 1,
    },
  };
}
