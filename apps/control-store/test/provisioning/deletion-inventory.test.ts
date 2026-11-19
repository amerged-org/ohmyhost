import { afterAll, beforeAll, expect, it } from "vitest";
import {
  DELETION_INVENTORY_TARGETS,
  inventoryTargetGuards,
  readDeletionInventoryPlan,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";
import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

/** D1 rejects a compound SELECT of more than five terms, so the target set must stay executable there. */
it("reads the frozen deletion targets of a project on D1 and guards them against change", async () => {
  const project = await seedProject(control),
    input = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      operationId: newUlid(),
      recordedAt: "2026-10-29T10:00:00.000Z",
    },
    plan = await readDeletionInventoryPlan(control.core, input);
  expect(plan.targets).toEqual([
    { provider: "control", resource_kind: "project", locator: project.projectId },
  ]);
  expect(plan.records).toHaveLength(1);
  // The count guard and the tuple guards hold while nothing changed and refuse a plan that lost or gained a target.
  const scope = [project.organizationId, project.projectId];
  await control.core.batch(
    inventoryTargetGuards(control.core, DELETION_INVENTORY_TARGETS, scope, plan.targets),
  );
  await expect(
    control.core.batch(
      inventoryTargetGuards(control.core, DELETION_INVENTORY_TARGETS, scope, [
        ...plan.targets,
        { provider: "cloudflare", resource_kind: "r2-bucket", locator: "gone-bucket" },
      ]),
    ),
  ).rejects.toThrow("guard_precondition_changed");
});
