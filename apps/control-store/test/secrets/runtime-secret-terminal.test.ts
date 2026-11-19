import { createControlStore } from "../../src/store.js";
import { createD1RuntimeSecretPersistence } from "../../../runtime-secret-delivery/src/d1-persistence.js";
import { parseUlid } from "@ohmyhost/platform";
import { expect, it } from "vitest";
import { createTestControl, coreRouter } from "../support/control-d1.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { claimDelivery } from "../../src/catalog/runtime-secrets/claim.js";
import { activateDelivery } from "../../src/catalog/runtime-secrets/terminal.js";
import { losingWriteResponses } from "../support/platform-fixtures.js";

const id = () => parseUlid(newUlid());
const nativeScope = (s: { organizationId: string; projectId: string; environmentId: string }) => ({
  organizationId: parseUlid(s.organizationId),
  projectId: parseUlid(s.projectId),
  environmentId: parseUlid(s.environmentId),
});

it("replays the exact stage, an expired-but-same activation and a lost compensation, refuses activation after the route is removed and compensates a superseded stage", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const ctx = { directory: control.core, router: coreRouter(control) },
      d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets),
      now = Date.now(),
      claim = {
        ...nativeScope(r.scope),
        operationId: parseUlid(r.accepted.operationId),
        trigger: "deploy" as const,
        runtimeProvider: "wfp" as const,
        leaseId: id(),
        claimedAt: new Date(now - 600000).toISOString(),
        leaseMilliseconds: 120000,
      };
    await claimDelivery(ctx, claim);
    const stage = {
      ...nativeScope(r.scope),
      stageReceiptId: id(),
      operationId: parseUlid(r.accepted.operationId),
      productDeploymentId: parseUlid(r.deploymentId),
      candidateReceiptId: parseUlid(r.candidateReceiptId),
      leaseId: claim.leaseId,
      generation: 0,
      releaseSequence: 1,
      trigger: "deploy" as const,
      providerTag: r.providerTag,
      appliedSecretNames: [],
      manifestSha256: new Uint8Array(32).fill(3),
      manifestSecretCount: 0,
      stagedAt: new Date(now - 540000).toISOString(),
    };
    expect(await d1.stageWfp(stage)).toEqual({
      outcome: "staged",
      stageReceiptId: stage.stageReceiptId,
    });
    const replay = { ...stage, stageReceiptId: id() };
    // The same lease replays its stored stage identity, not the retried receipt.
    expect(await d1.stageWfp(replay)).toEqual({
      outcome: "existing",
      stageReceiptId: stage.stageReceiptId,
    });
    const gateway = await r.store.gateway.management.activate(r.activation);
    const activate = {
      ...nativeScope(r.scope),
      activationReceiptId: id(),
      stageReceiptId: stage.stageReceiptId,
      operationId: parseUlid(r.accepted.operationId),
      productDeploymentId: parseUlid(r.deploymentId),
      candidateReceiptId: parseUlid(r.candidateReceiptId),
      candidateScriptName: r.script,
      candidateProviderTag: r.providerTag,
      candidateArtifactDigest: new Uint8Array(32).fill(3),
      gateway,
      activatedAt: new Date().toISOString(),
    };
    const lossy = {
      directory: control.core,
      router: coreRouter(control, { CONTROL_SHARD_0000: losingWriteResponses(control.core, 1) }),
    };
    // The committed activation is reconciled as existing, with its original time, not another stage/receipt.
    const a = await activateDelivery(lossy, activate);
    expect(a).toEqual({
      outcome: "existing",
      activationReceiptId: activate.activationReceiptId,
      activatedAt: activate.activatedAt,
    });
    const later = { ...activate, activatedAt: new Date(Date.now() + 1000).toISOString() };
    expect(await d1.activateWfp(later)).toEqual({
      outcome: "existing",
      activationReceiptId: activate.activationReceiptId,
      activatedAt: activate.activatedAt,
    });
    expect(
      await control.core
        .prepare("SELECT count(*) n FROM runtime_secret_delivery_receipts WHERE organization_id=?")
        .bind(r.scope.organizationId)
        .first(),
    ).toEqual({ n: 1 });
    const clear = await control.core
      .prepare(
        "SELECT active_lease_id,applied_release_sequence FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
      )
      .bind(r.scope.organizationId, r.scope.environmentId)
      .first();
    expect(clear).toEqual({ active_lease_id: null, applied_release_sequence: 1 });
    await r.store.gateway.management.remove({ ...r.mutation, expectedRevision: 2 });
    await expect(d1.activateWfp(activate)).rejects.toHaveProperty(
      "name",
      "RuntimeSecretDeliveryConflictError",
    );
    const other = await gatewayFixture(control);
    const otherClaim = {
      ...claim,
      ...nativeScope(other.scope),
      operationId: parseUlid(other.accepted.operationId),
      leaseId: id(),
    };
    await claimDelivery(ctx, otherClaim);
    const otherStage = {
      ...stage,
      ...nativeScope(other.scope),
      stageReceiptId: id(),
      operationId: parseUlid(other.accepted.operationId),
      productDeploymentId: parseUlid(other.deploymentId),
      candidateReceiptId: parseUlid(other.candidateReceiptId),
      leaseId: otherClaim.leaseId,
    };
    await d1.stageWfp(otherStage);
    const supersede =
      "UPDATE runtime_secret_delivery_states SET active_lease_id=NULL,claimed_generation=NULL,claimed_release_sequence=NULL,claimed_trigger=NULL,claimed_at=NULL,lease_expires_at=NULL,applied_release_sequence=3,next_release_sequence=4,provider_tag='newer-tag',applied_manifest_sha256=";
    await control.core
      .prepare(supersede + "zeroblob(32) WHERE organization_id=? AND environment_id=?")
      .bind(other.scope.organizationId, other.scope.environmentId)
      .run();
    const compensate = {
      ...nativeScope(other.scope),
      compensationReceiptId: id(),
      stageReceiptId: otherStage.stageReceiptId,
      candidateReceiptId: otherStage.candidateReceiptId,
      failureCode: "CANDIDATE_REMOVED",
      compensatedAt: new Date().toISOString(),
    };
    const unknownCompensate = await createD1RuntimeSecretPersistence(
      createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }).runtimeSecrets,
    ).compensateWfp(compensate);
    expect(unknownCompensate).toEqual({
      outcome: "existing",
      compensationReceiptId: compensate.compensationReceiptId,
      compensatedAt: compensate.compensatedAt,
    });
    const repeated = { ...compensate, compensatedAt: new Date(Date.now() + 1000).toISOString() };
    expect(await d1.compensateWfp(repeated)).toEqual({
      outcome: "existing",
      compensationReceiptId: compensate.compensationReceiptId,
      compensatedAt: compensate.compensatedAt,
    });
    const matching = await gatewayFixture(control);
    const matchingScope = nativeScope(matching.scope),
      matchingClient = createD1RuntimeSecretPersistence(matching.store.runtimeSecrets);
    const matchingClaim = {
      ...claim,
      ...matchingScope,
      operationId: parseUlid(matching.accepted.operationId),
      leaseId: id(),
    };
    await matchingClient.claim(matchingClaim);
    const matchingStage = {
      ...stage,
      ...matchingScope,
      stageReceiptId: id(),
      operationId: matchingClaim.operationId,
      productDeploymentId: parseUlid(matching.deploymentId),
      candidateReceiptId: parseUlid(matching.candidateReceiptId),
      leaseId: matchingClaim.leaseId,
    };
    await matchingClient.stageWfp(matchingStage);
    const failed = {
      ...matchingScope,
      compensationReceiptId: id(),
      stageReceiptId: matchingStage.stageReceiptId,
      candidateReceiptId: matchingStage.candidateReceiptId,
      failureCode: "CANDIDATE_REMOVED",
      compensatedAt: new Date().toISOString(),
    };
    await control.core
      .prepare(
        `CREATE TRIGGER test_fail_secret_clear BEFORE UPDATE ON runtime_secret_delivery_states WHEN OLD.organization_id='${matching.scope.organizationId}' AND NEW.active_lease_id IS NULL BEGIN SELECT RAISE(ABORT,'test last secret state failure'); END`,
      )
      .run();
    await expect(matchingClient.compensateWfp(failed)).rejects.toThrow(
      "test last secret state failure",
    );
    expect(
      await control.core
        .prepare(
          "SELECT count(*) n FROM runtime_secret_delivery_stage_compensations WHERE stage_receipt_id=?",
        )
        .bind(matchingStage.stageReceiptId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await control.core
        .prepare(
          "SELECT active_lease_id FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
        )
        .bind(matching.scope.organizationId, matching.scope.environmentId)
        .first(),
    ).toEqual({ active_lease_id: matchingClaim.leaseId });
    await control.core.prepare("DROP TRIGGER test_fail_secret_clear").run();
    expect(await matchingClient.compensateWfp(failed)).toEqual({
      outcome: "compensated",
      compensationReceiptId: failed.compensationReceiptId,
      compensatedAt: failed.compensatedAt,
    });
    expect(
      await control.core
        .prepare(
          "SELECT active_lease_id,last_failure_code FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
        )
        .bind(matching.scope.organizationId, matching.scope.environmentId)
        .first(),
    ).toEqual({ active_lease_id: null, last_failure_code: "CANDIDATE_REMOVED" });
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 240000);
