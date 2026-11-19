import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProject, type SeededProject } from "../support/platform-fixtures.js";
import { seedDeploymentPlan, sourceFrameworkPlan } from "../support/provider-fixtures.js";

let control: TestControl;
let project: SeededProject;
beforeAll(async () => {
  control = await createTestControl();
  project = await seedProject(control);
}, 120_000);
afterAll(async () => control.dispose());

const SHAPE = "deployment framework adapter shape";
const AI_SHAPE = "deployment ai shape";

/** The edge Next.js plan of the 17-key shape, the common base of the accepted AI plans. */
function edgePlan(extra: Record<string, unknown> = {}) {
  return { ...sourceFrameworkPlan(false), ...extra };
}

/** The functions runtime plan of the 12-key shape (no build output, no server entry). */
function functionsPlan(extra: Record<string, unknown> = {}) {
  return {
    adapter: "functions",
    runtime: "functions",
    installCommand: "npm ci --ignore-scripts",
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    ...extra,
  };
}

/** The static Vite plan of the 12-key shape. */
function staticVitePlan(extra: Record<string, unknown> = {}) {
  return {
    adapter: "vite-static",
    runtime: "static",
    installCommand: "npm ci --ignore-scripts",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
    ...extra,
  };
}

async function insert(plan: unknown) {
  return seedDeploymentPlan(project, newUlid(), plan, project.prodEnvironmentId);
}

describe("stored deployment plans with the optional ai key", () => {
  it("accepts an edge plan that declares ai for the EU", async () => {
    await expect(
      insert(edgePlan({ ai: { enabled: true, jurisdiction: "eu" } })),
    ).resolves.toMatchObject({ sourceConnectionId: expect.any(String) });
  });

  it("accepts an edge plan that declares ai for any jurisdiction", async () => {
    await expect(
      insert(edgePlan({ ai: { enabled: true, jurisdiction: "any" } })),
    ).resolves.toMatchObject({ sourceConnectionId: expect.any(String) });
  });

  it("accepts a functions plan that declares ai", async () => {
    await expect(
      insert(functionsPlan({ ai: { enabled: true, jurisdiction: "eu" } })),
    ).resolves.toMatchObject({ sourceConnectionId: expect.any(String) });
  });

  it("accepts a functions plan that declares ai next to scheduled crons", async () => {
    await expect(
      insert(
        functionsPlan({
          ai: { enabled: true, jurisdiction: "any" },
          functions: { crons: ["0 3 * * *"] },
        }),
      ),
    ).resolves.toMatchObject({ sourceConnectionId: expect.any(String) });
  });

  it("still accepts a plan without ai (the 0336 shape is unchanged)", async () => {
    await expect(insert(edgePlan())).resolves.toMatchObject({
      sourceConnectionId: expect.any(String),
    });
  });

  it("refuses ai on a static Vite plan", async () => {
    await expect(
      insert(staticVitePlan({ ai: { enabled: true, jurisdiction: "eu" } })),
    ).rejects.toThrow(AI_SHAPE);
  });

  it("refuses ai that is not enabled", async () => {
    await expect(insert(edgePlan({ ai: { enabled: false, jurisdiction: "eu" } }))).rejects.toThrow(
      AI_SHAPE,
    );
  });

  it("refuses a jurisdiction other than eu or any", async () => {
    await expect(insert(edgePlan({ ai: { enabled: true, jurisdiction: "us" } }))).rejects.toThrow(
      AI_SHAPE,
    );
  });

  it("refuses an extra key inside ai", async () => {
    await expect(
      insert(edgePlan({ ai: { enabled: true, jurisdiction: "eu", model: "x" } })),
    ).rejects.toThrow(AI_SHAPE);
  });

  it("refuses ai set to null", async () => {
    await expect(insert(edgePlan({ ai: null }))).rejects.toThrow(AI_SHAPE);
  });

  it("refuses ai given as an array", async () => {
    await expect(insert(edgePlan({ ai: [{ enabled: true, jurisdiction: "eu" }] }))).rejects.toThrow(
      AI_SHAPE,
    );
  });

  it("still refuses an unrelated extra top-level key next to a valid ai", async () => {
    await expect(
      insert(edgePlan({ ai: { enabled: true, jurisdiction: "eu" }, unrelated: 1 })),
    ).rejects.toThrow(SHAPE);
  });
});
