import { createD1RuntimeSecretPersistence } from "../../../runtime-secret-delivery/src/d1-persistence.js";
import { parseUlid } from "@ohmyhost/platform";
import { expect, it } from "vitest";
import { createTestControl, coreRouter } from "../support/control-d1.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import {
  sourceFrameworkPlan,
  seedWfpPublication,
  seedDeploymentPlan,
} from "../support/provider-fixtures.js";
import {
  promotionIntent,
  rollbackIntent,
  releaseProviderClaim,
  seedAcceptedOperation,
  seedPublishedClaim,
  seedOperation,
} from "../support/accepted-operation.js";
import { claimDelivery } from "../../src/catalog/runtime-secrets/claim.js";
import { newUlid } from "../../src/catalog/common.js";
import {
  losingWriteResponses,
  beforeFirstWrite,
  freezeOwnership,
  seedProject,
  STORED_NOW,
  bytes,
} from "../support/platform-fixtures.js";

const id = () => parseUlid(newUlid());
const nativeScope = (s: { organizationId: string; projectId: string; environmentId: string }) => ({
  organizationId: parseUlid(s.organizationId),
  projectId: parseUlid(s.projectId),
  environmentId: parseUlid(s.environmentId),
});

it("claims, refuses a busy lease, fails, reclaims and releases with byte-exact encrypted snapshots, adopting no new snapshot after a lost commit", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets),
      scope = nativeScope(r.scope);
    const input = {
      ...scope,
      trigger: "deploy" as const,
      runtimeProvider: "wfp" as const,
      operationId: parseUlid(r.accepted.operationId),
      leaseId: id(),
      claimedAt: "2026-10-29T00:00:00.000Z",
      leaseMilliseconds: 120000,
    };
    const seed = async (name: string, fill: number) => {
      const env = [
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        name,
        new Uint8Array(24).fill(fill),
        new Uint8Array(12).fill(fill),
        new Uint8Array(32).fill(fill),
        "2026-10-28T10:00:00.000000Z",
      ];
      await r.db
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
        )
        .bind(...env)
        .run();
    };
    await seed("API_TOKEN", 4);
    await seed("OHMYHOST_MAIL_KEY", 5);
    await seed("OHMYHOST_AI_KEY", 6);
    await expect(d1.claim({ ...input, force: true })).rejects.toHaveProperty(
      "name",
      "RuntimeSecretDeliveryInputError",
    );
    const secret = {
      name: "API_TOKEN",
      ciphertext: new Uint8Array(24).fill(4),
      nonce: new Uint8Array(12).fill(4),
      valueSha256: new Uint8Array(32).fill(4),
      keyVersion: 1,
      revision: 1,
    };
    // Only the deliverable secret is claimed with its exact encrypted snapshot, never the reserved mail and AI keys.
    expect(await d1.claim(input)).toEqual({
      outcome: "claimed",
      generation: 0,
      trigger: "deploy",
      runtimeProvider: "wfp",
      releaseSequence: 1,
      leaseId: input.leaseId,
      leaseExpiresAt: "2026-10-29T00:02:00.000Z",
      secrets: [secret],
      appliedSecretNames: [],
    });
    expect(await d1.claim(input)).toEqual({
      outcome: "busy",
      generation: 0,
      releaseSequence: 1,
      retryAt: "2026-10-29T00:02:00.000Z",
    });
    const fail = {
      ...scope,
      leaseId: input.leaseId,
      generation: 0,
      releaseSequence: 1,
      code: "DELIVERY_FAILED",
      failedAt: "2026-10-29T00:01:00.000Z",
    };
    expect(await d1.fail(fail)).toBe("failed");
    await expect(d1.fail(fail)).rejects.toHaveProperty("name", "RuntimeSecretDeliveryLeaseError");
    const next = { ...input, leaseId: id(), claimedAt: "2026-10-29T00:03:00.000Z" };
    expect(await d1.claim(next)).toEqual({
      outcome: "claimed",
      generation: 0,
      trigger: "deploy",
      runtimeProvider: "wfp",
      releaseSequence: 2,
      leaseId: next.leaseId,
      leaseExpiresAt: "2026-10-29T00:05:00.000Z",
      secrets: [secret],
      appliedSecretNames: [],
    });
    const release = {
      ...scope,
      leaseId: next.leaseId,
      generation: 0,
      releaseSequence: 2,
      releasedAt: "2026-10-29T00:04:00.000Z",
    };
    expect(await d1.release(release)).toBe("released");
    // A plan that declares ai delivers the AI key with the API token; the mail key stays withheld.
    const aiRun = await gatewayFixture(control, {
      frameworkPlan: { ...sourceFrameworkPlan(false), ai: { enabled: true, jurisdiction: "eu" } },
    });
    const aiScope = nativeScope(aiRun.scope);
    const aiInput = {
      ...aiScope,
      trigger: "deploy" as const,
      runtimeProvider: "wfp" as const,
      operationId: parseUlid(aiRun.accepted.operationId),
      leaseId: id(),
      claimedAt: "2026-10-29T00:07:00.000Z",
      leaseMilliseconds: 120000,
    };
    for (const name of ["API_TOKEN", "OHMYHOST_MAIL_KEY", "OHMYHOST_AI_KEY"]) {
      await aiRun.db
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
        )
        .bind(
          aiScope.organizationId,
          aiScope.projectId,
          aiScope.environmentId,
          name,
          new Uint8Array(24).fill(7),
          new Uint8Array(12).fill(7),
          new Uint8Array(32).fill(7),
          "2026-10-28T10:00:00.000000Z",
        )
        .run();
    }
    const aiClaim = await d1.claim(aiInput);
    expect(aiClaim.outcome).toBe("claimed");
    expect(
      aiClaim.outcome === "claimed" ? aiClaim.secrets.map((secret) => secret.name) : [],
    ).toEqual(["API_TOKEN", "OHMYHOST_AI_KEY"]);
    const unknown = { ...input, leaseId: id(), claimedAt: "2026-10-29T00:06:00.000Z" };
    const lossy = {
      directory: control.core,
      router: coreRouter(control, { CONTROL_SHARD_0000: losingWriteResponses(control.core, 1) }),
    };
    expect(await claimDelivery(lossy, unknown)).toMatchObject({
      outcome: "busy",
      generation: 0,
      releaseSequence: 3,
    });
    const row = await r.db
      .prepare(
        "SELECT active_lease_id,claimed_release_sequence,next_release_sequence FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
      )
      .bind(scope.organizationId, scope.environmentId)
      .first();
    expect(row).toEqual({
      active_lease_id: unknown.leaseId,
      claimed_release_sequence: 3,
      next_release_sequence: 4,
    });
    const race = await gatewayFixture(control),
      fenced = {
        directory: control.core,
        router: coreRouter(control, {
          CONTROL_SHARD_0000: beforeFirstWrite(control.core, () => freezeOwnership(race.project)),
        }),
      };
    await expect(
      claimDelivery(fenced, {
        ...input,
        ...race.scope,
        operationId: race.accepted.operationId,
        leaseId: id(),
      }),
    ).rejects.toHaveProperty("name", "RuntimeSecretDeliveryScopeError");
    expect(
      await r.db
        .prepare(
          "SELECT active_lease_id FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
        )
        .bind(race.scope.organizationId, race.scope.environmentId)
        .first(),
    ).toEqual({ active_lease_id: null });
  } finally {
    await control.dispose();
  }
}, 240000);

it("defers a reconcile while the staging deployment's operation is live and takes the expired lease over only after that operation ends", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const d1 = createD1RuntimeSecretPersistence(r.store.runtimeSecrets),
      scope = nativeScope(r.scope),
      operationId = parseUlid(r.accepted.operationId),
      deploy = {
        ...scope,
        operationId,
        trigger: "deploy" as const,
        runtimeProvider: "wfp" as const,
        leaseId: id(),
        claimedAt: "2026-10-29T00:00:00.000Z",
        leaseMilliseconds: 120000,
      };
    expect(await d1.claim(deploy)).toMatchObject({ outcome: "claimed", leaseId: deploy.leaseId });
    // The staging step is slow: the lease expires at 00:02:00 before the stage row and activation exist.
    expect(
      await d1.stageWfp({
        ...scope,
        stageReceiptId: id(),
        operationId,
        productDeploymentId: parseUlid(r.deploymentId),
        candidateReceiptId: parseUlid(r.candidateReceiptId),
        leaseId: deploy.leaseId,
        generation: 0,
        releaseSequence: 1,
        trigger: "deploy" as const,
        providerTag: r.providerTag,
        appliedSecretNames: [],
        manifestSha256: new Uint8Array(32).fill(3),
        manifestSecretCount: 0,
        stagedAt: "2026-10-29T00:00:30.000Z",
      }),
    ).toMatchObject({ outcome: "staged" });
    // A head exists, so the one-minute reconcile cron has work to do once the lease lapses.
    await r.db
      .prepare(
        "UPDATE runtime_secret_delivery_states SET provider_tag=?1 WHERE organization_id=?2 AND environment_id=?3",
      )
      .bind(r.providerTag, scope.organizationId, scope.environmentId)
      .run();
    const reconcile = {
      ...scope,
      trigger: "reconcile" as const,
      runtimeProvider: "wfp" as const,
      leaseId: id(),
      claimedAt: "2026-10-29T00:03:00.000Z",
      leaseMilliseconds: 120000,
    };
    // The owning operation is still running: the expired lease is not taken over.
    expect(await d1.claim(reconcile)).toEqual({
      outcome: "busy",
      generation: 0,
      releaseSequence: 1,
      retryAt: "2026-10-29T00:02:00.000Z",
    });
    const active = await r.db
      .prepare(
        "SELECT active_lease_id FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
      )
      .bind(scope.organizationId, scope.environmentId)
      .first();
    expect(active).toEqual({ active_lease_id: deploy.leaseId });
    // Operation lease recovery moves the crashed deployment to a terminal state; the cron then takes over.
    await r.db
      .prepare("UPDATE operations SET state='failed' WHERE organization_id=?1 AND operation_id=?2")
      .bind(r.scope.organizationId, operationId)
      .run();
    expect(await d1.claim({ ...reconcile, leaseId: id() })).toMatchObject({
      outcome: "claimed",
      trigger: "reconcile",
      releaseSequence: 2,
    });
  } finally {
    await control.dispose();
  }
});

it("delivers the AI key only for the pinned promotion or rollback plan, and the active reconcile plan", async () => {
  const control = await createTestControl();
  try {
    for (const trigger of ["promotion", "rollback", "reconcile"] as const) {
      for (const enabled of [false, true]) {
        const project = await seedProject(control, {
          handle: `claim-ai-${newUlid().toLowerCase()}`,
        });
        const sourceEnvironmentId =
          trigger === "promotion" ? project.devEnvironmentId : project.prodEnvironmentId;
        const frameworkPlan = {
          ...sourceFrameworkPlan(false),
          ...(enabled ? { ai: { enabled: true, jurisdiction: "eu" } } : {}),
        };
        const { published } = await seedPublishedClaim(
          project,
          sourceEnvironmentId,
          (operationId) =>
            seedWfpPublication(project, {
              operationId,
              environmentId: sourceEnvironmentId,
              frameworkPlan,
            }),
        );
        await releaseProviderClaim(project);
        // The current head deliberately disagrees with the revision pinned by the promotion/rollback.
        if (trigger !== "reconcile") {
          const opposite = {
            ...sourceFrameworkPlan(false),
            ...(!enabled ? { ai: { enabled: true, jurisdiction: "any" } } : {}),
          };
          if (trigger === "promotion") {
            await seedPublishedClaim(project, project.prodEnvironmentId, (operationId) =>
              seedWfpPublication(project, {
                operationId,
                environmentId: project.prodEnvironmentId,
                frameworkPlan: opposite,
              }),
            );
            await releaseProviderClaim(project);
          } else {
            const planId = newUlid(),
              deploymentId = newUlid(),
              revisionId = newUlid(),
              operationId = await seedOperation(project);
            await seedDeploymentPlan(project, planId, opposite, project.prodEnvironmentId);
            await control.core.batch([
              control.core.prepare("PRAGMA defer_foreign_keys=ON"),
              control.core
                .prepare(
                  "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_revision_id,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','succeeded',?6,1,?7,?7)",
                )
                .bind(
                  project.organizationId,
                  deploymentId,
                  project.projectId,
                  project.prodEnvironmentId,
                  operationId,
                  revisionId,
                  STORED_NOW,
                ),
              control.core
                .prepare(
                  "INSERT INTO deployment_revisions(organization_id,revision_id,project_id,deployment_id,plan_id,build_execution_id,artifact_id,wfp_receipt_id,operation_id,created_at) SELECT organization_id,?2,project_id,?3,?4,build_execution_id,artifact_id,wfp_receipt_id,?5,created_at FROM deployment_revisions WHERE organization_id=?1 AND revision_id=?6",
                )
                .bind(
                  project.organizationId,
                  revisionId,
                  deploymentId,
                  planId,
                  operationId,
                  published.revisionId,
                ),
              control.core
                .prepare(
                  "UPDATE environments SET active_deployment_id=?3,active_revision_id=?4,head_version=head_version+1 WHERE organization_id=?1 AND environment_id=?2",
                )
                .bind(project.organizationId, project.prodEnvironmentId, deploymentId, revisionId),
            ]);
          }
        }
        const accepted =
          trigger === "reconcile"
            ? null
            : await seedAcceptedOperation(project, project.prodEnvironmentId, {
                eventType:
                  trigger === "promotion"
                    ? "DeploymentPromotionRequestedV1"
                    : "DeploymentRollbackRequestedV1",
                intent: (operationId) =>
                  trigger === "promotion"
                    ? promotionIntent(project, operationId, project.prodEnvironmentId, {
                        ...published,
                        environmentId: sourceEnvironmentId,
                      })
                    : rollbackIntent(project, operationId, project.prodEnvironmentId, published),
              });
        for (const name of ["API_TOKEN", "OHMYHOST_AI_KEY", "OHMYHOST_MAIL_KEY"]) {
          await control.core
            .prepare(
              "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
            )
            .bind(
              project.organizationId,
              project.projectId,
              project.prodEnvironmentId,
              name,
              bytes(24, 1),
              bytes(12, 2),
              bytes(32, 3),
              STORED_NOW,
            )
            .run();
        }
        if (trigger === "reconcile") {
          await control.core
            .prepare(
              "UPDATE runtime_secret_delivery_states SET provider_tag='exact-fixture-tag',applied_manifest_sha256=zeroblob(32) WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND ?4 IS NOT NULL",
            )
            .bind(project.organizationId, project.projectId, project.prodEnvironmentId, STORED_NOW)
            .run();
        }
        const result = await claimDelivery(
          { directory: control.core, router: coreRouter(control) },
          {
            organizationId: project.organizationId,
            projectId: project.projectId,
            environmentId: project.prodEnvironmentId,
            trigger,
            runtimeProvider: "wfp",
            leaseId: newUlid(),
            claimedAt: "2026-10-29T00:00:00.000Z",
            leaseMilliseconds: 120000,
            ...(accepted === null ? { force: true } : { operationId: accepted.operationId }),
          },
        );
        expect(result.outcome, `${trigger}/${enabled}`).toBe("claimed");
        expect(
          result.outcome === "claimed" ? result.secrets.map((secret) => secret.name) : [],
        ).toEqual(enabled ? ["API_TOKEN", "OHMYHOST_AI_KEY"] : ["API_TOKEN"]);
      }
    }
  } finally {
    await control.dispose();
  }
}, 240000);
