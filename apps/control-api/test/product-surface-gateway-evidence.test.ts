import { describe, expect, it } from "vitest";

import { createProductSurfacePort } from "../src/product-surface.js";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("customer project status gateway projection", () => {
  it("fails closed on a forged persisted gateway receipt", async () => {
    const surface = createProductSurfacePort({
      persistence: {
        readProjectStatus: async () => ({
          projection: {
            project_id: projectId,
            name: "Customer project",
            handle: "calm-river-studio",
            region: "us",
            dev_access_mode: "protected",
            lifecycle_state: "active",
            lifecycle_version: 1,
            gateway_evidence: {
              dev: { runtime_provider: "wfp", wfp_receipt_id: "foreign-receipt" },
              prod: null,
            },
            source: null,
            default_environment: null,
            environments: [],
            deployments: [],
          },
          headDeployment: null,
          latestOperation: undefined,
          cleanupState: undefined,
        }),
      } as never,
      clock: { now: () => new Date("2026-09-23T00:00:00.000Z") },
      ids: {} as never,
      sourceInspector: {} as never,
      dataChanges: {} as never,
    });
    await expect(surface.getProjectStatus({ organizationId, projectId } as never)).rejects.toThrow(
      "Persisted dev gateway evidence is invalid",
    );
  });
});
