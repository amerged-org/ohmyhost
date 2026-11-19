import type { D1Database } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import { claimProductProviderMutation } from "../../src/catalog/provisioning/provider-claim.js";
import { workflowFixture } from "../provisioning/workflow-fixture.js";

export type Workflow = Awaited<ReturnType<typeof workflowFixture>>;

export const deploymentContext = (db: D1Database) => ({
  nativeAuthLaunchPolicy: { mode: "password-general-availability" as const },
  directory: db,
  router: new SharedCoreRouter(db),
});

/** An accepted deployment Workflow that already holds the project's provider mutation claim. */
export async function claimedWorkflow(
  control: Parameters<typeof workflowFixture>[0],
  options: Parameters<typeof workflowFixture>[1] = {},
) {
  const r = await workflowFixture(control, options);
  expectCreated(await claimProductProviderMutation(deploymentContext(r.db), r.input));
  return r;
}

function expectCreated(outcome: string) {
  if (outcome !== "created") throw new Error(`fixture claim was ${outcome}`);
}

/** The Build evidence (source custody, upload, execution, artifact) and the candidate of the accepted deployment of `r`. */
export function candidateRecord(r: Workflow, ids = { artifactId: newUlid() }) {
  const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
  const environmentName = r.input.environmentId === r.p.developmentEnvironmentId ? "dev" : "prod";
  const scope = {
    organizationId: r.input.organizationId,
    projectId: r.input.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
  };
  return {
    eventType: "DeploymentRequestedV1" as const,
    candidate: {
      candidateReceiptId: newUlid(),
      ...scope,
      productDeploymentId: r.deployment,
      artifactId: ids.artifactId,
      namespace: "ohmyho-development",
      immutableScriptName: `p-${r.input.projectId.toLowerCase()}-${environmentName}-${r.deployment.toLowerCase()}`,
      artifactDigest: new Uint8Array(32).fill(5),
      providerTag: "a".repeat(32),
      buildReused: false,
      stagedAt: "2026-10-28T11:01:00.000Z",
    },
    deploymentEvidence: {
      ...scope,
      billingEpochId: r.p.billingEpochId,
      sourceConnectionId: r.source,
      externalRepositoryId: "42",
      commitSha: "a".repeat(40),
      sourceSha256: hex(3),
      archive: {
        bucket: "synthetic-source",
        key: "source.tar.gz",
        versionId: "retained-version",
        archiveId: `archive_${r.input.operationId}_${r.input.claimId}`,
        eTag: "retained-etag",
        byteLength: 123,
      },
      recordedAt: "2026-10-28T11:00:30.000Z",
      deploymentId: r.deployment,
      planId: r.plan,
      uploadId: newUlid(),
      uploadClaimId: newUlid(),
      buildExecutionId: newUlid(),
      artifactId: ids.artifactId,
      revisionId: newUlid(),
      buildPlanSha256: hex(3),
      build: { buildId: "build-1", projectName: "fixture-build" },
      artifact: {
        artifactDigest: hex(5),
        manifestDigest: hex(6),
        sbomDigest: hex(7),
        outputVersionRef: "exact-output",
      },
    },
  };
}
