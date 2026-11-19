import { expect, it } from "vitest";
import { createUlidFactory, parseUlid, SystemEntropy } from "@ohmyhost/platform";

import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { NOW, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import { createD1ProductOperationReader } from "../src/d1-product-operation.js";
import { createD1ControlApiPersistence } from "../src/d1-project-persistence.js";

const clock = { now: () => new Date(NOW) };
const ids = () => createUlidFactory({ clock, entropy: new SystemEntropy() });

it("reads a product operation that is neither recovery nor database work through the product reader", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      organizationId = await seedOrganization(store, 2, 0),
      project = projectInput(organizationId, "operation-read");
    await store.projects.createInitialProject(project);
    const operationId = project.operation.operationId,
      persistence = createD1ControlApiPersistence({
        platform: "production",
        runtime: {
          readProjectRecoveryOperation: store.recovery.owner.readOperation,
          readProjectDatabaseOperation: store.productDatabase.readOperation,
        } as never,
        clock,
        ids: ids(),
        extras: { getOperation: createD1ProductOperationReader(store.productApi) },
      });

    // A project create is a product operation: the recovery and database readers both say "not theirs".
    expect(
      await persistence.getOperation(parseUlid(organizationId), parseUlid(operationId)),
    ).toMatchObject({ state: "queued" });

    // Another organization never sees this operation, even though the id exists.
    const foreign = await seedOrganization(store, 2, 1);
    expect(await persistence.getOperation(parseUlid(foreign), parseUlid(operationId))).toBeNull();

    // An unknown id is still reported as absent.
    expect(
      await persistence.getOperation(parseUlid(organizationId), parseUlid(ulidOf("unknown", 1))),
    ).toBeNull();
  } finally {
    await control.dispose();
  }
});

it("still reads a database compute operation through the database reader", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      f = await seedProductRuntimeFixture(control);
    await makePaid(control.core, f.organizationId);
    const operationId = ulidOf("compute-read", f.n);
    await store.productDatabase.acceptCompute({
      organizationId: f.organizationId,
      projectId: f.projectId,
      environmentId: f.devEnvironmentId,
      billingEpochId: f.billingEpochId,
      operationId,
      operationEventId: ulidOf("compute-read-queued", f.n),
      auditEventId: ulidOf("compute-read-audit", f.n),
      outboxEventId: ulidOf("compute-read-outbox", f.n),
      principalId: "user:fixture",
      requestId: "compute-read",
      idempotencyKey: `compute-read-${String(f.n)}`,
      canonicalRequestDigest: "cd".repeat(32),
      httpMethod: "POST",
      routeTemplate: "/v1/projects/{project_id}/database/compute",
      occurredAt: NOW,
      memoryMiB: 512,
      currentStorageMiB: 1024,
      expectedDatabaseId: f.database,
      expectedTargetVersion: 1,
      eventType: "ProjectDatabaseComputeChangeRequestedV1",
    });
    const persistence = createD1ControlApiPersistence({
      platform: "production",
      runtime: {
        readProjectRecoveryOperation: store.recovery.owner.readOperation,
        readProjectDatabaseOperation: store.productDatabase.readOperation,
      } as never,
      clock,
      ids: ids(),
      extras: { getOperation: createD1ProductOperationReader(store.productApi) },
    });

    expect(
      await persistence.getOperation(parseUlid(f.organizationId), parseUlid(operationId)),
    ).toMatchObject({ state: "queued" });
  } finally {
    await control.dispose();
  }
});
