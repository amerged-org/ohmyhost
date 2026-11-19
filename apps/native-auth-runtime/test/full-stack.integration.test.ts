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
import { createEnvironmentSecretCipher } from "@ohmyhost/platform";
import { quoteBuildCost } from "@ohmyhost/platform";
import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
} from "../../orchestrator/src/index.js";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { resourceHash } from "../../control-store/src/catalog/provisioning/context-values.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import {
  sourceFrameworkPlan,
  seedDeploymentPlan,
} from "../../control-store/test/support/provider-fixtures.js";
import {
  promotionIntent,
  rollbackIntent,
  seedAcceptedOperation,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import { STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
import {
  fundOrganization,
  publishMailPricing,
} from "../../control-store/test/support/mail-events-fixture.js";
import type { TestControl } from "../../control-store/test/support/control-d1.js";
import { pgcfFixture } from "../../neon-management/test/pgcf-runtime-fixture.js";
import { managementWorkerFixture } from "../../neon-management/test/support/d1-management-worker.js";
import {
  coreWorkflowBindings,
  runCoreWorkflow,
} from "../../project-provisioning-worker/test/support/chain-workflows.js";
import { deterministicUlid } from "../../project-provisioning-worker/src/deterministic-ulid.js";
import { runCoreDeploymentWorkflow } from "../../project-provisioning-worker/src/core-deployment-workflow.js";
import {
  acknowledge,
  chainHandlers,
  deployRun,
  gatewayActivation,
  seedProjectDomain,
  type ChainRun,
} from "../../project-provisioning-worker/test/support/deployment-chain-runs.js";
import {
  buildArtifact,
  stagedCandidate,
  wfpReceipt,
} from "../../project-provisioning-worker/test/support/deployment-chain-providers.js";

it("bootstraps the first Native realm and serves signup through real Core, Neon, registry, policy, runtime and mail", async () => {
  const provider = await pgcfFixture(false);
  const worker = await managementWorkerFixture(provider, { nativeIntegrated: true });
  const control: TestControl = {
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
    const fixture = await workflowFixture(control, {
      frameworkPlan: { ...sourceFrameworkPlan(false), auth },
    });
    await seedProjectDomain(control, fixture);
    await publishMailPricing(control);
    await fundOrganization(control, fixture.p.organizationId);
    // Core commands establish the shared sender and its customer-domain proof. The provider's
    // verified status/key and DNS TXT answer are external seams, not a legacy sender shortcut.
    const senderScope = {
      organizationId: fixture.p.organizationId,
      projectId: fixture.p.projectId,
      environmentId: fixture.p.productionEnvironmentId,
    };
    const store = createControlStore(control.bindings);
    const stamp = new Date().toISOString().slice(0, 23) + "000Z";
    const now = new Date().toISOString();
    const domainId = newUlid(),
      domain = `mail-${domainId.toLowerCase()}.example.com`;
    const request = (idempotencyKey: string) => ({
      organizationId: senderScope.organizationId,
      principalId: "user:user_seed",
      idempotencyKey,
      requestSha256: "a".repeat(64),
      now,
    });
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(senderScope.organizationId, stamp),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_seed','admin','active',1,?2,?3,'evt')",
        )
        .bind(senderScope.organizationId, new Uint8Array(32).fill(1), stamp),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_seed','owner',?3)",
        )
        .bind(senderScope.organizationId, newUlid(), stamp),
      control.core
        .prepare(
          "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?1) ON CONFLICT(capability) DO UPDATE SET enabled=1",
        )
        .bind(stamp),
    ]);
    const run = deployRun(fixture);
    await acknowledge(control, fixture.input.eventId);
    const claimId = await deterministicUlid(`${run.workflowId}:provider-mutation-claim`);
    await store.provisioning.claimProviderMutation({ ...fixture.input, claimId });
    const claim = {
      organizationId: senderScope.organizationId,
      projectId: senderScope.projectId,
      environmentId: fixture.input.environmentId,
      operationId: fixture.input.operationId,
      claimId,
    };
    const refusedPlacement = async () => {
      expect(await worker.call("placeNativeAuthDatabase", claim)).toMatchObject({
        ok: false,
        message: "native_auth_resource_conflict",
      });
      expect(provider.stats.creates).toBe(0);
    };
    await refusedPlacement();
    await store.sharedMail.createDomain({ ...request("create"), domainId, domain });
    const sealed = await createEnvironmentSecretCipher({
      keyBase64: Buffer.alloc(32, 0x63).toString("base64"),
      keyVersion: 1,
      crypto: globalThis.crypto,
    }).encrypt({
      organizationId: senderScope.organizationId,
      projectId: domainId,
      environmentId: domainId,
      name: "RESEND_DOMAIN_SEND_KEY",
      value: "re_fixture_native_send",
    });
    await control.core
      .prepare(
        "UPDATE workspace_mail_domains SET sending_status='ready',provider_domain_id=?2,sending_key_id=?3,sending_key_ciphertext=?4,sending_key_nonce=?5,sending_key_sha256=?6,sending_key_version=1 WHERE domain_id=?1",
      )
      .bind(
        domainId,
        `provider_${domainId}`,
        `key_${domainId}`,
        sealed.ciphertext,
        sealed.nonce,
        sealed.valueSha256,
      )
      .run();
    const bind = {
      ...request("bind"),
      ...senderScope,
      domainId,
      sending: true,
      senderAddresses: [`hello@${domain}`],
      defaultFrom: `hello@${domain}`,
      defaultReplyTo: null,
      expectedRevision: 0,
    };
    await expect(store.sharedMail.bindProject(bind)).rejects.toThrow("mail_domain_mismatch");
    await refusedPlacement();
    const identityBase = {
      organizationId: senderScope.organizationId,
      projectId: senderScope.projectId,
      actorId: "user:user_seed",
      delegation: null,
      requestSha256: "b".repeat(64),
    };
    const challenge = `omh-domain-v1=${"A".repeat(43)}`;
    const declare = async (hostname: string, registrableDomain: string, key: string) =>
      store.cfApplicationIdentity.declare({
        ...identityBase,
        idempotencyKeySha256: key.repeat(64),
        hostname,
        registrableDomain,
        challengeValue: challenge,
        declaredAt: now,
        expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      });
    const verify = async (revision: number, key: string) =>
      store.cfApplicationIdentity.completeAction({
        ...identityBase,
        idempotencyKeySha256: key.repeat(64),
        action: "verify",
        revision,
        now,
        viewAt: now,
        challengeValue: challenge,
        expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
      });
    await declare("app.other.com", "other.com", "1");
    await expect(store.sharedMail.bindProject(bind)).rejects.toThrow("mail_domain_mismatch");
    await verify(1, "2");
    await expect(store.sharedMail.bindProject(bind)).rejects.toThrow("mail_domain_mismatch");
    await refusedPlacement();
    await declare("app.example.com", "example.com", "3");
    await expect(store.sharedMail.bindProject(bind)).rejects.toThrow("mail_domain_mismatch");
    await refusedPlacement();
    expect(await verify(2, "4")).toMatchObject({ status: "verified" });
    expect(await store.sharedMail.bindProject(bind)).toMatchObject({
      status: "active",
      sending: true,
    });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM resend_mail_domains WHERE project_id=?1")
        .bind(senderScope.projectId)
        .first(),
    ).toEqual({ n: 0 });
    await expect(
      store.identity.initializeNativeAuthRealm({
        organizationId: fixture.p.organizationId,
        projectId: fixture.p.projectId,
        environmentId: fixture.input.environmentId,
        operationId: fixture.input.operationId,
        claimId: newUlid(),
      }),
    ).rejects.toThrow();
    for (const table of ["mail_gateway_keys", "mail_reputation_states"]) {
      expect(
        await control.core
          .prepare(`select count(*) as n from ${table} where organization_id=?1 and project_id=?2`)
          .bind(senderScope.organizationId, senderScope.projectId)
          .first(),
      ).toEqual({ n: 0 });
    }
    const headBefore = await control.core
      .prepare(
        "select active_deployment_id from environments where organization_id=?1 and environment_id=?2",
      )
      .bind(fixture.p.organizationId, fixture.input.environmentId)
      .first<{ active_deployment_id: string | null }>();
    expect(headBefore?.active_deployment_id).toBeNull();
    expect(
      await control.core
        .prepare("select count(*) as n from native_auth_realms where project_id=?1")
        .bind(fixture.p.projectId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare("select count(*) as n from native_auth_database_targets where project_id=?1")
        .bind(fixture.p.projectId)
        .first(),
    ).toEqual({ n: 0 });
    const handlers = chainHandlers(run.chain, gatewayActivation(store, run.chain));
    const existing = handlers.BUILD_RUNNER.readBuildArtifact;
    const call = async (action: string, input: unknown) => {
      const result = await worker.call(action, input);
      if (!result.ok) throw new Error(result.message ?? "private_rpc_failed");
      return result.result;
    };
    const callNativeCore = async (method: string, input: unknown) => {
      const result = await worker.callNativeCore(method, input);
      if (!result.ok) throw new Error(result.message ?? "private_rpc_failed");
      return result.result;
    };
    const outcome = await runCoreWorkflow(control, run, {
      ...handlers,
      BUILD_RUNNER: {
        ...handlers.BUILD_RUNNER,
        readBuildArtifact: () => ({
          ...existing(),
          provenance: { ...existing().provenance, auth },
        }),
      },
      NEON_MANAGEMENT: {
        placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
        prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
      },
      NATIVE_AUTH_RESOURCE_RUNTIME: {
        readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
        readDomainPolicySync: (input) => call("nativeDomainRead", input),
        ackDomainPolicySync: (input) => call("nativeDomainAck", input),
        beginHandleDomainRecovery: (input) => callNativeCore("beginHandleDomainRecovery", input),
        completeHandleDomainRecovery: (input) =>
          callNativeCore("completeHandleDomainRecovery", input),
        readPendingNativePolicySync: (input) => call("nativePending", input),
        completeNativePolicySync: (input) => call("nativeComplete", input),
      },
      NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input) => call("nativePolicyUs", input) },
      NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input) => call("nativePolicyEu", input) },
    });
    expect(outcome.failures).toEqual([]);
    expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
    expect(
      await control.core
        .prepare(
          "select state, version from mail_reputation_states where organization_id=?1 and project_id=?2",
        )
        .bind(senderScope.organizationId, senderScope.projectId)
        .first(),
    ).toEqual({ state: "active", version: 1 });
    expect(
      await control.core
        .prepare(
          "select count(*) as n from mail_gateway_keys where organization_id=?1 and project_id=?2",
        )
        .bind(senderScope.organizationId, senderScope.projectId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare("select state from native_auth_policy_syncs where operation_id=?1")
        .bind(fixture.input.operationId)
        .first(),
    ).toEqual({ state: "completed" });
    const ids = { projectId: fixture.p.projectId, environmentId: fixture.input.environmentId };
    const authority = await store.identity.resolveNativeAuthAuthority({
      ...ids,
      deploymentId: fixture.deployment,
    });
    expect(authority).toMatchObject({
      enabled: true,
      sourceCapable: true,
      paidAllowed: true,
      runtimeAllowed: true,
      deploymentId: fixture.deployment,
    });
    const origin = authority.realm.canonicalOrigin,
      runtimeScope = { ...authority.realm, deploymentId: fixture.deployment };
    expect(
      await store.identity.authorizeNativeMail({
        organizationId: fixture.p.organizationId,
        ...ids,
      }),
    ).not.toBeNull();
    const email = `joined-${crypto.randomUUID()}@example.test`;
    let password = "joined-private-password-123";
    const fetchNative = (
      path: string,
      method: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      worker.call("nativeFetch", {
        url: `${origin}${path}`,
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { origin, "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        scope: runtimeScope,
        region: authority.region,
      });
    const signup = await fetchNative(
      "/api/auth/v1/sign-up/email",
      "POST",
      { name: "Joined", email, password },
      { "idempotency-key": "joined-signup" },
    );
    expect(signup).toMatchObject({ ok: true, result: { status: 200, cookies: [] } });
    const sent = await worker.call("nativeMails");
    expect(sent.ok).toBe(true);
    const mails = sent.result as Array<{ text: string }>;
    expect(mails).toHaveLength(1);
    const verificationUrl = mails[0]?.text.match(/https:\/\/[^\s]+/u)?.[0];
    if (!verificationUrl) throw new Error("verification mail missing");
    expect(
      await worker.call("nativeFetch", {
        url: verificationUrl,
        method: "GET",
        headers: {},
        scope: runtimeScope,
        region: authority.region,
      }),
    ).toMatchObject({ ok: true, result: { status: 302, cookies: [] } });
    const login = await fetchNative("/api/auth/v1/sign-in/email", "POST", { email, password });
    expect(login).toMatchObject({ ok: true, result: { status: 200 } });
    const cookies = (login.result as { cookies: string[] }).cookies;
    expect(cookies.join(";")).toContain("omh_native");
    const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
    const sessionScope = { ...ids, deploymentId: fixture.deployment };
    const initialSession = await worker.call("nativeSession", {
      scope: sessionScope,
      cookie,
      region: authority.region,
    });
    expect(initialSession).toMatchObject({ ok: true, result: { user: { email } } });
    const initialUserId = (initialSession.result as { user: { id: string } }).user.id;
    expect(
      await fetchNative(
        "/api/auth/v1/request-password-reset",
        "POST",
        { email, redirectTo: "/reset-password" },
        { "idempotency-key": "joined-reset" },
      ),
    ).toMatchObject({ ok: true, result: { status: 200 } });
    const resetMessages = (await worker.call("nativeMails")).result as Array<{ text: string }>;
    expect(resetMessages).toHaveLength(2);
    const resetUrl = resetMessages[1]?.text.match(/https:\/\/[^\s]+/u)?.[0];
    const resetToken = resetUrl ? new URL(resetUrl).searchParams.get("token") : null;
    if (!resetToken) throw new Error("reset mail missing");
    password = "joined-new-private-password-456";
    expect(
      await fetchNative("/api/auth/v1/reset-password", "POST", {
        token: resetToken,
        newPassword: password,
      }),
    ).toMatchObject({ ok: true, result: { status: 200 } });
    expect(
      await worker.call("nativeSession", { scope: sessionScope, cookie, region: authority.region }),
    ).toEqual({ ok: true, result: null });
    const resetLogin = await fetchNative("/api/auth/v1/sign-in/email", "POST", { email, password });
    expect(resetLogin).toMatchObject({ ok: true, result: { status: 200 } });
    const resetCookie = (resetLogin.result as { cookies: string[] }).cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(
      await worker.call("nativeSession", {
        scope: sessionScope,
        cookie: resetCookie,
        region: authority.region,
      }),
    ).toMatchObject({ ok: true, result: { user: { id: initialUserId, email } } });
    expect(
      await fetchNative("/api/auth/v1/sign-out", "POST", {}, { cookie: resetCookie }),
    ).toMatchObject({
      ok: true,
      result: { status: 200 },
    });
    expect(
      await worker.call("nativeSession", {
        scope: sessionScope,
        cookie: resetCookie,
        region: authority.region,
      }),
    ).toEqual({ ok: true, result: null });

    const project = {
      organizationId: fixture.p.organizationId,
      projectId: fixture.p.projectId,
      billingEpochId: fixture.p.billingEpochId,
      shard: control.core,
    };
    const nextDeployment = async (native: boolean, failPolicyOnce = false) => {
      const operationId = await seedOperation(project),
        eventId = newUlid(),
        deploymentId = newUlid(),
        planId = newUlid();
      const plan = native ? { ...sourceFrameworkPlan(false), auth } : sourceFrameworkPlan(false);
      const { sourceConnectionId } = await seedDeploymentPlan(
        project,
        planId,
        plan,
        ids.environmentId,
        { costEstimate: quoteBuildCost("2026-10-28T11:00:00.000Z") },
      );
      await control.core
        .prepare(
          "insert into deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) values(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
        )
        .bind(
          project.organizationId,
          deploymentId,
          project.projectId,
          ids.environmentId,
          operationId,
          STORED_NOW,
        )
        .run();
      const command = parseProductCommandMessageV1({
        version: 1,
        eventType: "DeploymentRequestedV1",
        eventId,
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: ids.environmentId,
        operationId,
        billingEpochId: project.billingEpochId,
        planId,
      });
      const workflowId = deterministicProductCommandWorkflowId(command);
      await seedAcceptedOperation(project, ids.environmentId, {
        operationId,
        eventId,
        workflowId,
        claim: false,
        intent: {
          plan_id: planId,
          source_connection_id: sourceConnectionId,
          deployment_id: deploymentId,
          source_generation: 1,
        },
      });
      await acknowledge(control, eventId);
      const next: ChainRun = {
        command,
        workflowId,
        chain: {
          organizationId: project.organizationId,
          billingEpochId: project.billingEpochId,
          projectId: project.projectId,
          environmentId: ids.environmentId,
          environmentName: "dev",
          operationId,
          deploymentId,
          buildId: "build-1",
        },
      };
      const currentGateway = await control.core
        .prepare(
          "select revision from shared_gateway_route_revisions where organization_id=?1 and project_id=?2 and environment_id=?3 order by revision desc limit 1",
        )
        .bind(project.organizationId, project.projectId, ids.environmentId)
        .first<{ revision: number }>();
      if (!currentGateway) throw new Error("gateway head missing");
      const activate = gatewayActivation(store, next.chain);
      const nextHandlers = chainHandlers(next.chain, (input) =>
        activate({ ...(input as object), previousGateway: { revision: currentGateway.revision } }),
      );
      const readArtifact = nextHandlers.BUILD_RUNNER.readBuildArtifact;
      let rejectPolicy = failPolicyOnce;
      const applyPolicy = (region: "us" | "eu", input: unknown) => {
        if (rejectPolicy) {
          rejectPolicy = false;
          throw new Error("fixture_policy_unavailable");
        }
        return call(region === "eu" ? "nativePolicyEu" : "nativePolicyUs", input);
      };
      const workflowHandlers = {
        ...nextHandlers,
        BUILD_RUNNER: {
          ...nextHandlers.BUILD_RUNNER,
          readBuildArtifact: () => ({
            ...readArtifact(),
            provenance: { ...readArtifact().provenance, ...(native ? { auth } : {}) },
          }),
        },
        NEON_MANAGEMENT: {
          placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
          prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
        },
        NATIVE_AUTH_RESOURCE_RUNTIME: {
          readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
          readDomainPolicySync: (input) => call("nativeDomainRead", input),
          ackDomainPolicySync: (input) => call("nativeDomainAck", input),
          beginHandleDomainRecovery: (input) => callNativeCore("beginHandleDomainRecovery", input),
          completeHandleDomainRecovery: (input) =>
            callNativeCore("completeHandleDomainRecovery", input),
          readPendingNativePolicySync: (input) => call("nativePending", input),
          completeNativePolicySync: (input) => call("nativeComplete", input),
        },
        NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input: unknown) => applyPolicy("us", input) },
        NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input: unknown) => applyPolicy("eu", input) },
      } satisfies Parameters<typeof runCoreWorkflow>[2];
      if (failPolicyOnce) {
        const { bindings } = coreWorkflowBindings(control, workflowHandlers);
        const journal = new Map<string, unknown>();
        let retries = 0;
        const step = {
          async do<T>(name: string, _config: unknown, execute: () => Promise<T>): Promise<T> {
            if (journal.has(name)) return structuredClone(journal.get(name)) as T;
            let value: T;
            try {
              value = await execute();
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "fixture_policy_unavailable")
                throw error;
              retries++;
              const pending = await control.core
                .prepare("select state from native_auth_policy_syncs where operation_id=?1")
                .bind(operationId)
                .first<{ state: string }>();
              const operation = await control.core
                .prepare("select state from operations where operation_id=?1")
                .bind(operationId)
                .first<{ state: string }>();
              const head = await control.core
                .prepare(
                  "select active_deployment_id from environments where organization_id=?1 and environment_id=?2",
                )
                .bind(project.organizationId, ids.environmentId)
                .first<{ active_deployment_id: string }>();
              const claim = await control.core
                .prepare(
                  "select count(*) as n from product_provider_mutation_claims where organization_id=?1 and project_id=?2 and operation_id=?3",
                )
                .bind(project.organizationId, project.projectId, operationId)
                .first<{ n: number }>();
              expect(pending?.state).not.toBe("completed");
              expect(operation?.state).not.toBe("succeeded");
              expect(head?.active_deployment_id).toBe(deploymentId);
              expect(claim?.n).toBe(1);
              value = await execute();
            }
            journal.set(name, structuredClone(value));
            return value;
          },
          async sleep() {},
        } as Parameters<typeof runCoreDeploymentWorkflow>[2];
        const result = await runCoreDeploymentWorkflow(
          bindings,
          { payload: next.command, instanceId: next.workflowId },
          step,
        );
        expect(retries).toBe(1);
        expect(result).toEqual({ status: "succeeded", persistence: "applied" });
      } else {
        const result = await runCoreWorkflow(control, next, workflowHandlers);
        expect(result.failures).toEqual([]);
        expect(result.result).toEqual({ status: "succeeded", persistence: "applied" });
      }
      return { deploymentId, operationId };
    };
    const newLogin = await fetchNative("/api/auth/v1/sign-in/email", "POST", { email, password });
    const stableCookie = (newLogin.result as { cookies: string[] }).cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(stableCookie).toContain("omh_native");
    const redeployed = await nextDeployment(true);
    expect(
      (
        await worker.call("nativeSession", {
          scope: sessionScope,
          cookie: stableCookie,
          region: authority.region,
        })
      ).ok,
    ).toBe(false);
    const newScope = { ...sessionScope, deploymentId: redeployed.deploymentId };
    expect(
      await worker.call("nativeSession", {
        scope: newScope,
        cookie: stableCookie,
        region: authority.region,
      }),
    ).toMatchObject({ ok: true, result: { user: { email } } });
    const performRollback = async (returnedScope: typeof sessionScope, returnedCookie: string) => {
      const rollbackTarget = await control.core
        .prepare("select revision_id,artifact_id from deployment_revisions where deployment_id=?1")
        .bind(redeployed.deploymentId)
        .first<{ revision_id: string; artifact_id: string }>();
      if (!rollbackTarget) throw new Error("rollback target missing");
      const rollbackOperation = await seedOperation(project),
        rollbackEvent = newUlid();
      const rollbackCommand = parseProductCommandMessageV1({
        version: 1,
        eventType: "DeploymentRollbackRequestedV1",
        eventId: rollbackEvent,
        organizationId: project.organizationId,
        projectId: project.projectId,
        billingEpochId: project.billingEpochId,
        environmentId: ids.environmentId,
        operationId: rollbackOperation,
      });
      const rollbackWorkflow = deterministicProductCommandWorkflowId(rollbackCommand);
      await seedAcceptedOperation(project, ids.environmentId, {
        eventType: "DeploymentRollbackRequestedV1",
        operationId: rollbackOperation,
        eventId: rollbackEvent,
        claim: false,
        workflowId: rollbackWorkflow,
        intent: async (operation) => ({
          ...(await rollbackIntent(project, operation, ids.environmentId, {
            deploymentId: redeployed.deploymentId,
            revisionId: rollbackTarget.revision_id,
            artifactId: rollbackTarget.artifact_id,
          })),
          source_generation: 1,
        }),
      });
      await acknowledge(control, rollbackEvent);
      const rollbackRun: ChainRun = {
        command: rollbackCommand,
        workflowId: rollbackWorkflow,
        chain: {
          organizationId: project.organizationId,
          billingEpochId: project.billingEpochId,
          projectId: project.projectId,
          environmentId: ids.environmentId,
          environmentName: "dev",
          operationId: rollbackOperation,
          deploymentId: redeployed.deploymentId,
          buildId: "build-1",
        },
      };
      const rollbackHead = await control.core
        .prepare(
          "select revision from shared_gateway_route_revisions where organization_id=?1 and project_id=?2 and environment_id=?3 order by revision desc limit 1",
        )
        .bind(project.organizationId, project.projectId, ids.environmentId)
        .first<{ revision: number }>();
      if (!rollbackHead) throw new Error("rollback gateway missing");
      const rollbackActivate = gatewayActivation(store, rollbackRun.chain);
      const rollbackHandlers = chainHandlers(rollbackRun.chain, (input) =>
        rollbackActivate({
          ...(input as object),
          previousGateway: { revision: rollbackHead.revision },
        }),
      );
      const rollbackArtifact = rollbackHandlers.BUILD_RUNNER.readBuildArtifact;
      const rolledBack = await runCoreWorkflow(control, rollbackRun, {
        ...rollbackHandlers,
        BUILD_RUNNER: {
          ...rollbackHandlers.BUILD_RUNNER,
          readBuildArtifact: () => ({
            ...rollbackArtifact(),
            provenance: { ...rollbackArtifact().provenance, auth },
          }),
        },
        RUNTIME_SECRET_DELIVERY: {
          ...rollbackHandlers.RUNTIME_SECRET_DELIVERY,
          prepareExistingCandidate: () => ({
            ...stagedCandidate(rollbackRun.chain),
            status: "replayed",
            candidate: { ...wfpReceipt(rollbackRun.chain), buildReused: true },
            priorGateway: undefined,
            deploymentUrl: undefined,
          }),
        },
        NEON_MANAGEMENT: {
          placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
          prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
        },
        NATIVE_AUTH_RESOURCE_RUNTIME: {
          readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
          readDomainPolicySync: (input) => call("nativeDomainRead", input),
          ackDomainPolicySync: (input) => call("nativeDomainAck", input),
          beginHandleDomainRecovery: (input) => callNativeCore("beginHandleDomainRecovery", input),
          completeHandleDomainRecovery: (input) =>
            callNativeCore("completeHandleDomainRecovery", input),
          readPendingNativePolicySync: (input) => call("nativePending", input),
          completeNativePolicySync: (input) => call("nativeComplete", input),
        },
        NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input) => call("nativePolicyUs", input) },
        NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input) => call("nativePolicyEu", input) },
      });
      expect(rolledBack.failures).toEqual([]);
      expect(rolledBack.result).toEqual({ status: "succeeded", persistence: "applied" });
      expect(
        (
          await worker.call("nativeSession", {
            scope: returnedScope,
            cookie: returnedCookie,
            region: authority.region,
          })
        ).ok,
      ).toBe(false);
      expect(
        await worker.call("nativeSession", {
          scope: { ...sessionScope, deploymentId: redeployed.deploymentId },
          cookie: returnedCookie,
          region: authority.region,
        }),
      ).toMatchObject({ ok: true, result: { user: { email } } });
    };
    const sourceOff = await nextDeployment(false, true);
    expect(
      (
        await worker.call("nativeSession", {
          scope: newScope,
          cookie: stableCookie,
          region: authority.region,
        })
      ).ok,
    ).toBe(false);
    expect(
      await control.core
        .prepare("select state from native_auth_policy_syncs where operation_id=?1")
        .bind(sourceOff.operationId)
        .first(),
    ).toEqual({ state: "completed" });
    const role = await provider.native(`omh_ar_${ids.environmentId.toLowerCase()}`);
    try {
      expect(
        (
          await role.query(
            `select count(*)::int as n from omh_auth_${ids.environmentId.toLowerCase()}."user"`,
          )
        ).rows[0],
      ).toEqual({ n: 1 });
    } finally {
      await role.end();
    }
    const returned = await nextDeployment(true);
    const returnedScope = { ...sessionScope, deploymentId: returned.deploymentId };
    expect(
      await worker.call("nativeSession", {
        scope: returnedScope,
        cookie: stableCookie,
        region: authority.region,
      }),
    ).toEqual({ ok: true, result: null });
    const returnedAuthority = await store.identity.resolveNativeAuthAuthority({
      ...ids,
      deploymentId: returned.deploymentId,
    });
    const newSession = await worker.call("nativeFetch", {
      url: `${origin}/api/auth/v1/sign-in/email`,
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      scope: { ...returnedAuthority.realm, deploymentId: returned.deploymentId },
      region: authority.region,
    });
    expect(newSession).toMatchObject({ ok: true, result: { status: 200 } });
    const returnedCookie = (newSession.result as { cookies: string[] }).cookies
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const revision = await control.core
      .prepare("select revision_id,artifact_id from deployment_revisions where deployment_id=?1")
      .bind(returned.deploymentId)
      .first<{ revision_id: string; artifact_id: string }>();
    if (!revision) throw new Error("returned revision missing");
    const devHead = await control.core
      .prepare(
        "select head_version from environments where organization_id=?1 and environment_id=?2",
      )
      .bind(project.organizationId, ids.environmentId)
      .first<{ head_version: number }>();
    if (!devHead) throw new Error("dev head missing");
    const promotionOperation = await seedOperation(project),
      promotionEvent = newUlid();
    const promotionCommand = parseProductCommandMessageV1({
      version: 1,
      eventType: "DeploymentPromotionRequestedV1",
      eventId: promotionEvent,
      organizationId: project.organizationId,
      projectId: project.projectId,
      billingEpochId: project.billingEpochId,
      environmentId: fixture.p.productionEnvironmentId,
      operationId: promotionOperation,
    });
    const promotionWorkflow = deterministicProductCommandWorkflowId(promotionCommand);
    await seedAcceptedOperation(project, fixture.p.productionEnvironmentId, {
      eventType: "DeploymentPromotionRequestedV1",
      operationId: promotionOperation,
      eventId: promotionEvent,
      claim: false,
      workflowId: promotionWorkflow,
      intent: async (operation) => ({
        ...(await promotionIntent(project, operation, fixture.p.productionEnvironmentId, {
          deploymentId: returned.deploymentId,
          revisionId: revision.revision_id,
          artifactId: revision.artifact_id,
          environmentId: ids.environmentId,
        })),
        expected_source_head_version: devHead.head_version,
        source_generation: 1,
      }),
    });
    await acknowledge(control, promotionEvent);
    const deniedStore = createControlStore({ CONTROL_CORE: control.core });
    await expect(
      deniedStore.provisioning.authorizeActivation({
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: promotionOperation,
      }),
    ).rejects.toThrow("Native Auth launch unavailable");
    expect(
      await control.core
        .prepare(
          "select count(*) n from wfp_publish_receipts receipt join deployments deployment on deployment.organization_id=receipt.organization_id and deployment.deployment_id=receipt.product_deployment_id where deployment.operation_id=?1",
        )
        .bind(promotionOperation)
        .first(),
    ).toEqual({ n: 0 });
    const promotion = await control.core
      .prepare("select deployment_id from deployments where operation_id=?1 and kind='promotion'")
      .bind(promotionOperation)
      .first<{ deployment_id: string }>();
    if (!promotion) throw new Error("promotion missing");
    const promoteRun: ChainRun = {
      command: promotionCommand,
      workflowId: promotionWorkflow,
      chain: {
        organizationId: project.organizationId,
        billingEpochId: project.billingEpochId,
        projectId: project.projectId,
        environmentId: fixture.p.productionEnvironmentId,
        environmentName: "prod",
        operationId: promotionOperation,
        deploymentId: promotion.deployment_id,
        buildId: "build-1",
      },
    };
    const promotionHandlers = chainHandlers(
      promoteRun.chain,
      gatewayActivation(store, promoteRun.chain),
      "stagePromotionCandidate",
    );
    const promotionArtifact = promotionHandlers.BUILD_RUNNER.readBuildArtifact;
    const promoted = await runCoreWorkflow(control, promoteRun, {
      ...promotionHandlers,
      BUILD_RUNNER: {
        ...promotionHandlers.BUILD_RUNNER,
        readBuildArtifact: () => ({
          ...promotionArtifact(),
          provenance: { ...promotionArtifact().provenance, auth },
        }),
      },
      NEON_MANAGEMENT: {
        placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
        prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
      },
      NATIVE_AUTH_RESOURCE_RUNTIME: {
        readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
        readDomainPolicySync: (input) => call("nativeDomainRead", input),
        ackDomainPolicySync: (input) => call("nativeDomainAck", input),
        beginHandleDomainRecovery: (input) => callNativeCore("beginHandleDomainRecovery", input),
        completeHandleDomainRecovery: (input) =>
          callNativeCore("completeHandleDomainRecovery", input),
        readPendingNativePolicySync: (input) => call("nativePending", input),
        completeNativePolicySync: (input) => call("nativeComplete", input),
      },
      NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input) => call("nativePolicyUs", input) },
      NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input) => call("nativePolicyEu", input) },
    });
    expect(
      promoted.failures,
      JSON.stringify({ steps: promoted.steps, calls: promoted.calls.map(([name]) => name) }),
    ).toEqual([]);
    expect(
      promoted.result,
      JSON.stringify({
        steps: promoted.steps,
        operation: await control.core
          .prepare("select state,failure from operations where operation_id=?1")
          .bind(promotionOperation)
          .first(),
      }),
    ).toEqual({ status: "succeeded", persistence: "applied" });
    const prodScope = {
      projectId: ids.projectId,
      environmentId: fixture.p.productionEnvironmentId,
      deploymentId: promotion.deployment_id,
    };
    expect(
      await worker.call("nativeSession", {
        scope: prodScope,
        cookie: returnedCookie,
        region: authority.region,
      }),
    ).toEqual({ ok: true, result: null });
    const prodRole = await provider.native(
      `omh_ar_${fixture.p.productionEnvironmentId.toLowerCase()}`,
    );
    try {
      expect(
        (
          await prodRole.query(
            `select count(*)::int as n from omh_auth_${fixture.p.productionEnvironmentId.toLowerCase()}."user"`,
          )
        ).rows[0],
      ).toEqual({ n: 0 });
    } finally {
      await prodRole.end();
    }
    expect(
      await worker.call("nativeSession", {
        scope: returnedScope,
        cookie: returnedCookie,
        region: authority.region,
      }),
    ).toMatchObject({ ok: true, result: { user: { email } } });
    await performRollback(returnedScope, returnedCookie);
    const refreshSource = await control.core
      .prepare(
        `select e.active_deployment_id,e.active_revision_id,e.head_version,r.plan_id,r.artifact_id,r.build_execution_id,r.operation_id,w.candidate_receipt_id,w.dispatch_namespace,w.script_name,w.provider_version_id,lower(hex(a.artifact_sha256)) artifact_sha256,(select revision from shared_gateway_route_revisions g where g.organization_id=e.organization_id and g.environment_id=e.environment_id order by revision desc limit 1) gateway_revision,(select data_environment_id from environment_data_assignments d where d.organization_id=e.organization_id and d.environment_id=e.environment_id order by assignment_version desc limit 1) data_environment_id,(select assignment_version from environment_data_assignments d where d.organization_id=e.organization_id and d.environment_id=e.environment_id order by assignment_version desc limit 1) assignment_version from environments e join deployment_revisions r on r.organization_id=e.organization_id and r.revision_id=e.active_revision_id join wfp_publish_receipts w on w.organization_id=r.organization_id and w.wfp_receipt_id=r.wfp_receipt_id join build_artifacts a on a.organization_id=r.organization_id and a.artifact_id=r.artifact_id where e.organization_id=?1 and e.environment_id=?2`,
      )
      .bind(project.organizationId, ids.environmentId)
      .first<{
        active_deployment_id: string;
        active_revision_id: string;
        head_version: number;
        plan_id: string;
        artifact_id: string;
        build_execution_id: string;
        operation_id: string;
        candidate_receipt_id: string;
        dispatch_namespace: string;
        script_name: string;
        provider_version_id: string;
        artifact_sha256: string;
        gateway_revision: number;
        data_environment_id: string;
        assignment_version: number;
      }>();
    if (!refreshSource) throw new Error("refresh source missing");
    const refreshSnapshot = {
      sourceDeploymentId: refreshSource.active_deployment_id,
      sourceRevisionId: refreshSource.active_revision_id,
      sourceCandidateReceiptId: refreshSource.candidate_receipt_id,
      sourceArtifactId: refreshSource.artifact_id,
      sourcePlanId: refreshSource.plan_id,
      sourceBuildExecutionId: refreshSource.build_execution_id,
      sourceArtifactSha256: refreshSource.artifact_sha256,
      sourceNamespace: refreshSource.dispatch_namespace,
      sourceScriptName: refreshSource.script_name,
      sourceProviderTag: refreshSource.provider_version_id,
      expectedHeadVersion: refreshSource.head_version,
      expectedGatewayRevision: refreshSource.gateway_revision,
      dataEnvironmentId: refreshSource.data_environment_id,
      assignmentVersion: refreshSource.assignment_version,
      registrationVersion: 0,
    };
    const refreshOperation = await seedOperation(project),
      refreshEvent = newUlid(),
      refreshDeployment = newUlid();
    await control.core
      .prepare(
        "insert into deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) values(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
      )
      .bind(
        project.organizationId,
        refreshDeployment,
        project.projectId,
        ids.environmentId,
        refreshOperation,
        STORED_NOW,
      )
      .run();
    const refreshSourceConnection = await control.core
      .prepare("select source_connection_id from deployment_plans where plan_id=?1")
      .bind(refreshSource.plan_id)
      .first<{ source_connection_id: string }>();
    if (!refreshSourceConnection) throw new Error("refresh source connection missing");
    const refreshCommand = parseProductCommandMessageV1({
      version: 1,
      eventType: "DeploymentRequestedV1",
      eventId: refreshEvent,
      organizationId: project.organizationId,
      projectId: project.projectId,
      billingEpochId: project.billingEpochId,
      environmentId: ids.environmentId,
      operationId: refreshOperation,
      planId: refreshSource.plan_id,
    });
    const refreshWorkflow = deterministicProductCommandWorkflowId(refreshCommand);
    await seedAcceptedOperation(project, ids.environmentId, {
      operationId: refreshOperation,
      eventId: refreshEvent,
      workflowId: refreshWorkflow,
      claim: false,
      intent: {
        plan_id: refreshSource.plan_id,
        source_connection_id: refreshSourceConnection.source_connection_id,
        deployment_id: refreshDeployment,
        source_generation: 1,
        binding_refresh_snapshot: JSON.stringify(refreshSnapshot),
      },
    });
    await control.core
      .prepare(
        "insert into audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) values(?1,?2,?3,?4,'DeploymentRequestedV1','service','binding-refresh',?5,?6,?7)",
      )
      .bind(
        project.organizationId,
        newUlid(),
        project.projectId,
        refreshOperation,
        JSON.stringify({ bindingRefreshSnapshot: refreshSnapshot, acceptedLifecycleVersion: 1 }),
        STORED_NOW,
        project.billingEpochId,
      )
      .run();
    // The accepted binding-refresh intent normally carries this source-script inventory;
    // the fixture seeds the same immutable record as the parent data-change operation.
    const refreshLocator = `${refreshSnapshot.sourceNamespace}/${refreshSnapshot.sourceScriptName}`;
    const refreshHash = await resourceHash("cloudflare", "wfp-script", refreshLocator);
    await control.core
      .prepare(
        "insert into run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,cleanup_locator,recorded_at) values(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),?6,?7)",
      )
      .bind(
        project.organizationId,
        newUlid(),
        project.projectId,
        refreshOperation,
        refreshHash,
        `encoded/${Buffer.from(refreshLocator).toString("base64url")}`,
        STORED_NOW,
      )
      .run();
    await acknowledge(control, refreshEvent);
    const refreshRun: ChainRun = {
      command: refreshCommand,
      workflowId: refreshWorkflow,
      chain: {
        organizationId: project.organizationId,
        billingEpochId: project.billingEpochId,
        projectId: project.projectId,
        environmentId: ids.environmentId,
        environmentName: "dev",
        operationId: refreshOperation,
        deploymentId: refreshDeployment,
        buildId: "build-1",
      },
    };
    const refreshActivate = gatewayActivation(store, refreshRun.chain);
    const refreshHandlers = chainHandlers(refreshRun.chain, (input) =>
      refreshActivate({
        ...(input as object),
        previousGateway: { revision: refreshSource.gateway_revision },
      }),
    );
    const oldArtifact = buildArtifact({
      ...refreshRun.chain,
      operationId: refreshSource.operation_id,
      deploymentId: refreshSource.active_deployment_id,
    });
    const refreshed = await runCoreWorkflow(control, refreshRun, {
      ...refreshHandlers,
      RUNTIME_SECRET_DELIVERY: {
        ...refreshHandlers.RUNTIME_SECRET_DELIVERY,
        stageCandidate: () => ({
          ...stagedCandidate(refreshRun.chain),
          candidate: { ...wfpReceipt(refreshRun.chain), buildReused: true },
        }),
      },
      BUILD_RUNNER: {
        ...refreshHandlers.BUILD_RUNNER,
        readBuildArtifact: () => ({
          ...oldArtifact,
          provenance: { ...oldArtifact.provenance, auth },
        }),
      },
      WFP_MANAGEMENT: {
        ...refreshHandlers.WFP_MANAGEMENT,
        activateCandidate: async (input) => {
          const result = await refreshHandlers.WFP_MANAGEMENT.activateCandidate(input);
          return { ...result, candidate: { ...result.candidate, buildReused: true } };
        },
        removeCandidate: () => ({ status: "removed", outcome: "removed" }),
      },
      NEON_MANAGEMENT: {
        placeNativeAuthDatabase: (input) => call("placeNativeAuthDatabase", input),
        prepareNativeAuthRealm: (input) => call("prepareNativeAuthRealm", input),
      },
      NATIVE_AUTH_RESOURCE_RUNTIME: {
        readProvisioningPolicy: (input) => call("nativeProvisioningPolicy", input),
        readDomainPolicySync: (input) => call("nativeDomainRead", input),
        ackDomainPolicySync: (input) => call("nativeDomainAck", input),
        beginHandleDomainRecovery: (input) => callNativeCore("beginHandleDomainRecovery", input),
        completeHandleDomainRecovery: (input) =>
          callNativeCore("completeHandleDomainRecovery", input),
        readPendingNativePolicySync: (input) => call("nativePending", input),
        completeNativePolicySync: (input) => call("nativeComplete", input),
      },
      NATIVE_AUTH_ADMIN_US: { applyRealmPolicy: (input) => call("nativePolicyUs", input) },
      NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy: (input) => call("nativePolicyEu", input) },
    });
    expect(refreshed.failures).toEqual([]);
    expect(refreshed.result).toEqual({ status: "succeeded", persistence: "applied" });
    expect(
      (
        await worker.call("nativeSession", {
          scope: { ...sessionScope, deploymentId: refreshSource.active_deployment_id },
          cookie: returnedCookie,
          region: authority.region,
        })
      ).ok,
    ).toBe(false);
    expect(
      await worker.call("nativeSession", {
        scope: { ...sessionScope, deploymentId: refreshDeployment },
        cookie: returnedCookie,
        region: authority.region,
      }),
    ).toMatchObject({ ok: true, result: { user: { email } } });
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 180_000);
