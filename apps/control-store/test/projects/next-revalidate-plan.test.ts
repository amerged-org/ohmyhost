import { afterAll, beforeAll, expect, it } from "vitest";
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

it("stores only the explicit Next edge revalidation option without relaxing plan shape", async () => {
  const next = sourceFrameworkPlan(false);
  const insert = (plan: unknown) =>
    seedDeploymentPlan(project, newUlid(), plan, project.prodEnvironmentId);
  await expect(insert({ ...next, nextRevalidatePath: true })).resolves.toBeDefined();
  for (const flag of [false, "true", null, 1])
    await expect(insert({ ...next, nextRevalidatePath: flag })).rejects.toThrow(
      "deployment Next revalidation shape",
    );
  await expect(insert({ ...next, nextRevalidatePath: true, unexpected: true })).rejects.toThrow();
  await expect(
    insert({
      ...next,
      adapter: "tanstack-start",
      outputDirectory: "dist/client",
      serverOutputDirectory: "dist/server",
      serverEntryPoint: "dist/server/index.js",
      serverConfigPath: "dist/server/wrangler.json",
      nextRevalidatePath: true,
    }),
  ).rejects.toThrow("deployment Next revalidation shape");
});
