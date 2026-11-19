import { quoteBuildCost } from "@ohmyhost/platform";
import type { D1Database } from "../../src/d1-types.js";
import { createControlStore } from "../../src/store.js";
import type { TestControl } from "./control-d1.js";
import { seedProject } from "./platform-fixtures.js";
import { deploymentIntent, seedProviderClaim } from "./accepted-operation.js";
import { reserveBuild } from "./credit-fixtures.js";
let sequence = 0;
export const cid = () => `90000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
export const fingerprint = `sha256:${"ab".repeat(32)}`;

export async function buildRig(control: TestControl, db: D1Database = control.core) {
  const project = await seedProject(control);
  // The accepted deployment of the build: its plan carries the quote the measured build is settled against.
  const operation = await seedProviderClaim(
    project,
    project.devEnvironmentId,
    "DeploymentRequestedV1",
    {
      intent: (operationId) =>
        deploymentIntent(project, operationId, project.devEnvironmentId, {
          costEstimate: quoteBuildCost("2026-10-28T10:00:00.000Z"),
        }),
    },
  );
  const scope = {
    projectId: project.projectId,
    environmentId: project.devEnvironmentId,
    operationId: operation.operationId,
  };
  const store = createControlStore({ CONTROL_CORE: db });
  const claim = { scope, inputFingerprint: fingerprint, claimId: cid(), leaseMilliseconds: 30_000 };
  const receipt = {
    scope,
    buildId: `sandbox:${operation.operationId}`,
    projectName: "test-builds",
  };
  const envelope = { receipt, inputFingerprint: fingerprint, claimId: claim.claimId };
  return { db, project, operation, scope, store, claim, receipt, envelope };
}

/** The accepted deployment's build reservation, which the Free month of the organization funds. */
export async function fundBuild(r: Awaited<ReturnType<typeof buildRig>>) {
  await reserveBuild(r.db, {
    organizationId: r.project.organizationId,
    projectId: r.project.projectId,
    operationId: r.scope.operationId,
    now: "2026-10-28T10:01:00.000Z",
  });
}
