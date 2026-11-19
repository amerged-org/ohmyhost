import { createHash, webcrypto } from "node:crypto";

import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/application-root";
import {
  FrameworkAdmissionError,
  rootFrameworkConversionDiagnostic,
} from "@ohmyhost/contracts/framework-admission";
import { FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/framework-admission-corpus";
import { NextWorkersIncompatibleError } from "@ohmyhost/adapter-next";
import { serializeNewProductionFrameworkPlanPreimage } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";
import * as typescript from "typescript";

import {
  FrameworkConversionRequiredError,
  inspectFrameworkArchive,
  inspectViteArchive,
  MigrationFilenameNoncanonicalError,
  ViteArchiveInspectionError,
} from "../src/index.js";
import {
  gzipTar,
  nestedApplicationEntries,
  nextEdgeEntries,
  sourceEntries,
  tanStackEdgeEntries,
  tanStackEntries,
  tar,
  viteCompanionEntries,
  viteEntries,
  type TarFixtureEntry,
} from "./tar-fixture.js";

describe("bounded Vite tarball inspection", () => {
  it("inspects root and nested Worker and HTTP-only companion modules before validating handlers", async () => {
    for (const fixture of httpModuleEntries()) {
      const root = await inspectFrameworkArchive(await gzipTar(fixture.entries));
      expect(root.frameworkPlan).toMatchObject({
        applicationRoot: ".",
        runtime: fixture.runtime,
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
        functions: { crons: ["0 3 * * *"] },
      });
      for (const applicationRoot of ["site", "apps/customer"]) {
        const nested = await inspectFrameworkArchive(
          await gzipTar(
            httpModuleAtRoot(fixture.entries, applicationRoot, [
              {
                path: "fixture/apps/customer-sibling/src/ohmyhost/worker.ts",
                content: new Uint8Array([0xff]),
              },
              {
                path: `fixture/${applicationRoot}/tooling/build.ts`,
                content: 'import subprocess from "node:child_process"; export default subprocess;',
              },
              {
                path: `fixture/${applicationRoot}/ohmyhost.yaml`,
                content: "version: 1\nproject: shadow\nruntime:\n  mode: static\n",
              },
            ]),
          ),
        );
        expect(nested.frameworkPlan).toEqual({ ...root.frameworkPlan, applicationRoot });
        expect(nested.companionSource).toEqual(root.companionSource);
        expect(nested.buildPlanSha256).not.toBe(root.buildPlanSha256);
      }
      const socket = fixture.entries.map((entry) =>
        entry.path.endsWith("answer.mjs")
          ? { ...entry, content: 'import { Pool } from "pg"; export const answer = Pool;' }
          : entry,
      );
      await expect(
        inspectFrameworkArchive(await gzipTar(httpModuleAtRoot(socket, "apps/customer"))),
      ).rejects.toMatchObject({
        diagnostic: {
          code: "database_driver_unsupported",
          path: "apps/customer/src/server/answer.mjs",
        },
      });
    }
  });

  it("keeps sibling modules outside the selected app and still requires default and scheduled handlers", async () => {
    for (const fixture of httpModuleEntries()) {
      const source = httpModuleAtRoot(fixture.entries, "apps/customer", [
        {
          path: `fixture/apps/customer-sibling/${fixture.modulePath}`,
          content: "export default { fetch() { return new Response(); }, scheduled() {} };",
        },
      ]);
      for (const content of [
        undefined,
        "export function fetch() { return new Response(); } export function scheduled() {}",
        "export default { fetch() { return new Response(); } }; /* scheduled() {} */",
      ]) {
        const entries = source.flatMap((entry) =>
          entry.path !== `fixture/apps/customer/${fixture.modulePath}`
            ? [entry]
            : content === undefined
              ? []
              : [{ ...entry, content }],
        );
        // Every diagnostic names its file from the repository root, like the build and init do.
        await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
          name: "FrameworkConversionRequiredError",
          adapter: fixture.runtime === "functions" ? "functions" : "vite-static",
          diagnostic: {
            code:
              content === undefined
                ? fixture.runtime === "functions"
                  ? "worker_module_required"
                  : "companion_entry_required"
                : content.startsWith("export function")
                  ? "worker_module_default_export_required"
                  : "scheduled_handler_required",
            path: `apps/customer/${fixture.modulePath}`,
          },
        });
      }
      const database = source.map((entry) =>
        entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
          ? {
              ...entry,
              content: `${entry.content}database:\n  enabled: true\n  migrations: migrations\n`,
            }
          : entry.path === `fixture/apps/customer/${fixture.modulePath}`
            ? {
                ...entry,
                content:
                  "export default { fetch(request: Request, env: { DATABASE_URL: string }) { return new Response(env.DATABASE_URL); }, scheduled() {} };",
              }
            : entry,
      );
      await expect(inspectFrameworkArchive(await gzipTar(database))).rejects.toMatchObject({
        diagnostic: {
          code: "database_binding_private",
          path: `apps/customer/${fixture.modulePath}`,
        },
      });
      await expect(
        inspectFrameworkArchive(
          await gzipTar([
            ...source,
            { path: "fixture/apps/customer/../escape.ts", content: "export {};" },
          ]),
        ),
      ).rejects.toBeInstanceOf(ViteArchiveInspectionError);
    }
  });

  it("preserves source byte limits and UTF-8 validation for selected nested entry modules and imports", async () => {
    for (const fixture of httpModuleEntries()) {
      for (const applicationRoot of [".", "apps/customer"]) {
        for (const path of [fixture.modulePath, "src/server/answer.mjs"]) {
          const oversized = fixture.entries.map((entry) =>
            entry.path === `fixture/${path}`
              ? { ...entry, content: `/*${"x".repeat(256 * 1024)}*/` }
              : entry,
          );
          await expect(
            inspectFrameworkArchive(await gzipTar(httpModuleAtRoot(oversized, applicationRoot))),
          ).rejects.toBeInstanceOf(FrameworkConversionRequiredError);
        }
        const invalidUtf8 = fixture.entries.map((entry) =>
          entry.path.endsWith("answer.mjs") ? { ...entry, content: new Uint8Array([0xff]) } : entry,
        );
        await expect(
          inspectFrameworkArchive(await gzipTar(httpModuleAtRoot(invalidUtf8, applicationRoot))),
        ).rejects.toMatchObject({
          diagnostic: {
            code: "source_syntax_invalid",
            path: `${applicationRoot === "." ? "" : `${applicationRoot}/`}src/server/answer.mjs`,
          },
        });
      }
    }
  });

  it("inspects reachable server helpers across Worker frameworks while leaving build-only files alone", async () => {
    const fixtures = [
      { entries: viteCompanionEntries(), entry: "fixture/src/ohmyhost/companion.ts" },
      { entries: nextEdgeEntries(), entry: "fixture/src/app/page.tsx" },
      { entries: tanStackEdgeEntries(), entry: "fixture/src/routes/index.tsx" },
    ];
    for (const fixture of fixtures) {
      const entries = fixture.entries.map((entry) =>
        entry.path === fixture.entry
          ? {
              ...entry,
              content: 'import "@/server/db"; export default {fetch(){return new Response("ok")}};',
            }
          : entry,
      );
      const shared = [
        {
          path: "fixture/tsconfig.json",
          content: JSON.stringify({
            compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
          }),
        },
        {
          path: "fixture/src/server/db.ts",
          content: 'import { Pool } from "pg"; export const db = Pool;',
        },
        {
          path: "fixture/tooling/build.ts",
          content: 'import fs from "node:child_process"; export default fs;',
        },
      ];
      await expect(
        inspectFrameworkArchive(await gzipTar([...entries, ...shared])),
      ).rejects.toMatchObject({
        diagnostic: { code: "database_driver_unsupported", path: "src/server/db.ts" },
      });
      const working = shared.map((entry) =>
        entry.path.endsWith("db.ts")
          ? { ...entry, content: 'import SDK from "@customer/https-sdk"; export default SDK;' }
          : entry,
      );
      await expect(
        inspectFrameworkArchive(await gzipTar([...entries, ...working])),
      ).resolves.toHaveProperty("frameworkPlan");
    }
  });

  it("rejects a native addon reached through re-exports and a literal dynamic import", async () => {
    const entries = viteCompanionEntries().map((entry) =>
      entry.path.endsWith("companion.ts")
        ? {
            ...entry,
            content:
              'import "../server/service"; export default {fetch(){return new Response("ok")}};',
          }
        : entry,
    );
    await expect(
      inspectFrameworkArchive(
        await gzipTar([
          ...entries,
          { path: "fixture/src/server/service.ts", content: 'export * from "./loader";' },
          {
            path: "fixture/src/server/loader.ts",
            content: 'export async function load(){return import("./codec.node");}',
          },
        ]),
      ),
    ).rejects.toMatchObject({
      findings: [
        { code: "native_addon_unsupported", path: "src/server/loader.ts", module: "./codec.node" },
      ],
    });
  });

  it("resolves inherited JSONC aliases for functions without treating type imports as sockets", async () => {
    const entries = viteEntries().filter(
      (entry) => !entry.path.endsWith("ohmyhost.yaml") && !entry.path.endsWith("package.json"),
    );
    const fixtures: TarFixtureEntry[] = [
      ...entries,
      {
        path: "fixture/ohmyhost.yaml",
        content:
          "version: 1\nproject: fixture\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\nruntime:\n  mode: functions\n",
      },
      { path: "fixture/package.json", content: '{"packageManager":"pnpm@10.28.2"}' },
      {
        path: "fixture/src/ohmyhost/worker.ts",
        content: 'import "@/server/db"; export default {fetch(){return new Response("ok")}};',
      },
      {
        path: "fixture/tsconfig.json",
        content: '{ // inherited paths\n"extends":"./configs/base",\n}',
      },
      {
        path: "fixture/configs/base.json",
        content:
          '{ /* paths remain data */ "compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*",],},},}',
      },
      {
        path: "fixture/src/server/db.ts",
        content:
          'import type {Pool} from "pg"; import net from "node:net"; export default net.isIP("127.0.0.1");',
      },
    ];
    await expect(inspectFrameworkArchive(await gzipTar(fixtures))).resolves.toMatchObject({
      frameworkPlan: { runtime: "functions" },
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          fixtures.map((entry) =>
            entry.path.endsWith("db.ts")
              ? { ...entry, content: 'const db = require("mysql2/promise"); export default db;' }
              : entry,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      diagnostic: { code: "database_driver_unsupported", path: "src/server/db.ts" },
    });
    for (const variant of [
      {
        child: '{"extends":"./configs/base"}',
        parent: '{"compilerOptions":{"paths":{"@/*":["../src/*"]}}}',
        imported: "@/server/db",
      },
      {
        child: '{"extends":"./configs/base","compilerOptions":{"baseUrl":"."}}',
        parent: '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
        imported: "@/server/db",
      },
      {
        child: '{"extends":"./configs/base"}',
        parent: '{"compilerOptions":{"baseUrl":"../src"}}',
        imported: "server/db",
      },
    ]) {
      const source = fixtures.map((entry) =>
        entry.path.endsWith("tsconfig.json")
          ? { ...entry, content: variant.child }
          : entry.path.endsWith("configs/base.json")
            ? { ...entry, content: variant.parent }
            : entry.path.endsWith("worker.ts")
              ? {
                  ...entry,
                  content: `import "${variant.imported}"; export default {fetch(){return new Response("ok")}};`,
                }
              : entry.path.endsWith("db.ts")
                ? { ...entry, content: 'import {Pool} from "pg"; export default Pool;' }
                : entry,
      );
      const files = new Map(
        source.flatMap((entry) =>
          typeof entry.content === "string"
            ? [[entry.path.replace(/^fixture/u, "/project"), entry.content] as const]
            : [],
        ),
      );
      const host = {
        readFile: (name: string) => files.get(name),
        fileExists: (name: string) => files.has(name),
        readDirectory: () => [],
        useCaseSensitiveFileNames: true,
      };
      const config = typescript.readJsonConfigFile("/project/tsconfig.json", host.readFile);
      const parsed = typescript.parseJsonSourceFileConfigFileContent(config, host, "/project");
      expect(
        typescript.resolveModuleName(
          variant.imported,
          "/project/src/ohmyhost/worker.ts",
          parsed.options,
          host,
        ).resolvedModule?.resolvedFileName,
      ).toBe("/project/src/server/db.ts");
      await expect(inspectFrameworkArchive(await gzipTar(source))).rejects.toMatchObject({
        diagnostic: { code: "database_driver_unsupported", path: "src/server/db.ts" },
      });
    }
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          fixtures.map((entry) =>
            entry.path.endsWith("db.ts")
              ? { ...entry, content: `export default "${"x".repeat(262_144)}";` }
              : entry,
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "framework_conversion_required", diagnostic: null });
  });

  it("identifies a missing repository config without trusting a nested config", async () => {
    const entries = nestedApplicationEntries(viteEntries()).map((entry) =>
      entry.path === "fixture/ohmyhost.yaml"
        ? { ...entry, path: "fixture/site/ohmyhost.yaml" }
        : entry,
    );
    await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
      code: "repository_configuration_missing",
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar([...entries, { path: "fixture/../escape", content: "unsafe" }]),
      ),
    ).rejects.toBeInstanceOf(ViteArchiveInspectionError);
    await expect(
      inspectFrameworkArchive(await gzipTar(nestedApplicationEntries(viteEntries()))),
    ).resolves.toMatchObject({
      frameworkPlan: { applicationRoot: "site", runtime: "static" },
    });
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)(
    "accepts shared application root: $name",
    async ({ value }) => {
      await expect(
        inspectFrameworkArchive(await gzipTar(viteEntriesAtApplicationRoot(value))),
      ).resolves.toMatchObject({
        frameworkPlan: {
          schemaVersion: "ohmyhost.framework-plan/v5",
          applicationRoot: value,
          adapter: "vite-static",
        },
        buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    },
  );

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)(
    "rejects shared application root: $name",
    async ({ value }) => {
      await expect(
        inspectFrameworkArchive(await gzipTar(viteEntriesWithConfiguredRoot(value))),
      ).rejects.toMatchObject({
        name: "FrameworkConversionRequiredError",
        adapter: null,
        requirement: null,
        diagnostic: { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
      });
    },
  );

  it.each([
    ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted,
    ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.pending,
  ])("plans shared admission source: $name", async ({ files }) => {
    for (const applicationRoot of [".", "apps/site"]) {
      await expect(
        inspectFrameworkArchive(await gzipTar(sourceEntries(files, applicationRoot))),
      ).resolves.toMatchObject({
        frameworkPlan: { schemaVersion: "ohmyhost.framework-plan/v5", applicationRoot },
        buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
    }
  });

  it.each(FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused)(
    "refuses shared admission source with its first diagnostic: $name",
    async ({ files, diagnostic }) => {
      for (const applicationRoot of [".", "apps/site"]) {
        const failure: unknown = await inspectFrameworkArchive(
          await gzipTar(sourceEntries(files, applicationRoot)),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(FrameworkConversionRequiredError);
        // The application-relative finding of the shared rules, named from the repository root.
        expect((failure as FrameworkConversionRequiredError).diagnostic).toEqual(
          rootFrameworkConversionDiagnostic(diagnostic, applicationRoot),
        );
      }
    },
  );

  it.each(["minimal", "Lovable-like"])(
    "detects and plans a %s Vite fixture deterministically",
    async () => {
      const archive = await gzipTar(viteEntries());
      const first = await inspectViteArchive(archive, webcrypto.subtle as unknown as SubtleCrypto);
      const second = await inspectViteArchive(archive, webcrypto.subtle as unknown as SubtleCrypto);
      expect(first).toEqual({
        frameworkPlan: {
          schemaVersion: "ohmyhost.framework-plan/v5",
          applicationRoot: ".",
          adapter: "vite-static",
          runtime: "static",
          installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
          buildCommand: "pnpm run build",
          outputDirectory: "dist",
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
          database: { enabled: false },
          auth: { provider: "none" },
          mail: { enabled: false },
          storage: { enabled: false },
        },
        buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(second).toEqual(first);
      expect(Object.isFrozen(first)).toBe(true);
    },
  );

  it.each([
    ["npm", "npm@11.5.2", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
    [
      "pnpm",
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    [
      "Yarn",
      "yarn@4.10.3",
      "yarn.lock",
      "yarn install --immutable --mode=skip-build",
      "yarn run build",
    ],
    [
      "Bun",
      "bun@1.2.22",
      "bun.lock",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
    [
      "Bun binary lockfile",
      "bun@1.2.22",
      "bun.lockb",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
  ] as const)(
    "admits one matching %s package-manager declaration and lockfile",
    async (_name, packageManager, lockfile, installCommand, buildCommand) => {
      const archive = await gzipTar(
        packageManagerEntries(viteEntries(), {
          packageManager,
          lockfile,
          installCommand,
          buildCommand,
        }),
      );

      await expect(inspectFrameworkArchive(archive)).resolves.toMatchObject({
        frameworkPlan: {
          adapter: "vite-static",
          installCommand,
          buildCommand,
        },
      });
    },
  );

  it.each([
    [
      "missing declaration",
      undefined,
      ["pnpm-lock.yaml"],
      "package_manager_missing",
      "package.json",
    ],
    [
      "mismatched lockfile",
      "pnpm@10.28.2",
      ["package-lock.json"],
      "package_manager_lockfile_mismatch",
      "package-lock.json",
    ],
    [
      "ambiguous lockfiles",
      "pnpm@10.28.2",
      ["pnpm-lock.yaml", "package-lock.json"],
      "lockfile_ambiguous",
      "package.json",
    ],
    ["missing lockfile", "pnpm@10.28.2", [], "lockfile_missing", "package.json"],
    [
      "declaration with a hash suffix",
      "pnpm@10.28.2+sha512.0123",
      ["pnpm-lock.yaml"],
      "package_manager_invalid",
      "package.json",
    ],
    [
      "Bun version other than the pinned one",
      "bun@1.2.21",
      ["bun.lock"],
      "package_manager_version_unsupported",
      "package.json",
    ],
  ] as const)(
    "answers a package-manager %s as a framework conversion blocker",
    async (_name, packageManager, lockfiles, code, path) => {
      const entries = viteEntries()
        .filter((entry) => !entry.path.endsWith("pnpm-lock.yaml"))
        .map((entry) =>
          entry.path === "fixture/package.json" && typeof entry.content === "string"
            ? {
                ...entry,
                content: JSON.stringify({
                  ...(JSON.parse(entry.content) as Record<string, unknown>),
                  ...(packageManager === undefined
                    ? { packageManager: undefined }
                    : { packageManager }),
                }),
              }
            : entry,
        );
      entries.push(
        ...lockfiles.map((lockfile) => ({ path: `fixture/${lockfile}`, content: "lock\n" })),
      );

      for (const [applicationRoot, source] of [
        [".", entries],
        ["site", nestedApplicationEntries(entries)],
      ] as const) {
        const result = inspectFrameworkArchive(await gzipTar(source));
        await expect(result).rejects.toMatchObject({
          code: "framework_conversion_required",
          adapter: "vite-static",
          requirement: "vite-adapter",
          diagnostic: { code, path: applicationRoot === "." ? path : `site/${path}` },
        });
        await expect(result).rejects.toBeInstanceOf(FrameworkConversionRequiredError);
      }
    },
  );

  it.each(["js", "mjs", "ts"] as const)(
    "loads a Vite companion configuration from .%s",
    async (extension) => {
      const entries = renameFixturePath(
        viteCompanionEntries(),
        "fixture/vite.config.ts",
        `fixture/vite.config.${extension}`,
      );

      await expect(inspectFrameworkArchive(await gzipTar(entries))).resolves.toMatchObject({
        frameworkPlan: { adapter: "vite-static", runtime: "edge" },
      });
    },
  );

  it("answers ambiguous framework configuration variants as a framework conversion blocker", async () => {
    const entries = viteCompanionEntries([
      {
        path: "fixture/vite.config.mjs",
        content: 'import { defineConfig } from "vite"; export default defineConfig({});\n',
      },
    ]);

    const result = inspectFrameworkArchive(await gzipTar(entries));
    await expect(result).rejects.toMatchObject({
      code: "framework_conversion_required",
      adapter: "vite-static",
      diagnostic: { code: "framework_config_ambiguous", path: "vite.config.mjs" },
    });
    await expect(result).rejects.not.toBeInstanceOf(FrameworkAdmissionError);
  });

  it.each([
    ["Next.js", nextEdgeEntries(), "fixture/next.config.ts", "nextjs", "nextjs-adapter"],
    [
      "TanStack Start",
      tanStackEntries(),
      "fixture/vite.config.ts",
      "tanstack-start",
      "tanstack-adapter",
    ],
  ] as const)(
    "answers a missing %s framework config as a framework conversion blocker",
    async (_name, entries, configPath, adapter, requirement) => {
      const archive = await gzipTar(entries.filter((entry) => entry.path !== configPath));

      await expect(inspectFrameworkArchive(archive)).rejects.toMatchObject({
        name: "FrameworkConversionRequiredError",
        adapter,
        requirement,
        diagnostic: {
          code: "framework_config_required",
          path: configPath.replace("fixture/", ""),
        },
      });
    },
  );

  it.each([
    [".", "vite.config.ts"],
    ["site", "site/vite.config.ts"],
  ])(
    "names a Vite base the adapter refuses in an application at %s",
    async (applicationRoot, path) => {
      const entries = viteEntries([
        { path: "fixture/vite.config.ts", content: "export default { base: './' };\n" },
      ]);
      const archive = await gzipTar(
        applicationRoot === "." ? entries : nestedApplicationEntries(entries),
      );

      await expect(inspectFrameworkArchive(archive)).rejects.toMatchObject({
        name: "FrameworkConversionRequiredError",
        adapter: "vite-static",
        diagnostic: { code: "framework_base_path_unsupported", path },
      });
    },
  );

  it("admits managed auth without Mail and still diagnoses its database requirement", async () => {
    for (const database of ["", "database:\n  enabled: false\n"]) {
      const source = viteCompanionEntries().map((entry) =>
        entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
          ? {
              ...entry,
              content: entry.content.replace(
                "database:\n  enabled: true\n  migrations: migrations\n",
                database,
              ),
            }
          : entry,
      );
      for (const entries of [source, nestedApplicationEntries(source)]) {
        await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
          diagnostic: { code: "managed_auth_database_required", path: "ohmyhost.yaml" },
        });
      }
    }
    for (const mail of ["", "mail:\n  enabled: false\n"]) {
      const entries = viteCompanionEntries().map((entry) =>
        entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
          ? { ...entry, content: entry.content.replace("mail:\n  enabled: true\n", mail) }
          : entry,
      );
      for (const source of [entries, nestedApplicationEntries(entries)]) {
        await expect(inspectFrameworkArchive(await gzipTar(source))).resolves.toMatchObject({
          frameworkPlan: { auth: { provider: "better-auth" }, mail: { enabled: false } },
        });
      }
    }
    const ordinary = viteCompanionEntries().map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content
              .replace("provider: better-auth", "provider: none")
              .replace("mail:\n  enabled: true\n", "mail:\n  enabled: false\n"),
          }
        : entry,
    );
    await expect(inspectFrameworkArchive(await gzipTar(ordinary))).resolves.toMatchObject({
      frameworkPlan: { auth: { provider: "none" }, mail: { enabled: false } },
    });
  });

  it("admits and hashes the fixed Vite companion source into archive evidence", async () => {
    const inspection = await inspectViteArchive(await gzipTar(viteCompanionEntries()));

    expect(inspection).toEqual({
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "vite-static",
        runtime: "edge",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: "dist",
        serverOutputDirectory: ".ohmyhost/vite-companion",
        serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
        serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        runtimePolicy: { healthCheckPath: "/api/health", egressAllowedOrigins: [] },
        database: { enabled: true, migrations: "migrations" },
        auth: {
          provider: "better-auth",
          version: "1.7.7",
          deployment: "companion",
          routePath: "/api/auth",
          databaseSchema: "auth",
          databaseBindingName: "OHMYHOST_DATABASE",
          authSecretName: "BETTER_AUTH_SECRET",
        },
        mail: { enabled: true },
        storage: { enabled: true, provider: "r2", jurisdiction: "us", public: false },
      },
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      companionSource: {
        schemaVersion: "ohmyhost.vite-api-companion/v1",
        path: "src/ohmyhost/companion.ts",
        byteLength: 88,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(Object.isFrozen(inspection.companionSource)).toBe(true);
  });

  const withCrons = (entries: readonly TarFixtureEntry[]) =>
    entries.map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? { ...entry, content: `${entry.content}functions:\n  crons:\n    - "*/5 * * * *"\n` }
        : entry,
    );
  const scheduledCompanion = {
    path: "fixture/src/ohmyhost/companion.ts",
    content:
      "export default { async fetch(request: Request) { return new Response(request.url); }, async scheduled() {} };\n",
  };

  it("binds declared crons into the Vite edge plan digest when the companion schedules", async () => {
    const scheduled = await inspectFrameworkArchive(
      await gzipTar(withCrons(viteCompanionEntries([scheduledCompanion]))),
    );
    const empty = await inspectFrameworkArchive(await gzipTar(viteCompanionEntries()));

    expect(scheduled.frameworkPlan).toMatchObject({
      adapter: "vite-static",
      runtime: "edge",
      functions: { crons: ["*/5 * * * *"] },
    });
    expect(empty.frameworkPlan).not.toHaveProperty("functions");
    expect(scheduled.buildPlanSha256).not.toBe(empty.buildPlanSha256);
  });

  it("rejects declared crons when the companion has no scheduled handler", async () => {
    await expect(
      inspectFrameworkArchive(await gzipTar(withCrons(viteCompanionEntries()))),
    ).rejects.toMatchObject({
      code: "framework_conversion_required",
      requirement: "vite-adapter",
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          withCrons(
            viteCompanionEntries([
              {
                path: "fixture/src/ohmyhost/companion.ts",
                content:
                  "/* scheduled() lives only in this comment */\nexport default { async fetch() { return new Response(); } };\n",
              },
            ]),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(FrameworkConversionRequiredError);
  });

  it("admits a functions runtime archive with its Worker module and crons", async () => {
    const worker =
      "export default { async fetch(request: Request) { return new Response(request.url); }, async scheduled(controller: unknown) { return controller; } };\n";
    const entries = (workerSource: string, yamlExtra = "") => [
      { path: "fixture/", type: 53 },
      {
        path: "fixture/ohmyhost.yaml",
        content: `version: 1\nproject: jobs\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\nruntime:\n  mode: functions\n${yamlExtra}`,
      },
      {
        path: "fixture/package.json",
        content: JSON.stringify({ packageManager: "pnpm@10.28.2", dependencies: {} }),
      },
      { path: "fixture/pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
      { path: "fixture/src/ohmyhost/worker.ts", content: workerSource },
    ];
    const crons = 'functions:\n  crons:\n    - "0 3 * * *"\n';
    const inspection = await inspectFrameworkArchive(await gzipTar(entries(worker, crons)));

    expect(inspection.frameworkPlan).toEqual({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "functions",
      runtime: "functions",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
      functions: { crons: ["0 3 * * *"] },
    });
    expect(inspection.companionSource).toMatchObject({
      schemaVersion: "ohmyhost.worker-module/v1",
      path: "src/ohmyhost/worker.ts",
      byteLength: new TextEncoder().encode(worker).byteLength,
    });
    expect(inspection.buildPlanSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          entries("export default { async fetch() { return new Response(); } };\n", crons),
        ),
      ),
    ).rejects.toMatchObject({
      code: "framework_conversion_required",
      requirement: "functions-adapter",
    });
    await expect(
      inspectFrameworkArchive(await gzipTar(entries("export const helper = 1;\n"))),
    ).rejects.toMatchObject({
      requirement: "functions-adapter",
      diagnostic: {
        code: "worker_module_default_export_required",
        path: "src/ohmyhost/worker.ts",
      },
    });
    // The functions runtime serves requests through the module, so it names a missing fetch handler.
    await expect(
      inspectFrameworkArchive(
        await gzipTar(entries("export default { async scheduled() {} /* fetch() */ };\n", crons)),
      ),
    ).rejects.toMatchObject({
      adapter: "functions",
      requirement: "functions-adapter",
      diagnostic: {
        code: "worker_module_fetch_handler_required",
        path: "src/ohmyhost/worker.ts",
      },
    });
    // Every customer passes plan time, including the ones who never ran init. The two database
    // clients that cannot work are named here with the file that holds them.
    const database = "database:\n  enabled: true\n  migrations: migrations\n";
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          entries(
            "export default { fetch(request: Request, env: { HYPERDRIVE: { connectionString: string } }) { return new Response(env.HYPERDRIVE.connectionString); } };\n",
            database,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      diagnostic: { code: "database_binding_private", path: "src/ohmyhost/worker.ts" },
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          entries(
            'import { Pool } from "pg";\nexport default { fetch() { return new Response(String(Pool)); } };\n',
            database,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      diagnostic: { code: "database_driver_unsupported", path: "src/ohmyhost/worker.ts" },
    });
    // The raw TCP primitive is refused with or without a database, however it is loaded; the other
    // Node networking modules stay out of this rule.
    for (const load of [
      'import { connect } from "cloudflare:sockets";\nexport default { fetch() { return new Response(String(connect)); } };\n',
      'export default { async fetch() { const { connect } = await import("cloudflare:sockets"); return new Response(String(connect)); } };\n',
      'const { connect } = require("cloudflare:sockets");\nexport default { fetch() { return new Response(String(connect)); } };\n',
      // The parser decodes the specifier and knows a regex literal, which a text scan does not.
      'export default { async fetch() { const { connect } = await import("cloudflare\\x3asockets"); return new Response(String(connect)); } };\n',
      'const hidden = /[/*]/;\nimport { connect } from "cloudflare:sockets";\nexport default { fetch() { return new Response(String(hidden) + String(connect)); } };\n',
      'const hidden = /[//]/; export default { async fetch() { await import("cloudflare:sockets"); return new Response(String(hidden)); } };\n',
    ])
      await expect(inspectFrameworkArchive(await gzipTar(entries(load)))).rejects.toMatchObject({
        adapter: "functions",
        diagnostic: { code: "socket_primitive_unsupported", path: "src/ohmyhost/worker.ts" },
      });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          entries(
            'import net from "node:net";\nexport default { fetch() { return new Response(String(net)); } };\n',
          ),
        ),
      ),
    ).resolves.toMatchObject({ frameworkPlan: { adapter: "functions" } });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          entries(
            "export async function fetch() { return new Response(); }\nexport async function scheduled() {}\n",
            crons,
          ),
        ),
      ),
    ).rejects.toMatchObject({
      requirement: "functions-adapter",
      diagnostic: {
        code: "worker_module_default_export_required",
        path: "src/ohmyhost/worker.ts",
      },
    });
    // Without its Worker module the functions adapter detects nothing; the shared rules still name
    // the first refusal, exactly as `ohmyhost init` lists it.
    const withoutWorker = entries(worker).filter(
      ({ path }) => path !== "fixture/src/ohmyhost/worker.ts",
    );
    await expect(inspectFrameworkArchive(await gzipTar(withoutWorker))).rejects.toMatchObject({
      name: "FrameworkConversionRequiredError",
      adapter: "functions",
      requirement: "functions-adapter",
      diagnostic: { code: "worker_module_required", path: "src/ohmyhost/worker.ts" },
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          replaceEntry(
            withoutWorker,
            "fixture/ohmyhost.yaml",
            "version: 1\nproject: jobs\nbuild:\n  install: npm ci --ignore-scripts\nruntime:\n  mode: functions\n",
          ),
        ),
      ),
    ).rejects.toMatchObject({
      adapter: "functions",
      diagnostic: { code: "build_command_mismatch", path: "ohmyhost.yaml" },
    });
  });

  it("binds declared crons into the Next.js edge plan only with a scheduled Worker module", async () => {
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    const nextWithCrons = (workerSource: string) =>
      withCrons([
        ...nextEdgeEntries(),
        { path: "fixture/src/ohmyhost/worker.ts", content: workerSource },
      ]);
    const scheduled = await inspectFrameworkArchive(
      await gzipTar(nextWithCrons("export default { async scheduled() {} };\n")),
      subtle,
    );
    expect(scheduled.frameworkPlan).toMatchObject({
      adapter: "nextjs",
      runtime: "edge",
      functions: { crons: ["*/5 * * * *"] },
    });
    expect(scheduled.companionSource).toBeUndefined();
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          nextWithCrons("export default { async fetch() { return new Response(); } };\n"),
        ),
        subtle,
      ),
    ).rejects.toMatchObject({ requirement: "nextjs-adapter" });
  });

  it("blocks Worker modules whose handlers are only named exports", async () => {
    const subtle = webcrypto.subtle as unknown as SubtleCrypto;
    const namedScheduled =
      "export async function scheduled(controller: unknown) { return controller; }\n";
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          withCrons([
            ...nextEdgeEntries(),
            { path: "fixture/src/ohmyhost/worker.ts", content: namedScheduled },
          ]),
        ),
        subtle,
      ),
    ).rejects.toMatchObject({
      code: "framework_conversion_required",
      requirement: "nextjs-adapter",
      diagnostic: {
        code: "worker_module_default_export_required",
        path: "src/ohmyhost/worker.ts",
      },
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          withCrons(
            viteCompanionEntries([
              {
                path: "fixture/src/ohmyhost/companion.ts",
                content:
                  "export async function fetch() { return new Response(); }\nexport async function scheduled() {}\n",
              },
            ]),
          ),
        ),
      ),
    ).rejects.toMatchObject({
      requirement: "vite-adapter",
      diagnostic: {
        code: "worker_module_default_export_required",
        path: "src/ohmyhost/companion.ts",
      },
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          withCrons([
            ...nextEdgeEntries(),
            {
              path: "fixture/src/ohmyhost/worker.ts",
              content: "export default { async fetch() { return new Response(); } };\n",
            },
          ]),
        ),
        subtle,
      ),
    ).rejects.toMatchObject({
      requirement: "nextjs-adapter",
      diagnostic: { code: "scheduled_handler_required", path: "src/ohmyhost/worker.ts" },
    });
  });

  it("admits a Vite companion that builds directly for its project root origin", async () => {
    const archive = await gzipTar(
      viteCompanionEntries([
        {
          path: "fixture/vite.config.ts",
          content:
            'import { defineConfig } from "vite"; export default defineConfig({ base: "/", plugins: [] });\n',
        },
      ]),
    );

    await expect(inspectFrameworkArchive(archive)).resolves.toMatchObject({
      frameworkPlan: { adapter: "vite-static", runtime: "edge" },
    });
  });

  it("plans disabled database capabilities without admitting their unused migration inventory", async () => {
    const entries = viteCompanionEntries([
      { path: "fixture/migrations/001_unused.sql", content: "DROP TABLE public.unused;\n" },
    ]).map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content
              .replace("database:\n  enabled: true\n", "database:\n  enabled: false\n")
              .replace("provider: better-auth", "provider: none")
              .replace("mail:\n  enabled: true\n", "mail:\n  enabled: false\n"),
          }
        : entry,
    );
    for (const source of [entries, nestedApplicationEntries(entries)])
      await expect(inspectFrameworkArchive(await gzipTar(source))).resolves.toMatchObject({
        frameworkPlan: {
          database: { enabled: false },
          auth: { provider: "none" },
          mail: { enabled: false },
        },
      });
    const selected = entries.map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content.replace(
              "database:\n  enabled: false\n",
              "database:\n  enabled: true\n",
            ),
          }
        : entry,
    );
    await expect(inspectFrameworkArchive(await gzipTar(selected))).rejects.toMatchObject({
      code: "migration_filename_noncanonical",
      paths: ["migrations/001_unused.sql"],
    });
  });

  it("rejects noncanonical configured migration filenames before framework planning", async () => {
    const archive = await gzipTar(
      viteCompanionEntries([
        { path: "fixture/migrations/", type: 53 },
        {
          path: "fixture/migrations/001_foundation.sql",
          content: "create table public.items(id uuid primary key);\n",
        },
      ]),
    );

    await expect(inspectFrameworkArchive(archive)).rejects.toMatchObject({
      code: "migration_filename_noncanonical",
      paths: ["migrations/001_foundation.sql"],
    });
    await expect(inspectFrameworkArchive(archive)).rejects.toBeInstanceOf(
      MigrationFilenameNoncanonicalError,
    );
  });

  it("selects the production TanStack Start adapter from bounded package evidence", async () => {
    const archive = await gzipTar(tanStackEntries());

    await expect(
      inspectFrameworkArchive(archive, webcrypto.subtle as unknown as SubtleCrypto),
    ).resolves.toEqual({
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "tanstack-start",
        runtime: "static",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: "dist/client",
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("binds the complete TanStack Cloudflare edge plan into the build digest", async () => {
    const archive = await gzipTar(tanStackEdgeEntries());

    await expect(inspectFrameworkArchive(archive)).resolves.toEqual({
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "tanstack-start",
        runtime: "edge",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: "dist/client",
        serverOutputDirectory: "dist/server",
        serverEntryPoint: "dist/server/index.js",
        serverConfigPath: "dist/server/wrangler.json",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("preserves an actionable TanStack conversion requirement for incomplete edge config", async () => {
    const entries = tanStackEdgeEntries().map((entry) =>
      entry.path === "fixture/vite.config.ts" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content.replace(
              "cloudflare({ viteEnvironment: { name: 'ssr' } }), ",
              "",
            ),
          }
        : entry,
    );

    await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
      code: "framework_conversion_required",
      adapter: "tanstack-start",
      requirement: "tanstack-adapter",
      diagnostic: { code: "tanstack_vite_plugins_required", path: "vite.config.ts" },
    });
    await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toBeInstanceOf(
      FrameworkConversionRequiredError,
    );
  });

  it("selects Next.js and binds the platform OpenNext overlay into the canonical digest", async () => {
    const archive = await gzipTar(nextEdgeEntries());
    const first = await inspectFrameworkArchive(
      archive,
      webcrypto.subtle as unknown as SubtleCrypto,
    );
    const second = await inspectFrameworkArchive(
      archive,
      webcrypto.subtle as unknown as SubtleCrypto,
    );

    expect(first).toEqual({
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: ".",
        adapter: "nextjs",
        runtime: "edge",
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputDirectory: ".open-next/assets",
        serverOutputDirectory: ".ohmyhost-worker",
        serverEntryPoint: ".ohmyhost-worker/worker.js",
        serverConfigPath: "wrangler.jsonc",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        ssgCacheMaxBytes: 32 * 1024 * 1024,
        runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
        database: { enabled: false },
        auth: { provider: "none" },
        mail: { enabled: false },
        storage: { enabled: false },
      },
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(second).toEqual(first);
    const jsx = await inspectFrameworkArchive(
      await gzipTar(
        nextEdgeEntries([
          {
            path: "fixture/src/app/page.tsx",
            content:
              "export default function Page() { return <nav><a href='/login'>Sign in</a> | <a href='/logout'>Sign out</a></nav>; }",
          },
        ]),
      ),
    );
    expect(jsx.frameworkPlan).toEqual(first.frameworkPlan);
    expect(jsx.buildPlanSha256).toBe(first.buildPlanSha256);
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          nextEdgeEntries([
            {
              path: "fixture/src/app/page.tsx",
              content: "export default function Page() { return <div>{import('node:vm')}</div>; }",
            },
          ]),
        ),
      ),
    ).rejects.toBeInstanceOf(NextWorkersIncompatibleError);

    const changedDate = nextEdgeEntries().map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: entry.content.replace("mode: edge", "mode: edge\n  healthcheck: /health"),
          }
        : entry,
    );
    const changed = await inspectFrameworkArchive(await gzipTar(changedDate));
    expect(changed.buildPlanSha256).not.toBe(first.buildPlanSha256);

    // The customer-shaped source (next 16.4.5 resolved by npm's package-lock.json, runtime edge)
    // plans with npm's commands; the lockfile decides admission but never enters the plan digest.
    const [customer] = FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted;
    if (customer === undefined) throw new Error("conformance corpus has no customer source");
    const exact = await inspectFrameworkArchive(
      await gzipTar(sourceEntries(customer.files)),
      webcrypto.subtle as unknown as SubtleCrypto,
    );
    expect(exact).toEqual({
      frameworkPlan: {
        ...first.frameworkPlan,
        installCommand: "npm ci --ignore-scripts",
        buildCommand: "npm run build",
      },
      buildPlanSha256: createHash("sha256")
        .update(serializeNewProductionFrameworkPlanPreimage(exact.frameworkPlan))
        .digest("hex"),
    });
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          sourceEntries({ ...customer.files, "package-lock.json": new Uint8Array([0xff]) }),
        ),
      ),
    ).resolves.toEqual(exact);
  });

  it.each(["js", "mjs", "ts"] as const)(
    "passes a .%s Next.js config into the platform-overlay adapter without customer OpenNext files",
    async (extension) => {
      const entries = renameFixturePath(
        nextEdgeEntries(),
        "fixture/next.config.ts",
        `fixture/next.config.${extension}`,
      );

      await expect(inspectFrameworkArchive(await gzipTar(entries))).resolves.toMatchObject({
        frameworkPlan: {
          adapter: "nextjs",
          runtime: "edge",
          installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
          buildCommand: "pnpm run build",
          outputDirectory: ".open-next/assets",
          serverOutputDirectory: ".ohmyhost-worker",
          serverEntryPoint: ".ohmyhost-worker/worker.js",
          serverConfigPath: "wrangler.jsonc",
          compatibilityFlags: ["nodejs_compat"],
        },
      });
    },
  );

  it("rejects ambiguous optional OpenNext config variants instead of choosing one", async () => {
    const entries = [
      ...nextEdgeEntries(),
      { path: "fixture/open-next.config.js", content: "export default {};\n" },
      { path: "fixture/open-next.config.ts", content: "export default {};\n" },
    ];

    await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
      code: "framework_conversion_required",
      adapter: "nextjs",
      diagnostic: { code: "framework_config_ambiguous", path: "open-next.config.js" },
    });
  });

  it("preserves an actionable Workers-incompatibility blocker before provider mutation", async () => {
    const archive = await gzipTar(
      nextEdgeEntries([
        {
          path: "fixture/src/app/page.tsx",
          content: `import { execFile } from "node:child_process"; export default function Page() { return null; }`,
        },
      ]),
    );
    await expect(inspectFrameworkArchive(archive)).rejects.toMatchObject({
      code: "next_workers_runtime_incompatible",
      classification: "unsupported",
      findings: [
        {
          code: "workers_node_stub_module",
          path: "src/app/page.tsx",
          module: "node:child_process",
        },
      ],
    });
    await expect(inspectFrameworkArchive(archive)).rejects.toBeInstanceOf(
      NextWorkersIncompatibleError,
    );
  });

  it("rejects the withdrawn container mode and standalone output before plan persistence", async () => {
    const withdrawnMode = await gzipTar(
      nextEdgeEntries([
        {
          path: "fixture/ohmyhost.yaml",
          content:
            "version: 1\nproject: next-standalone\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: .next/standalone\nruntime:\n  mode: container\n",
        },
      ]),
    );
    const standaloneOutput = await gzipTar(
      nextEdgeEntries([
        {
          path: "fixture/next.config.ts",
          content:
            'import type { NextConfig } from "next"; const nextConfig: NextConfig = { output: "standalone" }; export default nextConfig;\n',
        },
      ]),
    );

    // An ohmyhost.yaml outside its schema names no application, so no adapter is known yet; the
    // diagnostic is all that names the fix, so a refusal without an adapter must carry one.
    await expect(inspectFrameworkArchive(withdrawnMode)).rejects.toMatchObject({
      name: "FrameworkConversionRequiredError",
      adapter: null,
      requirement: null,
      diagnostic: { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
    });
    expect(() => new FrameworkConversionRequiredError(null)).toThrow(TypeError);
    await expect(inspectFrameworkArchive(standaloneOutput)).rejects.toMatchObject({
      name: "FrameworkConversionRequiredError",
      adapter: "nextjs",
      requirement: "nextjs-adapter",
      diagnostic: { code: "next_output_unsupported", path: "next.config.ts" },
    });
  });

  it("binds the repository database requirement and migration path into the plan digest", async () => {
    const withDatabase = nextEdgeEntries().map((entry) =>
      entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
        ? {
            ...entry,
            content: `${entry.content}database:\n  enabled: true\n  migrations: supabase/migrations\n`,
          }
        : entry,
    );
    const enabled = await inspectFrameworkArchive(await gzipTar(withDatabase));
    const disabled = await inspectFrameworkArchive(await gzipTar(nextEdgeEntries()));

    expect(enabled.frameworkPlan.database).toEqual({
      enabled: true,
      migrations: "supabase/migrations",
    });
    expect(disabled.frameworkPlan.database).toEqual({ enabled: false });
    expect(enabled.buildPlanSha256).not.toBe(disabled.buildPlanSha256);
    // A declaration file never runs, so its typed DATABASE_URL reads no connection string.
    const declared = await inspectFrameworkArchive(
      await gzipTar([
        ...withDatabase,
        {
          path: "fixture/src/app/env.d.ts",
          content: "declare namespace NodeJS { interface ProcessEnv { DATABASE_URL: string } }\n",
        },
      ]),
    );
    expect(declared.buildPlanSha256).toBe(enabled.buildPlanSha256);
  });

  it("names a TanStack Router param module in its typed database diagnostic", async () => {
    const entries = tanStackEdgeEntries([
      {
        path: "fixture/ohmyhost.yaml",
        content:
          "version: 1\nproject: tanstack-edge\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist/client\nruntime:\n  mode: edge\ndatabase:\n  enabled: true\n  migrations: migrations\n",
      },
      {
        path: "fixture/src/routes/items.$id.tsx",
        content: "export const url = process.env.DATABASE_URL;\n",
      },
    ]);

    await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
      name: "FrameworkConversionRequiredError",
      adapter: "tanstack-start",
      diagnostic: { code: "database_binding_private", path: "src/routes/items.$id.tsx" },
    });
  });

  it.each(["vite", "@tanstack/react-start"])(
    "rejects an archive declaring both Next.js and %s before adapter planning",
    async (ambiguousDependency) => {
      const entries = nextEdgeEntries().map((entry) =>
        entry.path === "fixture/package.json" && typeof entry.content === "string"
          ? {
              ...entry,
              content: JSON.stringify({
                ...(JSON.parse(entry.content) as Record<string, unknown>),
                dependencies: {
                  ...(JSON.parse(entry.content) as { dependencies: Record<string, string> })
                    .dependencies,
                  [ambiguousDependency]: "1.0.0",
                },
              }),
            }
          : entry,
      );

      for (const [applicationRoot, source] of [
        [".", entries],
        ["site", nestedApplicationEntries(entries)],
      ] as const) {
        await expect(inspectFrameworkArchive(await gzipTar(source))).rejects.toMatchObject({
          name: "FrameworkConversionRequiredError",
          adapter: null,
          requirement: null,
          diagnostic: {
            code: "framework_ambiguous",
            path: applicationRoot === "." ? "package.json" : "site/package.json",
          },
        });
      }
    },
  );

  it.each([
    ["Vite", viteEntries()],
    ["TanStack static", tanStackEntries()],
    ["TanStack edge", tanStackEdgeEntries()],
    ["Next.js edge", nextEdgeEntries()],
  ])(
    "admits customer SDK dependencies through the same %s framework contract",
    async (_name, entries) => {
      const baseline = await inspectFrameworkArchive(await gzipTar(entries));
      for (const dependency of [
        "better-auth",
        "@workos-inc/authkit-react",
        "@workos-inc/authkit-nextjs",
        "@auth0/auth0-react",
        "@auth0/nextjs-auth0",
        "@supabase/supabase-js",
        "customer-owned-sdk",
        "@tanstack/react-router",
        "@tanstack/react-query",
      ]) {
        const withDependency = entries.map((entry) =>
          entry.path.endsWith("/package.json") && typeof entry.content === "string"
            ? {
                ...entry,
                content: JSON.stringify({
                  ...(JSON.parse(entry.content) as Record<string, unknown>),
                  dependencies: {
                    ...(JSON.parse(entry.content) as { dependencies: Record<string, string> })
                      .dependencies,
                    [dependency]: dependency === "better-auth" ? "1.7.7" : "1.0.0",
                  },
                }),
              }
            : entry,
        );
        const inspected = await inspectFrameworkArchive(await gzipTar(withDependency));
        expect(inspected.frameworkPlan).toEqual(baseline.frameworkPlan);
        expect(inspected.buildPlanSha256).toBe(baseline.buildPlanSha256);
      }
    },
  );

  it.each([
    ["Vite", viteEntries()],
    ["TanStack static", tanStackEntries()],
    ["TanStack edge", tanStackEdgeEntries()],
    ["Next.js edge", nextEdgeEntries()],
  ])(
    "rebases a nested %s application without fabricating or trusting its config",
    async (_name, entries) => {
      const root = await inspectFrameworkArchive(await gzipTar(entries));
      const nested = await inspectFrameworkArchive(
        await gzipTar(
          nestedApplicationEntries(entries, [
            {
              path: "fixture/site/ohmyhost.yaml",
              content:
                "version: 1\nproject: shadow\nbuild:\n  install: unsafe\n  command: unsafe\n  output: unsafe\nruntime:\n  mode: functions\n",
            },
            { path: "fixture/root-only-sentinel.txt", content: "must remain outside application" },
          ]),
        ),
      );

      expect(nested.frameworkPlan).toMatchObject({
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot: "site",
        adapter: root.frameworkPlan.adapter,
        runtime: root.frameworkPlan.runtime,
      });
      expect(nested.buildPlanSha256).not.toBe(root.buildPlanSha256);
    },
  );

  it("rejects a missing selected directory and validates hostile root-only archive entries", async () => {
    // The configured directory is the customer's to fix, whether it is absent or empty.
    for (const entries of [
      viteEntriesWithConfiguredRoot("site"),
      [...viteEntriesWithConfiguredRoot("site"), { path: "fixture/site/", type: 53 }],
    ]) {
      await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
        name: "FrameworkConversionRequiredError",
        adapter: null,
        requirement: null,
        diagnostic: { code: "application_root_missing", path: "ohmyhost.yaml" },
      });
    }
    // Neither GitHub nor the managed export lists files without their directory.
    const missingDirectory = nestedApplicationEntries(viteEntries()).filter(
      (entry) => entry.path !== "fixture/site/",
    );
    await expect(inspectFrameworkArchive(await gzipTar(missingDirectory))).rejects.toBeInstanceOf(
      ViteArchiveInspectionError,
    );

    const hostileSibling = nestedApplicationEntries(viteEntries(), [
      { path: "fixture/../escape", content: "hostile" },
    ]);
    await expect(inspectFrameworkArchive(await gzipTar(hostileSibling))).rejects.toBeInstanceOf(
      ViteArchiveInspectionError,
    );
  });

  it("accepts the 231-byte worst-case GitHub USTAR application inspection path without PAX", async () => {
    const repositoryRoot = `${"r".repeat(100)}-${"a".repeat(40)}`;
    const applicationRoot = `${"a".repeat(31)}/${"b".repeat(32)}`;
    const rootEntries = viteEntries();
    const entries = rootEntries.flatMap((entry) => {
      if (entry.path === "fixture/") return [{ ...entry, path: `${repositoryRoot}/` }];
      if (entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string") {
        return [
          {
            ...entry,
            path: `${repositoryRoot}/ohmyhost.yaml`,
            content: entry.content.replace(
              "version: 1\n",
              `version: 1\napplicationRoot: ${applicationRoot}\n`,
            ),
          },
        ];
      }
      return [
        { ...entry, path: entry.path.replace("fixture/", `${repositoryRoot}/${applicationRoot}/`) },
      ];
    });
    entries.push(
      { path: `${repositoryRoot}/${applicationRoot.split("/")[0]}/`, type: 53 },
      { path: `${repositoryRoot}/${applicationRoot}/`, type: 53 },
      { path: `${repositoryRoot}/${applicationRoot}/${"x".repeat(24)}`, content: "sentinel" },
    );
    expect(`${repositoryRoot}/${applicationRoot}/${"x".repeat(24)}`.length).toBe(231);

    await expect(inspectFrameworkArchive(await gzipTar(entries))).resolves.toMatchObject({
      frameworkPlan: {
        schemaVersion: "ohmyhost.framework-plan/v5",
        applicationRoot,
        adapter: "vite-static",
      },
    });
  });

  it("accepts only GitHub's leading commit-comment PAX header", async () => {
    const commit = "a".repeat(40);
    const githubArchive = await gzipTar([
      { path: "pax_global_header", type: 103, content: `52 comment=${commit}\n` },
      ...viteEntries(),
    ]);

    await expect(inspectViteArchive(githubArchive)).resolves.toMatchObject({
      frameworkPlan: { adapter: "vite-static", runtime: "static" },
    });

    for (const content of [
      `51 path=${commit}\n`,
      `52 comment=${"z".repeat(40)}\n`,
      `53 comment=${commit}\n`,
    ]) {
      await expect(
        inspectViteArchive(
          await gzipTar([{ path: "pax_global_header", type: 103, content }, ...viteEntries()]),
        ),
      ).rejects.toBeInstanceOf(ViteArchiveInspectionError);
    }
  });

  it("rejects links, duplicate paths, multiple roots, and traversal", async () => {
    for (const entries of [
      viteEntries([{ path: "fixture/link", type: 50 }]),
      [...viteEntries(), { path: "fixture/index.html", content: "duplicate" }],
      [...viteEntries(), { path: "other/file", content: "other root" }],
      viteEntries([{ path: "fixture/../escape", content: "escape" }]),
      viteEntries([{ path: "fixture/new\nline", content: "control character" }]),
    ]) {
      await expect(inspectViteArchive(await gzipTar(entries))).rejects.toBeInstanceOf(
        ViteArchiveInspectionError,
      );
    }
  });

  it("rejects malformed gzip, invalid UTF-8, unsafe adapter input, and oversized entries", async () => {
    const archive = tar(viteEntries());
    for (const trailingByte of [0, 1]) {
      const padded = new Uint8Array(archive.byteLength + 512);
      padded.set(archive);
      padded[padded.length - 1] = trailingByte;
      const paddedBody = new Response(padded.buffer).body;
      if (paddedBody === null) throw new Error("fixture response body is unavailable");
      const compressed = paddedBody.pipeThrough(new CompressionStream("gzip"));
      const inspected = inspectViteArchive(
        new Uint8Array(await new Response(compressed).arrayBuffer()),
      );
      if (trailingByte === 0) {
        await expect(inspected).resolves.toMatchObject({ frameworkPlan: { runtime: "static" } });
      } else {
        await expect(inspected).rejects.toBeInstanceOf(ViteArchiveInspectionError);
      }
    }
    await expect(inspectViteArchive(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      ViteArchiveInspectionError,
    );
    // Customer bytes that are not UTF-8, or a package.json that selects no framework, are refused
    // by the rule that reads that file; outside the selected application they are not read.
    const invalid = new Uint8Array([0xff]);
    for (const [entries, adapter, diagnostic] of [
      [
        replaceEntry(viteEntries(), "fixture/package.json", invalid),
        null,
        { code: "package_manifest_invalid", path: "package.json" },
      ],
      [
        viteEntries().filter((entry) => entry.path !== "fixture/package.json"),
        null,
        { code: "package_manifest_invalid", path: "package.json" },
      ],
      [
        replaceEntry(viteEntries(), "fixture/package.json", "[]"),
        null,
        { code: "package_manifest_invalid", path: "package.json" },
      ],
      [
        replaceEntry(viteEntries(), "fixture/package.json", '{"packageManager":"pnpm@10.28.2"}'),
        null,
        { code: "framework_unsupported", path: "package.json" },
      ],
      [
        replaceEntry(viteEntries(), "fixture/ohmyhost.yaml", invalid),
        null,
        { code: "repository_configuration_invalid", path: "ohmyhost.yaml" },
      ],
      [
        viteEntries([{ path: "fixture/vite.config.ts", content: invalid }]),
        "vite-static",
        { code: "source_syntax_invalid", path: "vite.config.ts" },
      ],
      [
        replaceEntry(nextEdgeEntries(), "fixture/src/app/page.tsx", invalid),
        "nextjs",
        { code: "source_syntax_invalid", path: "src/app/page.tsx" },
      ],
    ] as const) {
      await expect(inspectFrameworkArchive(await gzipTar(entries))).rejects.toMatchObject({
        name: "FrameworkConversionRequiredError",
        adapter,
        diagnostic,
      });
    }
    await expect(
      inspectFrameworkArchive(
        await gzipTar(
          nestedApplicationEntries(viteEntries(), [
            { path: "fixture/tools/package.json", content: invalid },
            { path: "fixture/docs/app/page.tsx", content: invalid },
          ]),
        ),
      ),
    ).resolves.toMatchObject({ frameworkPlan: { applicationRoot: "site" } });
    const unsafe = viteEntries().map((entry) =>
      entry.path === "fixture/package.json" && typeof entry.content === "string"
        ? {
            ...entry,
            content: JSON.stringify({
              ...(JSON.parse(entry.content) as Record<string, unknown>),
              scripts: { build: "curl example.com" },
            }),
          }
        : entry,
    );
    await expect(inspectViteArchive(await gzipTar(unsafe))).rejects.toMatchObject({
      code: "framework_conversion_required",
      adapter: "vite-static",
      requirement: "vite-adapter",
      diagnostic: {
        code: "build_script_unsupported",
        path: "package.json",
        framework: "vite-static",
      },
    });
    const oversized = tar([
      { path: "fixture/", type: 53 },
      { path: "fixture/huge", declaredSize: 5 * 1024 * 1024 + 1 },
    ]);
    const body = new Response(new Uint8Array(oversized).buffer).body;
    if (body === null) throw new Error("fixture response body is unavailable");
    const stream = body.pipeThrough(new CompressionStream("gzip"));
    await expect(
      inspectViteArchive(new Uint8Array(await new Response(stream).arrayBuffer())),
    ).rejects.toBeInstanceOf(ViteArchiveInspectionError);
  });

  it("applies Next.js runtime-source limits only to a Next.js application", async () => {
    const archive = await gzipTar(
      viteEntries([
        {
          path: "fixture/src/pages/data.ts",
          content: `export const data = "${"x".repeat(300 * 1024)}";\n`,
        },
      ]),
    );
    await expect(inspectFrameworkArchive(archive)).resolves.toMatchObject({
      frameworkPlan: { adapter: "vite-static", runtime: "static" },
    });
  });

  it("refuses an oversized Next.js runtime source once the application is detected as Next.js", async () => {
    const archive = await gzipTar(
      nextEdgeEntries([
        {
          path: "fixture/src/app/data.ts",
          content: `export const data = "${"x".repeat(300 * 1024)}";\n`,
        },
      ]),
    );
    await expect(inspectFrameworkArchive(archive)).rejects.toBeInstanceOf(
      FrameworkConversionRequiredError,
    );
  });

  it("inspects a reachable helper after more than 2000 unrelated source files", async () => {
    const unrelated = Array.from({ length: 2_100 }, (_, index) => ({
      path: `fixture/tests/unit-${index}.test.ts`,
      content: "export {};\n",
    }));
    // The page imports a helper that the archive lists after the unrelated files: the helper is
    // reachable, so its body must be readable whatever the number of unrelated files.
    const page = nextEdgeEntries().map((entry) =>
      entry.path === "fixture/src/app/page.tsx"
        ? {
            ...entry,
            content:
              'import { answer } from "../lib/answer";\nexport default function Page() { return answer; }\n',
          }
        : entry,
    );
    const archive = await gzipTar([
      ...unrelated,
      { path: "fixture/src/lib/answer.ts", content: "export const answer = 42;\n" },
      ...page,
    ]);
    await expect(inspectFrameworkArchive(archive)).resolves.toMatchObject({
      frameworkPlan: { adapter: "nextjs", runtime: "edge" },
    });
  });

  it("bounds the inspection files retained from an inflated archive", async () => {
    const fiveMiB = new Uint8Array(5 * 1024 * 1024);
    const archive = await gzipTar(
      viteEntries(
        ["a", "b", "c", "d"].map((name) => ({
          path: `fixture/vendor/${name}/package.json`,
          content: fiveMiB,
        })),
      ),
    );
    await expect(inspectFrameworkArchive(archive)).rejects.toBeInstanceOf(
      ViteArchiveInspectionError,
    );
  });

  it("streams an inflated archive whose bodies are not inspected", async () => {
    const fiveMiB = new Uint8Array(5 * 1024 * 1024);
    const archive = await gzipTar(
      viteEntries(
        Array.from({ length: 19 }, (_, index) => ({
          path: `fixture/public/chunk-${index}.bin`,
          content: fiveMiB,
        })),
      ),
    );
    await expect(inspectFrameworkArchive(archive)).resolves.toMatchObject({
      frameworkPlan: { adapter: "vite-static", runtime: "static" },
    });
  });
});

function httpModuleEntries() {
  return (["functions", "edge"] as const).map((runtime) => {
    const modulePath =
      runtime === "functions" ? "src/ohmyhost/worker.ts" : "src/ohmyhost/companion.ts";
    const entries: readonly TarFixtureEntry[] = [
      { path: "fixture/", type: 53 },
      {
        path: "fixture/ohmyhost.yaml",
        content: `version: 1\nproject: http-module\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n${runtime === "edge" ? "  command: pnpm run build\n  output: dist\n" : ""}runtime:\n  mode: ${runtime}\nfunctions:\n  crons:\n    - "0 3 * * *"\n`,
      },
      {
        path: "fixture/package.json",
        content: JSON.stringify({
          packageManager: "pnpm@10.28.2",
          ...(runtime === "edge"
            ? { scripts: { build: "vite build" }, devDependencies: { vite: "8.2.2" } }
            : {}),
        }),
      },
      { path: "fixture/pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
      { path: "fixture/index.html", content: '<div id="root"></div>' },
      {
        path: `fixture/${modulePath}`,
        content:
          'import { answer } from "../server/answer.mjs"; export default { fetch() { return new Response(String(answer)); }, scheduled() {} };\n',
      },
      {
        path: "fixture/src/server/answer.mjs",
        content: 'export { answer } from "./answer.js";',
      },
      {
        path: "fixture/src/server/answer.js",
        content: 'import codec from "./codec.wasm"; export const answer = codec;',
      },
      {
        path: "fixture/src/server/codec.wasm",
        content: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      },
    ];
    return { runtime, modulePath, entries };
  });
}

function httpModuleAtRoot(
  entries: readonly TarFixtureEntry[],
  applicationRoot: string,
  extra: readonly TarFixtureEntry[] = [],
): readonly TarFixtureEntry[] {
  if (applicationRoot === ".") return [...entries, ...extra];
  return [
    ...entries.map((entry) => {
      if (entry.path === "fixture/") return entry;
      if (entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string")
        return {
          ...entry,
          content: entry.content.replace(
            "version: 1\n",
            `version: 1\napplicationRoot: ${applicationRoot}\n`,
          ),
        };
      return { ...entry, path: entry.path.replace("fixture/", `fixture/${applicationRoot}/`) };
    }),
    ...applicationRoot.split("/").map((_, index, segments) => ({
      path: `fixture/${segments.slice(0, index + 1).join("/")}/`,
      type: 53,
    })),
    ...extra,
  ];
}

function viteEntriesAtApplicationRoot(applicationRoot: string) {
  if (applicationRoot === ".") return viteEntries();
  const directories = applicationRoot.split("/").map((_, index, segments) => ({
    path: `fixture/${segments.slice(0, index + 1).join("/")}/`,
    type: 53,
  }));
  return [
    ...viteEntries().map((entry) => {
      if (entry.path === "fixture/") return entry;
      if (entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string") {
        return {
          ...entry,
          content: entry.content.replace(
            "version: 1\n",
            `version: 1\napplicationRoot: ${JSON.stringify(applicationRoot)}\n`,
          ),
        };
      }
      return {
        ...entry,
        path: entry.path.replace("fixture/", `fixture/${applicationRoot}/`),
      };
    }),
    ...directories,
  ];
}

function viteEntriesWithConfiguredRoot(applicationRoot: unknown) {
  return viteEntries().map((entry) =>
    entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string"
      ? {
          ...entry,
          content: entry.content.replace(
            "version: 1\n",
            `version: 1\napplicationRoot: ${JSON.stringify(applicationRoot)}\n`,
          ),
        }
      : entry,
  );
}

function renameFixturePath(
  entries: readonly {
    readonly path: string;
    readonly content?: Uint8Array | string;
    readonly type?: number;
    readonly declaredSize?: number;
  }[],
  from: string,
  to: string,
) {
  return entries.map((entry) => (entry.path === from ? { ...entry, path: to } : entry));
}

function replaceEntry(
  entries: readonly TarFixtureEntry[],
  path: string,
  content: string | Uint8Array,
): readonly TarFixtureEntry[] {
  return entries.map((entry) => (entry.path === path ? { ...entry, content } : entry));
}

function packageManagerEntries(
  entries: readonly {
    readonly path: string;
    readonly content?: Uint8Array | string;
    readonly type?: number;
    readonly declaredSize?: number;
  }[],
  input: Readonly<{
    packageManager: string;
    lockfile: string;
    installCommand: string;
    buildCommand: string;
  }>,
) {
  return entries
    .filter((entry) => !entry.path.endsWith("pnpm-lock.yaml"))
    .map((entry) => {
      if (entry.path === "fixture/ohmyhost.yaml" && typeof entry.content === "string") {
        return {
          ...entry,
          content: entry.content
            .replace(/install: [^\n]+/u, `install: ${input.installCommand}`)
            .replace(/command: [^\n]+/u, `command: ${input.buildCommand}`),
        };
      }
      if (entry.path === "fixture/package.json" && typeof entry.content === "string") {
        return {
          ...entry,
          content: JSON.stringify({
            ...(JSON.parse(entry.content) as Record<string, unknown>),
            packageManager: input.packageManager,
          }),
        };
      }
      return entry;
    })
    .concat({
      path: `fixture/${input.lockfile}`,
      content: input.lockfile === "bun.lockb" ? new Uint8Array([0xff, 0x00]) : "lock\n",
    });
}

it("plans Astro static and SSR archives and keeps runtime imports in their source boundary", async () => {
  for (const mode of ["static", "edge"]) {
    const entries: TarFixtureEntry[] = [
      {
        path: "fixture/ohmyhost.yaml",
        content: `version: 1\nproject: astro-app\nbuild:\n  install: npm ci --ignore-scripts\n  command: npm run build\n  output: ${mode === "edge" ? "dist/client" : "dist"}\nruntime:\n  mode: ${mode}\n`,
      },
      {
        path: "fixture/package.json",
        content: JSON.stringify({
          packageManager: "npm@11.5.1",
          scripts: { build: "astro build" },
          dependencies: {
            astro: "7.4.0",
            ...(mode === "edge" ? { "@astrojs/cloudflare": "14.4.0" } : {}),
          },
        }),
      },
      { path: "fixture/package-lock.json", content: '{"lockfileVersion":3,"packages":{}}' },
      {
        path: "fixture/astro.config.mjs",
        content:
          mode === "edge"
            ? 'import cloudflare from "@astrojs/cloudflare"; export default {output:"server", adapter:cloudflare({imageService:"passthrough"}),session:false};'
            : 'export default {output:"static"};',
      },
      { path: "fixture/src/pages/index.astro", content: "<h1>Astro</h1>" },
    ];
    const result = await inspectFrameworkArchive(await gzipTar(entries));
    expect(result.frameworkPlan).toMatchObject({
      adapter: "astro",
      runtime: mode,
      outputDirectory: mode === "edge" ? "dist/client" : "dist",
    });
    if (mode === "edge") {
      const invalid = entries.map((entry) =>
        entry.path.endsWith("index.astro")
          ? { ...entry, content: '<h1>{await import("node:child_process")}</h1>' }
          : entry,
      );
      await expect(inspectFrameworkArchive(await gzipTar(invalid))).rejects.toMatchObject({
        diagnostic: { code: "astro_template_import_unsupported", path: "src/pages/index.astro" },
      });
    }
  }
});
