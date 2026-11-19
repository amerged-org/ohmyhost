import { describe, expect, it } from "vitest";

import {
  FrameworkAdmissionError,
  FrameworkConversionDiagnosticError,
  classifyFrameworkVersion,
  frameworkConversionDetail,
  frameworkConversionDiagnosticFromDetail,
  frameworkVersionDiagnostic,
  parseFrameworkConversionDetail,
  parseFrameworkConversionDiagnostic,
  resolveFrameworkConfig,
  resolvePackageManager,
  rootFrameworkConversionDiagnostic,
  type FrameworkConversionDiagnostic,
} from "../src/framework-admission.js";

import {
  compareStableVersions,
  FRAMEWORK_VERSION_POLICY,
  frameworkVersionMinimum,
  frameworkVersionVerdict,
  nextBuildArguments,
  parseStableVersion,
  type FrameworkVersionPolicy,
} from "../src/framework-build-script.mjs";
import { FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS } from "../src/framework-admission-corpus.js";
import {
  databaseContractCodes,
  declaredDependency,
  declaredDependencyNames,
  frameworkSourceFindings,
  frameworkVersionAdmissions,
  importsSocketPrimitive,
  isDatabaseContractModule,
  isSocketPrimitiveModule,
  lockedPackageVersions,
  MANAGED_BETTER_AUTH_VERSION,
  MAXIMUM_FRAMEWORK_CONFIG_BYTES,
  nextConfigFindings,
  packageManagerDeclaration,
  parsePackageManifest,
  repositorySourceFindings,
  sourceWithoutComments,
  tanStackViteConfigFindings,
  tanStackViteConfigRuntime,
  VITE_COMPANION_ENTRY_PATH,
  viteCompanionRequired,
  viteConfigFindings,
  WORKER_MODULE_PATH,
  workerModuleFindings,
  type FrameworkSourceFramework,
  type FrameworkSourceRuleInput,
} from "../src/framework-source-rules.js";
import { parseOhmyhostConfig } from "../src/index.js";

const PUSH = "Commit and push the change, then plan the new commit.";
const PUSH_CLAUSE = "commit and push the change, then plan the new commit.";

describe("Native Auth source selection", () => {
  it("does not turn a static Vite application into a companion", () => {
    const config = parseOhmyhostConfig({
      version: 1,
      project: "storefront",
      build: { install: "npm ci --ignore-scripts", command: "npm run build", output: "dist" },
      runtime: { mode: "static" },
      auth: { provider: "omh-native" },
    });
    expect(viteCompanionRequired(config)).toBe(false);
  });
});

describe("framework conversion diagnostics", () => {
  it.each<{ diagnostic: FrameworkConversionDiagnostic; detail: string }>([
    {
      diagnostic: { code: "managed_auth_database_required", path: "ohmyhost.yaml" },
      detail: `"ohmyhost.yaml" selects the managed Better Auth bridge, which requires the managed PostgreSQL database. Set database.enabled: true with an admitted migrations path, or set auth.provider: none and keep the application-owned authentication configuration. ${PUSH}`,
    },
    {
      diagnostic: { code: "source_syntax_invalid", path: "app/page.tsx" },
      detail: `Invalid JavaScript or TypeScript in "app/page.tsx". Fix the file, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "source_syntax_invalid", path: "packages/site/app/(public)/page.tsx" },
      detail: `Invalid JavaScript or TypeScript in "packages/site/app/(public)/page.tsx". Fix the file, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "source_syntax_invalid",
        path: "src/routes/{-$locale}/posts.post-{$postId}.tsx",
      },
      detail: `Invalid JavaScript or TypeScript in "src/routes/{-$locale}/posts.post-{$postId}.tsx". Fix the file, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "worker_module_default_export_required", path: "src/ohmyhost/worker.ts" },
      detail: `Worker module "src/ohmyhost/worker.ts" has no default export. Export default { fetch, scheduled } with the handlers ohmyho.st invokes; named exports are never called. ${PUSH}`,
    },
    {
      diagnostic: { code: "scheduled_handler_required", path: "src/ohmyhost/companion.ts" },
      detail: `functions.crons is declared but "src/ohmyhost/companion.ts" exports no scheduled handler. Add scheduled(controller, env, ctx) to its default export, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "database_binding_private", path: "src/ohmyhost/worker.ts" },
      detail: `"src/ohmyhost/worker.ts" reads a database connection string (DATABASE_URL, HYPERDRIVE, connectionString or a postgres:// URL); none reaches a customer Worker. Call the database with createPrivateDatabaseClient from "@ohmyhost/customer-runtime/database". ${PUSH}`,
    },
    {
      diagnostic: { code: "database_driver_unsupported", path: "src/ohmyhost/worker.ts" },
      detail: `"src/ohmyhost/worker.ts" imports a database socket driver (pg, postgres, pg-native or mysql2); customer Workers cannot open sockets. Call the database with createPrivateDatabaseClient from "@ohmyhost/customer-runtime/database". ${PUSH}`,
    },
    {
      diagnostic: { code: "socket_primitive_unsupported", path: "src/ohmyhost/worker.ts" },
      detail: `"src/ohmyhost/worker.ts" loads cloudflare:sockets; customer Workers cannot open sockets. Call HTTPS services through the global fetch function and declare each origin in runtime.egress.allow in ohmyhost.yaml. ${PUSH}`,
    },
    {
      diagnostic: { code: "database_binding_private", path: "src/routes/items.$id.tsx" },
      detail: `"src/routes/items.$id.tsx" reads a database connection string (DATABASE_URL, HYPERDRIVE, connectionString or a postgres:// URL); none reaches a customer Worker. Call the database with createPrivateDatabaseClient from "@ohmyhost/customer-runtime/database". ${PUSH}`,
    },
    {
      diagnostic: { code: "framework_base_path_unsupported", path: "vite.config.ts" },
      detail: `"vite.config.ts" sets a Vite base. ohmyho.st serves the app at the root origin: remove base or set base: "/". ${PUSH}`,
    },
    {
      diagnostic: { code: "tanstack_prerender_required", path: "vite.config.mjs" },
      detail: `"vite.config.mjs" does not call tanstackStart({ prerender: { enabled: true } }), which the static TanStack Start runtime needs; enable prerender, or set runtime.mode: edge with the Cloudflare Vite plugin. ${PUSH}`,
    },
    {
      diagnostic: { code: "tanstack_vite_plugins_required", path: "vite.config.js" },
      detail: `"vite.config.js" does not follow the TanStack Start plugin contract: import tanstackStart from "@tanstack/react-start/plugin/vite"; on runtime edge also import cloudflare from "@cloudflare/vite-plugin" and call cloudflare({ viteEnvironment: { name: "ssr" } }) before tanstackStart(); on runtime static do not import the Cloudflare plugin. ${PUSH}`,
    },
    {
      diagnostic: { code: "next_tailwind_turbopack_only", path: "next.config.ts" },
      detail: `"next.config.ts" loads Tailwind CSS through the Turbopack rule "@tailwindcss/turbopack", which the Webpack build on ohmyho.st ignores, and the application root has no PostCSS configuration that Webpack reads, so the site would deploy without its Tailwind classes. Add postcss.config.mjs to the application root with export default { plugins: { "@tailwindcss/postcss": {} } } and remove the Turbopack rule. Use the package manager to add @tailwindcss/postcss to devDependencies at the same version as tailwindcss and to remove @tailwindcss/turbopack, so the lockfile records both. ${PUSH}`,
    },
    {
      diagnostic: {
        code: "framework_version_unsupported",
        path: "package.json",
        package: "next",
        version: "16.4.0",
        minimum: "16.4.5",
      },
      detail: `"package.json" declares next 16.4.0, which ohmyho.st does not admit; use next 16.4.5 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "framework_version_unsupported",
        path: "website/pnpm-lock.yaml",
        package: "@tanstack/react-start",
        version: "1.168.49",
        minimum: "1.168.60",
      },
      detail: `"website/pnpm-lock.yaml" resolves @tanstack/react-start 1.168.49, which ohmyho.st does not admit; use @tanstack/react-start 1.168.60 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "framework_version_unsupported",
        path: "package.json",
        package: "vite",
        version: "^8.0.0-beta.3",
        minimum: "5.4.6",
      },
      detail: `"package.json" declares vite ^8.0.0-beta.3, which ohmyho.st does not admit; use vite 5.4.6 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "framework_version_declaration_unsupported",
        path: "package.json",
        package: "next",
      },
      detail: `"package.json" declares next in a form ohmyho.st cannot check against its security minimum; declare an exact X.Y.Z version or a ^X.Y.Z or ~X.Y.Z range, update the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "framework_dependency_required",
        path: "package.json",
        package: "@cloudflare/vite-plugin",
      },
      detail: `"package.json" does not declare @cloudflare/vite-plugin in dependencies, which this framework and runtime need. Add it with the package manager so the lockfile records it, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "react_version_exact_required",
        path: "package.json",
        package: "react-dom",
      },
      detail: `"package.json" must declare react-dom in dependencies at an exact version such as 19.1.0, without ^ or ~, for Next.js. Pin the version the lockfile installs, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "build_script_unsupported", path: "package.json", framework: "nextjs" },
      detail: `"package.json" scripts.build is missing or not admitted for the nextjs adapter: it must be exactly "next build" or "next build --webpack"; ohmyho.st adds the OpenNext build itself. Move other steps into their own scripts, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: {
        code: "build_script_unsupported",
        path: "apps/web/package.json",
        framework: "tanstack-start",
      },
      detail: `"apps/web/package.json" scripts.build is missing or not admitted for the tanstack-start adapter: it must be "vite build", optionally joined with && to one "tsc", "tsc -b", "tsc --build" or "tsc --noEmit" stage. Move other steps into their own scripts, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "better_auth_version_required", path: "package.json" },
      detail: `"package.json" must declare better-auth at exactly 1.7.7 in dependencies because ohmyhost.yaml sets auth.provider: better-auth. Pin that version or set auth.provider: none, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "package_manifest_invalid", path: "package.json" },
      detail: `"package.json" is missing or is not one JSON object. Add package.json in the applicationRoot that ohmyhost.yaml names, or fix its syntax so the whole file parses as one object; ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "framework_unsupported", path: "package.json" },
      detail: `"package.json" declares none of astro, next, vite or @tanstack/react-start. Add the app's framework to dependencies, or set runtime.mode: functions in ohmyhost.yaml and add src/ohmyhost/worker.ts. ${PUSH}`,
    },
    {
      diagnostic: { code: "framework_ambiguous", path: "package.json" },
      detail: `"package.json" declares competing application framework packages, so ohmyho.st cannot choose one framework. Remove the packages of the framework this application does not use, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "lockfile_missing", path: "package.json" },
      detail: `"package.json" has no lockfile beside it. Install with the packageManager it names so package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock is written, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "lockfile_ambiguous", path: "package.json" },
      detail: `"package.json" has more than one lockfile beside it. Keep only the lockfile of the packageManager it names and delete the others, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "package_manager_missing", path: "package.json" },
      detail: `"package.json" has no packageManager field. Set it to name@X.Y.Z for the npm, pnpm, yarn or bun version that wrote the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "package_manager_invalid", path: "package.json" },
      detail: `"package.json" sets packageManager to a value ohmyho.st cannot use. Write npm, pnpm, yarn or bun, then @ and an exact X.Y.Z version without a +sha suffix, matching the lockfile; ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "package_manager_lockfile_mismatch", path: "bun.lockb" },
      detail: `"bun.lockb" was not written by the packageManager that package.json names. Set packageManager to the manager of this lockfile, or replace the lockfile with one from the named manager; ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "package_manager_version_unsupported", path: "package.json" },
      detail: `"package.json" pins a version ohmyho.st cannot build with: Bun other than 1.2.22, the only Bun ohmyho.st builds with, or Yarn before 3.0.0, the first that runs the frozen install flags. Set packageManager to bun@1.2.22 or to a Yarn version from 3.0.0 on, such as yarn@4.9.4, reinstall to update the lockfile, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
      detail: `"ohmyhost.yaml" does not match the ohmyho.st configuration schema. Run ohmyhost init --dry-run --json locally to see the exact field and fix, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "runtime_mode_unsupported", path: "ohmyhost.yaml", framework: "nextjs" },
      detail: `"ohmyhost.yaml" sets a runtime.mode that the nextjs adapter cannot run with this configuration; use runtime.mode: edge. ${PUSH}`,
    },
    {
      diagnostic: {
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "vite-static",
      },
      detail: `"ohmyhost.yaml" sets a runtime.mode that the vite-static adapter cannot run with this configuration; use runtime.mode: edge with src/ohmyhost/companion.ts when database, auth, mail, ai, browser, storage or functions.crons is set, and static otherwise. ${PUSH}`,
    },
    {
      diagnostic: {
        code: "runtime_mode_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      },
      detail: `"ohmyhost.yaml" sets a runtime.mode that the tanstack-start adapter cannot run with this configuration; use runtime.mode: edge, or static without functions.crons, storage, ai and browser. ${PUSH}`,
    },
    {
      diagnostic: { code: "build_output_unsupported", path: "ohmyhost.yaml", framework: "nextjs" },
      detail: `"ohmyhost.yaml" sets a build.output that the nextjs adapter does not produce; set build.output: .open-next/assets. ${PUSH}`,
    },
    {
      diagnostic: {
        code: "build_output_unsupported",
        path: "ohmyhost.yaml",
        framework: "vite-static",
      },
      detail: `"ohmyhost.yaml" sets a build.output that the vite-static adapter does not produce; set build.output: dist. ${PUSH}`,
    },
    {
      diagnostic: {
        code: "build_output_unsupported",
        path: "ohmyhost.yaml",
        framework: "tanstack-start",
      },
      detail: `"ohmyhost.yaml" sets a build.output that the tanstack-start adapter does not produce; set build.output: dist/client. ${PUSH}`,
    },
    {
      diagnostic: { code: "build_command_mismatch", path: "ohmyhost.yaml" },
      detail: `"ohmyhost.yaml" build.install or build.command differs from the commands of the packageManager in package.json (for npm: npm ci --ignore-scripts and npm run build). ohmyhost init --dry-run --json prints the exact values; set them, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "build_option_unsupported", path: "ohmyhost.yaml" },
      detail: `"ohmyhost.yaml" sets a build option this runtime ignores: build.ssg_cache_max_mib and build.next_revalidate_path apply only to Next.js, and runtime.mode: functions takes only build.install. Remove the option, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "application_root_missing", path: "ohmyhost.yaml" },
      detail: `"ohmyhost.yaml" sets applicationRoot to a directory that is missing or empty in this commit. Set it to the directory that holds the app's package.json, or "." for the repository root; ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "framework_config_required", path: "next.config.ts" },
      detail: `This application has no "next.config.ts". Add one framework config with that name and a .js, .mjs or .ts extension that exports its config as default, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "framework_config_ambiguous", path: "open-next.config.mjs" },
      detail: `"open-next.config.mjs" exists beside another variant with the same name and a .js, .mjs or .ts extension. Keep exactly one and delete the others, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "framework_config_too_large", path: "site/vite.config.ts" },
      detail: `"site/vite.config.ts" is larger than the 256 KiB ohmyho.st inspects. Keep the config small and move large data into imported modules, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "framework_config_default_export_required", path: "next.config.mjs" },
      detail: `"next.config.mjs" does not export its config as default. Use export default (next.config.js may assign module.exports instead), ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "next_output_unsupported", path: "next.config.js" },
      detail: `"next.config.js" sets output: "export" or output: "standalone", which the Next.js edge runtime on ohmyho.st cannot serve. Remove the output setting, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "next_base_path_unsupported", path: "next.config.ts" },
      detail: `"next.config.ts" sets basePath or assetPrefix. ohmyho.st serves the app at the root origin: remove both or set them to "". ${PUSH}`,
    },
    {
      diagnostic: { code: "companion_entry_required", path: "src/ohmyhost/companion.ts" },
      detail: `"src/ohmyhost/companion.ts" is missing. A Vite app with runtime.mode: edge or with database, auth, mail, ai, browser, storage or functions.crons needs this Worker module with export default { fetch }. Add it, or use runtime.mode: static without those settings; ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "worker_module_required", path: "web/src/ohmyhost/worker.ts" },
      detail: `"web/src/ohmyhost/worker.ts" is missing. runtime.mode: functions and functions.crons on Next.js or TanStack Start need this Worker module; export default { fetch, scheduled } with the handlers ohmyho.st invokes. Add it, ${PUSH_CLAUSE}`,
    },
    {
      diagnostic: { code: "worker_module_fetch_handler_required", path: "src/ohmyhost/worker.ts" },
      detail: `Worker module "src/ohmyhost/worker.ts" exports no fetch handler; runtime.mode: functions serves every request and the health check through it. Add a fetch handler that receives request, env and ctx to its default export. ${PUSH}`,
    },
  ])(
    "renders and parses the $diagnostic.code diagnostic of $diagnostic.path losslessly",
    ({ diagnostic, detail }) => {
      const parsed = parseFrameworkConversionDiagnostic(diagnostic);
      expect(parsed).toEqual(diagnostic);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(frameworkConversionDetail(diagnostic)).toBe(detail);
      expect(parseFrameworkConversionDetail(detail)).toBe(detail);
      expect(frameworkConversionDiagnosticFromDetail(detail)).toEqual(diagnostic);
      const error = new FrameworkConversionDiagnosticError(diagnostic);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.diagnostic).toEqual(diagnostic);
      expect(error.message).toBe(detail);
    },
  );

  it.each([
    null,
    "source_syntax_invalid",
    [{ code: "source_syntax_invalid", path: "app/page.tsx" }],
    { code: "other", path: "a.ts" },
    { code: "__proto__", path: "a.ts" },
    { code: "source_syntax_invalid" },
    { code: "worker_module_default_export_required", path: "src/ohmyhost/worker.ts", extra: true },
    Object.assign(Object.create({ code: "source_syntax_invalid" }) as object, {
      path: "app/page.tsx",
      extra: "inherited code",
    }),
    { code: "scheduled_handler_required", path: "../src/ohmyhost/worker.ts" },
    { code: "source_syntax_invalid", path: "https://private.invalid/a.ts" },
    { code: "source_syntax_invalid", path: "/app/page.tsx" },
    { code: "source_syntax_invalid", path: "app//page.tsx" },
    { code: "source_syntax_invalid", path: "./app/page.tsx" },
    { code: "source_syntax_invalid", path: "src/routes/old items.tsx" },
    { code: "source_syntax_invalid", path: `${"a/".repeat(119)}b.ts` },
    { code: "source_syntax_invalid", path: "package.json" },
    { code: "source_syntax_invalid", path: 7 },
    { code: "next_tailwind_turbopack_only", path: "src/next.ts" },
    { code: "next_tailwind_turbopack_only", path: "next.config.cjs" },
    { code: "framework_config_required", path: "remix.config.ts" },
    { code: "lockfile_missing", path: "package-lock.json" },
    { code: "lockfile_missing", path: "web/package.json/" },
    { code: "package_manager_lockfile_mismatch", path: "package.json" },
    { code: "package_manager_lockfile_mismatch", path: "deno.lock" },
    { code: "repository_configuration_invalid", path: "web/ohmyhost.yaml" },
    { code: "managed_auth_database_required", path: "ohmyhost.yml" },
    {
      code: "framework_version_unsupported",
      path: "package.json",
      package: "next",
      version: "16.4.0",
    },
    {
      code: "framework_version_unsupported",
      path: "package.json",
      package: "react",
      version: "19.0.0",
      minimum: "19.0.0",
    },
    ...[
      ">=16.0.0",
      "v16.4.0",
      "16.4",
      "16.4.01",
      "1234567.0.0",
      "16.4.0+build.1",
      `16.4.0-${"a".repeat(33)}`,
      "16.4.0-canary 1",
      16,
    ].map((version) => ({
      code: "framework_version_unsupported",
      path: "package.json",
      package: "next",
      version,
      minimum: "16.4.5",
    })),
    ...["^16.4.1", "16.4.1-rc.1"].map((minimum) => ({
      code: "framework_version_unsupported",
      path: "package-lock.json",
      package: "next",
      version: "16.4.0",
      minimum,
    })),
    {
      code: "framework_version_unsupported",
      path: "ohmyhost.yaml",
      package: "next",
      version: "16.4.0",
      minimum: "16.4.5",
    },
    {
      code: "framework_version_declaration_unsupported",
      path: "package.json",
      package: "next",
      version: "16.4.0",
    },
    { code: "framework_dependency_required", path: "package.json", package: "lodash" },
    { code: "react_version_exact_required", path: "package.json", package: "next" },
    { code: "build_script_unsupported", path: "package.json", framework: "functions" },
    { code: "runtime_mode_unsupported", path: "ohmyhost.yaml", framework: "functions" },
    { code: "build_output_unsupported", path: "ohmyhost.yaml" },
  ])("rejects unknown codes, extra fields, wrong path classes and unsafe values: %j", (value) => {
    expect(parseFrameworkConversionDiagnostic(value)).toBeNull();
    expect(frameworkConversionDetail(value)).toBeNull();
    expect(() => new FrameworkConversionDiagnosticError(value)).toThrow(
      "Framework conversion diagnostic is invalid",
    );
  });

  it.each([
    "Worker module has no default export.",
    `"package.json" resolves next 16.4.0, which ohmyho.st does not admit; use next 16.4.5 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    `"package-lock.json" declares next 16.4.0, which ohmyho.st does not admit; use next 16.4.5 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    `"package.json" declares next 16.4.0, which ohmyho.st does not admit; use vite 16.4.5 or a later stable release, update package.json and the lockfile, ${PUSH_CLAUSE}`,
    `Invalid JavaScript or TypeScript in "../app/page.tsx". Fix the file, ${PUSH_CLAUSE}`,
    `Invalid JavaScript or TypeScript in "app/page.tsx". Fix the file, ${PUSH_CLAUSE} `,
    `"ohmyhost.yaml" sets a runtime.mode that the nextjs adapter cannot run with this configuration; use runtime.mode: functions with src/ohmyhost/worker.ts. ${PUSH}`,
    `"web/ohmyhost.yaml" does not match the ohmyho.st configuration schema. Run ohmyhost init --dry-run --json locally to see the exact field and fix, ${PUSH_CLAUSE}`,
    `Invalid JavaScript or TypeScript in "app/page.tsx". Fix the file, ${PUSH_CLAUSE}${" ".repeat(2_000)}`,
    42,
    null,
  ])("recognizes only exact catalog renderings: %j", (detail) => {
    expect(parseFrameworkConversionDetail(detail)).toBeNull();
    expect(frameworkConversionDiagnosticFromDetail(detail)).toBeNull();
  });

  it("keeps the longest rendering within the public detail bound", () => {
    const path = `${"a/".repeat(113)}next.config.ts`;
    expect(path).toHaveLength(240);
    const detail = frameworkConversionDetail({ code: "next_tailwind_turbopack_only", path });
    expect(detail?.length).toBeLessThan(1_000);
    expect(parseFrameworkConversionDetail(detail)).toBe(detail);
  });

  it("roots application paths and keeps ohmyhost.yaml at the repository root", () => {
    const version = {
      code: "framework_version_unsupported",
      path: "package-lock.json",
      package: "next",
      version: "16.4.0",
      minimum: "16.4.5",
    } as const;
    const rooted = rootFrameworkConversionDiagnostic(version, "website");
    expect(rooted).toEqual({ ...version, path: "website/package-lock.json" });
    expect(Object.isFrozen(rooted)).toBe(true);
    expect(
      rootFrameworkConversionDiagnostic(
        { code: "source_syntax_invalid", path: "app/page.tsx" },
        "apps/web",
      ),
    ).toEqual({ code: "source_syntax_invalid", path: "apps/web/app/page.tsx" });
    expect(
      rootFrameworkConversionDiagnostic(
        { code: "runtime_mode_unsupported", path: "ohmyhost.yaml", framework: "nextjs" },
        "website",
      ),
    ).toEqual({ code: "runtime_mode_unsupported", path: "ohmyhost.yaml", framework: "nextjs" });
    expect(
      rootFrameworkConversionDiagnostic({ code: "lockfile_missing", path: "package.json" }, "."),
    ).toEqual({ code: "lockfile_missing", path: "package.json" });
    expect(
      rootFrameworkConversionDiagnostic(
        { code: "source_syntax_invalid", path: `${"a".repeat(200)}.ts` },
        "b".repeat(40),
      ),
    ).toBeNull();
    expect(rootFrameworkConversionDiagnostic({ code: "other", path: "a.ts" }, "web")).toBeNull();
  });
});

describe("package manager admission", () => {
  it.each([
    [
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm",
      "10.28.2",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    [
      "npm@11.5.2",
      "package-lock.json",
      "npm",
      "11.5.2",
      "npm ci --ignore-scripts",
      "npm run build",
    ],
    [
      "yarn@4.9.2",
      "yarn.lock",
      "yarn",
      "4.9.2",
      "yarn install --immutable --mode=skip-build",
      "yarn run build",
    ],
    [
      "bun@1.2.22",
      "bun.lock",
      "bun",
      "1.2.22",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
    [
      "bun@1.2.22",
      "bun.lockb",
      "bun",
      "1.2.22",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
  ] as const)(
    "admits %s with %s",
    (packageManager, lockfile, manager, version, installCommand, buildCommand) => {
      expect(
        resolvePackageManager({
          packageManager,
          files: ["package.json", lockfile, "README.md"],
        }),
      ).toEqual({
        manager,
        version,
        lockfile,
        installCommand,
        buildCommand,
      });
    },
  );

  it.each([
    [
      { packageManager: "pnpm@10.28.2", files: ["package.json"] },
      "missing_lockfile",
      { code: "lockfile_missing", path: "package.json" },
    ],
    [
      {
        packageManager: "pnpm@10.28.2",
        files: ["pnpm-lock.yaml", "package-lock.json"],
      },
      "ambiguous_lockfile",
      { code: "lockfile_ambiguous", path: "package.json" },
    ],
    [
      { packageManager: undefined, files: ["pnpm-lock.yaml"] },
      "missing_package_manager",
      { code: "package_manager_missing", path: "package.json" },
    ],
    ...["pnpm", "pnpm@latest", "pnpm@10.28", " pnpm@10.28.2", "pnpm@10.28.2+sha512.abc"].map(
      (packageManager) =>
        [
          { packageManager, files: ["pnpm-lock.yaml"] },
          "invalid_package_manager",
          { code: "package_manager_invalid", path: "package.json" },
        ] as const,
    ),
    [
      { packageManager: "npm@11.5.2", files: ["pnpm-lock.yaml"] },
      "package_manager_lockfile_mismatch",
      { code: "package_manager_lockfile_mismatch", path: "pnpm-lock.yaml" },
    ],
    [
      { packageManager: "bun@1.2.21", files: ["bun.lock"] },
      "package_manager_version_unsupported",
      { code: "package_manager_version_unsupported", path: "package.json" },
    ],
    [
      { packageManager: "yarn@1.22.22", files: ["yarn.lock"] },
      "package_manager_version_unsupported",
      { code: "package_manager_version_unsupported", path: "package.json" },
    ],
    [
      { packageManager: "yarn@2.4.3", files: ["yarn.lock"] },
      "package_manager_version_unsupported",
      { code: "package_manager_version_unsupported", path: "package.json" },
    ],
    [
      { packageManager: "bun@1.2.22", files: ["bun.lock", "bun.lockb"] },
      "ambiguous_lockfile",
      { code: "lockfile_ambiguous", path: "package.json" },
    ],
  ] as const)(
    "rejects invalid package manager input %j with %s and its diagnostic",
    (input, reason, diagnostic) => {
      expect(() => resolvePackageManager(input)).toThrowError(
        expect.objectContaining<Partial<FrameworkAdmissionError>>({
          name: "FrameworkAdmissionError",
          code: "framework_admission_failed",
          reason,
          diagnostic,
        }),
      );
    },
  );

  it("admits Yarn from 3.0.0, the first release that runs --mode=skip-build", () => {
    for (const packageManager of ["yarn@3.0.0", "yarn@4.9.4"]) {
      expect(resolvePackageManager({ packageManager, files: ["yarn.lock"] })).toMatchObject({
        manager: "yarn",
        installCommand: "yarn install --immutable --mode=skip-build",
      });
    }
  });

  it("does not mutate caller-owned file input", () => {
    const files = ["package.json", "pnpm-lock.yaml"];
    resolvePackageManager({ packageManager: "pnpm@10.28.2", files });
    expect(files).toEqual(["package.json", "pnpm-lock.yaml"]);
  });
});

describe("framework config admission", () => {
  it.each([
    ["vite.config", "vite.config.js"],
    ["vite.config", "vite.config.mjs"],
    ["vite.config", "vite.config.ts"],
    ["next.config", "next.config.js"],
    ["next.config", "next.config.mjs"],
    ["next.config", "next.config.ts"],
  ] as const)("resolves %s from %s", (basename, expected) => {
    expect(resolveFrameworkConfig(basename, ["package.json", expected])).toBe(expected);
  });

  it("returns null when the config is absent", () => {
    expect(resolveFrameworkConfig("vite.config", ["package.json", "src/index.ts"])).toBeNull();
  });

  it.each([
    ["vite.config", ["vite.config.js", "vite.config.ts"], "vite.config.js"],
    ["open-next.config", ["open-next.config.mjs", "open-next.config.ts"], "open-next.config.mjs"],
  ] as const)("rejects multiple supported %s files", (basename, files, path) => {
    expect(() => resolveFrameworkConfig(basename, files)).toThrowError(
      expect.objectContaining<Partial<FrameworkAdmissionError>>({
        code: "framework_admission_failed",
        reason: "ambiguous_config",
        diagnostic: { code: "framework_config_ambiguous", path },
      }),
    );
  });

  it("ignores config extensions outside the admitted contract", () => {
    expect(resolveFrameworkConfig("vite.config", ["vite.config.cjs"])).toBeNull();
  });
});

/** Overlapping fixed ranges on Next 16.5 and a release line without a fix from 17.1.0 on. */
const DENIED_POLICY: FrameworkVersionPolicy = Object.freeze({
  ...FRAMEWORK_VERSION_POLICY,
  next: Object.freeze({
    floors: Object.freeze(["15.5.28", "16.4.1"]),
    denied: Object.freeze([
      Object.freeze(["16.5.0", "16.5.2"] as const),
      Object.freeze(["16.5.1", "16.6.0"] as const),
      Object.freeze(["17.1.0", null] as const),
    ]),
  }),
  vite: Object.freeze({
    floors: Object.freeze(["5.4.6"]),
    denied: Object.freeze([Object.freeze(["5.4.6", "5.4.8"] as const)]),
  }),
});

describe("framework version policy", () => {
  it.each([
    ["next", "14.2.33", "below_security_minimum"],
    ["next", "15.5.26", "below_security_minimum"],
    ["next", "15.5.27", "below_security_minimum"],
    ["next", "15.5.28", "below_security_minimum"],
    ["next", "15.6.0", "below_security_minimum"],
    ["next", "16.0.0", "below_security_minimum"],
    ["next", "16.3.7", "below_security_minimum"],
    ["next", "16.3.8", "below_security_minimum"],
    ["next", "16.4.0", "below_security_minimum"],
    ["next", "16.4.4", "below_security_minimum"],
    ["next", "16.4.5", "admitted"],
    ["next", "16.4.1", "below_security_minimum"],
    ["next", "16.4.2", "below_security_minimum"],
    ["next", "17.0.0", "admitted"],
    ["vite", "4.5.14", "below_security_minimum"],
    ["vite", "5.4.5", "below_security_minimum"],
    ["vite", "5.4.6", "admitted"],
    ["vite", "8.3.4", "admitted"],
    ["vite", "9.0.0", "admitted"],
    ["@tanstack/react-start", "1.168.49", "below_security_minimum"],
    ["@tanstack/react-start", "1.168.59", "below_security_minimum"],
    ["@tanstack/react-start", "1.168.60", "admitted"],
    ["@tanstack/react-start", "1.169.0", "admitted"],
    ["@tanstack/react-start", "2.0.0", "admitted"],
  ] as const)("judges %s %s as %s against the security floors", (packageName, version, verdict) => {
    expect(frameworkVersionVerdict(packageName, version)).toBe(verdict);
  });

  it.each([
    undefined,
    null,
    16,
    "16.5.0-canary.5",
    "16.4.1-rc.1",
    "16.4.1+build.1",
    "^16.4.1",
    "~15.5.28",
    ">=16.4.1",
    "16.4",
    "v16.4.1",
    " 16.4.1",
    "16.4.1\n",
    "16.04.1",
    "1234567.0.0",
    "15.5.999999999999999999999",
  ])("refuses the prerelease or malformed version %j", (version) => {
    expect(frameworkVersionVerdict("next", version)).toBe("invalid_version");
  });

  it("refuses packages outside the policy", () => {
    expect(frameworkVersionVerdict("react", "19.2.0")).toBe("invalid_version");
    expect(frameworkVersionVerdict("__proto__", "19.2.0")).toBe("invalid_version");
    expect(() => frameworkVersionMinimum("react", "19.2.0")).toThrow(
      "Framework version package is not governed",
    );
  });

  // A line's floor is the last listed one whose major is not above its own and an unknown line's
  // minimum is the first one, so a floor raise must keep each list stable and strictly ascending.
  it.each(Object.entries(FRAMEWORK_VERSION_POLICY))(
    "keeps the %s floors stable and strictly ascending",
    (_packageName, { floors }) => {
      expect(floors.length).toBeGreaterThan(0);
      let previous: readonly [number, number, number] | null = null;
      for (const floor of floors) {
        const version = parseStableVersion(floor);
        expect(version).not.toBeNull();
        if (previous !== null && version !== null)
          expect(compareStableVersions(previous, version)).toBeLessThan(0);
        previous = version;
      }
    },
  );

  it.each([
    ["next", "16.4.2", "admitted", "16.4.1"],
    ["next", "16.5.0", "known_vulnerable", "16.6.0"],
    ["next", "16.5.1", "known_vulnerable", "16.6.0"],
    ["next", "16.5.9", "known_vulnerable", "16.6.0"],
    ["next", "16.6.0", "admitted", "16.4.1"],
    ["next", "17.0.9", "admitted", "16.4.1"],
    ["next", "17.1.0", "known_vulnerable", "16.4.1"],
    ["next", "18.0.0", "known_vulnerable", "16.4.1"],
    ["next", "16.4.0", "below_security_minimum", "16.4.1"],
    ["next", "^16.5.0", "invalid_version", "16.6.0"],
    ["vite", "5.4.0", "below_security_minimum", "5.4.8"],
    ["vite", "5.4.6", "known_vulnerable", "5.4.8"],
    ["vite", "5.4.7", "known_vulnerable", "5.4.8"],
  ] as const)(
    "applies half-open, chained and unfixed denied ranges of an injected policy to %s %s",
    (packageName, version, verdict, minimum) => {
      expect(frameworkVersionVerdict(packageName, version, DENIED_POLICY)).toBe(verdict);
      expect(frameworkVersionMinimum(packageName, version, DENIED_POLICY)).toBe(minimum);
    },
  );

  it.each([
    ["next", "15.5.26", "16.4.5"],
    ["next", "15.5.27", "16.4.5"],
    ["next", "15.5.28", "16.4.5"],
    ["next", "16.3.7", "16.4.5"],
    ["next", "16.3.8", "16.4.5"],
    ["next", "16.4.0", "16.4.5"],
    ["next", "16.4.2", "16.4.5"],
    ["next", "17.0.0", "16.4.5"],
    ["next", "14.2.33", "16.4.5"],
    ["next", "^16.0.0", "16.4.5"],
    ["next", "~15.4.0", "16.4.5"],
    ["next", "16.5.0-canary.5", "16.4.5"],
    ["next", "^16.5.0-canary.5", "16.4.5"],
    ["next", ">=16.0.0", "16.4.5"],
    ["next", "latest", "16.4.5"],
    ["next", null, "16.4.5"],
    ["vite", "5.4.5", "5.4.6"],
    ["vite", "^8.0.0", "5.4.6"],
    ["@tanstack/react-start", "1.168.49", "1.168.60"],
    ["@tanstack/react-start", "~1.167.0", "1.168.60"],
  ] as const)("names the minimum of %s %s as %s", (packageName, version, minimum) => {
    expect(frameworkVersionMinimum(packageName, version)).toBe(minimum);
  });

  it.each([
    ["15.5.28", []],
    ["16.4.1", ["--webpack"]],
    ["17.0.0", ["--webpack"]],
  ] as const)("builds Next.js %s with %j", (version, argumentsForVersion) => {
    expect(nextBuildArguments(version)).toEqual(argumentsForVersion);
    expect(Object.isFrozen(nextBuildArguments(version))).toBe(true);
  });

  it.each([undefined, "16", "^16.4.1", "16.5.0-canary.5"])(
    "refuses Next.js build arguments for %j",
    (version) => {
      expect(() => nextBuildArguments(version)).toThrow("Next.js version is invalid");
    },
  );
});

describe("framework version admission", () => {
  it.each([
    ["next", "15.5.28", "unsupported", "16.4.5"],
    ["next", "15.6.0", "unsupported", "16.4.5"],
    ["next", "16.4.1", "unsupported", "16.4.5"],
    ["next", "16.4.5", "admitted", "16.4.5"],
    ["next", "17.0.0", "admitted", "16.4.5"],
    ["next", "15.5.26", "unsupported", "16.4.5"],
    ["next", "15.5.27", "unsupported", "16.4.5"],
    ["next", "16.3.7", "unsupported", "16.4.5"],
    ["next", "16.3.8", "unsupported", "16.4.5"],
    ["next", "16.4.0", "unsupported", "16.4.5"],
    ["next", "16.5.0-canary.5", "unsupported", "16.4.5"],
    ["vite", "5.4.5", "unsupported", "5.4.6"],
    ["vite", "8.3.4", "admitted", "5.4.6"],
    ["vite", "9.0.0", "admitted", "5.4.6"],
    ["@tanstack/react-start", "1.168.49", "unsupported", "1.168.60"],
    ["@tanstack/react-start", "1.168.60", "admitted", "1.168.60"],
    ["@tanstack/react-start", "2.0.0", "admitted", "1.168.60"],
  ] as const)(
    "judges the exact declaration %s %s as %s",
    (packageName, declared, status, minimum) => {
      const admission = classifyFrameworkVersion(packageName, declared);
      expect(admission).toEqual({
        package: packageName,
        status,
        declared,
        resolved: null,
        minimum,
      });
      expect(Object.isFrozen(admission)).toBe(true);
    },
  );

  it.each([
    ["next", "^16.4.5", "admitted", "16.4.5"],
    ["next", "~16.4.1", "pending", "16.4.5"],
    ["next", "^15.5.28", "unsupported", "16.4.5"],
    ["next", "~15.5.28", "unsupported", "16.4.5"],
    ["next", "^16.0.0", "pending", "16.4.5"],
    ["next", "^16.3.8", "pending", "16.4.5"],
    ["next", "~16.4.0", "pending", "16.4.5"],
    ["next", "^15.5.27", "unsupported", "16.4.5"],
    ["next", "~15.5.27", "unsupported", "16.4.5"],
    ["next", "~15.5.0", "unsupported", "16.4.5"],
    ["next", "^15.0.0", "unsupported", "16.4.5"],
    ["next", "~16.3.8", "unsupported", "16.4.5"],
    ["next", "~16.3.0", "unsupported", "16.4.5"],
    ["next", "~15.4.0", "unsupported", "16.4.5"],
    ["next", "~16.2.0", "unsupported", "16.4.5"],
    ["next", "^14.2.0", "unsupported", "16.4.5"],
    ["next", "^0.9.0", "unsupported", "16.4.5"],
    ["vite", "^5.4.0", "pending", "5.4.6"],
    ["vite", "~5.3.0", "unsupported", "5.4.6"],
    ["vite", "^8.2.2", "admitted", "5.4.6"],
    ["@tanstack/react-start", "^1.168.26", "pending", "1.168.60"],
    ["@tanstack/react-start", "~1.168.0", "pending", "1.168.60"],
    ["@tanstack/react-start", "~1.167.0", "unsupported", "1.168.60"],
  ] as const)(
    "judges the range %s %s as %s without a lockfile",
    (packageName, declared, status, minimum) => {
      expect(classifyFrameworkVersion(packageName, declared)).toEqual({
        package: packageName,
        status,
        declared,
        resolved: null,
        minimum,
      });
    },
  );

  it.each([
    [">=16.0.0", "16.4.5"],
    ["16.x", "16.4.5"],
    ["latest", "16.4.5"],
    ["*", "16.4.5"],
    ["", "16.4.5"],
    ["workspace:*", "16.4.5"],
    ["npm:next@16.4.1", "16.4.5"],
    ["^16.4.1-canary.1", "16.4.5"],
    [" 16.4.1", "16.4.5"],
    ["v16.4.1", "16.4.5"],
    ["16.4", "16.4.5"],
    ["^16.4", "16.4.5"],
    ["16.4.1 || 17.0.0", "16.4.5"],
    ["999999999999999999999.2.2", "16.4.5"],
  ])("refuses the declaration form %j", (declared, minimum) => {
    expect(classifyFrameworkVersion("next", declared)).toMatchObject({
      status: "unsupported",
      resolved: null,
      minimum,
    });
  });

  it.each([
    ["^16.0.0", "16.4.1", "unsupported", "16.4.5"],
    ["^16.0.0", "16.4.5", "admitted", "16.4.5"],
    ["^16.0.0", "16.4.0", "unsupported", "16.4.5"],
    ["^16.0.0", "16.2.0", "unsupported", "16.4.5"],
    ["16.4.1", "16.4.0", "unsupported", "16.4.5"],
    [">=16.0.0", "16.4.5", "admitted", "16.4.5"],
  ] as const)(
    "lets the lockfile resolution of %s (%s) decide as %s",
    (declared, resolved, status, minimum) => {
      expect(classifyFrameworkVersion("next", declared, resolved)).toEqual({
        package: "next",
        status,
        declared,
        resolved,
        minimum,
      });
    },
  );

  it("judges an unresolved range by its declaration", () => {
    expect(classifyFrameworkVersion("next", "^16.0.0", undefined)).toMatchObject({
      status: "pending",
      resolved: null,
    });
    expect(classifyFrameworkVersion("next", "^16.0.0", null)).toMatchObject({
      status: "pending",
      resolved: null,
    });
  });

  it.each([
    ["^16.4.1", null, "pending", "16.4.1"],
    ["~16.5.0", null, "unsupported", "16.6.0"],
    ["~16.6.0", null, "admitted", "16.4.1"],
    ["^17.0.0", null, "pending", "16.4.1"],
    ["~17.1.0", null, "unsupported", "16.4.1"],
    ["^16.0.0", "16.5.1", "unsupported", "16.6.0"],
    ["^16.0.0", "16.6.0", "admitted", "16.4.1"],
  ] as const)(
    "applies denied ranges of an injected policy to next %s resolved as %s",
    (declared, resolved, status, minimum) => {
      expect(classifyFrameworkVersion("next", declared, resolved, DENIED_POLICY)).toMatchObject({
        status,
        minimum,
      });
    },
  );

  it("names the deciding file and fields of an unsupported admission", () => {
    expect(frameworkVersionDiagnostic(classifyFrameworkVersion("next", "16.4.5"), null)).toBeNull();
    expect(
      frameworkVersionDiagnostic(classifyFrameworkVersion("next", "^16.0.0"), "package-lock.json"),
    ).toBeNull();
    expect(frameworkVersionDiagnostic(classifyFrameworkVersion("next", "16.4.0"), null)).toEqual({
      code: "framework_version_unsupported",
      path: "package.json",
      package: "next",
      version: "16.4.0",
      minimum: "16.4.5",
    });
    expect(
      frameworkVersionDiagnostic(classifyFrameworkVersion("vite", "~5.3.0"), "pnpm-lock.yaml"),
    ).toEqual({
      code: "framework_version_unsupported",
      path: "package.json",
      package: "vite",
      version: "~5.3.0",
      minimum: "5.4.6",
    });
    expect(
      frameworkVersionDiagnostic(classifyFrameworkVersion("next", "^16.5.0-canary.1"), null),
    ).toEqual({
      code: "framework_version_unsupported",
      path: "package.json",
      package: "next",
      version: "^16.5.0-canary.1",
      minimum: "16.4.5",
    });
    for (const declared of [">=16.0.0", "", `16.5.0-${"a".repeat(33)}`])
      expect(frameworkVersionDiagnostic(classifyFrameworkVersion("next", declared), null)).toEqual({
        code: "framework_version_declaration_unsupported",
        path: "package.json",
        package: "next",
      });
    const locked = classifyFrameworkVersion("@tanstack/react-start", "^1.168.0", "1.168.49");
    expect(frameworkVersionDiagnostic(locked, "pnpm-lock.yaml")).toEqual({
      code: "framework_version_unsupported",
      path: "pnpm-lock.yaml",
      package: "@tanstack/react-start",
      version: "1.168.49",
      minimum: "1.168.60",
    });
    expect(() => frameworkVersionDiagnostic(locked, null)).toThrow(
      "Framework version lockfile is required",
    );
  });

  const npmLockfile = (packages: Record<string, unknown>, lockfileVersion: unknown = 3) =>
    JSON.stringify({
      name: "app",
      lockfileVersion,
      requires: true,
      packages: { "": { name: "app", dependencies: { next: "^16.0.0" } }, ...packages },
    });

  it("resolves direct packages from package-lock.json v2 and v3 only", () => {
    const text = npmLockfile({
      "node_modules/next": { version: "16.4.2", resolved: "https://registry.npmjs.org/next" },
      "node_modules/@tanstack/react-start": { version: "1.168.60" },
      "node_modules/vite": { name: "rolldown-vite", version: "7.1.0" },
      "node_modules/react": { resolved: "../react", link: true },
      "node_modules/react-dom": { version: "19.2.0-canary.1" },
      "node_modules/eslint": { version: `9.0.0-${"a".repeat(33)}` },
      "node_modules/@vitejs/plugin-react": { name: "@vitejs/plugin-react", version: "5.0.0" },
      "node_modules/better-auth": "1.7.7",
    });
    const locked = lockedPackageVersions({ name: "package-lock.json", text });
    expect(locked("next")).toBe("16.4.2");
    expect(locked("@tanstack/react-start")).toBe("1.168.60");
    expect(locked("@vitejs/plugin-react")).toBe("5.0.0");
    expect(locked("react-dom")).toBe("19.2.0-canary.1");
    for (const packageName of ["vite", "react", "eslint", "better-auth", "typescript"])
      expect(locked(packageName)).toBeNull();
    const next = (text: string) =>
      lockedPackageVersions({ name: "package-lock.json", text })("next");
    expect(next(npmLockfile({ "node_modules/next": { version: "16.4.1" } }, 2))).toBe("16.4.1");
    for (const invalid of [
      npmLockfile({ "node_modules/next": { version: "16.4.1" } }, 1),
      npmLockfile({ "node_modules/next": { version: "16.4.1" } }, "3"),
      JSON.stringify({ lockfileVersion: 3, packages: [] }),
      JSON.stringify([{ lockfileVersion: 3 }]),
      "{ not json",
    ])
      expect(next(invalid)).toBeNull();
  });

  const pnpmLockfile = (...lines: readonly string[]) => [...lines, ""].join("\n");
  const PNPM_V9 = pnpmLockfile(
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      next:",
    "        specifier: ^16.0.0",
    "        version: 16.4.2(@types/node@24.3.0)(react-dom@19.2.8(react@19.2.8))(react@19.2.8)",
    "      react:",
    "        specifier: link:../react",
    "        version: link:../react",
    "      react-dom:",
    "        specifier: npm:react-dom-fork@19.2.8",
    "        version: react-dom-fork@19.2.8",
    "      better-auth:",
    "        specifier: file:../better-auth.tgz",
    "        version: file:../better-auth.tgz",
    "      '@cloudflare/vite-plugin': 1.13.0",
    "      '@vitejs/plugin-react':",
    "        specifier: 5.0.0",
    "        version: (5.0.0)",
    "    devDependencies:",
    "      vite:",
    "        specifier: ~8.3.0",
    "        version: 8.3.4(@types/node@24.3.0)",
    "    optionalDependencies:",
    "      '@tanstack/react-start':",
    "        specifier: ^1.168.0",
    "        version: 1.168.60(vite@8.3.4)",
    "",
    "  packages/other:",
    "    dependencies:",
    "      '@tanstack/react-router':",
    "        specifier: 1.169.0",
    "        version: 1.169.0",
    "",
    "packages:",
    "",
    "  next@16.4.2:",
    "    resolution: {integrity: sha512-abc}",
  );

  it("resolves the root importer of pnpm-lock.yaml v6 and v9 without its peer suffix", () => {
    const locked = (text: string, packageName: string) =>
      lockedPackageVersions({ name: "pnpm-lock.yaml", text })(packageName);
    expect(locked(PNPM_V9, "next")).toBe("16.4.2");
    expect(locked(PNPM_V9, "vite")).toBe("8.3.4");
    expect(locked(PNPM_V9, "@tanstack/react-start")).toBe("1.168.60");
    for (const packageName of [
      "react",
      "react-dom",
      "better-auth",
      "@cloudflare/vite-plugin",
      "@vitejs/plugin-react",
      "@tanstack/react-router",
      "typescript",
    ])
      expect(locked(PNPM_V9, packageName)).toBeNull();
    const inline = pnpmLockfile(
      "lockfileVersion: '6.0'",
      "",
      "dependencies:",
      "  next:",
      "    specifier: ~15.5.0",
      "    version: 15.5.28(react-dom@19.1.0)(react@19.1.0)",
      "  vite:",
      "    specifier: npm:rolldown-vite@7.1.0",
      "    version: /rolldown-vite@7.1.0",
      "",
      "packages:",
      "",
      "  /next@15.5.28(react-dom@19.1.0)(react@19.1.0):",
      "    resolution: {integrity: sha512-abc}",
      "    dev: false",
    );
    expect(locked(inline, "next")).toBe("15.5.28");
    expect(locked(inline, "vite")).toBeNull();
    const workspace = pnpmLockfile(
      "lockfileVersion: '6.1'",
      "importers:",
      "  .:",
      "    devDependencies:",
      "      vite:",
      "        specifier: ^5.4.0",
      "        version: 5.4.21",
    );
    expect(locked(workspace, "vite")).toBe("5.4.21");
    expect(locked(workspace.replace("'6.1'", "'9.0'"), "vite")).toBe("5.4.21");
    expect(locked(inline.replace("'6.0'", "'9.0'"), "next")).toBeNull();
    // Only the head before the top-level packages and snapshots is parsed.
    const head = PNPM_V9.slice(0, PNPM_V9.indexOf("\npackages:") + 1);
    expect(locked(`${head}packages:\n${"  x@1.0.0: {}\n".repeat(100_000)}`, "next")).toBe("16.4.2");
    expect(locked(`${head}snapshots:\n  next@16.4.2: {\n`, "next")).toBe("16.4.2");
  });

  it.each([
    ["lockfile v5", "lockfileVersion: 5.4\ndependencies:\n  next: 16.4.1\n"],
    [
      "lockfile v7",
      "lockfileVersion: '7.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        version: 16.4.1\n",
    ],
    [
      "unquoted version number",
      "lockfileVersion: 9.0\nimporters:\n  .:\n    dependencies:\n      next:\n        version: 16.4.1\n",
    ],
    ["a scalar root importer", "lockfileVersion: '9.0'\nimporters:\n  .: next\n"],
    [
      "an alias",
      "lockfileVersion: '9.0'\nimporters:\n  .: &root\n    dependencies:\n      next:\n        version: 16.4.1\n  copy: *root\n",
    ],
    [
      "a custom tag",
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        version: !semver 16.4.1\n",
    ],
    [
      "a YAML 1.1 tag",
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        version: !!binary MTYuNC4x\n",
    ],
    ["several documents", "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n"],
    ["invalid YAML", "lockfileVersion: '9.0'\nimporters: [\n"],
    ["deep nesting", `lockfileVersion: '9.0'\nimporters: ${"[".repeat(50_000)}\n`],
    [
      "a head over 256 KiB",
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        version: 16.4.1\n# ${"x".repeat(256 * 1024)}\npackages: {}\n`,
    ],
  ])("resolves nothing from pnpm-lock.yaml with %s", (_name, text) => {
    expect(lockedPackageVersions({ name: "pnpm-lock.yaml", text })("next")).toBeNull();
  });

  it("resolves nothing from other lockfiles, oversized text or a non-string body", () => {
    const npm = npmLockfile({ "node_modules/next": { version: "16.4.2" } });
    const next = (name: string, text: string) => lockedPackageVersions({ name, text })("next");
    for (const name of ["yarn.lock", "bun.lock", "bun.lockb", "deno.lock", "package.json"])
      expect(next(name, npm)).toBeNull();
    const padded = npmLockfile({
      "node_modules/next": { version: "16.4.2", description: "e".repeat(3 * 1024 * 1024) },
    });
    expect(next("package-lock.json", padded)).toBe("16.4.2");
    expect(next("package-lock.json", `${npm}${" ".repeat(5 * 1024 * 1024)}`)).toBeNull();
    expect(next("package-lock.json", 42 as unknown as string)).toBeNull();
  });
});

const NPM_COMMANDS = { install: "npm ci --ignore-scripts", command: "npm run build" } as const;
const PNPM_COMMANDS = {
  install: "pnpm install --frozen-lockfile --ignore-scripts",
  command: "pnpm run build",
} as const;
const TANSTACK_STATIC_CONFIG = [
  'import { tanstackStart } from "@tanstack/react-start/plugin/vite";',
  'import viteReact from "@vitejs/plugin-react";',
  "export default { plugins: [tanstackStart({ prerender: { enabled: true } }), viteReact()] };",
].join("\n");
const TANSTACK_EDGE_CONFIG = [
  'import { cloudflare } from "@cloudflare/vite-plugin";',
  'import { tanstackStart } from "@tanstack/react-start/plugin/vite";',
  "export default { plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart()] };",
].join("\n");
const TAILWIND_TURBOPACK_RULE =
  'turbopack: { rules: { "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" } } }';
const TAILWIND_TURBOPACK_CONFIG = `export default { ${TAILWIND_TURBOPACK_RULE} };`;
// The application-root files the Next.js Webpack build reads PostCSS from.
const POSTCSS_CONFIGURATIONS = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.json",
  ".postcssrc.json",
  ".postcssrc.js",
] as const;
const RULE_SOURCES = {
  astro: {
    configuration: { build: { ...NPM_COMMANDS, output: "dist" }, runtime: { mode: "static" } },
    manifest: {
      packageManager: "npm@11.5.1",
      scripts: { build: "astro build" },
      devDependencies: { astro: "7.4.0" },
    },
    files: ["package.json", "package-lock.json", "astro.config.mjs", "src/pages/index.astro"],
    config: { path: "astro.config.mjs", text: 'export default { output: "static" };' },
  },
  nextjs: {
    configuration: {
      build: { ...NPM_COMMANDS, output: ".open-next/assets" },
      runtime: { mode: "edge" },
    },
    manifest: {
      packageManager: "npm@11.5.1",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.1.2", "react-dom": "19.1.2" },
    },
    files: ["package.json", "package-lock.json", "next.config.ts", "src/app/page.tsx"],
    config: { path: "next.config.ts", text: "export default { reactStrictMode: true };" },
  },
  "vite-static": {
    configuration: { build: { ...PNPM_COMMANDS, output: "dist" }, runtime: { mode: "static" } },
    manifest: {
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    },
    files: ["package.json", "pnpm-lock.yaml", "index.html", "vite.config.ts"],
    config: { path: "vite.config.ts", text: "export default {};" },
  },
  "tanstack-start": {
    configuration: {
      build: { ...PNPM_COMMANDS, output: "dist/client" },
      runtime: { mode: "static" },
    },
    manifest: {
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build && tsc --noEmit" },
      dependencies: {
        "@tanstack/react-router": "1.170.41",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: { "@vitejs/plugin-react": "6.1.0", vite: "8.2.2" },
    },
    files: ["package.json", "pnpm-lock.yaml", "vite.config.ts"],
    config: { path: "vite.config.ts", text: TANSTACK_STATIC_CONFIG },
  },
  functions: {
    configuration: { build: { install: PNPM_COMMANDS.install }, runtime: { mode: "functions" } },
    manifest: { packageManager: "pnpm@10.28.2", dependencies: {} },
    files: ["package.json", "pnpm-lock.yaml", "src/ohmyhost/worker.ts"],
    config: null,
  },
} as const;

interface RuleOverrides {
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly files?: readonly string[];
  readonly packageManager?: null;
  readonly lockfile?: FrameworkSourceRuleInput["lockfile"];
  readonly config?: string | null;
}

type RuleCase = [
  string,
  FrameworkSourceFramework,
  RuleOverrides,
  readonly Readonly<Record<string, string>>[],
];

function ruleInput(
  framework: FrameworkSourceFramework,
  overrides: RuleOverrides = {},
): FrameworkSourceRuleInput {
  const source = RULE_SOURCES[framework];
  const manifest = overrides.manifest ?? source.manifest;
  const files = overrides.files ?? source.files;
  return {
    framework,
    files,
    configuration: parseOhmyhostConfig({
      version: 1,
      project: "website",
      ...source.configuration,
      ...overrides.configuration,
    }),
    manifest,
    packageManager:
      overrides.packageManager === null
        ? null
        : resolvePackageManager({ packageManager: String(manifest["packageManager"]), files }),
    lockfile: overrides.lockfile ?? null,
    frameworkConfig:
      source.config === null || overrides.config === null
        ? null
        : { path: source.config.path, text: overrides.config ?? source.config.text },
  };
}

const corpusSources = [
  ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted,
  ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.pending,
  ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused,
];

function corpusFiles(name: string): Readonly<Record<string, string>> {
  const source = corpusSources.find((entry) => entry.name.startsWith(name));
  if (source === undefined) throw new Error(`The conformance corpus has no source ${name}`);
  return source.files;
}

function withoutFiles(
  files: Readonly<Record<string, string>>,
  ...paths: readonly string[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => !paths.includes(path)));
}

const finding = (code: string, path: string, fields: Readonly<Record<string, string>> = {}) => ({
  code,
  path,
  ...fields,
});

describe("framework source rules", () => {
  it.each(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted)(
    "admits the conformance source: $name",
    ({ files }) => {
      const result = repositorySourceFindings(new Map(Object.entries(files)));
      expect(result.findings).toEqual([]);
      expect(result.versions.length).toBeGreaterThan(0);
      expect(result.versions.every(({ status }) => status === "admitted")).toBe(true);
      expect(Object.isFrozen(files)).toBe(true);
      expect(Object.isFrozen(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS)).toBe(true);
      expect(Object.isFrozen(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted)).toBe(true);
    },
  );

  it.each(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.pending)(
    "admits the conformance source pending its installed versions: $name",
    ({ files, packages }) => {
      const result = repositorySourceFindings(new Map(Object.entries(files)));
      expect(result.findings).toEqual([]);
      expect(result.versions.every(({ status }) => status !== "unsupported")).toBe(true);
      expect(
        result.versions.filter(({ status }) => status === "pending").map((entry) => entry.package),
      ).toEqual(packages);
      expect(Object.isFrozen(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.pending)).toBe(true);
    },
  );

  it.each(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused)(
    "refuses the conformance source with its first diagnostic: $name",
    ({ files, diagnostic }) => {
      const result = repositorySourceFindings(new Map(Object.entries(files)));
      expect(result.findings[0]).toEqual(diagnostic);
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(frameworkConversionDetail(diagnostic)).toMatch(/plan the new commit\.$/u);
      expect(Object.isFrozen(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused)).toBe(true);
    },
  );

  it.each<RuleCase>([
    ["an admitted Next.js source", "nextjs", {}, []],
    [
      "Next.js runtime packages outside dependencies",
      "nextjs",
      {
        manifest: {
          packageManager: "npm@11.5.1",
          scripts: { build: "next build" },
          dependencies: { react: "^19.1.0" },
          devDependencies: { next: "16.4.1" },
        },
      },
      [
        finding("framework_dependency_required", "package.json", { package: "next" }),
        finding("framework_dependency_required", "package.json", { package: "react-dom" }),
        finding("react_version_exact_required", "package.json", { package: "react" }),
      ],
    ],
    [
      "a Next.js range that package-lock.json resolves below the floor",
      "nextjs",
      {
        manifest: {
          ...RULE_SOURCES.nextjs.manifest,
          dependencies: { next: "^16.3.0", react: "19.1.2", "react-dom": "19.1.2" },
        },
        lockfile: {
          name: "package-lock.json",
          text: JSON.stringify({
            lockfileVersion: 3,
            packages: { "node_modules/next": { version: "16.4.0" } },
          }),
        },
      },
      [
        finding("framework_version_unsupported", "package-lock.json", {
          package: "next",
          version: "16.4.0",
          minimum: "16.4.5",
        }),
      ],
    ],
    [
      "a Next.js range that pnpm-lock.yaml resolves to a prerelease",
      "nextjs",
      {
        manifest: {
          ...RULE_SOURCES.nextjs.manifest,
          packageManager: "pnpm@10.28.2",
          dependencies: { next: "^16.4.1", react: "19.1.2", "react-dom": "19.1.2" },
        },
        files: ["package.json", "pnpm-lock.yaml", "next.config.ts"],
        lockfile: {
          name: "pnpm-lock.yaml",
          text: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        specifier: ^16.4.1\n        version: 16.5.0-canary.12(react@19.1.2)\n",
        },
      },
      [
        finding("framework_version_unsupported", "pnpm-lock.yaml", {
          package: "next",
          version: "16.5.0-canary.12",
          minimum: "16.4.5",
        }),
      ],
    ],
    [
      "Next.js runtime, Worker module and auth configuration",
      "nextjs",
      {
        configuration: {
          build: {
            install: "npm install",
            command: "next build",
            output: "out",
            ssg_cache_max_mib: 16,
          },
          runtime: { mode: "static" },
          functions: { crons: ["*/5 * * * *"] },
          auth: { provider: "better-auth" },
        },
      },
      [
        finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "nextjs" }),
        finding("worker_module_required", "src/ohmyhost/worker.ts"),
        finding("managed_auth_database_required", "ohmyhost.yaml"),
        finding("better_auth_version_required", "package.json"),
      ],
    ],
    [
      "every Next.js config rule",
      "nextjs",
      {
        config: `module.exports = { basePath: "/x", output: "standalone", cacheComponents: true, partialPrefetching: true, ${TAILWIND_TURBOPACK_RULE} };`,
      },
      [
        finding("next_base_path_unsupported", "next.config.ts"),
        finding("next_output_unsupported", "next.config.ts"),
        finding("next_tailwind_turbopack_only", "next.config.ts"),
        finding("framework_config_default_export_required", "next.config.ts"),
      ],
    ],
    ...POSTCSS_CONFIGURATIONS.map(
      (path): RuleCase => [
        `a Tailwind CSS Turbopack rule beside ${path}`,
        "nextjs",
        { config: TAILWIND_TURBOPACK_CONFIG, files: [...RULE_SOURCES.nextjs.files, path] },
        [],
      ],
    ),
    [
      "a Tailwind CSS Turbopack rule beside a package.json postcss object",
      "nextjs",
      {
        config: TAILWIND_TURBOPACK_CONFIG,
        manifest: {
          ...RULE_SOURCES.nextjs.manifest,
          postcss: { plugins: { "@tailwindcss/postcss": {} } },
        },
      },
      [],
    ],
    [
      "a Tailwind CSS Turbopack rule with PostCSS below the root, in files Webpack skips or a string",
      "nextjs",
      {
        config: TAILWIND_TURBOPACK_CONFIG,
        files: [
          ...RULE_SOURCES.nextjs.files,
          "src/postcss.config.mjs",
          ".postcssrc",
          "postcss.config.ts",
          "postcss.config.mts",
          "postcss.config.cts",
          "postcss.config.json5",
        ],
        manifest: { ...RULE_SOURCES.nextjs.manifest, postcss: "./postcss.config.mjs" },
      },
      [finding("next_tailwind_turbopack_only", "next.config.ts")],
    ],
    [
      "a Next.js build script with Turbopack",
      "nextjs",
      {
        manifest: { ...RULE_SOURCES.nextjs.manifest, scripts: { build: "next build --turbopack" } },
      },
      [finding("build_script_unsupported", "package.json", { framework: "nextjs" })],
    ],
    [
      "a Vite build script and vite outside its placement",
      "vite-static",
      {
        manifest: {
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build && node deploy.mjs" },
          optionalDependencies: { vite: "8.2.2" },
        },
      },
      [
        finding("build_script_unsupported", "package.json", { framework: "vite-static" }),
        finding("framework_dependency_required", "package.json", { package: "vite" }),
      ],
    ],
    [
      "a Vite range that pnpm-lock.yaml resolves below the floor",
      "vite-static",
      {
        manifest: { ...RULE_SOURCES["vite-static"].manifest, devDependencies: { vite: "^5.4.0" } },
        lockfile: {
          name: "pnpm-lock.yaml",
          text: "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vite:\n        specifier: ^5.4.0\n        version: 5.4.5\n",
        },
      },
      [
        finding("framework_version_unsupported", "pnpm-lock.yaml", {
          package: "vite",
          version: "5.4.5",
          minimum: "5.4.6",
        }),
      ],
    ],
    [
      "every Vite configuration rule",
      "vite-static",
      {
        configuration: {
          build: {
            install: "pnpm install",
            command: "pnpm build",
            output: "build",
            ssg_cache_max_mib: 8,
          },
          database: { enabled: true, migrations: "migrations" },
        },
      },
      [
        finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "vite-static" }),
        finding("build_option_unsupported", "ohmyhost.yaml"),
        finding("build_output_unsupported", "ohmyhost.yaml", { framework: "vite-static" }),
        finding("build_command_mismatch", "ohmyhost.yaml"),
        finding("companion_entry_required", "src/ohmyhost/companion.ts"),
      ],
    ],
    [
      "a Vite edge runtime without its companion",
      "vite-static",
      { configuration: { runtime: { mode: "edge" } } },
      [finding("companion_entry_required", "src/ohmyhost/companion.ts")],
    ],
    [
      "Next path revalidation on another framework",
      "vite-static",
      {
        configuration: { build: { ...PNPM_COMMANDS, output: "dist", next_revalidate_path: true } },
      },
      [finding("build_option_unsupported", "ohmyhost.yaml")],
    ],
    [
      "Vite build commands next to a refused package manager",
      "vite-static",
      {
        packageManager: null,
        configuration: {
          build: { install: "pnpm install", command: "pnpm build", output: "dist" },
        },
      },
      [],
    ],
    [
      "a Vite base and no Vite config",
      "vite-static",
      { config: "export default { base: './' };" },
      [finding("framework_base_path_unsupported", "vite.config.ts")],
    ],
    ["a Vite source without a Vite config", "vite-static", { config: null }, []],
    [
      "TanStack Start runtime packages outside dependencies",
      "tanstack-start",
      {
        manifest: {
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          dependencies: { "@tanstack/react-start": "1.168.60", react: "19.2.8" },
          devDependencies: {
            "@tanstack/react-router": "1.170.41",
            "@vitejs/plugin-react": "6.1.0",
            vite: "8.2.2",
          },
        },
      },
      [
        finding("framework_dependency_required", "package.json", {
          package: "@tanstack/react-router",
        }),
        finding("framework_dependency_required", "package.json", { package: "react-dom" }),
      ],
    ],
    [
      "TanStack Start on the edge without the Cloudflare plugin or the Worker module of its crons",
      "tanstack-start",
      { configuration: { runtime: { mode: "edge" }, functions: { crons: ["0 3 * * *"] } } },
      [
        finding("framework_dependency_required", "package.json", {
          package: "@cloudflare/vite-plugin",
        }),
        finding("worker_module_required", "src/ohmyhost/worker.ts"),
        finding("tanstack_vite_plugins_required", "vite.config.ts"),
      ],
    ],
    [
      "TanStack Start static with crons and project storage",
      "tanstack-start",
      {
        configuration: {
          functions: { crons: ["0 3 * * *"] },
          storage: { provider: "r2", jurisdiction: "us", public: false },
        },
      },
      [finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "tanstack-start" })],
    ],
    [
      "TanStack Start static with ai",
      "tanstack-start",
      { configuration: { ai: { enabled: true, jurisdiction: "eu" } } },
      [finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "tanstack-start" })],
    ],
    [
      "an Astro static site with ai",
      "astro",
      { configuration: { ai: { enabled: true, jurisdiction: "any" } } },
      [finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "astro" })],
    ],
    [
      "TanStack Start static with ai disabled",
      "tanstack-start",
      { configuration: { ai: { enabled: false, jurisdiction: "eu" } } },
      [],
    ],
    [
      "TanStack Start with runtime auto and a base",
      "tanstack-start",
      {
        configuration: { runtime: { mode: "auto" } },
        config: TANSTACK_STATIC_CONFIG.replace("plugins:", "base: '/shop/', plugins:"),
      },
      [
        finding("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "tanstack-start" }),
        finding("framework_base_path_unsupported", "vite.config.ts"),
      ],
    ],
    [
      "TanStack Start and Vite below their floors",
      "tanstack-start",
      {
        manifest: {
          ...RULE_SOURCES["tanstack-start"].manifest,
          dependencies: {
            ...RULE_SOURCES["tanstack-start"].manifest.dependencies,
            "@tanstack/react-start": "1.168.59",
          },
          devDependencies: { "@vitejs/plugin-react": "6.1.0", vite: "5.4.5" },
        },
      },
      [
        finding("framework_version_unsupported", "package.json", {
          package: "@tanstack/react-start",
          version: "1.168.59",
          minimum: "1.168.60",
        }),
        finding("framework_version_unsupported", "package.json", {
          package: "vite",
          version: "5.4.5",
          minimum: "5.4.6",
        }),
      ],
    ],
    [
      "functions with better-auth as an optional dependency",
      "functions",
      {
        configuration: {
          database: { enabled: true, migrations: "migrations" },
          auth: { provider: "better-auth" },
        },
        manifest: {
          packageManager: "pnpm@10.28.2",
          optionalDependencies: { "better-auth": "1.7.7" },
        },
      },
      [],
    ],
    [
      "functions with better-auth at another exact version",
      "functions",
      {
        configuration: {
          database: { enabled: true, migrations: "migrations" },
          auth: { provider: "better-auth" },
        },
        manifest: { packageManager: "pnpm@10.28.2", dependencies: { "better-auth": "1.7.0" } },
      },
      [finding("better_auth_version_required", "package.json")],
    ],
    [
      "every functions configuration rule",
      "functions",
      {
        configuration: { build: { install: NPM_COMMANDS.install } },
        files: ["package.json", "pnpm-lock.yaml"],
      },
      [
        finding("build_command_mismatch", "ohmyhost.yaml"),
        finding("worker_module_required", "src/ohmyhost/worker.ts"),
      ],
    ],
  ])("orders the findings of %s", (_name, framework, overrides, expected) => {
    const result = frameworkSourceFindings(ruleInput(framework, overrides));
    expect(result.findings).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
  });

  it("reports literal Native namespace routes only when Native is selected", () => {
    const files = [
      "package.json",
      "package-lock.json",
      "app/api/auth/v1/route.ts",
      "app/api/auth/v10/route.ts",
      "src/routes/api.auth.v1.callback.ts",
    ];
    const selected = frameworkSourceFindings(
      ruleInput("nextjs", {
        configuration: { auth: { provider: "omh-native" } },
        files,
      }),
    );
    expect(selected.findings).toContainEqual(
      finding("native_auth_route_conflict", "app/api/auth/v1/route.ts"),
    );
    expect(selected.findings).toContainEqual(
      finding("native_auth_route_conflict", "src/routes/api.auth.v1.callback.ts"),
    );
    const external = frameworkSourceFindings(ruleInput("nextjs", { files }));
    expect(external.findings.some((item) => item.code === "native_auth_route_conflict")).toBe(
      false,
    );
  });

  it.each<[string, string, readonly string[]]>([
    ["module.exports = { reactStrictMode: true };", "next.config.js", []],
    ['module["exports"] = { reactStrictMode: true };', "next.config.js", []],
    ["module.exports == {};", "next.config.js", ["framework_config_default_export_required"]],
    ["module.exports = {};", "next.config.mjs", ["framework_config_default_export_required"]],
    ["export default { basePath: '', assetPrefix: '/', port: 3000 };", "next.config.ts", []],
    ["export default { basePath: undefined, assetPrefix: undefined };", "next.config.ts", []],
    ["export default { label: 'basePath', note: 'assetPrefix' };", "next.config.ts", []],
    [
      "export default { ['basePath']: '/computed' };",
      "next.config.ts",
      ["next_base_path_unsupported"],
    ],
    [
      "const basePath = '/x'; export default { basePath };",
      "next.config.ts",
      ["next_base_path_unsupported"],
    ],
    [
      "export default { assetPrefix: `https://cdn.example.com` };",
      "next.config.ts",
      ["next_base_path_unsupported"],
    ],
    [
      "// output: 'export'\n/* loaders: ['@tailwindcss/turbopack'] */ export default {};",
      "next.config.ts",
      [],
    ],
    ["export default { cacheComponents: true, partialPrefetching: true };", "next.config.ts", []],
    [TAILWIND_TURBOPACK_CONFIG, "next.config.ts", ["next_tailwind_turbopack_only"]],
    [
      TAILWIND_TURBOPACK_CONFIG.replace("@tailwindcss/turbopack", "@svgr/webpack"),
      "next.config.ts",
      [],
    ],
    ["export default { output: 'export' };", "next.config.ts", ["next_output_unsupported"]],
    ["export default { a: 'it\\'s' };", "next.config.ts", []],
    ["/* unterminated", "next.config.ts", ["source_syntax_invalid"]],
    ["export default { a: 'unterminated };", "next.config.ts", ["source_syntax_invalid"]],
    ["export default { a: 'escape at the end \\", "next.config.ts", ["source_syntax_invalid"]],
    [
      "x".repeat(MAXIMUM_FRAMEWORK_CONFIG_BYTES + 1),
      "next.config.ts",
      ["framework_config_too_large"],
    ],
    [
      "é".repeat(MAXIMUM_FRAMEWORK_CONFIG_BYTES / 2 + 1),
      "next.config.ts",
      ["framework_config_too_large"],
    ],
    ["export default { base: '/' };", "vite.config.ts", []],
    ["export default { base: undefined, plugins: [] };", "vite.config.ts", []],
    ["export default { base: '' };", "vite.config.ts", ["framework_base_path_unsupported"]],
    ["export default { 'base': '/x' };", "vite.config.ts", ["framework_base_path_unsupported"]],
    [
      "export default { base: process.env.BASE };",
      "vite.config.ts",
      ["framework_base_path_unsupported"],
    ],
    ["export default { label: 'base' };", "vite.config.ts", []],
    ["export default { base: '/ };", "vite.config.ts", ["source_syntax_invalid"]],
    [
      "x".repeat(MAXIMUM_FRAMEWORK_CONFIG_BYTES + 1),
      "vite.config.mjs",
      ["framework_config_too_large"],
    ],
  ])("judges the framework config %#", (text, path, codes) => {
    const findings = path.startsWith("next.config")
      ? nextConfigFindings(text, path, false)
      : viteConfigFindings(text, path);
    expect(findings).toEqual(codes.map((code) => finding(code, path)));
    expect(Object.isFrozen(findings)).toBe(true);
  });

  it.each<[string, string, "edge" | "static" | null, readonly string[], "edge" | "static" | null]>([
    ["the static contract", TANSTACK_STATIC_CONFIG, "static", [], "static"],
    [
      "the static contract on edge",
      TANSTACK_STATIC_CONFIG,
      "edge",
      ["tanstack_vite_plugins_required"],
      "static",
    ],
    ["the static contract without a runtime", TANSTACK_STATIC_CONFIG, null, [], "static"],
    ["the edge contract", TANSTACK_EDGE_CONFIG, "edge", [], "edge"],
    [
      "the edge contract on static",
      TANSTACK_EDGE_CONFIG,
      "static",
      ["tanstack_vite_plugins_required", "tanstack_prerender_required"],
      "edge",
    ],
    [
      "Cloudflare after TanStack Start",
      TANSTACK_EDGE_CONFIG.replace(
        "cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart()",
        "tanstackStart(), cloudflare({ viteEnvironment: { name: 'ssr' } })",
      ),
      "edge",
      ["tanstack_vite_plugins_required"],
      null,
    ],
    [
      "Cloudflare without the SSR environment",
      TANSTACK_EDGE_CONFIG.replace(
        "{ viteEnvironment: { name: 'ssr' } }",
        "{ viteEnvironment: 'ssr' }",
      ),
      "edge",
      ["tanstack_vite_plugins_required"],
      null,
    ],
    [
      "Cloudflare without options",
      TANSTACK_EDGE_CONFIG.replace("{ viteEnvironment: { name: 'ssr' } }", "{}"),
      "edge",
      ["tanstack_vite_plugins_required"],
      null,
    ],
    [
      "a base below the root origin",
      TANSTACK_STATIC_CONFIG.replace("plugins:", "base: '/shop/', plugins:"),
      "static",
      ["framework_base_path_unsupported"],
      "static",
    ],
    [
      "disabled prerender",
      TANSTACK_STATIC_CONFIG.replace("enabled: true", "enabled: false"),
      "static",
      ["tanstack_prerender_required"],
      null,
    ],
    [
      "prerender after nested options",
      TANSTACK_STATIC_CONFIG.replace(
        "{ prerender: { enabled: true } }",
        "{ pages: [{ path: '/' }], filter: ({ path }) => path !== '/x', prerender: { crawlLinks: true, enabled: true } }",
      ),
      "static",
      [],
      "static",
    ],
    [
      "a side-effect import only",
      "import './polyfill';\nexport default {};",
      "static",
      ["tanstack_vite_plugins_required", "tanstack_prerender_required"],
      null,
    ],
    [
      "an unclosed plugin call",
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite';\nexport default { plugins: [tanstackStart({ prerender: { enabled: true }",
      "static",
      ["source_syntax_invalid"],
      null,
    ],
    ["an unterminated comment", "/* unterminated", "static", ["source_syntax_invalid"], null],
    [
      "a config above the inspection limit",
      "x".repeat(MAXIMUM_FRAMEWORK_CONFIG_BYTES + 1),
      "edge",
      ["framework_config_too_large"],
      null,
    ],
  ])("judges the TanStack Start config with %s", (_name, text, runtime, codes, detected) => {
    expect(tanStackViteConfigFindings(text, "vite.config.ts", runtime)).toEqual(
      codes.map((code) => finding(code, "vite.config.ts")),
    );
    expect(tanStackViteConfigRuntime(text)).toBe(detected);
  });

  it("reads dependencies, manifests, lockfile versions, companion needs and modules one way", () => {
    const manifest = {
      packageManager: "npm@11.5.1",
      dependencies: { next: "", react: "19.1.2", toString: 1 },
      devDependencies: { next: "16.4.1", vite: "8.2.2" },
      optionalDependencies: { "better-auth": MANAGED_BETTER_AUTH_VERSION, vite: "9.0.0" },
    };
    expect(declaredDependency(manifest, "next", "runtime")).toBeNull();
    expect(declaredDependency(manifest, "next", "build")).toBe("16.4.1");
    expect(declaredDependency(manifest, "vite", "any")).toBe("8.2.2");
    expect(declaredDependency(manifest, "better-auth", "build")).toBeNull();
    expect(declaredDependency(manifest, "better-auth", "any")).toBe("1.7.7");
    expect(declaredDependency(manifest, "toString", "any")).toBeNull();
    expect(declaredDependency(manifest, "constructor", "any")).toBeNull();
    expect(declaredDependency({ dependencies: ["next"] }, "0", "any")).toBeNull();
    expect([...declaredDependencyNames(manifest)]).toEqual([
      "react",
      "next",
      "vite",
      "better-auth",
    ]);
    expect(packageManagerDeclaration(manifest)).toBe("npm@11.5.1");
    expect(packageManagerDeclaration({ packageManager: 11 })).toBeUndefined();
    expect(parsePackageManifest('{"name":"website"}')).toEqual({ name: "website" });
    expect(parsePackageManifest(manifest)).toBe(manifest);
    for (const invalid of ["{bad", "[]", "null", 1, null, ["next"]])
      expect(parsePackageManifest(invalid)).toBeNull();

    let reads = 0;
    const lockfile = {
      name: "pnpm-lock.yaml",
      get text() {
        reads += 1;
        return "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@tanstack/react-start':\n        specifier: ^1.168.0\n        version: 1.168.61(vite@8.3.4)\n";
      },
    } as const;
    const admissions = frameworkVersionAdmissions(
      "tanstack-start",
      {
        dependencies: { "@tanstack/react-start": "^1.168.0" },
        devDependencies: { vite: "^8.2.0" },
      },
      lockfile,
    );
    expect(admissions).toEqual([
      {
        package: "@tanstack/react-start",
        status: "admitted",
        declared: "^1.168.0",
        resolved: "1.168.61",
        minimum: "1.168.60",
      },
      {
        package: "vite",
        status: "admitted",
        declared: "^8.2.0",
        resolved: null,
        minimum: "5.4.6",
      },
    ]);
    expect(Object.isFrozen(admissions)).toBe(true);
    expect(reads).toBe(1);
    expect(
      frameworkVersionAdmissions("nextjs", { devDependencies: { next: "16.4.1" } }, null),
    ).toEqual([]);
    expect(frameworkVersionAdmissions("functions", manifest, null)).toEqual([]);

    const vite = (value: Readonly<Record<string, unknown>>) =>
      parseOhmyhostConfig({
        version: 1,
        project: "website",
        ...RULE_SOURCES["vite-static"].configuration,
        ...value,
      });
    expect(viteCompanionRequired(vite({}))).toBe(false);
    expect(
      viteCompanionRequired(
        vite({
          database: { enabled: false },
          auth: { provider: "none" },
          mail: { enabled: false },
        }),
      ),
    ).toBe(false);
    for (const capability of [
      { runtime: { mode: "edge" } },
      { database: { enabled: true, migrations: "migrations" } },
      { auth: { provider: "better-auth" } },
      { mail: { enabled: true } },
      { ai: { enabled: true, jurisdiction: "eu" } },
      { storage: { provider: "r2", jurisdiction: "us", public: false } },
      { functions: { crons: ["0 3 * * *"] } },
    ])
      expect(viteCompanionRequired(vite(capability))).toBe(true);

    expect(
      frameworkConversionDetail(finding("better_auth_version_required", "package.json")),
    ).toContain(`exactly ${MANAGED_BETTER_AUTH_VERSION} in dependencies`);
    expect(
      frameworkConversionDetail(finding("framework_config_too_large", "vite.config.ts")),
    ).toContain(`${MAXIMUM_FRAMEWORK_CONFIG_BYTES / 1024} KiB`);
    expect(() => nextConfigFindings("export default {};", "next.config.cjs", false)).toThrow(
      "Framework source diagnostic is invalid",
    );
    expect(() => tanStackViteConfigFindings("export default {};", "src/vite.ts", "static")).toThrow(
      "Framework source diagnostic is invalid",
    );

    // Module rules blank comments in place, including the closing "*/", and keep strings.
    expect(sourceWithoutComments('x = "//"; /* y\n */z // w\n')).toBe(
      'x = "//";     \n   z     \n',
    );
    expect(
      databaseContractCodes('import type { Pool } from "pg";\nconst url = "postgres://db/app";\n'),
    ).toEqual(["database_binding_private", "database_driver_unsupported"]);
    expect(databaseContractCodes("// new Pool({ connectionString })\nexport {};\n")).toEqual([]);
    // A quoted string ends at its line, so an apostrophe in JSX text hides no later comment.
    expect(databaseContractCodes("<p>Don't worry</p>;\n// never reads DATABASE_URL\n")).toEqual([]);
    // A backtick inside a regex literal is not a template, so the comment after the literal stays blank.
    expect(
      databaseContractCodes("const r = /`([^`]+)`/g;\n// never reads DATABASE_URL\nexport {};\n"),
    ).toEqual([]);
    expect(sourceWithoutComments("const r = /`/g;\n// DATABASE_URL\n")).toBe(
      `const r = /\`/g;\n${" ".repeat(15)}\n`,
    );
    // The early hint for `ohmyhost init` reads the raw text, comments included, with string escapes
    // decoded: the specifier in either quote or a template literal, spelled with an escape, after
    // a regex literal that a comment scanner would mistake for a comment, in a comment (an
    // accepted false positive) or in a variable that holds it. Planning decides by parsing.
    for (const source of [
      'import { connect } from "cloudflare:sockets";\n',
      "import {connect} from 'cloudflare:sockets'\n",
      'import "cloudflare:sockets";\n',
      'const { connect } = require("cloudflare:sockets");\n',
      'const sockets = await import(/* tcp */ "cloudflare:sockets");\n',
      "const sockets = await import(`cloudflare:sockets`);\n",
      'const name = "cloudflare:sockets";\nawait import(name);\n',
      'import type { Socket } from "cloudflare:sockets";\n',
      'await import("cloudflare\\x3asockets");\n',
      'await import("cloudflare\\u003Asockets");\n',
      'await import("cloudflare\\u{3a}sockets");\n',
      'await import("\\x63loudflare:sockets");\n',
      'await import("cloudflare\\:sockets");\n',
      'await import("cloud\\\nflare:sockets");\n',
      'const hidden = /[/*]/;\nimport { connect } from "cloudflare:sockets";\n',
      'const hidden = /[//]/; await import("cloudflare:sockets");\n',
      '// import { connect } from "cloudflare:sockets";\nexport {};\n',
    ])
      expect(importsSocketPrimitive(source), source).toBe(true);
    for (const source of [
      'import net from "node:net";\nimport tls from "node:tls";\n',
      'import { env } from "cloudflare:workers";\n',
      'import x from "cloudflare:sockets-fixture";\n',
      'const text = "cloudflare sockets";\n',
      'await import("cloudflare:" + "sockets");\n',
      'await import("cloudflare\\u00zzsockets");\n',
    ])
      expect(importsSocketPrimitive(source), source).toBe(false);
    expect(
      [
        "src/ohmyhost/worker.ts",
        "src/pages/index.astro",
        "src/db.cjs",
        "src/db.cts",
        "src/page.jsx",
        "worker-configuration.d.ts",
        "src/env.d.mts",
        "src/env.d.cts",
        "package.json",
      ].filter((path) => isSocketPrimitiveModule(path)),
    ).toEqual([
      "src/ohmyhost/worker.ts",
      "src/pages/index.astro",
      "src/db.cjs",
      "src/db.cts",
      "src/page.jsx",
    ]);
    // Planning and init judge the same modules; a TypeScript declaration file never runs.
    expect(
      [
        "src/app/page.tsx",
        "src/db.mts",
        "worker-configuration.d.ts",
        "src/env.d.mts",
        "src/env.d.cts",
        "src/db.cjs",
      ].filter((path) => isDatabaseContractModule(path)),
    ).toEqual(["src/app/page.tsx", "src/db.mts"]);
    const worker = (source: string) =>
      workerModuleFindings({ path: WORKER_MODULE_PATH, source, fetch: true, scheduled: true });
    expect(worker("export function fetch() {}\nexport function scheduled() {}\n")).toEqual([
      finding("worker_module_default_export_required", WORKER_MODULE_PATH),
    ]);
    expect(worker("export default {}; // fetch() and scheduled() follow\n")).toEqual([
      finding("worker_module_fetch_handler_required", WORKER_MODULE_PATH),
      finding("scheduled_handler_required", WORKER_MODULE_PATH),
    ]);
    expect(worker("export /* the handlers */ default { fetch, scheduled };\n")).toEqual([]);
    // A slash escaped as in a regex literal opens no comment that would hide the default export.
    expect(
      worker('const t = (p) => p.replace(/\\/*$/, "");\nexport default { fetch, scheduled };\n'),
    ).toEqual([]);
    // Only a key or method names a handler; a scheduled handler calling fetch() serves no request.
    expect(
      worker('export default { async scheduled() { await fetch("https://example.com"); } };\n'),
    ).toEqual([finding("worker_module_fetch_handler_required", WORKER_MODULE_PATH)]);
    expect(
      worker(
        "export default { scheduled(event, env, ctx) { ctx.waitUntil(fetch(url)); return fetch(url); } };\n",
      ),
    ).toEqual([finding("worker_module_fetch_handler_required", WORKER_MODULE_PATH)]);
    // A class method needs no async after another member's "}" or a field's ";".
    for (const members of [
      "scheduled() {} fetch(request) {}",
      "ready = true; fetch(request) {} scheduled() {}",
    ])
      expect(worker(`export default class extends WorkerEntrypoint { ${members} }\n`)).toEqual([]);
    expect(
      workerModuleFindings({
        path: VITE_COMPANION_ENTRY_PATH,
        source: "export default {};\n",
        fetch: false,
        scheduled: false,
      }),
    ).toEqual([]);
  });

  const customer = corpusFiles("Next.js 16.4.5 with npm");
  const tanStack = corpusFiles("TanStack Start 1.168.60");
  const rooted = (files: Readonly<Record<string, string>>, root: string) => ({
    "ohmyhost.yaml": `${files["ohmyhost.yaml"] ?? ""}applicationRoot: ${root}\n`,
    ...Object.fromEntries(
      Object.entries(withoutFiles(files, "ohmyhost.yaml")).map(([path, text]) => [
        `${root}/${path}`,
        text,
      ]),
    ),
  });

  it.each<
    [
      string,
      Readonly<Record<string, string | null>>,
      FrameworkSourceFramework | null,
      readonly Readonly<Record<string, string>>[],
    ]
  >([
    [
      "no ohmyhost.yaml",
      withoutFiles(customer, "ohmyhost.yaml"),
      null,
      [finding("repository_configuration_invalid", "ohmyhost.yaml")],
    ],
    [
      "an ohmyhost.yaml that is not text",
      { ...customer, "ohmyhost.yaml": null },
      null,
      [finding("repository_configuration_invalid", "ohmyhost.yaml")],
    ],
    [
      "an application root without files",
      {
        ...customer,
        "ohmyhost.yaml": `${customer["ohmyhost.yaml"] ?? ""}applicationRoot: website\n`,
      },
      null,
      [finding("application_root_missing", "ohmyhost.yaml")],
    ],
    ["a nested application root", rooted(customer, "website"), "nextjs", []],
    [
      "no package.json",
      withoutFiles(customer, "package.json"),
      null,
      [finding("package_manifest_invalid", "package.json")],
    ],
    [
      "a package.json array",
      { ...customer, "package.json": "[]" },
      null,
      [finding("package_manifest_invalid", "package.json")],
    ],
    [
      "no framework",
      { ...customer, "package.json": '{"dependencies":{"react":"19.1.2"}}' },
      null,
      [finding("framework_unsupported", "package.json")],
    ],
    [
      "two frameworks",
      { ...customer, "package.json": '{"dependencies":{"next":"16.4.1","vite":"8.2.2"}}' },
      null,
      [finding("framework_ambiguous", "package.json")],
    ],
    [
      "the functions runtime selected by ohmyhost.yaml",
      {
        ...customer,
        "ohmyhost.yaml": `version: 1\nproject: website\nbuild:\n  install: ${NPM_COMMANDS.install}\nruntime:\n  mode: functions\n`,
        "src/ohmyhost/worker.ts": "export default { fetch: () => new Response('ok') };\n",
      },
      "functions",
      [],
    ],
    [
      "no lockfile and ambiguous configs",
      {
        ...withoutFiles(customer, "package-lock.json"),
        "next.config.js": "module.exports = {};",
        "open-next.config.mjs": "export default {};",
        "open-next.config.ts": "export default {};",
      },
      "nextjs",
      [
        finding("lockfile_missing", "package.json"),
        finding("framework_config_ambiguous", "next.config.js"),
        finding("framework_config_ambiguous", "open-next.config.mjs"),
      ],
    ],
    [
      "a TanStack Start source without a Vite config",
      withoutFiles(tanStack, "vite.config.ts"),
      "tanstack-start",
      [finding("framework_config_required", "vite.config.ts")],
    ],
    [
      "a Next.js source without a Next.js config",
      withoutFiles(customer, "next.config.ts"),
      "nextjs",
      [finding("framework_config_required", "next.config.ts")],
    ],
    [
      "a Next.js config that is not text",
      { ...customer, "next.config.ts": null },
      "nextjs",
      [finding("source_syntax_invalid", "next.config.ts")],
    ],
  ])("judges a repository with %s", (_name, files, framework, expected) => {
    const result = repositorySourceFindings(new Map(Object.entries(files)));
    expect(result.framework).toBe(framework);
    expect(result.findings).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("blanks comments after a long run of slashes that open no regex literal in linear time", () => {
    // Every slash after "[" may open a regex literal, and none of them closes on its line.
    const slashes = "[/".repeat(100_000);
    const started = performance.now();
    expect(sourceWithoutComments(`${slashes}\n// DATABASE_URL\n`)).toBe(
      `${slashes}\n${" ".repeat(15)}\n`,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
