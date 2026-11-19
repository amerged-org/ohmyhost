import { createControlStore } from "../../src/store.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";
import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createD1RuntimeSecretPersistence } from "../../../runtime-secret-delivery/src/d1-persistence.js";
import { createTestControl } from "../support/control-d1.js";
import { newUlid } from "../../src/catalog/common.js";
import { acceptedSecretFixture, promotionMailFixture } from "./runtime-secret-fixture.js";
import { seedProject } from "../support/platform-fixtures.js";
import { bucketOf } from "../../src/router.js";

it("reads state, pending, recorded and active-target evidence exactly across claim, stage, activation and reconcile", async () => {
  const control = await createTestControl();
  try {
    const r = await acceptedSecretFixture(control);
    const d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets);
    const scope = {
        organizationId: parseUlid(r.scope.organizationId),
        projectId: parseUlid(r.scope.projectId),
        environmentId: parseUlid(r.scope.environmentId),
      },
      at = new Date().toISOString();
    const claim = {
      ...scope,
      operationId: parseUlid(r.operationId),
      leaseId: parseUlid(newUlid()),
      trigger: "deploy" as const,
      runtimeProvider: "wfp" as const,
      claimedAt: at,
      leaseMilliseconds: 120000,
    };
    const leaseUntil = (from: string) => new Date(Date.parse(from) + 120000).toISOString();
    expect(await d1.claim(claim)).toEqual({
      outcome: "claimed",
      generation: 0,
      trigger: "deploy",
      runtimeProvider: "wfp",
      releaseSequence: 1,
      leaseId: claim.leaseId,
      leaseExpiresAt: leaseUntil(at),
      secrets: [],
      appliedSecretNames: [],
    });
    expect(await d1.readState(scope)).toEqual({
      ...scope,
      desiredGeneration: 0,
      appliedGeneration: 0,
      nextReleaseSequence: 2,
      appliedReleaseSequence: 0,
      activeClaimReleaseSequence: 1,
      activeLeaseExpiresAt: leaseUntil(at),
      appliedSecretNames: [],
      manifestSecretCount: 0,
      updatedAt: at,
    });
    const stage = {
      ...scope,
      stageReceiptId: parseUlid(newUlid()),
      operationId: claim.operationId,
      productDeploymentId: parseUlid(r.published.deploymentId),
      candidateReceiptId: parseUlid(r.published.candidateReceiptId),
      leaseId: claim.leaseId,
      generation: 0,
      releaseSequence: 1,
      trigger: "deploy" as const,
      providerTag: "exact-fixture-tag",
      appliedSecretNames: [],
      manifestSha256: new Uint8Array(32).fill(3),
      manifestSecretCount: 0,
      stagedAt: at,
    };
    expect(await d1.stageWfp?.(stage)).toEqual({
      outcome: "staged",
      stageReceiptId: stage.stageReceiptId,
    });
    const record = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentName: "prod" as const,
      candidateReceiptId: stage.candidateReceiptId,
    };
    const recorded = {
      stageReceiptId: stage.stageReceiptId,
      candidateReceiptId: stage.candidateReceiptId,
      operationId: stage.operationId,
      productDeploymentId: stage.productDeploymentId,
      leaseId: stage.leaseId,
      generation: 0,
      releaseSequence: 1,
      trigger: "deploy",
      providerTag: "exact-fixture-tag",
      appliedSecretNames: [],
      manifestDigest: `sha256:${"03".repeat(32)}`,
      manifestSecretCount: 0,
      stagedAt: at,
      outcome: "existing",
    };
    expect(await d1.readRecordedWfpStage?.(record)).toEqual(recorded);
    const gateway = await r.store.gateway.management.observe(r.scope);
    if (!gateway) throw new Error("Missing accepted route");
    const activate = {
      ...scope,
      activationReceiptId: parseUlid(newUlid()),
      stageReceiptId: stage.stageReceiptId,
      operationId: claim.operationId,
      productDeploymentId: stage.productDeploymentId,
      candidateReceiptId: stage.candidateReceiptId,
      candidateScriptName: gateway.targetScriptName,
      candidateProviderTag: stage.providerTag,
      candidateArtifactDigest: new Uint8Array(32).fill(3),
      gateway,
      activatedAt: new Date().toISOString(),
    };
    expect(await d1.activateWfp?.(activate)).toEqual({
      outcome: "activated",
      activationReceiptId: activate.activationReceiptId,
      activatedAt: expect.any(String),
    });
    expect(await d1.readActiveWfpTarget?.(scope)).toEqual({
      deployment: {
        provider: "cloudflare-wfp",
        namespace: "ohmyho-production",
        scriptName: gateway.targetScriptName,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        productDeploymentId: stage.productDeploymentId,
        providerTag: "exact-fixture-tag",
        artifactDigest: `sha256:${"03".repeat(32)}`,
        buildReused: false,
        deployedAt: expect.any(String),
      },
      candidateReceiptId: stage.candidateReceiptId,
      operationId: claim.operationId,
      gateway,
    });
    expect(await d1.readRecordedWfpStage?.(record)).toBeNull();
    const secret = {
      ...scope,
      operationId: claim.operationId,
      claimId: parseUlid(r.claimId),
      name: "DATABASE_URL" as const,
      ciphertext: new Uint8Array(24).fill(4),
      nonce: new Uint8Array(12).fill(5),
      valueSha256: new Uint8Array(32).fill(6),
      keyVersion: 1,
      writtenAt: new Date().toISOString(),
    };
    expect(await d1.installPlatform?.(secret)).toEqual({
      name: "DATABASE_URL",
      revision: 1,
      keyVersion: 1,
      createdAt: secret.writtenAt,
      updatedAt: secret.writtenAt,
    });
    const pending = { now: new Date(Date.now() + 1000).toISOString(), limit: 10 };
    expect(await d1.readPending(pending)).toEqual([
      {
        ...scope,
        desiredGeneration: 1,
        appliedGeneration: 0,
        runtimeProvider: "wfp",
        activeCandidate: {
          candidateReceiptId: stage.candidateReceiptId,
          ...scope,
          operationId: claim.operationId,
          productDeploymentId: stage.productDeploymentId,
          artifactId: expect.any(String),
          namespace: "ohmyho-production",
          immutableScriptName: gateway.targetScriptName,
          artifactDigest: new Uint8Array(32).fill(3),
          providerTag: "exact-fixture-tag",
          buildReused: false,
          stagedAt: expect.any(String),
        },
        environmentName: "prod",
        handle: gateway.handle,
      },
    ]);
    expect(await d1.readState(scope)).toEqual({
      ...scope,
      desiredGeneration: 1,
      appliedGeneration: 0,
      nextReleaseSequence: 2,
      appliedReleaseSequence: 1,
      runtimeProvider: "wfp",
      providerTag: "exact-fixture-tag",
      appliedSecretNames: [],
      manifestSha256: new Uint8Array(32).fill(3),
      manifestSecretCount: 0,
      updatedAt: secret.writtenAt,
    });
    const reconcile = {
      ...scope,
      leaseId: parseUlid(newUlid()),
      trigger: "reconcile" as const,
      runtimeProvider: "wfp" as const,
      claimedAt: new Date(Date.now() + 2000).toISOString(),
      leaseMilliseconds: 120000,
    };
    expect(await d1.claim(reconcile)).toEqual({
      outcome: "claimed",
      generation: 1,
      trigger: "reconcile",
      runtimeProvider: "wfp",
      releaseSequence: 2,
      leaseId: reconcile.leaseId,
      leaseExpiresAt: leaseUntil(reconcile.claimedAt),
      secrets: [
        {
          name: "DATABASE_URL",
          ciphertext: secret.ciphertext,
          nonce: secret.nonce,
          valueSha256: secret.valueSha256,
          keyVersion: 1,
          revision: 1,
        },
      ],
      appliedSecretNames: [],
      providerTag: "exact-fixture-tag",
    });
    const nonempty = {
      ...stage,
      stageReceiptId: parseUlid(newUlid()),
      leaseId: reconcile.leaseId,
      generation: 1,
      releaseSequence: 2,
      trigger: "reconcile" as const,
      appliedSecretNames: ["DATABASE_URL"],
      manifestSecretCount: 1,
      stagedAt: reconcile.claimedAt,
    };
    const uncertain = await createD1RuntimeSecretPersistence(
      createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }).runtimeSecrets,
    ).stageWfp(nonempty);
    // The first stage reply is lost after its write committed: the retry reports the already staged receipt.
    expect(uncertain).toEqual({ outcome: "existing", stageReceiptId: nonempty.stageReceiptId });
    expect(await d1.readRecordedWfpStage(record)).toEqual({
      ...recorded,
      stageReceiptId: nonempty.stageReceiptId,
      leaseId: reconcile.leaseId,
      generation: 1,
      releaseSequence: 2,
      trigger: "reconcile",
      appliedSecretNames: ["DATABASE_URL"],
      manifestSecretCount: 1,
      stagedAt: reconcile.claimedAt,
    });
  } finally {
    await control.dispose();
  }
}, 240000);

it("returns the exact promotion source environment envelope without relabeling its AAD scope", async () => {
  const control = await createTestControl();
  try {
    const r = await promotionMailFixture(control);
    const input = {
        organizationId: parseUlid(r.project.organizationId),
        projectId: parseUlid(r.project.projectId),
        environmentId: parseUlid(r.target),
        operationId: parseUlid(r.operationId),
        claimId: parseUlid(r.claimId),
      },
      d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets);
    // The envelope keeps the source (Development) environment: its AAD scope is never relabeled to the target.
    expect(await d1.readPromotionMailGatewaySource?.(input)).toEqual({
      environmentId: r.project.devEnvironmentId,
      ciphertext: new Uint8Array(24).fill(4),
      nonce: new Uint8Array(12).fill(5),
      valueSha256: new Uint8Array(32).fill(6),
      keyVersion: 1,
    });
    expect(
      await d1.readPromotionMailGatewaySource?.({ ...input, claimId: parseUlid(newUlid()) }),
    ).toBeNull();
  } finally {
    await control.dispose();
  }
}, 240000);

it("sends never-deployed scopes nowhere and lets a scope the sweeper already tried leave the head of the batch", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const never = await seedProject(control),
      deployedA = await seedProject(control),
      deployedB = await seedProject(control),
      newest = await seedProject(control);
    const state = (
      project: Awaited<ReturnType<typeof seedProject>>,
      environmentId: string,
      updatedAt: string,
      deployed: boolean,
    ) =>
      control.core
        .prepare(
          "UPDATE runtime_secret_delivery_states SET desired_generation=1,applied_generation=0,applied_secret_names='[]',applied_secret_count=0,applied_manifest_sha256=?4,provider_tag=?5,created_at=?6,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(
          project.organizationId,
          project.projectId,
          environmentId,
          deployed ? new Uint8Array(32) : null,
          deployed ? "exact-deployed-tag" : null,
          updatedAt,
        )
        .run();
    // Both environments of the never-deployed project are the oldest pending rows: no runtime exists to sync them.
    for (const environmentId of [never.devEnvironmentId, never.prodEnvironmentId])
      await state(never, environmentId, "2026-10-29T08:00:00.000000Z", false);
    await state(deployedA, deployedA.prodEnvironmentId, "2026-10-29T09:00:00.000000Z", true);
    await state(deployedA, deployedA.devEnvironmentId, "2026-10-29T09:00:01.000000Z", true);
    await state(deployedB, deployedB.prodEnvironmentId, "2026-10-29T09:00:02.000000Z", true);
    await state(deployedB, deployedB.devEnvironmentId, "2026-10-29T09:00:03.000000Z", true);
    await state(newest, newest.prodEnvironmentId, "2026-10-29T09:30:00.000000Z", true);
    const ids = (rows: readonly { environmentId: string }[]) =>
      rows.map((row) => row.environmentId);
    const at = "2026-10-29T10:00:00.000Z";

    expect(ids(await store.runtimeSecrets.readPending({ now: at, limit: 10 }))).toEqual([
      deployedA.prodEnvironmentId,
      deployedA.devEnvironmentId,
      deployedB.prodEnvironmentId,
      deployedB.devEnvironmentId,
      newest.prodEnvironmentId,
    ]);
    // The sweeper tried the two oldest scopes; the next batch starts with the scopes it has not tried yet.
    for (const [project, environmentId] of [
      [deployedA, deployedA.prodEnvironmentId],
      [deployedA, deployedA.devEnvironmentId],
    ] as const)
      await store.runtimeSecrets.recordPendingAttempt({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId,
        now: at,
      });
    expect(ids(await store.runtimeSecrets.readPending({ now: at, limit: 2 }))).toEqual([
      deployedB.prodEnvironmentId,
      deployedB.devEnvironmentId,
    ]);
  } finally {
    await control.dispose();
  }
});

it("leaves rows whose bucket moved or whose owner or environment is inconsistent out of the batch, and logs them", async () => {
  const control = await createTestControl();
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const store = createControlStore(control.bindings);
    const moved = await seedProject(control),
      healthy = await seedProject(control);
    for (const project of [moved, healthy])
      await control.core
        .prepare(
          "UPDATE runtime_secret_delivery_states SET desired_generation=1,applied_generation=0,provider_tag='exact-deployed-tag',applied_manifest_sha256=zeroblob(32),created_at=?3,updated_at=?3 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?4",
        )
        .bind(
          project.organizationId,
          project.projectId,
          "2026-10-29T08:00:00.000000Z",
          project.prodEnvironmentId,
        )
        .run();
    // The moved tenant's bucket has been moved away: its rows are no longer this Core's to deliver.
    await control.core
      .prepare(
        "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moved',?2,'2026-10-29T08:00:00.000000Z')",
      )
      .bind(await bucketOf(moved.organizationId), newUlid())
      .run();
    const at = "2026-10-29T10:00:00.000Z";
    const rows = await store.runtimeSecrets.readPending({ now: at, limit: 10 });
    expect(rows.map((row) => row.environmentId)).toEqual([healthy.prodEnvironmentId]);
    expect(errors).toHaveBeenCalledWith(
      "runtime_secret_pending_anomalies",
      JSON.stringify({
        sampled: 1,
        limit: 10,
        bucketMoved: 1,
        ownerMismatch: 0,
        environmentName: 0,
      }),
    );
  } finally {
    errors.mockRestore();
    await control.dispose();
  }
});

it("holds back a bucket that is moving as well, so its rows take no batch slot", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    const moving = await seedProject(control),
      healthy = await seedProject(control);
    for (const project of [moving, healthy])
      await control.core
        .prepare(
          "UPDATE runtime_secret_delivery_states SET desired_generation=1,applied_generation=0,provider_tag='exact-deployed-tag',applied_manifest_sha256=zeroblob(32),created_at=?3,updated_at=?3 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?4",
        )
        .bind(
          project.organizationId,
          project.projectId,
          "2026-10-29T08:00:00.000000Z",
          project.prodEnvironmentId,
        )
        .run();
    // A moving bucket refuses its writes, so its rows could only hold a batch slot without progress.
    await control.core
      .prepare(
        "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moving',?2,'2026-10-29T08:00:00.000000Z')",
      )
      .bind(await bucketOf(moving.organizationId), newUlid())
      .run();
    const rows = await store.runtimeSecrets.readPending({
      now: "2026-10-29T10:00:00.000Z",
      limit: 10,
    });
    expect(rows.map((row) => row.environmentId)).toEqual([healthy.prodEnvironmentId]);
  } finally {
    await control.dispose();
  }
});

it("surfaces a lost delivery-attempt stamp as an unknown outcome and keeps the committed stamp", async () => {
  const control = await createTestControl();
  try {
    const project = await seedProject(control),
      at = "2026-10-29T10:00:00.000Z";
    const stamp = () =>
      control.core
        .prepare(
          "SELECT last_attempted_at FROM runtime_secret_delivery_states WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
        )
        .bind(project.organizationId, project.projectId, project.prodEnvironmentId)
        .first<{ last_attempted_at: string | null }>();
    expect(await stamp()).toEqual({ last_attempted_at: null });
    const lost = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    await expect(
      lost.runtimeSecrets.recordPendingAttempt({
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.prodEnvironmentId,
        now: at,
      }),
    ).rejects.toThrow("runtimeSecrets.recordPendingAttempt: store_outcome_unknown");
    // The write committed before its reply was lost, so the scope is stamped as tried.
    expect((await stamp())?.last_attempted_at).not.toBeNull();
  } finally {
    await control.dispose();
  }
});
