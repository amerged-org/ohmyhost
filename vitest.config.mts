import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ohmyhost/platform/shared": fileURLToPath(
        new URL("./packages/platform/src/shared/index.ts", import.meta.url),
      ),
      "@ohmyhost/platform/ports": fileURLToPath(
        new URL("./packages/platform/src/ports/index.ts", import.meta.url),
      ),
      "@ohmyhost/platform": fileURLToPath(
        new URL("./packages/platform/src/index.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/signup-attribution": fileURLToPath(
        new URL("./packages/contracts/src/signup-attribution.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/credit-pricing": fileURLToPath(
        new URL("./packages/contracts/src/credit-pricing.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/shared-mail": fileURLToPath(
        new URL("./packages/contracts/src/shared-mail.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/feedback": fileURLToPath(
        new URL("./packages/contracts/src/feedback.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/user-api-keys": fileURLToPath(
        new URL("./packages/contracts/src/user-api-keys.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/database-compute": fileURLToPath(
        new URL("./packages/contracts/src/database-compute.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/project-context": fileURLToPath(
        new URL("./packages/contracts/src/project-context.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/project-exports": fileURLToPath(
        new URL("./packages/contracts/src/project-exports.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/billing": fileURLToPath(
        new URL("./packages/contracts/src/billing.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/framework-admission": fileURLToPath(
        new URL("./packages/contracts/src/framework-admission.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/framework-build-script": fileURLToPath(
        new URL("./packages/contracts/src/framework-build-script.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/framework-source-rules": fileURLToPath(
        new URL("./packages/contracts/src/framework-source-rules.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/framework-admission-corpus": fileURLToPath(
        new URL("./packages/contracts/src/framework-admission-corpus.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/project-data-changes": fileURLToPath(
        new URL("./packages/contracts/src/project-data-changes.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/secret-names": fileURLToPath(
        new URL("./packages/contracts/src/secret-names.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/problem-policy": fileURLToPath(
        new URL("./packages/contracts/src/problem-policy.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/browser-capabilities": fileURLToPath(
        new URL("./packages/contracts/src/browser-capabilities.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/wfp-dispatch": fileURLToPath(
        new URL("./packages/contracts/src/wfp-dispatch.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/operation-deployment-result": fileURLToPath(
        new URL("./packages/contracts/src/operation-deployment-result.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/operation-data-change-result": fileURLToPath(
        new URL("./packages/contracts/src/operation-data-change-result.ts", import.meta.url),
      ),
      "@ohmyhost/contracts/operation-failure": fileURLToPath(
        new URL("./packages/contracts/src/operation-failure.ts", import.meta.url),
      ),
      "@ohmyhost/provider-pgcf": fileURLToPath(
        new URL("./packages/provider-pgcf/src/index.ts", import.meta.url),
      ),
      "@ohmyhost/database/worker-postgres-targets": fileURLToPath(
        new URL("./packages/database/src/worker-postgres-targets.ts", import.meta.url),
      ),
      "@ohmyhost/database/worker-postgres": fileURLToPath(
        new URL("./packages/database/src/worker-postgres.ts", import.meta.url),
      ),
      "@ohmyhost/database/workos-persistence": fileURLToPath(
        new URL("./packages/database/src/workos-persistence.ts", import.meta.url),
      ),
      "@ohmyhost/database/worker-postgres-control": fileURLToPath(
        new URL("./packages/database/src/worker-postgres-control.ts", import.meta.url),
      ),
      "@ohmyhost/database/provisioning-persistence": fileURLToPath(
        new URL("./packages/database/src/provisioning-persistence.ts", import.meta.url),
      ),
      "@ohmyhost/database": fileURLToPath(
        new URL("./packages/database/src/index.ts", import.meta.url),
      ),
      "@ohmyhost/orchestrator": fileURLToPath(
        new URL("./apps/orchestrator/src/index.ts", import.meta.url),
      ),
    },
    conditions: ["source"],
  },
  test: {
    // Keep the barrel and instrumented subpaths on the same error-class instances.
    alias: [
      {
        find: /^@ohmyhost\/contracts$/u,
        replacement: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      },
    ],
    coverage: {
      include: ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: ["packages/sdk-ts/src/generated/**"],
      provider: "v8",
      reportOnFailure: true,
      reporter: ["text", "json-summary"],
      thresholds: {
        functions: 100,
      },
    },
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup/native-keyring-guard.ts"],
    include: [
      "tests/**/*.test.{js,mjs,ts,mts}",
      "packages/**/*.test.{js,mjs,ts,mts}",
      "apps/**/*.test.{js,mjs,ts,mts}",
    ],
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "tests/product-cli-boundary.test.mjs",
      // node:test suites of the build sandbox image; `pnpm test:node` runs them.
      "apps/build-runner/sandbox/tests/**",
    ],
    maxWorkers: 2,
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
