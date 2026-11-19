import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import {
  createD1ProductOperationReader,
  productOperationView,
} from "../src/d1-product-operation.js";

it("reads one product operation with its immutable history from the Core and refuses any foreign scope", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      organizationId = await seedOrganization(store, 2, 0),
      project = projectInput(organizationId, "product-operation");
    await store.projects.createInitialProject(project);
    const operationId = project.operation.operationId,
      read = createD1ProductOperationReader(store.productApi) as (
        organization: never,
        operation: never,
      ) => Promise<{ state: string; failure?: unknown } | null>,
      transition = async (type: string, state: string, eventCount: number, failure?: object) => {
        const occurredAt = "2026-10-29T10:05:00.000Z";
        await store.operations.transitionOperation({
          organizationId,
          operationId,
          expected: { state, eventCount },
          event: {
            eventId: newUlid(),
            type,
            idempotencyKey: `${type}-${eventCount}`,
            occurredAt,
            ...(failure === undefined ? {} : { failure }),
          },
          audit: {
            auditEventId: newUlid(),
            projectId: project.projectId,
            operationId,
            eventType: type,
            actorType: "system",
            actorId: "workflow",
            payload: {},
            occurredAt,
          },
        } as never);
      };

    expect(
      await read(parseUlid(organizationId) as never, parseUlid(operationId) as never),
    ).toMatchObject({ state: "queued" });
    await transition("OperationStarted", "queued", 1);
    await transition("OperationFailed", "running", 2, {
      code: "build_failed",
      message: "The build failed.",
    });
    expect(
      await read(parseUlid(organizationId) as never, parseUlid(operationId) as never),
    ).toMatchObject({
      state: "failed",
      failure: { code: "build_failed", message: "The build failed." },
    });
    expect(
      await read(parseUlid(organizationId) as never, parseUlid(newUlid()) as never),
    ).toBeNull();

    // A response for another scope than the one requested never reaches the caller.
    const raw = await store.productApi.readApiProductOperation({ organizationId, operationId });
    expect(() => productOperationView(raw, parseUlid(newUlid()), parseUlid(operationId))).toThrow(
      "escaped its requested scope",
    );
    expect(() => createD1ProductOperationReader({} as never)).toThrow(
      "product_operation_binding_required",
    );
  } finally {
    await control.dispose();
  }
});
