import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { seedAcceptedOperation } from "../../control-store/test/support/accepted-operation.js";
import { createPaidDomainPolicySynchronizer } from "../../cloudflare-domain-management/src/d1-runtime.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { sourceFrameworkPlan } from "../../control-store/test/support/provider-fixtures.js";
import { fundOrganization } from "../../control-store/test/support/mail-events-fixture.js";
import type { TestControl } from "../../control-store/test/support/control-d1.js";
import { pgcfFixture } from "../../neon-management/test/pgcf-runtime-fixture.js";
import { managementWorkerFixture } from "../../neon-management/test/support/d1-management-worker.js";
import { coreWorkflowBindings, runCoreWorkflow } from "./support/chain-workflows.js";
import { createDeploymentWorkflowPorts } from "../src/product-workflow-composition.js";
import { createRecordedDataPorts } from "./support/recorded-persistence.js";
import {
  acknowledge,
  chainHandlers,
  deployRun,
  gatewayActivation,
  seedProjectDomain,
} from "./support/deployment-chain-runs.js";

it("provisions Native storage and completes a deployment only after the current private policy ACK", async () => {
  const provider = await pgcfFixture(false),
    worker = await managementWorkerFixture(provider, { nativeIntegrated: true });
  const c: TestControl = {
    core: worker.core,
    directory: worker.core,
    bindings: {
      CONTROL_CORE: worker.core,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: '{"mode":"password-general-availability"}',
    },
    shards: { CONTROL_SHARD_0000: worker.core, CONTROL_SHARD_0001: worker.core },
    dispose: async () => undefined,
  };
  try {
    const auth = {
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    };
    const r = await workflowFixture(c, {
      production: true,
      frameworkPlan: { ...sourceFrameworkPlan(false), auth },
    });
    await seedProjectDomain(c, r);
    await fundOrganization(c, r.p.organizationId);
    const domain = newUlid(),
      stamp = new Date().toISOString().slice(0, 23) + "000Z";
    await c.core
      .prepare(
        `INSERT INTO resend_mail_domains(organization_id,project_id,environment_id,domain_id,domain,provider_domain_id,sending_key_id,sending_key_ciphertext,sending_key_nonce,sending_key_sha256,sending_key_version,sending,receiving,receiving_suspended,sending_status,receiving_status,webhook_url,webhook_verified_at,configured_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,1,1,0,'ready','ready','https://receiver.example.test',?11,?11)`,
      )
      .bind(
        r.p.organizationId,
        r.p.projectId,
        r.p.productionEnvironmentId,
        domain,
        `mail-${domain.toLowerCase()}.example.com`,
        `provider_${domain}`,
        `key_${domain}`,
        new Uint8Array(24).fill(7),
        new Uint8Array(12).fill(8),
        new Uint8Array(32).fill(9),
        stamp,
      )
      .run();
    const baseRun = deployRun(r),
      run = { ...baseRun, chain: { ...baseRun.chain, environmentName: "prod" as const } },
      store = createControlStore(c.bindings);
    await acknowledge(c, r.input.eventId);
    const handlers = chainHandlers(run.chain, gatewayActivation(store, run.chain));
    const existing = handlers.BUILD_RUNNER.readBuildArtifact;
    const call = async (action: string, input: unknown) => {
      const result = await worker.call(action, input);
      if (!result.ok) throw new Error(result.message ?? "private RPC failed");
      return result.result;
    };
    const workflowHandlers: Parameters<typeof runCoreWorkflow>[2] = {
      ...handlers,
      BUILD_RUNNER: {
        ...handlers.BUILD_RUNNER,
        readBuildArtifact: () => {
          const artifact = existing();
          return { ...artifact, provenance: { ...artifact.provenance, auth } };
        },
      },
      NEON_MANAGEMENT: {
        deleteNativeAuthProject: (input) => call("deleteNativeAuthProject", input),
        placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
        prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
      },
      NATIVE_AUTH_RESOURCE_RUNTIME: {
        beginHandleDomainRecovery: async (input) => {
          const result = await worker.callNativeCore("beginHandleDomainRecovery", input);
          if (!result.ok) throw new Error(result.message ?? "private RPC failed");
          return result.result;
        },
        completeHandleDomainRecovery: async (input) => {
          const result = await worker.callNativeCore("completeHandleDomainRecovery", input);
          if (!result.ok) throw new Error(result.message ?? "private RPC failed");
          return result.result;
        },
        readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
        readDomainPolicySync: (input) => call("nativeDomainRead", input),
        ackDomainPolicySync: (input) => call("nativeDomainAck", input),
        readPendingNativePolicySync: (input) => call("nativePending", input),
        completeNativePolicySync: (input) => call("nativeComplete", input),
      },
      NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input) => call("nativePolicyUs", input) },
      NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input) => call("nativePolicyEu", input) },
    };
    const outcome = await runCoreWorkflow(c, run, workflowHandlers);
    expect(outcome.failures).toEqual([]);
    expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
    expect(
      await c.core
        .prepare("SELECT state FROM native_auth_policy_syncs WHERE operation_id=?1")
        .bind(r.input.operationId)
        .first(),
    ).toEqual({ state: "completed" });
    expect(
      await c.core
        .prepare("SELECT state FROM operations WHERE operation_id=?1")
        .bind(r.input.operationId)
        .first(),
    ).toEqual({ state: "succeeded" });
    const beforeReplay = (
      await c.core
        .prepare(
          "SELECT event_type,actor_type,actor_id,payload FROM audit_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY audit_event_id",
        )
        .bind(r.p.organizationId, r.input.operationId)
        .all()
    ).results;
    const replay = coreWorkflowBindings(c, workflowHandlers);
    const replayPorts = createDeploymentWorkflowPorts(
      replay.bindings,
      createRecordedDataPorts(() => new Date()),
      () => new Date(),
    );
    if (run.command.eventType !== "DeploymentRequestedV1") throw new Error("Unexpected command");
    await expect(
      replayPorts.persistence.finalizeCandidate({
        workflowId: run.workflowId,
        executionId: run.workflowId,
        command: run.command,
        evidence: {},
      }),
    ).resolves.toBe("applied");
    expect(replay.calls.map(([name]) => name)).toEqual([
      "NATIVE_AUTH_RESOURCE_RUNTIME.readPendingNativePolicySync",
    ]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT event_type,actor_type,actor_id,payload FROM audit_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY audit_event_id",
          )
          .bind(r.p.organizationId, r.input.operationId)
          .all()
      ).results,
    ).toEqual(beforeReplay);

    // Exercise domain withdrawal with the real Core, regional workerd policy RPC and its
    // PostgreSQL directory. Only the Cloudflare resource itself is a transport fixture.
    const scope = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
    };
    const principalId = "user:user_domainowner";
    await c.core.batch([
      c.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(scope.organizationId, stamp),
      c.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_domainowner','admin','active',1,?2,?3,'evt-domain')",
        )
        .bind(scope.organizationId, new Uint8Array(32).fill(1), stamp),
      c.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
        )
        .bind(scope.organizationId, newUlid(), principalId, stamp),
      c.core
        .prepare(
          `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.native-domain.example','ohmyho-gateway-production','active',?3,?4,?4,'{}','{}',?5,?5,?5)`,
        )
        .bind(
          scope.organizationId,
          scope.projectId,
          principalId,
          new Uint8Array(32).fill(2),
          stamp,
        ),
      c.core
        .prepare(
          "UPDATE native_auth_realms SET canonical_origin='https://app.native-domain.example',configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(scope.organizationId, scope.projectId, scope.environmentId),
    ]);
    const applyCurrent = async () => {
      const authority = await store.identity.resolveNativeAuthAdminAuthority(scope);
      return call("nativePolicyEu", {
        ...scope,
        configurationRevision: authority.realm.configurationRevision,
        revocationEpoch: authority.revocationEpoch,
        enabled: authority.ownerEnabled,
        canonicalOrigin: authority.realm.canonicalOrigin,
      });
    };
    await applyCurrent();
    const key = `sha256:${"03".repeat(32)}`;
    await store.cloudflareDomain.claimPaidDomainDelete({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      hostname: "app.native-domain.example",
      principalId,
      idempotencyKeySha256: key,
      requestSha256: `sha256:${"04".repeat(32)}`,
      now: new Date().toISOString(),
    });
    const paidScope = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      kind: "paid_delete" as const,
      identity: key.slice(7),
    };
    const [paidPending] = await store.identity.readDomainPolicySync(paidScope);
    if (!paidPending) throw new Error("missing Native domain withdrawal policy");
    expect(paidPending).toMatchObject({
      environmentId: scope.environmentId,
      canonicalOrigin: null,
      registryVersion: 1,
    });
    await expect(
      store.cloudflareDomain.markPaidDomainDeleted({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        hostname: "app.native-domain.example",
        idempotencyKeySha256: key,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    const badPolicy = await worker.call("nativePolicyEu", {
      ...scope,
      configurationRevision: paidPending.configurationRevision - 1,
      revocationEpoch: paidPending.revocationEpoch,
      enabled: paidPending.ownerEnabled,
      canonicalOrigin: null,
    });
    expect(badPolicy.ok).toBe(false);
    const policyService = { applyRealmPolicy: (input: unknown) => call("nativePolicyEu", input) };
    const synchronize = createPaidDomainPolicySynchronizer(
      {
        readDomainPolicySync: (input) => store.identity.readDomainPolicySync(input),
        ackDomainPolicySync: (input) => store.identity.ackDomainPolicySync(input),
      },
      { NATIVE_AUTH_ADMIN_US: policyService, NATIVE_AUTH_ADMIN_EU: policyService },
    );
    const registry = await c.core
      .prepare(
        "SELECT role_name,schema_name FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND state='active'",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId)
      .first<{ role_name: string; schema_name: string }>();
    if (!registry) throw new Error("missing Native registration");
    const lockPool = await provider.native(registry.role_name);
    const locking = await lockPool.connect();
    await locking.query("SELECT set_config('search_path',$1,false)", [registry.schema_name]);
    await locking.query("BEGIN");
    await locking.query("SELECT 1 FROM native_realm_policy WHERE singleton=true FOR UPDATE");
    let synchronized = false;
    const pendingAcknowledgement = synchronize({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      idempotencyKeySha256: key,
    }).then(() => {
      synchronized = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(synchronized).toBe(false);
    await expect(
      store.cloudflareDomain.markPaidDomainDeleted({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        hostname: "app.native-domain.example",
        idempotencyKeySha256: key,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow();
    await locking.query("COMMIT");
    locking.release();
    await lockPool.end();
    await pendingAcknowledgement;
    await store.cloudflareDomain.markPaidDomainDeleted({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      hostname: "app.native-domain.example",
      idempotencyKeySha256: key,
      now: new Date().toISOString(),
    });
    expect(
      (
        await store.cloudflareDomain.readPaidDomainRecord({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
        })
      )?.state,
    ).toBe("deleted");

    const primary = `https://${r.p.projectHandle}.omh.st`;
    await c.core
      .prepare(
        "UPDATE native_auth_realms SET canonical_origin=?4,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId, primary)
      .run();
    await applyCurrent();
    const accepted = await seedAcceptedOperation(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        billingEpochId: r.p.billingEpochId,
        shard: c.core,
      },
      scope.environmentId,
      {
        eventType: "ProjectHandleChangeRequestedV1",
        intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: "renamed-native-chain" },
      },
    );
    await c.core
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal',?5,'{}',?6,?7)",
      )
      .bind(
        scope.organizationId,
        newUlid(),
        scope.projectId,
        accepted.operationId,
        principalId,
        stamp,
        r.p.billingEpochId,
      )
      .run();
    const currentRoute = await c.core
      .prepare(
        "SELECT revision,candidate_receipt_id FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND active=1 ORDER BY revision DESC LIMIT 1",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId)
      .first<{ revision: number; candidate_receipt_id: string }>();
    if (!currentRoute) throw new Error("missing current gateway route");
    const moved = await store.gateway.management.activate({
      ...scope,
      operationId: accepted.operationId,
      claimId: accepted.claimId,
      expectedRevision: currentRoute.revision,
      candidateReceiptId: currentRoute.candidate_receipt_id,
      egressAllowedOrigins: [],
    });
    await c.core
      .prepare("UPDATE outbox_events SET acknowledged_at=?2 WHERE event_id=?1")
      .bind(accepted.eventId, stamp)
      .run();
    const completion = {
      ...scope,
      operationId: accepted.operationId,
      requestedHandle: "renamed-native-chain",
      moved: [{ environmentId: scope.environmentId, publicOrigin: moved.publicOrigin }],
      workflowId: accepted.workflowId,
      outboxEventId: accepted.eventId,
      startedOperationEventId: newUlid(),
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      completedAt: new Date().toISOString(),
    };
    expect(await store.provisioning.finalizeHandleChange(completion)).toBe("pending");
    const handleScope = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      kind: "handle_change" as const,
      identity: accepted.operationId,
    };
    const [handlePending] = await store.identity.readDomainPolicySync(handleScope);
    if (!handlePending) throw new Error("missing Native handle transition policy");
    expect(handlePending).toMatchObject({ canonicalOrigin: null, registryVersion: 1 });
    expect(await store.provisioning.finalizeHandleChange(completion)).toBe("pending");
    const freshPrincipal = "user:user_freshdomainowner";
    await c.core.batch([
      c.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_freshdomainowner','admin','active',1,?2,?3,'evt-fresh-domain')",
        )
        .bind(scope.organizationId, new Uint8Array(32).fill(3), stamp),
      c.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
        )
        .bind(scope.organizationId, newUlid(), freshPrincipal, stamp),
      c.core
        .prepare(
          "INSERT INTO revocations(kind,resource_id,source_event_id,effective_at) VALUES('user','user_domainowner',?1,?2)",
        )
        .bind(newUlid(), stamp),
    ]);
    await expect(store.identity.readDomainPolicySync(handleScope)).rejects.toThrow();
    const replacement = await seedAcceptedOperation(
      {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        billingEpochId: r.p.billingEpochId,
        shard: c.core,
      },
      scope.environmentId,
      {
        eventType: "ProjectHandleChangeRequestedV1",
        claim: false,
        intent: { expected_etag: `"${"a".repeat(64)}"`, requested_handle: "fresh-native-chain" },
      },
    );
    await c.core
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProjectHandleChangeRequestedV1','principal',?5,'{}',?6,?7)",
      )
      .bind(
        scope.organizationId,
        newUlid(),
        scope.projectId,
        replacement.operationId,
        freshPrincipal,
        stamp,
        r.p.billingEpochId,
      )
      .run();
    const recovery = await store.identity.beginHandleDomainRecovery({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      operationId: replacement.operationId,
    });
    if (recovery === null) throw new Error("missing current Owner recovery");
    await applyCurrent();
    await store.identity.ackDomainPolicySync({
      ...recovery,
      environmentId: scope.environmentId,
      configurationRevision: handlePending.configurationRevision,
      revocationEpoch: handlePending.revocationEpoch,
      ownerEnabled: handlePending.ownerEnabled,
      registryVersion: handlePending.registryVersion,
      acknowledgement: "applied",
    });
    expect(await store.identity.completeHandleDomainRecovery(recovery)).toBe("completed");
    expect(
      await c.core
        .prepare("SELECT state FROM operations WHERE organization_id=?1 AND operation_id=?2")
        .bind(scope.organizationId, accepted.operationId)
        .first(),
    ).toEqual({ state: "failed" });
    expect(
      await store.provisioning.claimProviderMutation({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        operationId: replacement.operationId,
        eventId: replacement.eventId,
        logicalWorkflowId: replacement.workflowId,
        claimId: replacement.claimId,
        eventType: "ProjectHandleChangeRequestedV1",
        acceptedLifecycleVersion: 1,
      }),
    ).toBe("created");
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 180_000);
