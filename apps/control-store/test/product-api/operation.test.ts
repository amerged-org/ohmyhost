import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { projectInput, seedOrganization, type Store } from "../support/seed.js";

let control: TestControl;
let store: Store;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
});
afterAll(async () => control.dispose());

describe("productApi.readApiProductOperation", () => {
  it("reads one operation with its ordered history in a single snapshot and refuses another organization", async () => {
    const organizationId = await seedOrganization(store, 2, 0);
    const input = projectInput(organizationId, "operation-read");
    await store.projects.createInitialProject(input);
    const read = await store.productApi.readApiProductOperation({
      organizationId,
      operationId: input.operation.operationId,
    });
    expect(read).toMatchObject({
      operation: {
        organizationId,
        operationId: input.operation.operationId,
        projectId: input.projectId,
        state: "queued",
        failure: null,
        events: [{ type: "OperationQueued", revision: 0 }],
      },
      deploymentId: null,
      blockingOperationId: null,
      reconciliation: null,
      deploymentObservation: null,
    });
    const other = await seedOrganization(store, 2, 0);
    expect(
      await store.productApi.readApiProductOperation({
        organizationId: other,
        operationId: input.operation.operationId,
      }),
    ).toBeNull();
  });
});
