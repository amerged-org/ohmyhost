import { afterAll, beforeAll, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../src/store.js";
import { createD1RuntimeSecretPersistence } from "../../../runtime-secret-delivery/src/d1-persistence.js";
import {
  readProductDataEnvironment,
  recordAbandonedGatewayPredecessor,
  recordProductDeploymentCandidate,
  resolveProductRollbackCandidate,
} from "../../src/catalog/provisioning/deployment-candidate.js";
import { resourceHash } from "../../src/catalog/provisioning/context-values.js";
import { activeReceipt } from "../../src/catalog/provisioning/context-values.js";
import { RECEIPT } from "../../src/catalog/provisioning/context-queries.js";
import { prepareProductCandidateCleanup } from "../../src/catalog/provisioning/deployment-cleanup.js";
import { readLifecycleDeletionEvidence } from "../../src/catalog/provisioning/lifecycle-inventory.js";
import { readProductProviderReconciliationContext } from "../../src/catalog/provisioning/provider-reconciliation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  deploymentIntent,
  seedAcceptedOperation,
  seedPublishedClaim,
  seedIntent,
  seedOperation,
} from "../support/accepted-operation.js";
import { losingWriteResponses, seedProject, STORED_NOW } from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { contextGatewayFixture } from "./context-gateway.fixture.js";
import { createContextRpcControl } from "./context-rpc.fixture.js";
import {
  candidateRecord,
  claimedWorkflow,
  deploymentContext as context,
} from "../support/deployment-commands-fixture.js";
import { workflowFixture } from "./workflow-fixture.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const count = async (table: string, key: string, value: string) =>
  (
    await control.core
      .prepare(`SELECT count(*) n FROM ${table} WHERE ${key}=?`)
      .bind(value)
      .first<{ n: number }>()
  )?.n;

it("retains the optional binding digest across candidate persistence and workflow RPC", async () => {
  const rpc = await createContextRpcControl();
  try {
    const r = await claimedWorkflow(rpc);
    const base = candidateRecord(r);
    const bindingSetDigest = new Uint8Array(32).fill(0x42);
    const input = {
      ...base,
      candidate: { ...base.candidate, bindingSetDigest },
      deploymentEvidence: {
        ...base.deploymentEvidence,
        artifact: {
          ...base.deploymentEvidence.artifact,
          outputVersionRef: `r2-version:ohmyho-builds-development/runs/${r.input.projectId}/${r.input.environmentId}/${r.input.operationId}/output/bundle.tar.gz#${"a".repeat(32)}`,
        },
      },
    };
    expect(await recordProductDeploymentCandidate(context(rpc.core), input)).toBe("created");
    expect(await recordProductDeploymentCandidate(context(rpc.core), input)).toBe("existing");
    const row = await rpc.core
      .prepare("SELECT binding_set_digest FROM wfp_candidate_receipts WHERE candidate_receipt_id=?")
      .bind(input.candidate.candidateReceiptId)
      .first<{ binding_set_digest: number[] }>();
    expect(Array.from(row?.binding_set_digest ?? [])).toEqual(Array(32).fill(0x42));
    const scope = {
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
    };
    const workflow = await rpc.read(scope);
    expect(workflow?.knownDeployments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productDeploymentId: r.deployment,
          bindingSetDigest: `sha256:${"42".repeat(32)}`,
        }),
      ]),
    );
    await rpc.core.batch([
      rpc.core
        .prepare(
          "UPDATE deployments SET status='reconciliation_required' WHERE organization_id=?1 AND operation_id=?2",
        )
        .bind(scope.organizationId, scope.operationId),
      rpc.core
        .prepare(
          "UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PROVIDER_OBSERVATION_UNCERTAIN',intermediate_evidence=?2 WHERE workflow_id=?1",
        )
        .bind(
          r.input.logicalWorkflowId,
          JSON.stringify({ providerReconciliationHint: { phase: "wfp" } }),
        ),
    ]);
    const reconciliation = await readProductProviderReconciliationContext(context(rpc.core), {
      ...scope,
      claimId: r.input.claimId,
    });
    expect(reconciliation?.wfpTarget?.candidate.bindingSetDigest).toBe(`sha256:${"42".repeat(32)}`);
    await expect(
      recordProductDeploymentCandidate(context(rpc.core), {
        ...input,
        candidate: { ...input.candidate, bindingSetDigest: new Uint8Array(32).fill(0x43) },
      }),
    ).rejects.toThrow("WFP candidate receipt identity changed");
    for (const invalid of [undefined, null, new Uint8Array(31)]) {
      await expect(
        recordProductDeploymentCandidate(context(rpc.core), {
          ...input,
          candidate: { ...input.candidate, bindingSetDigest: invalid },
        }),
      ).rejects.toThrow();
    }
    const { bindingSetDigest: _digest, ...withoutBindingDigest } = input.candidate;
    void _digest;
    const inheritedCandidate = Object.assign(
      Object.create({ bindingSetDigest }),
      withoutBindingDigest,
    );
    await expect(
      recordProductDeploymentCandidate(context(rpc.core), {
        ...input,
        candidate: inheritedCandidate,
      }),
    ).rejects.toThrow();
    await expect(
      rpc.core
        .prepare(
          "UPDATE wfp_candidate_receipts SET binding_set_digest=? WHERE candidate_receipt_id=?",
        )
        .bind(new Uint8Array(32).fill(1), input.candidate.candidateReceiptId)
        .run(),
    ).rejects.toThrow();
    await expect(
      rpc.core
        .prepare(
          `INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,binding_set_digest)
        SELECT ?1,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,?2 FROM wfp_candidate_receipts WHERE candidate_receipt_id=?3`,
        )
        .bind(newUlid(), new Uint8Array(31), input.candidate.candidateReceiptId)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      rpc.core
        .prepare(
          `INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,binding_set_digest)
        SELECT ?1,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at,?2 FROM wfp_candidate_receipts WHERE candidate_receipt_id=?3`,
        )
        .bind(newUlid(), "a".repeat(32), input.candidate.candidateReceiptId)
        .run(),
    ).rejects.toThrow(/cannot store TEXT value in BLOB column/iu);
    const cleanup = {
      cleanupRequestId: newUlid(),
      candidate: input.candidate,
      reason: "failed" as const,
      requestedAt: "2026-10-28T12:00:00.000Z",
      claimId: newUlid(),
      leaseExpiresAt: "2026-10-28T12:05:00.000Z",
    };
    await expect(
      prepareProductCandidateCleanup(context(rpc.core), {
        ...cleanup,
        candidate: inheritedCandidate,
      }),
    ).rejects.toThrow();
    for (const invalid of [undefined, null, new Uint8Array(31)]) {
      await expect(
        prepareProductCandidateCleanup(context(rpc.core), {
          ...cleanup,
          candidate: { ...cleanup.candidate, bindingSetDigest: invalid },
        }),
      ).rejects.toThrow();
    }
    await expect(
      prepareProductCandidateCleanup(context(rpc.core), {
        ...cleanup,
        candidate: { ...cleanup.candidate, bindingSetDigest: new Uint8Array(32).fill(0x43) },
      }),
    ).rejects.toThrow();
    expect(await prepareProductCandidateCleanup(context(rpc.core), cleanup)).toMatchObject({
      candidate: { bindingSetDigest },
    });

    const old = await claimedWorkflow(rpc);
    const oldBase = candidateRecord(old);
    const legacy = {
      ...oldBase,
      deploymentEvidence: {
        ...oldBase.deploymentEvidence,
        artifact: {
          ...oldBase.deploymentEvidence.artifact,
          outputVersionRef: `r2-version:ohmyho-builds-development/runs/${old.input.projectId}/${old.input.environmentId}/${old.input.operationId}/output/bundle.tar.gz#${"a".repeat(32)}`,
        },
      },
    };
    expect(await recordProductDeploymentCandidate(context(rpc.core), legacy)).toBe("created");
    const oldContext = await rpc.read({
      organizationId: old.input.organizationId,
      projectId: old.input.projectId,
      environmentId: old.input.environmentId,
      operationId: old.input.operationId,
    });
    const oldReceipt = oldContext?.knownDeployments.find(
      (v) => v.productDeploymentId === old.deployment,
    );
    expect(oldReceipt).toBeDefined();
    expect(oldReceipt).not.toHaveProperty("bindingSetDigest");
    const oldDeletion = await readLifecycleDeletionEvidence(context(rpc.core), {
      organizationId: old.input.organizationId,
      projectId: old.input.projectId,
    });
    expect(oldDeletion.candidates[0]).not.toHaveProperty("bindingSetDigest");
    expect(await rpc.read({ ...scope, organizationId: old.input.organizationId })).toBeNull();

    const project = await seedProject(rpc);
    const environmentId = project.prodEnvironmentId;
    const { claim, published } = await seedPublishedClaim(project, environmentId, (operationId) =>
      seedWfpPublication(project, { operationId, environmentId, bindingSetDigest }),
    );
    const publishedScope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
      environmentId: parseUlid(environmentId),
    };
    const deletion = await readLifecycleDeletionEvidence(context(rpc.core), {
      organizationId: publishedScope.organizationId,
      projectId: publishedScope.projectId,
    });
    expect(
      deletion.candidates.find(
        (value) => value.candidateReceiptId === published.candidateReceiptId,
      ),
    ).toMatchObject({ bindingSetDigest });
    const rollback = await resolveProductRollbackCandidate(context(rpc.core), {
      ...publishedScope,
      targetDeploymentId: published.deploymentId,
      targetRevisionId: published.revisionId,
    });
    expect(rollback?.candidate.bindingSetDigest).toEqual(bindingSetDigest);
    const publishedRow = await rpc.core
      .prepare(RECEIPT)
      .bind(
        project.organizationId,
        project.projectId,
        environmentId,
        published.deploymentId,
        published.revisionId,
      )
      .first();
    expect(
      await activeReceipt(publishedRow ?? undefined, {
        projectId: project.projectId,
        environmentId,
        deploymentId: published.deploymentId,
        handle: project.handle,
        environmentName: "prod",
      }),
    ).toMatchObject({ wfp: { bindingSetDigest: `sha256:${"42".repeat(32)}` } });

    const store = createControlStore(rpc.bindings);
    const d1 = createD1RuntimeSecretPersistence(store.runtimeSecrets);
    const at = new Date().toISOString();
    const secretClaim = {
      ...publishedScope,
      operationId: parseUlid(claim.operationId),
      leaseId: parseUlid(newUlid()),
      trigger: "deploy" as const,
      runtimeProvider: "wfp" as const,
      claimedAt: at,
      leaseMilliseconds: 120000,
    };
    expect(await d1.claim(secretClaim)).toMatchObject({
      outcome: "claimed",
      generation: 0,
      releaseSequence: 1,
    });
    const stage = {
      ...publishedScope,
      stageReceiptId: parseUlid(newUlid()),
      operationId: secretClaim.operationId,
      productDeploymentId: parseUlid(published.deploymentId),
      candidateReceiptId: parseUlid(published.candidateReceiptId),
      leaseId: secretClaim.leaseId,
      generation: 0,
      releaseSequence: 1,
      trigger: "deploy" as const,
      providerTag: "exact-fixture-tag",
      appliedSecretNames: [],
      manifestSha256: new Uint8Array(32).fill(3),
      manifestSecretCount: 0,
      stagedAt: at,
    };
    expect(await d1.stageWfp?.(stage)).toMatchObject({ outcome: "staged" });
    const gateway = await store.gateway.management.observe(publishedScope);
    if (!gateway) throw new Error("missing published fixture gateway");
    expect(
      await d1.activateWfp?.({
        ...publishedScope,
        activationReceiptId: parseUlid(newUlid()),
        stageReceiptId: stage.stageReceiptId,
        operationId: stage.operationId,
        productDeploymentId: stage.productDeploymentId,
        candidateReceiptId: stage.candidateReceiptId,
        candidateScriptName: gateway.targetScriptName,
        candidateProviderTag: stage.providerTag,
        candidateArtifactDigest: new Uint8Array(32).fill(3),
        gateway,
        activatedAt: at,
      }),
    ).toMatchObject({ outcome: "activated" });
    expect(await d1.readActiveWfpTarget?.(publishedScope)).toMatchObject({
      deployment: { bindingSetDigest: `sha256:${"42".repeat(32)}` },
    });
    await d1.installPlatform?.({
      ...publishedScope,
      operationId: secretClaim.operationId,
      claimId: parseUlid(claim.claimId),
      name: "DATABASE_URL",
      ciphertext: new Uint8Array(24).fill(4),
      nonce: new Uint8Array(12).fill(5),
      valueSha256: new Uint8Array(32).fill(6),
      keyVersion: 1,
      writtenAt: at,
    });
    const pending = await d1.readPending({
      now: new Date(Date.now() + 1000).toISOString(),
      limit: 10,
    });
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ...publishedScope,
          activeCandidate: expect.objectContaining({ bindingSetDigest }),
        }),
      ]),
    );
  } finally {
    await rpc.dispose();
  }
}, 60_000);

it("records the source custody, Build evidence and candidate as one effect, replays it and refuses changed identities", async () => {
  const r = await claimedWorkflow(control),
    input = candidateRecord(r),
    id = input.candidate.candidateReceiptId;
  expect(await recordProductDeploymentCandidate(context(control.core), input)).toBe("created");
  expect(await recordProductDeploymentCandidate(context(control.core), input)).toBe("existing");
  // A late rollback or promotion candidate carries no evidence: the same receipt is an exact replay.
  expect(
    await recordProductDeploymentCandidate(context(control.core), {
      ...input,
      deploymentEvidence: null,
    }),
  ).toBe("existing");
  expect(
    await control.core
      .prepare(
        "SELECT operation_id,product_deployment_id,artifact_id,lower(hex(artifact_sha256)) digest,provider_tag,build_reused FROM wfp_candidate_receipts WHERE candidate_receipt_id=?",
      )
      .bind(id)
      .first(),
  ).toEqual({
    operation_id: r.input.operationId,
    product_deployment_id: r.deployment,
    artifact_id: input.candidate.artifactId,
    digest: "05".repeat(32),
    provider_tag: "a".repeat(32),
    build_reused: 0,
  });
  expect(
    await control.core
      .prepare(
        "SELECT state,source_upload_id,provider_build_id FROM build_executions WHERE build_execution_id=?",
      )
      .bind(input.deploymentEvidence.buildExecutionId)
      .first(),
  ).toEqual({
    state: "succeeded",
    source_upload_id: input.deploymentEvidence.uploadId,
    provider_build_id: "build-1",
  });
  expect(await count("build_artifacts", "artifact_id", input.candidate.artifactId)).toBe(1);
  expect(await count("source_archives", "operation_id", r.input.operationId)).toBe(1);
  expect(await count("product_source_archive_objects", "operation_id", r.input.operationId)).toBe(
    1,
  );
  expect(await count("build_source_uploads", "upload_id", input.deploymentEvidence.uploadId)).toBe(
    1,
  );

  await expect(
    recordProductDeploymentCandidate(context(control.core), {
      ...input,
      candidate: { ...input.candidate, providerTag: "b".repeat(32) },
    }),
  ).rejects.toThrow("WFP candidate receipt identity changed");
  await expect(
    recordProductDeploymentCandidate(context(control.core), {
      ...input,
      deploymentEvidence: {
        ...input.deploymentEvidence,
        build: { buildId: "build-2", projectName: "fixture-build" },
      },
    }),
  ).rejects.toThrow("Product deployment evidence changed");
  await expect(
    recordProductDeploymentCandidate(context(control.core), {
      ...input,
      deploymentEvidence: { ...input.deploymentEvidence, environmentId: newUlid() },
    }),
  ).rejects.toThrow("Candidate and deployment evidence scope changed");
  await expect(
    recordProductDeploymentCandidate(context(control.core), {
      ...input,
      eventType: "DeploymentPromotionRequestedV1",
    }),
  ).rejects.toThrow("Candidate and deployment evidence scope changed");

  // Without the provider mutation claim nothing of the effect persists.
  const unclaimed = await workflowFixture(control),
    refused = candidateRecord(unclaimed);
  await expect(recordProductDeploymentCandidate(context(control.core), refused)).rejects.toThrow(
    "guard_scope_inactive",
  );
  expect(
    await count(
      "wfp_candidate_receipts",
      "candidate_receipt_id",
      refused.candidate.candidateReceiptId,
    ),
  ).toBe(0);
  expect(await count("source_archives", "operation_id", unclaimed.input.operationId)).toBe(0);
}, 60_000);

it("adopts the source upload the Build already wrote and refuses an upload of another archive", async () => {
  const upload = (r: Awaited<ReturnType<typeof claimedWorkflow>>, bucket: string) => {
    const input = candidateRecord(r),
      e = input.deploymentEvidence;
    return {
      input,
      insert: control.core
        .prepare(
          "INSERT INTO build_source_uploads(upload_id,organization_id,project_id,operation_id,source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,claimed_at,lease_expires_at,attempt_number,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'completed',?10,?11,?12,1,?11,?11)",
        )
        .bind(
          e.uploadId,
          e.organizationId,
          e.projectId,
          e.operationId,
          e.sourceConnectionId,
          e.commitSha,
          bucket,
          e.archive.key,
          e.archive.versionId,
          e.uploadClaimId,
          STORED_NOW,
          "2026-10-28T10:00:01.000000Z",
        ),
    };
  };
  const adopted = upload(await claimedWorkflow(control), "synthetic-source");
  await adopted.insert.run();
  expect(await recordProductDeploymentCandidate(context(control.core), adopted.input)).toBe(
    "created",
  );
  expect(
    await count("build_source_uploads", "operation_id", adopted.input.candidate.operationId),
  ).toBe(1);
  expect(
    await count("build_executions", "source_upload_id", adopted.input.deploymentEvidence.uploadId),
  ).toBe(1);
  const foreign = upload(await claimedWorkflow(control), "another-bucket");
  await foreign.insert.run();
  await expect(
    recordProductDeploymentCandidate(context(control.core), foreign.input),
  ).rejects.toThrow("Source archive evidence changed");
  expect(
    await count("build_executions", "source_upload_id", foreign.input.deploymentEvidence.uploadId),
  ).toBe(0);
}, 60_000);

it("answers a committed candidate whose response was lost by reading it back", async () => {
  const r = await claimedWorkflow(control),
    input = candidateRecord(r);
  expect(
    await recordProductDeploymentCandidate(context(losingWriteResponses(control.core, 1)), input),
  ).toBe("existing");
  expect(
    await count(
      "wfp_candidate_receipts",
      "candidate_receipt_id",
      input.candidate.candidateReceiptId,
    ),
  ).toBe(1);
  expect(await count("build_executions", "operation_id", r.input.operationId)).toBe(1);
}, 60_000);

it("reads the current data environment of an environment and nothing for a foreign one", async () => {
  const r = await workflowFixture(control),
    scope = {
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      environmentId: r.input.environmentId,
    };
  expect(await readProductDataEnvironment(context(control.core), scope)).toBe(
    r.p.developmentDataEnvironmentId,
  );
  expect(
    await readProductDataEnvironment(context(control.core), {
      ...scope,
      environmentId: newUlid(),
    }),
  ).toBeNull();
});

it("resolves the exact published rollback target and refuses a target whose script a refresh already removed", async () => {
  const r = await gatewayFixture(control),
    scope = {
      ...r.scope,
      targetDeploymentId: r.published.deploymentId,
      targetRevisionId: r.published.revisionId,
    };
  const resolved = await resolveProductRollbackCandidate(context(control.core), scope);
  expect(resolved).toMatchObject({
    targetDeploymentId: r.published.deploymentId,
    targetRevisionId: r.published.revisionId,
    wfpReceiptId: r.published.wfpReceiptId,
    deploymentUrl: `https://${r.project.handle}.check.omh.st`,
    gateway: {
      revision: 1,
      active: true,
      targetDeploymentId: r.published.deploymentId,
      candidateReceiptId: r.published.candidateReceiptId,
    },
    candidate: {
      candidateReceiptId: r.published.candidateReceiptId,
      productDeploymentId: r.published.deploymentId,
      artifactId: r.published.artifactId,
      namespace: "ohmyho-production",
      providerTag: "exact-fixture-tag",
      buildReused: false,
    },
  });
  expect(Array.from(resolved?.candidate.artifactDigest ?? [])).toEqual(Array(32).fill(3));
  expect(
    await resolveProductRollbackCandidate(context(control.core), {
      ...scope,
      targetRevisionId: newUlid(),
    }),
  ).toBeNull();

  // A later binding refresh that proved the retained script absent retires the target for rollback.
  const operationId = await seedOperation(r.project),
    intent = await deploymentIntent(r.project, operationId, r.scope.environmentId, {
      refresh: true,
    }),
    snapshot = {
      ...JSON.parse(intent.binding_refresh_snapshot ?? "{}"),
      sourceCandidateReceiptId: r.published.candidateReceiptId,
    },
    locator = `ohmyho-production/p-${r.project.projectId.toLowerCase()}-prod-${r.published.deploymentId.toLowerCase()}`,
    hash = await resourceHash("cloudflare", "wfp-script", locator);
  await seedIntent(r.project, r.scope.environmentId, operationId, "DeploymentRequestedV1", {
    ...intent,
    binding_refresh_snapshot: JSON.stringify(snapshot),
  });
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),?6,'encoded/c3ludGhldGlj')",
      )
      .bind(r.scope.organizationId, newUlid(), r.scope.projectId, operationId, hash, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'removed',?6)",
      )
      .bind(newUlid(), r.scope.organizationId, r.scope.projectId, operationId, hash, STORED_NOW),
  ]);
  expect(await resolveProductRollbackCandidate(context(control.core), scope)).toBeNull();
}, 60_000);

it("refuses a rollback target whose script a data change removed, whatever intent recorded the removal", async () => {
  const r = await gatewayFixture(control),
    scope = {
      ...r.scope,
      targetDeploymentId: r.published.deploymentId,
      targetRevisionId: r.published.revisionId,
    };
  expect(await resolveProductRollbackCandidate(context(control.core), scope)).not.toBeNull();
  // A Dev reset removes the script under its own data-change operation: no binding refresh snapshot names the candidate.
  const change = await seedAcceptedOperation(r.project, r.scope.environmentId, {
    claim: false,
    eventType: "ProjectDataChangeRequestedV1",
  });
  const locator = `ohmyho-production/p-${r.project.projectId.toLowerCase()}-prod-${r.published.deploymentId.toLowerCase()}`,
    hash = await resourceHash("cloudflare", "wfp-script", locator);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),?6,'encoded/c3ludGhldGlj')",
      )
      .bind(
        r.scope.organizationId,
        newUlid(),
        r.scope.projectId,
        change.operationId,
        hash,
        STORED_NOW,
      ),
    control.core
      .prepare(
        "INSERT INTO run_cleanup_attempts(cleanup_attempt_id,organization_id,project_id,operation_id,provider,resource_kind,external_ref_hash,outcome,attempted_at) VALUES(?1,?2,?3,?4,'cloudflare','wfp-script',unhex(?5),'removed',?6)",
      )
      .bind(
        newUlid(),
        r.scope.organizationId,
        r.scope.projectId,
        change.operationId,
        hash,
        STORED_NOW,
      ),
  ]);
  expect(await resolveProductRollbackCandidate(context(control.core), scope)).toBeNull();
}, 60_000);

it("records the abandoned predecessor of the current deployment once and refuses a changed scope or audit", async () => {
  const r = await contextGatewayFixture(control, { publishedEnvironment: "dev" }),
    { project } = r,
    abandoned = r.accepted.operationId;
  await control.core.batch([
    control.core
      .prepare(
        "UPDATE operations SET state='failed',failure=? WHERE organization_id=? AND operation_id=?",
      )
      .bind(
        JSON.stringify({ code: "OPERATION_ABANDONED", message: "abandoned" }),
        project.organizationId,
        abandoned,
      ),
    control.core
      .prepare("UPDATE deployments SET status='failed' WHERE organization_id=? AND operation_id=?")
      .bind(project.organizationId, abandoned),
    control.core
      .prepare(
        "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{}',completed_at=?3 WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(project.organizationId, abandoned, STORED_NOW),
    control.core
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId),
  ]);
  const retry = await seedAcceptedOperation(project, project.prodEnvironmentId),
    input = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
      operationId: retry.operationId,
      candidateReceiptId: r.candidateReceiptId,
      sharedGatewayRevision: 1,
      auditEventId: newUlid(),
      observedAt: "2026-10-28T12:00:00.000Z",
    };
  expect(await recordAbandonedGatewayPredecessor(context(control.core), input)).toBe("created");
  expect(await recordAbandonedGatewayPredecessor(context(control.core), input)).toBe("existing");
  const audit = await control.core
    .prepare(
      "SELECT event_type,actor_type,actor_id,operation_id,payload FROM audit_events WHERE audit_event_id=?",
    )
    .bind(input.auditEventId)
    .first<Record<string, string>>();
  expect(audit).toMatchObject({
    event_type: "AbandonedGatewayPredecessorVerified",
    actor_type: "service",
    actor_id: "deployment-workflow",
    operation_id: retry.operationId,
  });
  expect(JSON.parse(audit?.["payload"] ?? "{}")).toEqual({
    environmentId: project.prodEnvironmentId,
    predecessorOperationId: abandoned,
    candidateReceiptId: r.candidateReceiptId,
    targetDeploymentId: r.deploymentId,
    sharedGatewayRevision: 1,
  });
  await expect(
    recordAbandonedGatewayPredecessor(context(control.core), {
      ...input,
      sharedGatewayRevision: 2,
    }),
  ).rejects.toThrow("Abandoned gateway predecessor audit changed");
  await expect(
    recordAbandonedGatewayPredecessor(context(control.core), {
      ...input,
      candidateReceiptId: newUlid(),
      auditEventId: newUlid(),
    }),
  ).rejects.toThrow("Abandoned gateway predecessor scope changed");
}, 60_000);
