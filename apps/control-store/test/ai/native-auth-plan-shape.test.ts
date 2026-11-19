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

const auth = { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" };
const base = sourceFrameworkPlan(false);
const staticBase = {
  schemaVersion: base.schemaVersion,
  applicationRoot: ".",
  installCommand: base.installCommand,
  buildCommand: base.buildCommand,
  runtime: "static",
  runtimePolicy: base.runtimePolicy,
  database: base.database,
  mail: base.mail,
  storage: base.storage,
  auth,
};
const edge = { ...base, auth };

async function insert(plan: unknown) {
  return seedDeploymentPlan(project, newUlid(), plan, project.prodEnvironmentId);
}

describe("Native Auth stored plan admission", () => {
  it("persists the static, server, and Worker framework matrix without a business database", async () => {
    const plans = [
      { ...staticBase, adapter: "vite-static", outputDirectory: "dist" },
      { ...staticBase, adapter: "astro", outputDirectory: "dist" },
      { ...staticBase, adapter: "tanstack-start", outputDirectory: "dist/client" },
      edge,
      {
        ...edge,
        adapter: "astro",
        outputDirectory: "dist/client",
        serverOutputDirectory: "dist/server",
        serverEntryPoint: "dist/server/entry.mjs",
        serverConfigPath: "dist/server/wrangler.json",
      },
      {
        ...edge,
        adapter: "tanstack-start",
        outputDirectory: "dist/client",
        serverOutputDirectory: "dist/server",
        serverEntryPoint: "dist/server/index.js",
        serverConfigPath: "dist/server/wrangler.json",
      },
      {
        ...edge,
        adapter: "vite-static",
        outputDirectory: "dist",
        serverOutputDirectory: ".ohmyhost/vite-companion",
        serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
        serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
        compatibilityDate: "2025-01-01",
      },
      {
        ...staticBase,
        adapter: "functions",
        runtime: "functions",
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        buildCommand: undefined,
        outputDirectory: undefined,
      },
    ];
    for (const plan of plans) {
      const planId = newUlid();
      await seedDeploymentPlan(project, planId, plan, project.prodEnvironmentId);
      const row = await control.core
        .prepare(
          "SELECT json_extract(framework_plan, '$.auth') AS auth FROM deployment_plans WHERE plan_id = ?",
        )
        .bind(planId)
        .first<{ auth: string }>();
      if (!row) throw new Error("Native framework plan was not persisted");
      expect(JSON.parse(row.auth)).toEqual(auth);
    }
  });

  it("rejects forged Native shapes and legacy Better Auth without its database", async () => {
    for (const invalid of [
      { ...edge, auth: { ...auth, bindingName: "OTHER" } },
      { ...edge, auth: { ...auth, extra: true } },
      {
        ...edge,
        auth: {
          provider: "better-auth",
          version: "1.7.7",
          deployment: "embedded",
          routePath: "/api/auth",
          databaseSchema: "auth",
          databaseBindingName: "OHMYHOST_DATABASE",
          authSecretName: "BETTER_AUTH_SECRET",
        },
      },
    ])
      await expect(insert(invalid)).rejects.toThrow("deployment framework plan shape");
    await expect(
      insert({ ...staticBase, adapter: "astro", outputDirectory: "dist", mail: { enabled: true } }),
    ).rejects.toThrow("Astro framework plan shape");
  });
});
