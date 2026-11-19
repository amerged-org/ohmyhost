import { quoteBuildCost } from "@ohmyhost/platform";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { deploymentIntent, seedAcceptedOperation } from "../support/accepted-operation.js";
import { cid, fingerprint } from "../support/build-fixtures.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => {
  await control?.dispose();
});

it("holds one organization to a bounded number of open build reservations", async () => {
  const project = await seedProject(control);
  const store = createControlStore({ CONTROL_CORE: control.core });
  const claims = [];
  for (let index = 0; index < 5; index += 1) {
    // Several accepted operations of one organization: each is a separate build of that tenant.
    const operation = await seedAcceptedOperation(project, project.devEnvironmentId, {
      claim: false,
      intent: (operationId) =>
        deploymentIntent(project, operationId, project.devEnvironmentId, {
          costEstimate: quoteBuildCost("2026-10-28T10:00:00.000Z"),
        }),
    });
    claims.push({
      scope: {
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        operationId: operation.operationId,
      },
      inputFingerprint: fingerprint,
      claimId: cid(),
      leaseMilliseconds: 30_000,
    });
  }
  for (const claim of claims.slice(0, 4)) {
    await expect(store.build.claimBuildInput(claim)).resolves.toMatchObject({ status: "claimed" });
  }
  const fifth = claims[4];
  if (fifth === undefined) throw new Error("fixture seeds five operations");
  await expect(store.build.claimBuildInput(fifth)).rejects.toMatchObject({
    code: "build_capacity_reached",
  });
  // Completed builds release their capacity: an append-only reservation never blocks a tenant forever.
  for (const claim of claims.slice(0, 4)) {
    await control.core
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(project.organizationId, claim.scope.operationId)
      .run();
  }
  await expect(store.build.claimBuildInput(fifth)).resolves.toMatchObject({ status: "claimed" });
});
