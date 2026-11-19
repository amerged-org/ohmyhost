import { quoteBuildCost } from "@ohmyhost/platform";

import { planProjectDataChangeTransition } from "../../../../packages/database/src/project-data-environments.js";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import type { TestControl } from "./control-d1.js";
import { releaseProviderClaim, seedPublishedClaim } from "./accepted-operation.js";
import { STORED_NOW, type SeededProject } from "./platform-fixtures.js";
import { sourceFrameworkPlan, seedWfpPublication } from "./provider-fixtures.js";
import { projectInput, seedOrganization } from "./seed.js";
import { grantOneTime, makePaid } from "./credit-fixtures.js";

/** An accepted, settled project of the Product API on the one local core database. */
export interface ProductRig extends SeededProject {
  readonly control: TestControl;
  readonly store: ReturnType<typeof createControlStore>;
  readonly input: ReturnType<typeof projectInput>;
  readonly principalId: string;
}

let sequence = 0;
let issuedConfirmations = 0;
/** A request digest that is unique per call, so two acceptances never share an idempotency receipt by accident. */
export const requestDigest = () => new Uint8Array(32).fill((++sequence % 250) + 1);

/**
 * A project the way the store creates it (data assignments included) whose creation operation has finished, so
 * nothing else is queued or running and the Product API commands see an idle project.
 */
export async function productRig(
  control: TestControl,
  options: { readonly shared?: boolean; readonly prodOnly?: boolean } = {},
): Promise<ProductRig> {
  const store = createControlStore(control.bindings),
    organizationId = await seedOrganization(store, 2, 0),
    input = projectInput(
      organizationId,
      `shop-${newUlid().toLowerCase().slice(-12)}`,
      options.shared,
    );
  await store.projects.createInitialProject(
    options.prodOnly
      ? {
          ...input,
          includeDevelopmentEnvironment: false,
          productionDataEnvironmentId: input.productionEnvironmentId,
        }
      : input,
  );
  const transition = (type: "OperationStarted" | "OperationSucceeded", state: string, n: number) =>
    store.operations.transitionOperation({
      organizationId,
      operationId: input.operation.operationId,
      expected: { state, eventCount: n },
      event: {
        eventId: newUlid(),
        type,
        idempotencyKey: `${type}-settle`,
        occurredAt: "2026-10-28T10:30:00.000Z",
      },
      audit: {
        auditEventId: newUlid(),
        projectId: input.projectId,
        operationId: input.operation.operationId,
        eventType: type,
        actorType: "system",
        actorId: "workflow",
        payload: {},
        occurredAt: "2026-10-28T10:30:00.000Z",
      },
    });
  await transition("OperationStarted", "queued", 1);
  await transition("OperationSucceeded", "running", 2);
  return {
    control,
    store,
    input,
    organizationId,
    projectId: input.projectId,
    devEnvironmentId: input.developmentEnvironmentId,
    prodEnvironmentId: input.productionEnvironmentId,
    billingEpochId: input.billingEpochId,
    handle: input.projectHandle,
    shard: control.core,
    principalId: "user:user_seed",
  };
}

/** The ready GitHub source of the project: connection, grant (its trigger binds generation 1), selected source row and domain. */
export async function linkSource(rig: ProductRig) {
  const db = rig.control.core,
    sourceConnectionId = newUlid(),
    grantId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','42',?5)",
      )
      .bind(rig.organizationId, sourceConnectionId, rig.projectId, rig.billingEpochId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','7','42','o','r','contents:read',?6)",
      )
      .bind(
        rig.organizationId,
        grantId,
        rig.projectId,
        rig.billingEpochId,
        sourceConnectionId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO project_sources(organization_id,project_id,source_id,billing_epoch_id,grant_id,provider,installation_id,external_repository_id,repository_owner,repository_name,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'github','7','42','o','r','ready',1,?6,?6)",
      )
      .bind(rig.organizationId, rig.projectId, newUlid(), rig.billingEpochId, grantId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,NULL,'user:fixture',?7,?7,?8)",
      )
      .bind(
        rig.organizationId,
        rig.projectId,
        rig.input.operation.operationId,
        rig.handle,
        `${rig.handle}.check.omh.st`,
        `dev-${rig.handle}.check.omh.st`,
        new Uint8Array(32).fill(3),
        STORED_NOW,
      ),
  ]);
  return { sourceConnectionId, grantId };
}

/** One published, succeeded deployment of an environment (head version 1) whose operation has settled. */
export async function publishedRevision(
  rig: ProductRig,
  environmentId: string,
  options: { readonly frameworkPlan?: unknown } = {},
) {
  const { published } = await seedPublishedClaim(rig, environmentId, (operationId) =>
    seedWfpPublication(rig, { operationId, environmentId, frameworkPlan: options.frameworkPlan }),
  );
  await releaseProviderClaim(rig);
  return published;
}

export const PLAN_AT = "2026-10-28T11:00:00.000Z";

/** The request of an immutable deployment plan of the dev environment. */
export function planRequest(
  rig: ProductRig,
  sourceConnectionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    planId: newUlid(),
    organizationId: rig.organizationId,
    projectId: rig.projectId,
    environmentId: rig.devEnvironmentId,
    sourceConnectionId,
    sourceGeneration: 1,
    commitSha: "b".repeat(40),
    sourceDigest: new Uint8Array(32).fill(5),
    buildPlanDigest: new Uint8Array(32).fill(6),
    planDigest: requestDigest(),
    runtime: "cloudflare_workers_edge_ssr",
    frameworkPlan: sourceFrameworkPlan(false),
    impacts: [],
    risks: [],
    costEstimate: quoteBuildCost(PLAN_AT),
    createdAt: PLAN_AT,
    ...overrides,
  };
}

/** A deployment plan of the dev environment, created through the real command. */
export async function createPlan(rig: ProductRig, sourceConnectionId: string) {
  const plan = planRequest(rig, sourceConnectionId),
    outcome = await rig.store.productApi.createApiDeploymentPlan(plan);
  if (outcome !== "created") throw new Error(`plan was not created: ${String(outcome)}`);
  return plan;
}

/** The common fields of an acceptance request; `overrides` carry the event type's own fields. */
export function acceptance<Extra extends Record<string, unknown>>(
  rig: ProductRig,
  environmentId: string,
  overrides: Extra,
) {
  return {
    organizationId: rig.organizationId,
    projectId: rig.projectId,
    environmentId,
    billingEpochId: rig.billingEpochId,
    operationId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    outboxEventId: newUlid(),
    principalId: rig.principalId,
    requestId: "req-product",
    httpMethod: "POST",
    routeTemplate: "/v1/projects/{project_id}/operations",
    idempotencyKey: `key-${newUlid()}`,
    canonicalRequestDigest: requestDigest(),
    occurredAt: "2026-10-28T11:30:00.000Z",
    ...overrides,
  };
}

/** The action confirmation of a command: issued through the real command, consumed by the accepting batch. */
/** A token digest unique in the whole database: `action_confirmations.token_sha256` is a global UNIQUE column. */
function uniqueTokenDigest(): Uint8Array {
  const digest = new Uint8Array(32);
  new DataView(digest.buffer).setUint32(0, ++issuedConfirmations);
  return digest;
}

export async function issueConfirmation(
  rig: ProductRig,
  action: "rollback" | "promote" | "delete" | "data_change",
  subjectEtag: string,
  targetDeploymentId?: string,
) {
  const issued = {
    confirmationId: newUlid(),
    organizationId: rig.organizationId,
    projectId: rig.projectId,
    issuedToPrincipalId: rig.principalId,
    action,
    ...(targetDeploymentId === undefined ? {} : { targetDeploymentId }),
    subjectEtag,
    tokenDigest: uniqueTokenDigest(),
    issuedAt: "2026-10-28T11:20:00.000Z",
  };
  const outcome = await rig.store.productApi.issueApiActionConfirmation(issued);
  if (outcome !== "created") throw new Error(`confirmation was not created: ${String(outcome)}`);
  return {
    organizationId: issued.organizationId,
    projectId: issued.projectId,
    issuedToPrincipalId: issued.issuedToPrincipalId,
    action,
    ...(targetDeploymentId === undefined ? {} : { targetDeploymentId }),
    subjectEtag,
    tokenDigest: issued.tokenDigest,
    consumedAt: "2026-10-28T11:25:00.000Z",
  };
}

/**
 * A planned data change of the project: the current state as the Product API reads it, the transition computed
 * from that state, and the action confirmation issued for it. `request` builds the accepting request.
 */
export async function planDataChange(
  rig: ProductRig,
  change:
    | "isolate_prod_keeps_data"
    | "isolate_dev_keeps_data"
    | "share_prod_keeps_data"
    | "reset_dev",
) {
  const api = rig.store.productApi,
    scope = { organizationId: rig.organizationId, projectId: rig.projectId },
    state = await api.readApiProjectDataChangeState({
      ...scope,
      principalId: rig.principalId,
      includeRenewal: true,
    });
  if (state === null) throw new Error("the project has no data change state");
  const transition = planProjectDataChangeTransition({
    change,
    assignments: state.assignments,
    newDataEnvironmentId: newUlid(),
    prodDatabaseReady: state.prodDatabaseReady,
  });
  const tokenDigest = new Uint8Array(32).fill(0xd1);
  const confirmationId = newUlid();
  const plan = {
    ...scope,
    principalId: rig.principalId,
    billingEpochId: rig.billingEpochId,
    expectedProjectVersion: state.lifecycleVersion,
    snapshot: {
      transition,
      environmentHeads: state.environmentHeads,
      registrationGenerations: state.registrationGenerations,
    },
    confirmation: {
      confirmationId,
      ...scope,
      issuedToPrincipalId: rig.principalId,
      action: "data_change",
      subjectEtag: '"data"',
      tokenDigest,
      issuedAt: "2026-10-28T11:20:00.000Z",
    },
  };
  await api.issueApiProjectDataChangePlan(plan);
  const request = (overrides: Record<string, unknown> = {}) =>
    acceptance(rig, rig.devEnvironmentId, {
      eventType: "ProjectDataChangeRequestedV1",
      routeTemplate: "/v1/projects/{project_id}/data-change",
      cleanupRunId: newUlid(),
      expectedProjectVersion: state.lifecycleVersion,
      dataChange: change,
      dataChangeSnapshot: transition,
      expectedEnvironmentHeads: state.environmentHeads,
      expectedRegistrationGenerations: state.registrationGenerations,
      expectedEtag: '"data"',
      confirmation: {
        ...scope,
        issuedToPrincipalId: rig.principalId,
        action: "data_change",
        subjectEtag: '"data"',
        tokenDigest,
        consumedAt: "2026-10-28T11:25:00.000Z",
      },
      ...overrides,
    });
  return { state, transition, confirmationId, plan, request };
}

/** The Mail setup of the project the plan admission reads: an active sending domain bound to the prod environment. */
export async function configureMail(rig: ProductRig) {
  const db = rig.control.core,
    domainId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,configured_at) VALUES(?1,?2,'mail.example.test','example.test',?2,?3,?4,?5)",
      )
      .bind(domainId, rig.organizationId, rig.projectId, rig.prodEnvironmentId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO project_mail_domain_bindings(project_id,organization_id,environment_id,mail_domain_id,legacy,configured_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?5)",
      )
      .bind(rig.projectId, rig.organizationId, rig.prodEnvironmentId, domainId, STORED_NOW),
  ]);
}

/** Paid access of the organization, the entitlement a Mail plan requires. */
export async function grantPaidAccess(rig: ProductRig) {
  await makePaid(rig.control.core, rig.organizationId);
}

/** Funded organization credit: 100 credits of one-time credit on top of the Free month. */
export async function fundOrganization(rig: ProductRig) {
  await grantOneTime(
    rig.control.core,
    rig.organizationId,
    100_000_000,
    `topup:fixture-${rig.projectId}`,
  );
}
