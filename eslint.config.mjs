import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".ohmyhost/**",
      "docs/plan/tmp/**",
      "docs/plan/evidence/legacy/**",
      // Retained, hash-recorded acceptance artifact; not current executable source.
      "docs/plan/evidence/P23/windows-client-probe-20260913.mjs",
      ".turbo/**",
      "**/.terraform/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      // Astro recreates these verification outputs; authored fixture inputs remain linted.
      "fixtures/astro-edge/.astro/**",
      "fixtures/astro-static/.astro/**",
      "apps/project-provisioning-worker/worker-configuration.d.ts",
      "fixtures/tanstack-edge/worker-configuration.d.ts",
      // Generated Wrangler types and disposable Docker/Wrangler outputs, not fixture source.
      "fixtures/cloudflare-preview/tanstack-start/worker-configuration.d.ts",
      "scripts/preview-spike/worker/build-context/**",
      "scripts/preview-spike/worker/.dry-run/**",
      "packages/sdk-ts/src/generated/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["apps/public-site/site/*.js", "apps/control-api/site/*.js"],
    languageOptions: {
      globals: {
        location: "readonly",
        history: "readonly",
        document: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        matchMedia: "readonly",
        performance: "readonly",
        requestAnimationFrame: "readonly",
        IntersectionObserver: "readonly",
      },
    },
  },
  prettier,
);
