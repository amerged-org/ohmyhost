import { expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import { seedAcceptedOperation, seedOperation } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization } from "../support/seed.js";
import { losingWriteResponses, seedProject } from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

const LEASE = "2026-10-28T10:02:00.000000Z";

/**
 * A project whose prod environment serves a published deployment under `handle`, and the accepted rename to
 * `requested` whose gateway route is already moved: the exact state in which the Workflow finalizes the rename.
 */
async function renameFixture(control: TestControl, handle: string, requested: string) {
  const store = createControlStore(control.bindings);
  const project = await seedProject(control, { handle });
  const publishing = await seedOperation(project);
  const published = await seedWfpPublication(project, {
    operationId: publishing,
    environmentId: project.prodEnvironmentId,
  });
  await control.core
    .prepare("UPDATE operations SET state='succeeded' WHERE operation_id=?1")
    .bind(publishing)
    .run();
  const accepted = await seedAcceptedOperation(project, project.prodEnvironmentId, {
    eventType: "ProjectHandleChangeRequestedV1",
    intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: requested },
  });
  const route = await store.gateway.management.activate({
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: accepted.operationId,
    claimId: accepted.claimId,
    expectedRevision: 1,
    candidateReceiptId: published.candidateReceiptId,
    egressAllowedOrigins: [],
  });
  await control.core
    .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
    .bind(accepted.eventId, "2026-10-28T10:01:00.000000Z")
    .run();
  await control.core
    .prepare("UPDATE operations SET lease_expires_at=?2 WHERE operation_id=?1")
    .bind(accepted.operationId, LEASE)
    .run();
  const input = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: project.prodEnvironmentId,
    operationId: accepted.operationId,
    requestedHandle: requested,
    moved: [{ environmentId: project.prodEnvironmentId, publicOrigin: route.publicOrigin }],
    workflowId: accepted.workflowId,
    outboxEventId: accepted.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    completedAt: "2026-10-28T10:05:00.000Z",
  };
  return { control, project, published, accepted, route, input };
}
type Fixture = Awaited<ReturnType<typeof renameFixture>>;

const first = async <T>(f: Fixture, sql: string, ...values: unknown[]) =>
  f.control.core
    .prepare(sql)
    .bind(...values)
    .first<T>();
const OPERATION_ROW = "SELECT state,lease_expires_at FROM operations WHERE operation_id=?";
const addressReceipts = (f: Fixture) =>
  f.control.core
    .prepare(
      "SELECT shared_gateway_revision,handle,public_origin,head_version FROM shared_gateway_address_receipts WHERE organization_id=?1 AND operation_id=?2",
    )
    .bind(f.project.organizationId, f.input.operationId)
    .all();

it("moves the handle, the domain row and the address receipt with the terminal evidence in one commit, then replays and survives a lost response", async () => {
  const control = await createTestControl();
  try {
    const f = await renameFixture(control, "old-handle-one", "renamed-one");
    const { project, input } = f;
    const store = createControlStore(control.bindings);
    expect(f.route).toMatchObject({ revision: 2, handle: "renamed-one", active: true });

    expect(await store.provisioning.finalizeHandleChange(input)).toBe("applied");
    expect(
      await first(
        f,
        "SELECT handle,handle_version FROM projects WHERE project_id=?",
        project.projectId,
      ),
    ).toEqual({ handle: "renamed-one", handle_version: "customer-chosen-v1" });
    expect(
      await first(
        f,
        "SELECT handle,production_domain,development_domain FROM cloudflare_project_domains WHERE project_id=?",
        project.projectId,
      ),
    ).toEqual({
      handle: "renamed-one",
      production_domain: "renamed-one.check.omh.st",
      development_domain: "dev-renamed-one.check.omh.st",
    });
    expect((await addressReceipts(f)).results).toEqual([
      {
        shared_gateway_revision: 2,
        handle: "renamed-one",
        public_origin: "https://renamed-one.check.omh.st",
        head_version: 1,
      },
    ]);
    expect(
      await first(
        f,
        "SELECT state,terminal_evidence FROM product_workflow_runs WHERE workflow_id=?",
        input.workflowId,
      ),
    ).toEqual({
      state: "completed",
      terminal_evidence: expect.stringContaining('"requestedHandle"'),
    });
    // The operation ends succeeded and releases its lease together with the Workflow run.
    expect(await first(f, OPERATION_ROW, input.operationId)).toEqual({
      state: "succeeded",
      lease_expires_at: null,
    });
    expect(
      (
        await control.core
          .prepare("SELECT event_type FROM operation_events WHERE operation_id=? ORDER BY revision")
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([{ event_type: "OperationStarted" }, { event_type: "OperationSucceeded" }]);
    expect(
      await first(
        f,
        "SELECT event_type FROM audit_events WHERE audit_event_id=?",
        input.auditEventId,
      ),
    ).toEqual({ event_type: "ProjectHandleChangeRequestedV1Completed" });

    // The same finalization again changes nothing and says so.
    expect(await store.provisioning.finalizeHandleChange(input)).toBe("duplicate");
    expect((await addressReceipts(f)).results).toHaveLength(1);

    // A committed finalization whose response is lost is answered "duplicate" by the lookup, not applied twice.
    const lost = await renameFixture(control, "old-handle-lost", "renamed-lost");
    const lossy = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    expect(await lossy.provisioning.finalizeHandleChange(lost.input)).toBe("duplicate");
    expect(
      await first(lost, "SELECT handle FROM projects WHERE project_id=?", lost.project.projectId),
    ).toEqual({ handle: "renamed-lost" });
    expect((await addressReceipts(lost)).results).toHaveLength(1);
    const same = await renameFixture(control, "same-native-address", "same-native-address");
    await control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App','https://same-native-address.check.omh.st',1,1)",
      )
      .bind(same.project.organizationId, same.project.projectId, same.project.prodEnvironmentId)
      .run();
    expect(await store.provisioning.finalizeHandleChange(same.input)).toBe("applied");
    expect(
      await control.core
        .prepare(
          "SELECT configuration_revision,revocation_epoch FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(same.project.organizationId, same.project.projectId, same.project.prodEnvironmentId)
        .first(),
    ).toEqual({ configuration_revision: 1, revocation_epoch: 1 });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("keeps the original rename pending until the affected Native policy is acknowledged", async () => {
  const control = await createTestControl();
  try {
    const f = await renameFixture(control, "old-native-rename", "new-native-rename");
    const store = createControlStore(control.bindings);
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(f.project.organizationId, "2026-10-28T09:00:00.000000Z"),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_renameowner','admin','active',1,?2,?3,'evt-rename')",
        )
        .bind(f.project.organizationId, new Uint8Array(32).fill(1), "2026-10-28T09:00:00.000000Z"),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_renameowner','owner',?3)",
        )
        .bind(f.project.organizationId, newUlid(), "2026-10-28T09:00:00.000000Z"),
      control.core
        .prepare(
          "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal','user:user_renameowner','{}',?5,?6)",
        )
        .bind(
          f.project.organizationId,
          newUlid(),
          f.project.projectId,
          f.input.operationId,
          "2026-10-28T10:00:00.000000Z",
          f.project.billingEpochId,
        ),
    ]);
    await control.core
      .prepare(
        `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)`,
      )
      .bind(
        f.project.organizationId,
        f.project.projectId,
        f.project.prodEnvironmentId,
        "https://old-native-rename.check.omh.st",
      )
      .run();
    const concurrent = await Promise.allSettled([
      store.provisioning.finalizeHandleChange(f.input),
      store.provisioning.finalizeHandleChange(f.input),
    ]);
    expect(
      concurrent.some((result) => result.status === "fulfilled" && result.value === "pending"),
    ).toBe(true);
    expect(
      concurrent.every((result) => result.status === "rejected" || result.value === "pending"),
    ).toBe(true);
    expect(await first(f, OPERATION_ROW, f.input.operationId)).toMatchObject({ state: "running" });
    expect(
      await store.provisioning.finalizeHandleChange({
        ...f.input,
        completedAt: "2026-10-28T10:06:00.000Z",
      }),
    ).toBe("pending");
    const scope = {
      organizationId: f.project.organizationId,
      projectId: f.project.projectId,
      kind: "handle_change" as const,
      identity: f.input.operationId,
    };
    expect(await store.identity.readDomainPolicySync(scope)).toMatchObject([
      {
        environmentId: f.project.prodEnvironmentId,
        configurationRevision: 2,
        revocationEpoch: 2,
        canonicalOrigin: null,
        registryVersion: null,
      },
    ]);
    await expect(
      store.identity.ackDomainPolicySync({
        ...scope,
        environmentId: f.project.prodEnvironmentId,
        configurationRevision: 2,
        revocationEpoch: 3,
        ownerEnabled: true,
        registryVersion: null,
        acknowledgement: "unprovisioned",
      }),
    ).rejects.toThrow();
    expect(
      await store.identity.ackDomainPolicySync({
        ...scope,
        environmentId: f.project.prodEnvironmentId,
        configurationRevision: 2,
        revocationEpoch: 2,
        ownerEnabled: true,
        registryVersion: null,
        acknowledgement: "unprovisioned",
      }),
    ).toBe("acknowledged");
    expect(
      await store.provisioning.finalizeHandleChange({
        ...f.input,
        completedAt: "2026-10-28T10:06:00.000Z",
      }),
    ).toBe("applied");
    expect(
      await store.provisioning.finalizeHandleChange({
        ...f.input,
        completedAt: "2026-10-28T10:07:00.000Z",
      }),
    ).toBe("duplicate");
    expect(await first(f, OPERATION_ROW, f.input.operationId)).toMatchObject({
      state: "succeeded",
    });

    const stranded = await renameFixture(control, "old-stranded-rename", "stranded-rename");
    const p = stranded.project,
      stamp = "2026-10-28T09:00:00.000000Z";
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(p.organizationId, stamp),
      ...["user_oldowner", "user_newowner"].flatMap((user) => [
        control.core
          .prepare(
            "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'admin','active',1,?3,?4,'evt-owner')",
          )
          .bind(p.organizationId, user, new Uint8Array(32).fill(1), stamp),
        control.core
          .prepare(
            "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
          )
          .bind(p.organizationId, newUlid(), `user:${user}`, stamp),
      ]),
      control.core
        .prepare(
          "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal','user:user_oldowner','{}',?5,?6)",
        )
        .bind(
          p.organizationId,
          newUlid(),
          p.projectId,
          stranded.input.operationId,
          stamp,
          p.billingEpochId,
        ),
      control.core
        .prepare(
          "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App','https://old-stranded-rename.check.omh.st',1,1)",
        )
        .bind(p.organizationId, p.projectId, p.prodEnvironmentId),
    ]);
    expect(await store.provisioning.finalizeHandleChange(stranded.input)).toBe("pending");
    expect(
      await store.productApi.readApiRenameAdmission({
        organizationId: p.organizationId,
        projectId: p.projectId,
        handle: "stranded-rename",
      }),
    ).toMatchObject({ handle: "stranded-rename", busy: false, nativeRecoveryPending: true });
    await control.core
      .prepare(
        "INSERT INTO revocations(kind,resource_id,source_event_id,effective_at) VALUES('user','user_oldowner',?1,?2)",
      )
      .bind(newUlid(), stamp)
      .run();
    const strandedScope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      kind: "handle_change" as const,
      identity: stranded.input.operationId,
    };
    await expect(store.identity.readDomainPolicySync(strandedScope)).rejects.toThrow();
    const next = await seedAcceptedOperation(p, p.prodEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
      claim: false,
      intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: "fresh-rename" },
    });
    await control.core
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal','user:user_newowner','{}',?5,?6)",
      )
      .bind(p.organizationId, newUlid(), p.projectId, next.operationId, stamp, p.billingEpochId)
      .run();
    const recovery = await store.identity.beginHandleDomainRecovery({
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId: next.operationId,
    });
    expect(recovery).toMatchObject({ ...strandedScope, recoveryId: next.operationId });
    if (recovery === null) throw new Error("missing recovery");
    const pending = await store.identity.readDomainPolicySync(recovery);
    expect(pending).toMatchObject([
      { configurationRevision: 2, revocationEpoch: 2, registryVersion: null },
    ]);
    await store.identity.ackDomainPolicySync({
      ...recovery,
      environmentId: p.prodEnvironmentId,
      configurationRevision: 2,
      revocationEpoch: 2,
      ownerEnabled: true,
      registryVersion: null,
      acknowledgement: "unprovisioned",
    });
    expect(await store.identity.completeHandleDomainRecovery(recovery)).toBe("completed");
    expect(await first(stranded, OPERATION_ROW, stranded.input.operationId)).toMatchObject({
      state: "failed",
    });
    expect(
      await control.core
        .prepare(
          "SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId)
        .first(),
    ).toBeNull();
    expect(
      await store.provisioning.claimProviderMutation({
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
        operationId: next.operationId,
        eventId: next.eventId,
        logicalWorkflowId: next.workflowId,
        claimId: next.claimId,
        eventType: "ProjectHandleChangeRequestedV1",
        acceptedLifecycleVersion: 1,
      }),
    ).toBe("created");
    const partial = await renameFixture(control, "partial-native-address", "partial-native-new"),
      part = partial.project;
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(part.organizationId, stamp),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_partialowner','admin','active',1,?2,?3,'evt-partial')",
        )
        .bind(part.organizationId, new Uint8Array(32).fill(1), stamp),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_partialowner','owner',?3)",
        )
        .bind(part.organizationId, newUlid(), stamp),
      control.core
        .prepare(
          "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal','user:user_partialowner','{}',?5,?6)",
        )
        .bind(
          part.organizationId,
          newUlid(),
          part.projectId,
          partial.input.operationId,
          stamp,
          part.billingEpochId,
        ),
      control.core
        .prepare(
          "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App','https://partial-native-address.check.omh.st',1,1)",
        )
        .bind(part.organizationId, part.projectId, part.prodEnvironmentId),
      control.core
        .prepare(
          "INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider','database','runtime-partial','role.create:runtime-partial',?6,'reserved')",
        )
        .bind(
          part.organizationId,
          part.projectId,
          part.prodEnvironmentId,
          newUlid(),
          newUlid(),
          `partial-${part.projectId}`,
        ),
    ]);
    await expect(store.provisioning.finalizeHandleChange(partial.input)).rejects.toThrow();
    expect(
      await first(partial, "SELECT handle FROM projects WHERE project_id=?", part.projectId),
    ).toEqual({ handle: "partial-native-address" });
    expect(
      await first(
        partial,
        "SELECT canonical_origin,configuration_revision,revocation_epoch FROM native_auth_realms WHERE project_id=?",
        part.projectId,
      ),
    ).toEqual({
      canonical_origin: "https://partial-native-address.check.omh.st",
      configuration_revision: 1,
      revocation_epoch: 1,
    });
    expect(
      await first(
        partial,
        "SELECT 1 FROM native_auth_domain_operations WHERE project_id=?",
        part.projectId,
      ),
    ).toBeNull();
    const preclaim = await seedProject(control, { handle: "preclaim-native" });
    const setupOperation = await seedOperation(preclaim);
    const requested = await seedAcceptedOperation(preclaim, preclaim.prodEnvironmentId, {
      eventType: "ProjectHandleChangeRequestedV1",
      claim: false,
      intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: "preclaim-new" },
    });
    await control.core.batch([
      control.core
        .prepare("UPDATE operations SET state='succeeded' WHERE operation_id=?1")
        .bind(setupOperation),
      control.core
        .prepare(
          "INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,mail_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,'preclaim-native','omh.st','preclaim-native.check.omh.st','dev-preclaim-native.check.omh.st',NULL,'user:fixture',?4,?4,?5)",
        )
        .bind(
          preclaim.organizationId,
          preclaim.projectId,
          setupOperation,
          new Uint8Array(32).fill(1),
          stamp,
        ),
      control.core
        .prepare(
          "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App','https://preclaim-native.check.omh.st',1,1)",
        )
        .bind(preclaim.organizationId, preclaim.projectId, preclaim.prodEnvironmentId),
      control.core
        .prepare(
          "INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider','database','runtime-preclaim','role.create:runtime-preclaim',?6,'reserved')",
        )
        .bind(
          preclaim.organizationId,
          preclaim.projectId,
          preclaim.prodEnvironmentId,
          newUlid(),
          newUlid(),
          `preclaim-${preclaim.projectId}`,
        ),
    ]);
    expect(
      await store.productApi.readApiRenameAdmission({
        organizationId: preclaim.organizationId,
        projectId: preclaim.projectId,
        handle: "preclaim-new",
      }),
    ).toMatchObject({ nativePreparationPending: true });
    await expect(
      store.provisioning.claimProviderMutation({
        organizationId: preclaim.organizationId,
        projectId: preclaim.projectId,
        environmentId: preclaim.prodEnvironmentId,
        operationId: requested.operationId,
        eventId: requested.eventId,
        logicalWorkflowId: requested.workflowId,
        claimId: requested.claimId,
        eventType: "ProjectHandleChangeRequestedV1",
        acceptedLifecycleVersion: 1,
      }),
    ).rejects.toThrow();
    expect(
      await control.core
        .prepare(
          "SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(preclaim.organizationId, preclaim.projectId)
        .first(),
    ).toBeNull();
  } finally {
    await control.dispose();
  }
}, 60_000);

it("compensates the moved route and answers taken when another project holds the requested handle, replaying the compensation", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    await seedProject(control, { handle: "renamed-taken" });
    const f = await renameFixture(control, "old-handle-two", "renamed-taken");

    const taken = { status: "conflict", reason: "taken" };
    expect(await store.provisioning.finalizeHandleChange(f.input)).toEqual(taken);
    expect(
      await first(f, "SELECT handle FROM projects WHERE project_id=?", f.project.projectId),
    ).toEqual({ handle: "old-handle-two" });
    // The rename route (revision 2) is compensated by revision 3 back onto the old origin and receipted there.
    expect(
      await first(
        f,
        "SELECT action,handle,public_origin,active FROM shared_gateway_route_revisions WHERE project_id=? AND environment_id=? AND revision=3",
        f.project.projectId,
        f.project.prodEnvironmentId,
      ),
    ).toEqual({
      action: "compensate",
      handle: "old-handle-two",
      public_origin: "https://old-handle-two.check.omh.st",
      active: 1,
    });
    expect((await addressReceipts(f)).results).toEqual([
      {
        shared_gateway_revision: 3,
        handle: "old-handle-two",
        public_origin: "https://old-handle-two.check.omh.st",
        head_version: 1,
      },
    ]);
    // Nothing is terminal: the Workflow run stays queued and no completion event exists.
    expect(
      await first(
        f,
        "SELECT state FROM product_workflow_runs WHERE workflow_id=?",
        f.input.workflowId,
      ),
    ).toEqual({ state: "queued" });
    expect(await first(f, OPERATION_ROW, f.input.operationId)).toEqual({
      state: "running",
      lease_expires_at: LEASE,
    });

    expect(await store.provisioning.finalizeHandleChange(f.input)).toEqual(taken);
    expect((await addressReceipts(f)).results).toHaveLength(1);
  } finally {
    await control.dispose();
  }
}, 60_000);

it("refuses a finalization whose intent or moved environments differ from the accepted rename", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const f = await renameFixture(control, "old-handle-three", "renamed-three");
    const refusal = { code: "deployment_persistence_conflict" };

    await expect(
      store.provisioning.finalizeHandleChange({ ...f.input, requestedHandle: "renamed-other" }),
    ).rejects.toMatchObject({ ...refusal, message: "Project handle intent changed" });
    await expect(
      store.provisioning.finalizeHandleChange({ ...f.input, moved: [] }),
    ).rejects.toMatchObject({ ...refusal, message: "Gateway address moves are incomplete" });
    // Handles outside the customer grammar never reach the store.
    await expect(
      store.provisioning.finalizeHandleChange({ ...f.input, requestedHandle: "api-service" }),
    ).rejects.toThrow();
    expect(
      await first(f, "SELECT handle FROM projects WHERE project_id=?", f.project.projectId),
    ).toEqual({ handle: "old-handle-three" });
    expect((await addressReceipts(f)).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 60_000);

it("holds the handle a rename releases for thirty days against other organizations only", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const f = await renameFixture(control, "old-handle-four", "renamed-four");
    expect(await store.provisioning.finalizeHandleChange(f.input)).toBe("applied");
    expect(
      await control.directory
        .prepare(
          "SELECT organization_id,project_id,quarantined_until FROM project_handle_releases WHERE handle=?",
        )
        .bind("old-handle-four")
        .first(),
    ).toEqual({
      organization_id: f.project.organizationId,
      project_id: f.project.projectId,
      quarantined_until: "2026-11-27T10:05:00.000000Z",
    });
    const other = await seedOrganization(store, 2, 0);
    await expect(
      store.projects.createInitialProject(projectInput(other, "old-handle-four")),
    ).rejects.toMatchObject({ code: "project_handle_taken" });
    const later = await seedOrganization(store, 2, 1);
    await expect(
      store.projects.createInitialProject({
        ...projectInput(later, "old-handle-four"),
        createdAt: "2026-11-27T10:05:00.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "created" });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("refuses a rename onto a handle another organization released within the last thirty days", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const released = await renameFixture(control, "old-handle-five", "renamed-five");
    expect(await store.provisioning.finalizeHandleChange(released.input)).toBe("applied");
    const f = await renameFixture(control, "other-handle-five", "old-handle-five");
    expect(await store.provisioning.finalizeHandleChange(f.input)).toEqual({
      status: "conflict",
      reason: "taken",
    });
    expect(
      await first(f, "SELECT handle FROM projects WHERE project_id=?", f.project.projectId),
    ).toEqual({ handle: "other-handle-five" });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("moves the project's Directory claims to the new handle, so the new names stay unique", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const f = await renameFixture(control, "old-handle-six", "renamed-six");
    await control.directory.batch([
      control.directory
        .prepare(
          "INSERT INTO domain_directory(class,domain,organization_id,project_id,updated_at) VALUES('app_prod','old-handle-six.check.omh.st',?1,?2,'2026-10-28T10:00:00.000000Z'),('app_dev','dev-old-handle-six.check.omh.st',?1,?2,'2026-10-28T10:00:00.000000Z')",
        )
        .bind(f.project.organizationId, f.project.projectId),
    ]);
    expect(await store.provisioning.finalizeHandleChange(f.input)).toBe("applied");
    expect(
      await control.directory
        .prepare("SELECT handle FROM project_directory WHERE project_id=?")
        .bind(f.project.projectId)
        .first(),
    ).toEqual({ handle: "renamed-six" });
    expect(
      (
        await control.directory
          .prepare("SELECT class,domain FROM domain_directory WHERE project_id=? ORDER BY class")
          .bind(f.project.projectId)
          .all()
      ).results,
    ).toEqual([
      { class: "app_dev", domain: "dev-renamed-six.check.omh.st" },
      { class: "app_prod", domain: "renamed-six.check.omh.st" },
    ]);
    const other = await seedOrganization(store, 2, 0);
    await expect(
      store.projects.createInitialProject(projectInput(other, "renamed-six")),
    ).rejects.toMatchObject({ code: "project_handle_taken" });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("renames a legacy project whose domain rows carry a stale handle, moving and quarantining that handle", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const f = await renameFixture(control, "old-handle-eight", "renamed-eight");
    const projectId = f.project.projectId;
    await control.directory.batch([
      control.directory
        .prepare(
          "INSERT INTO domain_directory(class,domain,organization_id,project_id,updated_at) VALUES('app_prod','stale-domain-eight.check.omh.st',?1,?2,'2026-10-28T10:00:00.000000Z'),('app_dev','dev-stale-domain-eight.check.omh.st',?1,?2,'2026-10-28T10:00:00.000000Z')",
        )
        .bind(f.project.organizationId, projectId),
    ]);
    expect(await store.provisioning.finalizeHandleChange(f.input)).toBe("applied");
    expect(
      (
        await control.directory
          .prepare("SELECT class,domain FROM domain_directory WHERE project_id=? ORDER BY class")
          .bind(projectId)
          .all()
      ).results,
    ).toEqual([
      { class: "app_dev", domain: "dev-renamed-eight.check.omh.st" },
      { class: "app_prod", domain: "renamed-eight.check.omh.st" },
    ]);
    expect(
      (
        await control.directory
          .prepare("SELECT handle FROM project_handle_releases WHERE project_id=? ORDER BY handle")
          .bind(projectId)
          .all()
      ).results,
    ).toEqual([{ handle: "old-handle-eight" }, { handle: "stale-domain-eight" }]);
  } finally {
    await control.dispose();
  }
}, 60_000);

it("renames a legacy project whose Directory handle is stale and quarantines both old handles", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const f = await renameFixture(control, "old-handle-seven", "renamed-seven");
    const projectId = f.project.projectId;
    await control.directory
      .prepare("UPDATE project_directory SET handle='stale-handle-seven' WHERE project_id=?")
      .bind(projectId)
      .run();
    expect(await store.provisioning.finalizeHandleChange(f.input)).toBe("applied");
    expect(
      await control.directory
        .prepare("SELECT handle FROM project_directory WHERE project_id=?")
        .bind(projectId)
        .first(),
    ).toEqual({ handle: "renamed-seven" });
    expect(
      (
        await control.directory
          .prepare(
            "SELECT handle,project_id FROM project_handle_releases WHERE project_id=? ORDER BY handle",
          )
          .bind(projectId)
          .all()
      ).results,
    ).toEqual([
      { handle: "old-handle-seven", project_id: projectId },
      { handle: "stale-handle-seven", project_id: projectId },
    ]);
  } finally {
    await control.dispose();
  }
}, 60_000);
