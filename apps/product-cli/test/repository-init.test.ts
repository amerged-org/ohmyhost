import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { APPLICATION_ROOT_CONFORMANCE_CORPUS, parseOhmyhostConfigYaml } from "@ohmyhost/contracts";
import { frameworkConversionDetail } from "@ohmyhost/contracts/framework-admission";
import { PINNED_BUN_VERSION } from "@ohmyhost/contracts/framework-build-script";
import { FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/framework-admission-corpus";
import { afterEach, describe, expect, it } from "vitest";

import {
  RepositoryInitBlockedError,
  RepositoryInitConflictError,
  initializeRepository,
} from "../src/repository-init.js";
import cliPackage from "../package.json" with { type: "json" };

const cliVersion = cliPackage.version;
// The npm alias keeps the import name and pins exactly this client's published runtime; unlike a
// website archive it stays installable after the next release replaces the current downloads.
const runtimeSource = `npm:@amerged/ohmyhost-runtime@${cliVersion}`;

// A blocker with a catalog code says exactly what planning says about the same file.
const blocker = (code: string, path: string, fields: Readonly<Record<string, string>> = {}) => ({
  code,
  path,
  message: frameworkConversionDetail({ code, path, ...fields }),
});
// What init cannot verify offline; installed_version leads it while a range is unresolved.
const PENDING = ["frozen_install", "framework_build", "reachable_runtime_sources", "project_state"];
const COMPANION = "export default { fetch() { return new Response('ok'); } };\n";
const MIGRATION_REASON = {
  destructive:
    "It contains DROP, TRUNCATE, INSERT, UPDATE, DELETE, BEGIN/COMMIT/ROLLBACK, CREATE OR REPLACE, or ALTER TABLE other than ADD; move row changes to 'ohmyhost database write'.",
  unsupported:
    "It has a statement other than CREATE TABLE, TYPE, DOMAIN, SEQUENCE, VIEW, MATERIALIZED VIEW, TRIGGER, INDEX or FUNCTION, ALTER TABLE ... ADD, COMMENT ON, CREATE SCHEMA IF NOT EXISTS auth|extensions|private or CREATE EXTENSION IF NOT EXISTS pgcrypto|btree_gist|unaccent; or a function not in LANGUAGE sql or plpgsql, SECURITY DEFINER without SET search_path, or the word ohmyhost, comments included.",
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const repository = async (packageJson: Readonly<Record<string, unknown>>): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-init-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
  return directory;
};

describe("repository initialization", () => {
  it.each(["directory", "file"])(
    "refuses init below a Git root identified by a %s without writing nested configuration",
    async (kind) => {
      const directory = await repository({ name: "repository" });
      if (kind === "directory") await mkdir(join(directory, ".git"));
      else await writeFile(join(directory, ".git"), "gitdir: /private/worktrees/example\n");
      const nested = join(directory, "website");
      await mkdir(nested);
      await writeFile(
        join(nested, "package.json"),
        JSON.stringify({
          name: "website",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "8.2.2" },
        }),
      );
      await writeFile(join(nested, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      for (const dryRun of [true, false]) {
        await expect(initializeRepository({ directory: nested, dryRun })).rejects.toMatchObject({
          code: "repository_root_required",
        });
      }
      await expect(readFile(join(nested, "ohmyhost.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const result = await initializeRepository({ directory, root: "website", dryRun: true });
      expect(result.applicationRoot).toBe("website");
    },
  );

  it("reports customer auth SDK evidence without selecting managed database, auth or mail", async () => {
    for (const [dependency, provider] of [
      ["better-auth", "betterAuth"],
      ["@workos-inc/authkit-react", "workos"],
      ["@workos-inc/authkit-nextjs", "workos"],
      ["@auth0/auth0-react", "auth0"],
      ["@auth0/nextjs-auth0", "auth0"],
      ["@supabase/supabase-js", "supabase"],
    ] as const) {
      const directory = await repository({
        name: "customer-auth",
        packageManager: "pnpm@10.28.2",
        scripts: { build: "vite build" },
        dependencies: { [dependency]: "1.0.0", resend: "1.0.0" },
        devDependencies: { vite: "8.2.2" },
      });
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const result = await initializeRepository({ directory, dryRun: true });
      expect(result.blockers).toEqual([]);
      expect(result.inventory.auth).toMatchObject({ [provider]: true });
      expect(result.inventory.database).toEqual({ provider: "none", migrationCount: 0 });
      expect(result.requirements).toEqual(["application-auth-review", "transactional-email"]);
      expect(result.companion).toBeNull();
      expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
        runtime: { mode: "static" },
        auth: { provider: "none" },
        mail: { enabled: false },
        database: { enabled: false },
      });
      await writeFile(
        join(directory, "ohmyhost.yaml"),
        result.configurationYaml.replace("build:\n", "build:\n  ssg_cache_max_mib: 32\n"),
        "utf8",
      );
      const invalidCache = await initializeRepository({ directory, dryRun: true });
      expect(invalidCache.blockers).toEqual([blocker("build_option_unsupported", "ohmyhost.yaml")]);
    }
    const directory = await repository({
      name: "database-only",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(directory, "supabase/migrations/20260909000000_items.sql"),
      "create table public.items(id uuid primary key);\n",
    );
    const result = await initializeRepository({ directory, dryRun: true });
    expect(result.inventory.database).toEqual({ provider: "supabase", migrationCount: 1 });
    expect(result.inventory.auth).toEqual({
      betterAuth: false,
      workos: false,
      auth0: false,
      supabase: false,
    });
    expect(result.requirements).toContain("supabase-postgres-conversion");
    expect(result.requirements).not.toContain("application-auth-review");
    await writeFile(join(directory, "ohmyhost.yaml"), result.configurationYaml);
    // The proposed managed path must actually contain the converted migrations before reuse.
    await mkdir(join(directory, "postgres/migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres/migrations/20260909000000_items.sql"),
      "create table public.items(id uuid primary key);\n",
    );
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    packageJson.dependencies = { "better-auth": "^1.7.7" };
    await writeFile(join(directory, "package.json"), JSON.stringify(packageJson));
    // The proposed edge runtime serves the database through the companion planning requires.
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      blocker("companion_entry_required", "src/ohmyhost/companion.ts"),
    ]);
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);
    const customerAuth = await initializeRepository({ directory, dryRun: true });
    expect(customerAuth.blockers).toEqual([]);
    expect(customerAuth.configurationYaml).toBe(result.configurationYaml);
    expect(customerAuth.companion?.packages).toEqual({
      customerRuntime: runtimeSource,
    });
  });

  it("reports the published npm runtime that serves the documented import paths", async () => {
    const root = new URL("../../../", import.meta.url);
    const generator = await readFile(
      new URL("scripts/prepare-npm-client-release.mjs", root),
      "utf8",
    );
    const runtime = JSON.parse(
      await readFile(new URL("packages/customer-runtime/package.json", root), "utf8"),
    );
    // The npm package is this release's runtime archive renamed, so its exports are the same.
    expect(generator).toContain('"customer-runtime": ["runtime", "packages/customer-runtime"]');
    expect(generator).toContain("metadata.name = `@amerged/ohmyhost-${suffix}`;");
    expect(runtime.version).toBe(cliVersion);
    expect(Object.keys(runtime.exports).sort()).toEqual([
      ".",
      "./auth-browser",
      "./auth-server",
      "./database",
      "./database-kysely",
      "./database-rls",
      "./mail",
      "./mail-attachment",
      "./preview-transport",
      "./storage",
    ]);
    expect(runtime.exports["./preview-transport"]).toEqual({
      source: "./src/preview-transport.ts",
      types: "./dist/preview-transport.d.ts",
      import: "./dist/preview-transport.js",
    });
    expect(runtimeSource).not.toContain("ohmyho.st/releases");
  });

  it("reports the runtime package and bindings of a Next.js app with a database", async () => {
    // Observed 2026-09-18: Next.js and TanStack Start apps with a database got neither the runtime
    // package nor its bindings, so the Skills' "install what init reports" had nothing to install.
    const directory = await repository({
      name: "next-database",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "next.config.ts"), "export default {};\n", "utf8");

    expect((await initializeRepository({ directory, dryRun: true })).runtime).toBeNull();

    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "20260918000000_items.sql"),
      "create table public.items(id uuid primary key);\n",
    );
    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(result.companion).toBeNull();
    expect(result.worker).toBeNull();
    expect(result.runtime).toEqual({
      bindings: ["OHMYHOST_DATABASE"],
      packages: { customerRuntime: runtimeSource },
    });
  });

  it("names the exact build script and commands each framework and package manager admit", async () => {
    // Both frameworks admit one TypeScript stage before or after the Vite build.
    const vite = await repository({
      name: "vite-typecheck",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build && tsc --noEmit" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(vite, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const tanstack = await repository({
      name: "tanstack-typecheck",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build && tsc --noEmit" },
      dependencies: {
        "@tanstack/react-router": "1.170.41",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: { "@vitejs/plugin-react": "6.1.0", vite: "8.2.2" },
    });
    await writeFile(join(tanstack, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(tanstack, "vite.config.ts"),
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart({ prerender: { enabled: true } })] };\n",
      "utf8",
    );
    for (const directory of [vite, tanstack]) {
      const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      for (const build of [
        "vite build",
        ...["tsc", "tsc -b", "tsc --build", "tsc --noEmit"].flatMap((stage) => [
          `${stage} && vite build`,
          `vite build && ${stage}`,
        ]),
      ]) {
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ ...packageJson, scripts: { build } }),
        );
        expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([]);
      }
      for (const build of [
        "vite build --mode ci",
        "vite build && echo done",
        "tsc -b && vite build && tsc --noEmit",
      ]) {
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ ...packageJson, scripts: { build } }),
        );
        expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
          blocker("build_script_unsupported", "package.json", {
            framework: directory === vite ? "vite-static" : "tanstack-start",
          }),
        ]);
      }
    }

    // The catalog sentence names the admitted script and never repeats the customer's.
    const longCommand = `next build && ${"x".repeat(300)}`;
    const next = await repository({
      name: "next-long-build",
      packageManager: "pnpm@10.28.2",
      scripts: { build: longCommand },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(next, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(next, "next.config.ts"), "export default {};\n", "utf8");
    const nextBlockers = (await initializeRepository({ directory: next, dryRun: true })).blockers;
    expect(nextBlockers).toEqual([
      blocker("build_script_unsupported", "package.json", { framework: "nextjs" }),
    ]);
    expect(JSON.stringify(nextBlockers)).not.toContain("xxxx");

    // The committed ohmyhost.yaml must use the install and build commands of package.json's manager.
    const configured = await repository({
      name: "vite-configured",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(configured, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(configured, "ohmyhost.yaml"),
      "version: 1\nproject: vite-configured\nbuild:\n  install: npm ci\n  command: npm run build\n  output: dist\nruntime:\n  mode: static\n",
    );
    expect((await initializeRepository({ directory: configured, dryRun: true })).blockers).toEqual([
      blocker("build_command_mismatch", "ohmyhost.yaml"),
    ]);
  });

  it("normalizes a conventional npm package name into a portable project slug", async () => {
    const directory = await repository({
      name: "vite_react_shadcn_ts",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(parseOhmyhostConfigYaml(result.configurationYaml).project).toBe("vite-react-shadcn-ts");
    await expect(
      initializeRepository({ directory, project: "Invalid_Project", dryRun: true }),
    ).rejects.toMatchObject({ code: "project_name_invalid" });
  });

  it.each([
    ["npm@10.9.3", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
    [
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    ["yarn@4.10.3", "yarn.lock", "yarn install --immutable --mode=skip-build", "yarn run build"],
    [
      `bun@${PINNED_BUN_VERSION}`,
      "bun.lock",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run build",
    ],
  ])(
    "admits an exact %s declaration with its only matching lockfile",
    async (packageManager, lockfile, installCommand, buildCommand) => {
      const directory = await repository({
        name: "portable-vite",
        packageManager,
        scripts: { build: "vite build" },
        devDependencies: { vite: "8.2.2" },
      });
      await writeFile(join(directory, lockfile), "fixture\n", "utf8");

      const result = await initializeRepository({ directory, dryRun: true });

      expect(result.blockers).toEqual([]);
      // No lockfile of this placeholder resolves vite, so the exact declaration decides.
      expect(result.compatibility).toEqual({
        frameworks: [
          {
            package: "vite",
            declared: "8.2.2",
            resolved: null,
            status: "admitted",
            minimum: "5.4.6",
          },
        ],
      });
      expect(result.pending.map(({ code }) => code)).toEqual(PENDING);
      expect(parseOhmyhostConfigYaml(result.configurationYaml).build).toMatchObject({
        install: installCommand,
        command: buildCommand,
      });
      // The exact values build_command_mismatch tells the agent to read here.
      expect(result.inventory.packageManager).toEqual({
        name: packageManager.slice(0, packageManager.indexOf("@")),
        version: packageManager.slice(packageManager.indexOf("@") + 1),
        lockfile,
        installCommand,
        buildCommand,
      });
    },
  );

  it("names the lockfile that the declared packageManager did not write", async () => {
    const directory = await repository({
      name: "mismatched-package-manager",
      packageManager: "npm@10.9.3",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "yarn.lock"), "fixture\n", "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([blocker("package_manager_lockfile_mismatch", "yarn.lock")]);
    // A refused package manager has no commands ohmyho.st would run.
    expect(result.inventory.packageManager).toEqual({
      name: "npm",
      version: "10.9.3",
      lockfile: "yarn.lock",
      installCommand: null,
      buildCommand: null,
    });
  });

  it("admits versions from the security minimum on and judges a resolved range by its lockfile", async () => {
    const pnpmLockfile = (version: string) =>
      `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    devDependencies:\n      vite:\n        specifier: ^5.4.0\n        version: ${version}\n`;
    const npmLockfile = (version: string) =>
      JSON.stringify({
        name: "vite-versions",
        lockfileVersion: 3,
        packages: { "": { name: "vite-versions" }, "node_modules/vite": { version } },
      });
    for (const [declared, lockfile, contents, framework, found] of [
      // Higher stable releases pass: there is no upper bound.
      ["7.1.0", "pnpm-lock.yaml", "fixture\n", ["7.1.0", null, "admitted", "5.4.6"], []],
      ["8.3.0", "pnpm-lock.yaml", "fixture\n", ["8.3.0", null, "admitted", "5.4.6"], []],
      ["9.0.0", "pnpm-lock.yaml", "fixture\n", ["9.0.0", null, "admitted", "5.4.6"], []],
      [
        "5.4.5",
        "pnpm-lock.yaml",
        "fixture\n",
        ["5.4.5", null, "unsupported", "5.4.6"],
        [["package.json", { version: "5.4.5", minimum: "5.4.6" }]],
      ],
      [
        "latest",
        "pnpm-lock.yaml",
        "fixture\n",
        ["latest", null, "unsupported", "5.4.6"],
        [["package.json", null]],
      ],
      // An unresolved range that can pass is pending: a placeholder, unparseable or binary
      // lockfile resolves nothing and never blocks.
      ["^5.4.0", "pnpm-lock.yaml", "fixture\n", ["^5.4.0", null, "pending", "5.4.6"], []],
      ["^5.4.0", "pnpm-lock.yaml", "importers: [\n", ["^5.4.0", null, "pending", "5.4.6"], []],
      [
        "^5.4.0",
        "package-lock.json",
        new Uint8Array([0xff, 0xfe]),
        ["^5.4.0", null, "pending", "5.4.6"],
        [],
      ],
      // The lockfile resolution decides.
      [
        "^5.4.0",
        "pnpm-lock.yaml",
        pnpmLockfile("5.4.5"),
        ["^5.4.0", "5.4.5", "unsupported", "5.4.6"],
        [["pnpm-lock.yaml", { version: "5.4.5", minimum: "5.4.6" }]],
      ],
      [
        "^5.4.0",
        "pnpm-lock.yaml",
        pnpmLockfile("5.4.21"),
        ["^5.4.0", "5.4.21", "admitted", "5.4.6"],
        [],
      ],
      [
        "^5.4.0",
        "package-lock.json",
        npmLockfile("5.4.21"),
        ["^5.4.0", "5.4.21", "admitted", "5.4.6"],
        [],
      ],
    ] as const) {
      const directory = await repository({
        name: "vite-versions",
        packageManager: lockfile === "pnpm-lock.yaml" ? "pnpm@10.28.2" : "npm@10.9.3",
        scripts: { build: "vite build" },
        devDependencies: { vite: declared },
      });
      await writeFile(join(directory, lockfile), contents);

      const result = await initializeRepository({ directory, dryRun: true });

      const [version, resolved, status, minimum] = framework;
      expect(result.compatibility.frameworks, declared).toEqual([
        { package: "vite", declared: version, resolved, status, minimum },
      ]);
      expect(result.blockers, declared).toEqual(
        found.map(([path, fields]) =>
          fields === null
            ? blocker("framework_version_declaration_unsupported", path, { package: "vite" })
            : blocker("framework_version_unsupported", path, { package: "vite", ...fields }),
        ),
      );
      expect(result.pending.map(({ code }) => code)).toEqual(
        status === "pending" ? ["installed_version", ...PENDING] : PENDING,
      );
    }
  });

  it("reports both TanStack Start and Vite compatibility through an mjs config", async () => {
    const directory = await repository({
      name: "tanstack-current",
      packageManager: "yarn@4.10.3",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.41",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.0",
        "react-dom": "19.2.0",
      },
      devDependencies: { "@vitejs/plugin-react": "6.1.0", vite: "8.2.2" },
    });
    await writeFile(join(directory, "yarn.lock"), "fixture\n", "utf8");
    await writeFile(
      join(directory, "vite.config.mjs"),
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart({ prerender: { enabled: true } })] };\n",
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    // Yarn's lockfile is not read, so both exact declarations decide.
    expect(result.compatibility).toEqual({
      frameworks: [
        {
          package: "@tanstack/react-start",
          declared: "1.168.60",
          resolved: null,
          status: "admitted",
          minimum: "1.168.60",
        },
        {
          package: "vite",
          declared: "8.2.2",
          resolved: null,
          status: "admitted",
          minimum: "5.4.6",
        },
      ],
    });
  });

  it("admits Next edge source without customer-owned OpenNext or Wrangler packages", async () => {
    const directory = await repository({
      name: "next-overlay",
      packageManager: "npm@10.9.3",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(directory, "package-lock.json"), "{}\n", "utf8");
    await writeFile(join(directory, "next.config.mjs"), "export default {};\n", "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(result.compatibility.frameworks).toEqual([
      {
        package: "next",
        declared: "16.4.5",
        resolved: null,
        status: "admitted",
        minimum: "16.4.5",
      },
    ]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml).build).toMatchObject({
      install: "npm ci --ignore-scripts",
      command: "npm run build",
      output: ".open-next/assets",
    });
    const configured = result.configurationYaml.replace(
      "build:\n",
      "build:\n  ssg_cache_max_mib: 64\n",
    );
    await writeFile(join(directory, "ohmyhost.yaml"), configured, "utf8");
    const repeated = await initializeRepository({ directory, dryRun: true });
    expect(repeated.blockers).toEqual([]);
    expect(repeated.configurationYaml).toBe(configured);
    expect(parseOhmyhostConfigYaml(repeated.configurationYaml).build).toMatchObject({
      ssg_cache_max_mib: 64,
    });
    // A Next.js plan always runs the packageManager's commands, so planning ignores these values.
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      configured.replace("npm ci --ignore-scripts", "npm install").replace("npm run", "npx next"),
      "utf8",
    );
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([]);
  });

  it("blocks ambiguous supported framework config extensions", async () => {
    const directory = await repository({
      name: "next-ambiguous-config",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "fixture\n", "utf8");
    await writeFile(join(directory, "next.config.js"), "export default {};\n", "utf8");
    await writeFile(join(directory, "next.config.ts"), "export default {};\n", "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([blocker("framework_config_ambiguous", "next.config.js")]);
    const { rm } = await import("node:fs/promises");
    await rm(join(directory, "next.config.ts"));
    await writeFile(join(directory, "open-next.config.js"), "export default {};\n");
    await writeFile(join(directory, "open-next.config.ts"), "export default {};\n");
    const ambiguousAdapter = await initializeRepository({ directory, dryRun: true });
    expect(ambiguousAdapter.blockers).toEqual([
      blocker("framework_config_ambiguous", "open-next.config.js"),
    ]);
  });

  it("inventories a Next/Supabase repository without running source code or mutating it", async () => {
    const directory = await repository({
      name: "stay-simpli",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build", "build:cloudflare": "opennextjs-cloudflare build" },
      dependencies: {
        "@lovable.dev/email-js": "0.1.0",
        "@opennextjs/cloudflare": "1.20.2",
        "@supabase/supabase-js": "2.112.3",
        next: "16.4.5",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: { wrangler: "4.125.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "next.config.ts"), "export default {};\n", "utf8");
    await writeFile(
      join(directory, "open-next.config.ts"),
      'import { defineCloudflareConfig } from "@opennextjs/cloudflare";\nexport default defineCloudflareConfig();\n',
      "utf8",
    );
    await writeFile(join(directory, "wrangler.jsonc"), "{}\n", "utf8");
    await mkdir(join(directory, "supabase", "migrations"), { recursive: true });
    await writeFile(join(directory, "supabase", "migrations", "001.sql"), "select 1;\n");
    await writeFile(join(directory, "supabase", "migrations", "002.sql"), "select 2;\n");
    await mkdir(join(directory, "supabase", "functions", "send-mail"), { recursive: true });
    await writeFile(
      join(directory, "supabase", "functions", "send-mail", "index.ts"),
      "throw new Error('must not execute');\n",
    );
    await mkdir(join(directory, "src", "app", "api", "health"), { recursive: true });
    await writeFile(join(directory, "src", "app", "api", "health", "route.ts"), "export {};\n");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result).toMatchObject({
      status: "analyzed",
      written: false,
      applicationRoot: ".",
      applicationRootSource: "repository",
      blockers: [],
      inventory: {
        framework: "nextjs",
        packageManager: { name: "pnpm", version: "10.28.2", lockfile: "pnpm-lock.yaml" },
        apiRouteCount: 1,
        database: { provider: "supabase", migrationCount: 2 },
        auth: { betterAuth: false, supabase: true },
        edgeFunctions: { count: 1 },
        mail: { detected: true },
      },
    });
    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      project: "stay-simpli",
      build: {
        install: "pnpm install --frozen-lockfile --ignore-scripts",
        command: "pnpm run build",
        output: ".open-next/assets",
      },
      runtime: { mode: "edge", healthcheck: "/api/health" },
      database: { enabled: true, migrations: "postgres/migrations" },
      auth: { provider: "none" },
      mail: { enabled: false },
    });
    expect(result.requirements).toContain("application-auth-review");
    expect(result.requirements).not.toContain("better-auth-conversion");
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("source-binds only the pinned Better Auth customer runtime", async () => {
    const directory = await repository({
      name: "portable-auth",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: { "better-auth": "1.7.7" },
      devDependencies: { vite: "7.3.6" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const proposed = await initializeRepository({ directory, dryRun: true });
    const configuration = parseOhmyhostConfigYaml(proposed.configurationYaml);
    await mkdir(join(directory, "postgres/migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres/migrations/20260909000000_items.sql"),
      "create table public.items(id uuid primary key);\n",
    );
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      JSON.stringify({
        ...configuration,
        runtime: { ...configuration.runtime, mode: "edge" },
        database: { enabled: true, migrations: "postgres/migrations" },
        auth: { provider: "better-auth" },
        mail: { enabled: true },
      }),
    );
    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml).auth).toEqual({
      provider: "better-auth",
    });

    const configured = parseOhmyhostConfigYaml(result.configurationYaml);
    for (const database of [undefined, { enabled: false }]) {
      await writeFile(
        join(directory, "ohmyhost.yaml"),
        JSON.stringify({ ...configured, database }),
      );
      await expect(initializeRepository({ directory, dryRun: true })).resolves.toMatchObject({
        blockers: [expect.objectContaining({ code: "managed_auth_database_required" })],
      });
    }
    for (const mail of [undefined, { enabled: false }]) {
      await writeFile(join(directory, "ohmyhost.yaml"), JSON.stringify({ ...configured, mail }));
      const independent = await initializeRepository({ directory, dryRun: true });
      expect(independent.blockers).toEqual([]);
      expect(parseOhmyhostConfigYaml(independent.configurationYaml).mail).toEqual(mail);
    }
    const packageBefore = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        ...packageBefore,
        dependencies: { "better-auth": "1.7.7", resend: "6.0.0" },
      }),
    );
    const ownSenderConfig = { ...configured, mail: { enabled: false } };
    const ownSenderBytes = JSON.stringify(ownSenderConfig);
    await writeFile(join(directory, "ohmyhost.yaml"), ownSenderBytes);
    const ownSender = await initializeRepository({ directory, dryRun: true });
    expect(ownSender.blockers).toEqual([]);
    expect(parseOhmyhostConfigYaml(ownSender.configurationYaml)).toMatchObject({
      auth: { provider: "better-auth" },
      database: { enabled: true },
      mail: { enabled: false },
    });
    expect(await readFile(join(directory, "ohmyhost.yaml"), "utf8")).toBe(ownSenderBytes);
    await writeFile(join(directory, "ohmyhost.yaml"), JSON.stringify(configured));

    const packageJson = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    // Planning installs exactly the bridge's better-auth: a range or no declaration is refused.
    for (const dependencies of [{ "better-auth": "^1.7.7" }, {}]) {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({ ...packageJson, dependencies })}\n`,
        "utf8",
      );
      expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
        blocker("better_auth_version_required", "package.json"),
      ]);
    }
  });

  it("emits the exact Vite edge companion scaffold for provider-backed capabilities", async () => {
    const directory = await repository({
      name: "portable-vite",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: { "@supabase/supabase-js": "2.112.4" },
      devDependencies: { vite: "8.2.2", wrangler: "4.125.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "supabase", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "supabase", "migrations", "20260824000000_source.sql"),
      "create table public.events(id uuid);\n",
    );
    await mkdir(join(directory, "supabase", "functions", "events"), { recursive: true });
    await writeFile(join(directory, "supabase", "functions", "events", "index.ts"), "export {};\n");
    await mkdir(join(directory, "worker"), { recursive: true });
    await writeFile(
      join(directory, "worker", "wrangler.toml"),
      '[[r2_buckets]]\nbinding = "SESSIONS"\nbucket_name = "legacy"\n',
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toEqual({
      version: 1,
      project: "portable-vite",
      applicationRoot: ".",
      build: {
        install: "pnpm install --frozen-lockfile --ignore-scripts",
        command: "pnpm run build",
        output: "dist",
      },
      runtime: { mode: "edge", healthcheck: "/", egress: { allow: [] } },
      database: { enabled: true, migrations: "postgres/migrations" },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { provider: "r2", jurisdiction: "us", public: false },
    });
    // An EU project keeps its files in the EU; init writes the region the caller resolved.
    const european = await initializeRepository({ directory, dryRun: true, region: "eu" });
    expect(parseOhmyhostConfigYaml(european.configurationYaml).storage).toEqual({
      provider: "r2",
      jurisdiction: "eu",
      public: false,
    });
    expect(result.requirements).toEqual([
      "application-auth-review",
      "edge-function-conversion",
      "supabase-postgres-conversion",
      "vite-api-companion",
    ]);
    expect(result.companion).toEqual({
      schemaVersion: "ohmyhost.vite-api-companion/v1",
      sourceEntryPoint: "src/ohmyhost/companion.ts",
      requiredFiles: ["src/ohmyhost/companion.ts"],
      missingFiles: ["src/ohmyhost/companion.ts"],
      packages: {
        customerRuntime: runtimeSource,
      },
      bindings: [
        "OHMYHOST_DATABASE",
        "OHMYHOST_ENVIRONMENT_ID",
        "OHMYHOST_PROJECT_ID",
        "OHMYHOST_STORAGE_GATEWAY_URL",
        "OHMYHOST_STORAGE_KEY",
      ],
      artifact: {
        outputDirectory: ".ohmyhost/vite-companion",
        entryPoint: ".ohmyhost/vite-companion/worker.js",
        configPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      },
    });
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(directory, "src", "ohmyhost", "companion.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(directory, "ohmyhost.yaml"), result.configurationYaml);
    const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    packageJson.dependencies["better-auth"] = "1.7.7";
    await writeFile(join(directory, "package.json"), JSON.stringify(packageJson));
    const preserved = await initializeRepository({ directory, dryRun: true });
    expect(preserved.configurationYaml).toBe(result.configurationYaml);
    expect(preserved.companion?.packages).toEqual({
      customerRuntime: runtimeSource,
    });
    expect(preserved.companion?.bindings).toEqual([
      "OHMYHOST_DATABASE",
      "OHMYHOST_ENVIRONMENT_ID",
      "OHMYHOST_PROJECT_ID",
      "OHMYHOST_STORAGE_GATEWAY_URL",
      "OHMYHOST_STORAGE_KEY",
    ]);
  });

  it("honors the authoritative Vite companion manifest and reports dependency pins separately", async () => {
    const directory = await repository({
      name: "portable-vite-existing",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: { "better-auth": "1.7.7" },
      devDependencies: { vite: "8.2.2", wrangler: "^4.125.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "20260824000000_foundation.sql"),
      "create table public.sessions(id uuid primary key);\n",
    );
    await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
    await writeFile(
      join(directory, "src", "ohmyhost", "companion.ts"),
      'import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";\n' +
        "export default { fetch: (request, env) =>\n" +
        "  Response.json(createPrivateStorageClient({ key: env.OHMYHOST_STORAGE_KEY })) };\n",
      "utf8",
    );
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      [
        "version: 1",
        "project: portable-vite-existing",
        "build:",
        "  install: pnpm install --frozen-lockfile --ignore-scripts",
        "  command: pnpm run build",
        "  output: dist",
        "runtime:",
        "  mode: edge",
        "  healthcheck: /api/health",
        "database:",
        "  enabled: true",
        "  migrations: postgres/migrations",
        "auth:",
        "  provider: better-auth",
        "mail:",
        "  enabled: true",
        "storage:",
        "  provider: r2",
        "  jurisdiction: us",
        "  public: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.inventory).toMatchObject({
      database: { provider: "postgresql", migrationCount: 1 },
      auth: { betterAuth: true, supabase: false },
      storage: { r2: true, supabase: false },
      mail: { detected: true },
    });
    expect(result.companion).toMatchObject({
      missingFiles: [],
      packages: {
        betterAuth: "1.7.7",
        customerRuntime: runtimeSource,
      },
      bindings: [
        "BETTER_AUTH_SECRET",
        "OHMYHOST_DATABASE",
        "OHMYHOST_ENVIRONMENT_ID",
        "OHMYHOST_MAIL_GATEWAY_URL",
        "OHMYHOST_MAIL_KEY",
        "OHMYHOST_PROJECT_ID",
        "OHMYHOST_STORAGE_GATEWAY_URL",
        "OHMYHOST_STORAGE_KEY",
      ],
    });
    expect(result.requirements).not.toContain("vite-api-companion");
    expect(result.blockers).toEqual([]);
    expect(result.runtime?.bindings).toEqual(result.companion?.bindings);
    expect(result.runtime?.bindings.filter((name) => name === "OHMYHOST_PROJECT_ID")).toHaveLength(
      1,
    );

    const mailOnly = parseOhmyhostConfigYaml(result.configurationYaml);
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      JSON.stringify({ ...mailOnly, storage: undefined }),
    );
    expect((await initializeRepository({ directory, dryRun: true })).runtime?.bindings).toEqual([
      "BETTER_AUTH_SECRET",
      "OHMYHOST_DATABASE",
      "OHMYHOST_MAIL_GATEWAY_URL",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_PROJECT_ID",
    ]);
  });

  it("names the AI gateway runtime contract for a Vite companion with declared AI", async () => {
    const directory = await repository({
      name: "ai-vite-existing",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      [
        "version: 1",
        "project: ai-vite-existing",
        "build:",
        "  install: pnpm install --frozen-lockfile --ignore-scripts",
        "  command: pnpm run build",
        "  output: dist",
        "runtime:",
        "  mode: edge",
        "  healthcheck: /api/health",
        "ai:",
        "  enabled: true",
        "  jurisdiction: eu",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.requirements).not.toContain("vite-api-companion");
    expect(result.companion?.bindings).toEqual(["OHMYHOST_AI_BASE_URL", "OHMYHOST_AI_KEY"]);
    expect(result.runtime?.bindings).toEqual(["OHMYHOST_AI_BASE_URL", "OHMYHOST_AI_KEY"]);
    expect(result.companion?.packages).toEqual({});
  });

  it("preserves the Browser rendering declaration and reports its server-only runtime values", async () => {
    const directory = await repository({
      name: "browser-vite-existing",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);
    const yaml = [
      "version: 1",
      "project: browser-vite-existing",
      "build:",
      "  install: pnpm install --frozen-lockfile --ignore-scripts",
      "  command: pnpm run build",
      "  output: dist",
      "runtime:",
      "  mode: edge",
      "  healthcheck: /api/health",
      "browser:",
      "  enabled: true",
      "",
    ].join("\n");
    await writeFile(join(directory, "ohmyhost.yaml"), yaml, "utf8");
    const result = await initializeRepository({ directory, dryRun: true });
    expect(result.configurationYaml).toBe(yaml);
    expect(result.companion?.bindings).toEqual([
      "OHMYHOST_BROWSER_BASE_URL",
      "OHMYHOST_BROWSER_KEY",
    ]);
    expect(result.runtime?.bindings).toEqual(["OHMYHOST_BROWSER_BASE_URL", "OHMYHOST_BROWSER_KEY"]);
    expect(result.blockers).toEqual([]);
  });

  it("names the storage gateway runtime contract and blocks declared storage without client code", async () => {
    const storageBindings = [
      "OHMYHOST_ENVIRONMENT_ID",
      "OHMYHOST_PROJECT_ID",
      "OHMYHOST_STORAGE_GATEWAY_URL",
      "OHMYHOST_STORAGE_KEY",
    ];
    const storageYaml = "storage:\n  provider: r2\n  jurisdiction: us\n  public: false\n";
    const client =
      'import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";\n' +
      "export default { async fetch(request, env) {\n" +
      "  const storage = createPrivateStorageClient({\n" +
      "    endpoint: env.OHMYHOST_STORAGE_GATEWAY_URL,\n" +
      "    fetch: (outbound) => fetch(outbound),\n" +
      "    capabilityFetch: (outbound) => fetch(outbound),\n" +
      "    projectId: env.OHMYHOST_PROJECT_ID,\n" +
      "    environmentId: env.OHMYHOST_ENVIRONMENT_ID,\n" +
      "    key: env.OHMYHOST_STORAGE_KEY,\n" +
      "  });\n" +
      "  return Response.json(await storage.createSignedRead('clip.mp4'));\n" +
      "} };\n";

    const vite = await repository({
      name: "video-vite",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(vite, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(vite, "src", "ohmyhost"), { recursive: true });
    const companion = join(vite, "src", "ohmyhost", "companion.ts");
    await writeFile(companion, "export default { fetch: () => new Response('ok') };\n", "utf8");
    await writeFile(
      join(vite, "ohmyhost.yaml"),
      "version: 1\nproject: video-vite\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: edge\n" +
        storageYaml,
      "utf8",
    );

    const silent = await initializeRepository({ directory: vite, dryRun: true });

    expect(silent.companion?.bindings).toEqual(storageBindings);
    expect(silent.companion?.packages).toEqual({ customerRuntime: runtimeSource });
    expect(silent.blockers).toEqual([
      {
        code: "storage_client_missing",
        path: null,
        message: expect.stringContaining("createPrivateStorageClient") as unknown as string,
      },
    ]);
    expect(silent.blockers[0]?.message).toContain("@ohmyhost/customer-runtime/storage");
    expect(silent.blockers[0]?.message).toContain("OHMYHOST_STORAGE_KEY");
    expect(silent.blockers[0]?.message).toContain("fetch: (request) => fetch(request)");
    expect(silent.blockers[0]?.message).toContain("capabilityFetch: (request) => fetch(request)");
    expect(silent.blockers[0]?.message).not.toMatch(/\bOHMYHOST_STORAGE_GATEWAY\b/u);

    await writeFile(companion, client, "utf8");
    await expect(initializeRepository({ directory: vite, dryRun: true })).resolves.toMatchObject({
      blockers: [],
    });

    const worker = await repository({
      name: "video-jobs",
      packageManager: "pnpm@10.28.2",
      dependencies: {},
    });
    await writeFile(join(worker, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(worker, "src", "ohmyhost"), { recursive: true });
    const module = join(worker, "src", "ohmyhost", "worker.ts");
    await writeFile(module, "export default { async fetch() { return new Response('ok'); } };\n");
    await writeFile(
      join(worker, "ohmyhost.yaml"),
      "version: 1\nproject: video-jobs\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\nruntime:\n  mode: functions\n" +
        storageYaml,
      "utf8",
    );

    const silentWorker = await initializeRepository({ directory: worker, dryRun: true });

    expect(silentWorker.worker).toEqual({
      sourceEntryPoint: "src/ohmyhost/worker.ts",
      present: true,
      bindings: storageBindings,
      packages: { customerRuntime: runtimeSource },
    });
    expect(silentWorker.blockers).toEqual([
      expect.objectContaining({ code: "storage_client_missing" }),
    ]);

    await writeFile(module, client);
    await expect(initializeRepository({ directory: worker, dryRun: true })).resolves.toMatchObject({
      blockers: [],
    });

    for (const gateway of ["OHMYHOST_MAIL_GATEWAY", "OHMYHOST_STORAGE_GATEWAY"]) {
      await writeFile(module, `${client}\nexport const legacy = (env) => env.${gateway};\n`);
      const unsupported = await initializeRepository({ directory: worker, dryRun: true });
      expect(unsupported.blockers).toEqual([
        {
          code: "gateway_binding_unsupported",
          path: "src/ohmyhost/worker.ts",
          message: expect.stringContaining(
            "fetch: (request) => fetch(request)",
          ) as unknown as string,
        },
      ]);
      await expect(
        initializeRepository({ directory: worker, dryRun: false }),
      ).rejects.toMatchObject({
        code: "repository_init_blocked",
        blockers: unsupported.blockers,
      });
    }

    // Types, diagnostic strings and test fixtures do not select a gateway transport.
    for (const suffix of ["ts", "mts", "cts"])
      await writeFile(
        join(worker, "src", `environment.d.${suffix}`),
        "interface Env { OHMYHOST_STORAGE_GATEWAY: Fetcher }\n" +
          "type MailBinding = typeof env.OHMYHOST_MAIL_GATEWAY;\n",
      );
    await writeFile(
      module,
      client +
        "interface Env { OHMYHOST_STORAGE_GATEWAY: Fetcher }\n" +
        "const runtimeEnv: { OHMYHOST_STORAGE_GATEWAY: Fetcher } = env;\n" +
        'type MailBinding = Env["OHMYHOST_MAIL_GATEWAY"];\n' +
        'const diagnostic = "env.OHMYHOST_STORAGE_GATEWAY.fetch(request)";\n' +
        "const escapedDiagnostic = " +
        JSON.stringify('quote " env.OHMYHOST_STORAGE_GATEWAY.fetch(request)') +
        ";\n" +
        "const message = `env.OHMYHOST_MAIL_GATEWAY.fetch(request)`;\n" +
        "const platformEnv = { ...env, OHMYHOST_MAIL_GATEWAY: binding };\n" +
        'const otherFixture = { "OHMYHOST_STORAGE_GATEWAY": binding };\n' +
        "const { ordinary: OHMYHOST_STORAGE_GATEWAY } = env;\n",
    );
    await expect(initializeRepository({ directory: worker, dryRun: true })).resolves.toMatchObject({
      blockers: [],
    });

    for (const usage of [
      "const legacy = env?.OHMYHOST_STORAGE_GATEWAY;",
      "const legacy: { ordinary: unknown } = env.OHMYHOST_STORAGE_GATEWAY;",
      "const legacy = `result: ${await env.OHMYHOST_MAIL_GATEWAY.fetch(request)}`;",
      "const legacy = `result: ${({ ordinary: 1 }), env.OHMYHOST_STORAGE_GATEWAY}`;",
      'const legacy = env["OHMYHOST_MAIL_GATEWAY"];',
      'const legacy = env?.["OHMYHOST_MAIL_GATEWAY"];',
      "const legacy = env['OHMYHOST_STORAGE_GATEWAY'];",
      "const { OHMYHOST_STORAGE_GATEWAY: gateway } = env;",
      'const { "OHMYHOST_MAIL_GATEWAY": gateway } = env;',
      "({ OHMYHOST_STORAGE_GATEWAY: gateway } = env);",
    ]) {
      await writeFile(module, `${client}\n${usage}\n`);
      expect((await initializeRepository({ directory: worker, dryRun: true })).blockers).toEqual([
        expect.objectContaining({
          code: "gateway_binding_unsupported",
          path: "src/ohmyhost/worker.ts",
        }),
      ]);
    }

    // URL/key values, comments about the old bindings and an explicit custom fetch remain valid.
    const customClient = client.replace(
      "fetch: (outbound) => fetch(outbound)",
      "fetch: customFetch",
    );
    await writeFile(
      module,
      "// env.OHMYHOST_MAIL_GATEWAY.fetch(request)\n" +
        "/* env.OHMYHOST_STORAGE_GATEWAY.fetch(request) */\n" +
        "const customFetch = (request) => fetch(request);\n" +
        customClient +
        "export const mail = (env) => [env.OHMYHOST_MAIL_GATEWAY_URL, env.OHMYHOST_MAIL_KEY];\n",
    );
    await expect(initializeRepository({ directory: worker, dryRun: true })).resolves.toMatchObject({
      blockers: [],
    });
  });

  it("counts only a storage client call, never a type-only import or a comment", async () => {
    const directory = await repository({
      name: "storage-mentions",
      packageManager: "pnpm@10.28.2",
      dependencies: {},
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      "version: 1\nproject: storage-mentions\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\nruntime:\n  mode: functions\nstorage:\n  provider: r2\n  jurisdiction: us\n  public: false\n",
      "utf8",
    );
    const module = join(directory, "src", "ohmyhost", "worker.ts");
    const handler = "export default { async fetch() { return new Response('ok'); } };\n";
    const blockersOf = async (): Promise<readonly unknown[]> =>
      (await initializeRepository({ directory, dryRun: true })).blockers;

    await writeFile(
      module,
      'import type {\n  createPrivateStorageClient,\n} from "@ohmyhost/customer-runtime/storage";\n' +
        handler,
      "utf8",
    );
    expect(await blockersOf()).toEqual([
      expect.objectContaining({ code: "storage_client_missing" }),
    ]);

    await writeFile(
      module,
      "// call createPrivateStorageClient(options) once uploads exist\n" +
        "/*\n  const storage = createPrivateStorageClient({ key: env.OHMYHOST_STORAGE_KEY });\n*/\n" +
        handler,
      "utf8",
    );
    expect(await blockersOf()).toEqual([
      expect.objectContaining({ code: "storage_client_missing" }),
    ]);

    await writeFile(
      module,
      'import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";\n' +
        "export const storage = (env) =>\n  createPrivateStorageClient ({ key: env.OHMYHOST_STORAGE_KEY });\n" +
        handler,
      "utf8",
    );
    expect(await blockersOf()).toEqual([]);

    await writeFile(
      module,
      'import { storage } from "../storage.js";\nexport { storage };\n' + handler,
      "utf8",
    );
    await writeFile(
      join(directory, "src", "storage.ts"),
      'import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";\n' +
        "export const storage = (env) => createPrivateStorageClient({ key: env.OHMYHOST_STORAGE_KEY });\n",
      "utf8",
    );
    expect(await blockersOf()).toEqual([]);
  });

  it("reports declared crons for a scheduling companion and blocks static or handler-less sources", async () => {
    const directory = await repository({
      name: "cron-vite",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2", wrangler: "4.125.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
    const companion = join(directory, "src", "ohmyhost", "companion.ts");
    await writeFile(
      companion,
      "export default { async fetch() { return new Response(); }, async scheduled() {} };\n",
    );
    const yaml = (mode: string) =>
      `version: 1\nproject: cron-vite\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: ${mode}\nfunctions:\n  crons:\n    - "*/5 * * * *"\n`;
    await writeFile(join(directory, "ohmyhost.yaml"), yaml("edge"));

    const result = await initializeRepository({ directory, dryRun: true });
    expect(result.inventory.functions.crons).toEqual(["*/5 * * * *"]);
    expect(result.blockers).toEqual([]);
    expect(result.companion).not.toBeNull();
    expect(result.worker).toBeNull();

    await writeFile(companion, "export default { async fetch() { return new Response(); } };\n");
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      blocker("scheduled_handler_required", "src/ohmyhost/companion.ts"),
    ]);
    // Named exports are never invoked by the platform: the handler must sit on the default export.
    await writeFile(
      companion,
      "export async function fetch() { return new Response(); }\nexport async function scheduled() {}\n",
    );
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      blocker("worker_module_default_export_required", "src/ohmyhost/companion.ts"),
    ]);
    // Crons need the companion's edge runtime; the shared rules name the runtime.mode to set.
    await writeFile(join(directory, "ohmyhost.yaml"), yaml("static"));
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      blocker("runtime_mode_unsupported", "ohmyhost.yaml", { framework: "vite-static" }),
    ]);
  });

  it("initializes a functions Worker repository without a framework build", async () => {
    const directory = await repository({
      name: "jobs",
      packageManager: "pnpm@10.28.2",
      dependencies: {},
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
    await writeFile(
      join(directory, "src", "ohmyhost", "worker.ts"),
      "export default { async fetch() { return new Response('ok'); }, async scheduled() {} };\n",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.inventory.framework).toBe("functions");
    expect(result.blockers).toEqual([]);
    // The functions runtime builds no governed framework package.
    expect(result.compatibility.frameworks).toEqual([]);
    expect(result.worker).toEqual({
      sourceEntryPoint: "src/ohmyhost/worker.ts",
      present: true,
      bindings: [],
      packages: {},
    });
    expect(result.companion).toBeNull();
    const configuration = parseOhmyhostConfigYaml(result.configurationYaml);
    expect(configuration.runtime.mode).toBe("functions");
    expect(configuration.build).toEqual({
      install: "pnpm install --frozen-lockfile --ignore-scripts",
    });
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      `${result.configurationYaml}functions:\n  crons:\n    - "0 3 * * *"\n`,
    );
    const declared = await initializeRepository({ directory, dryRun: true });
    expect(declared.inventory.functions.crons).toEqual(["0 3 * * *"]);
    expect(declared.inventory.framework).toBe("functions");
    expect(declared.blockers).toEqual([]);

    await writeFile(
      join(directory, "src", "ohmyhost", "worker.ts"),
      "export async function fetch() { return new Response('ok'); }\nexport async function scheduled() {}\n",
    );
    const named = await initializeRepository({ directory, dryRun: true });
    expect(named.inventory.framework).toBe("functions");
    expect(named.blockers).toEqual([
      blocker("worker_module_default_export_required", "src/ohmyhost/worker.ts"),
    ]);
    // Handlers named only in a comment are missing, as planning judges them; init lists both.
    await writeFile(
      join(directory, "src", "ohmyhost", "worker.ts"),
      "export default {}; // fetch() and scheduled() follow\n",
    );
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      blocker("worker_module_fetch_handler_required", "src/ohmyhost/worker.ts"),
      blocker("scheduled_handler_required", "src/ohmyhost/worker.ts"),
    ]);
  });

  it("inventories canonical portable PostgreSQL migrations without a Supabase conversion requirement", async () => {
    const directory = await repository({
      name: "portable-postgres",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "20260823000000_foundation.sql"),
      "create table public.items(id uuid primary key);\n",
    );
    await writeFile(
      join(directory, "postgres", "migrations", "20260823010000_expand.sql"),
      "alter table public.items add column name text;\n",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.inventory.database).toEqual({
      provider: "postgresql",
      migrationCount: 2,
    });
    expect(result.requirements).not.toContain("supabase-postgres-conversion");
    expect(parseOhmyhostConfigYaml(result.configurationYaml).database).toEqual({
      enabled: true,
      migrations: "postgres/migrations",
    });
  });

  it("counts the configured migration tree relative to the selected application", async () => {
    for (const applicationRoot of [".", "apps/customer"]) {
      const packageJson = { name: "configured-migrations", packageManager: "pnpm@10.28.2" };
      const directory = await repository(packageJson);
      const application = join(directory, applicationRoot);
      await mkdir(join(application, "src/ohmyhost"), { recursive: true });
      await writeFile(join(application, "package.json"), JSON.stringify(packageJson));
      await writeFile(join(application, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFile(
        join(application, "src/ohmyhost/worker.ts"),
        "export default { fetch() { return new Response('ok'); } };\n",
      );
      for (const [path, sql] of [
        ["db.v2/migrations/20260929000000_items.sql", "CREATE TABLE public.items(id uuid);\n"],
        [
          "db.v2/migrations/nested/20260929000001_expand.sql",
          "ALTER TABLE public.items ADD COLUMN label text;\n",
        ],
        ["db.v2/migrations-other/20260929000002_other.sql", "DROP TABLE public.items;\n"],
        ["postgres/migrations/20260929000003_unused.sql", "DROP TABLE public.items;\n"],
      ] as const) {
        await mkdir(join(application, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
        await writeFile(join(application, path), sql);
      }
      if (applicationRoot !== ".") {
        for (const prefix of ["", "apps/customer-sibling/"]) {
          await mkdir(join(directory, prefix, "db.v2/migrations"), { recursive: true });
          await writeFile(
            join(directory, prefix, "db.v2/migrations/20260929000004_outside.sql"),
            "DROP TABLE public.items;\n",
          );
        }
        await writeFile(join(application, "ohmyhost.yaml"), "this: shadow config is ignored\n");
      }
      const yaml = JSON.stringify({
        version: 1,
        project: "configured-migrations",
        applicationRoot,
        build: { install: "pnpm install --frozen-lockfile --ignore-scripts" },
        runtime: { mode: "functions" },
        database: { enabled: true, migrations: "db.v2/migrations" },
      });
      await writeFile(join(directory, "ohmyhost.yaml"), yaml);
      const result = await initializeRepository({ directory, root: applicationRoot, dryRun: true });
      expect(result.inventory.database).toEqual({ provider: "postgresql", migrationCount: 2 });
      expect(result.applicationRoot).toBe(applicationRoot);
      expect(result.blockers).toEqual([]);
      expect(result.runtime?.bindings).toContain("OHMYHOST_DATABASE");
      expect(result.configurationYaml).toBe(yaml);
      expect(await readFile(join(directory, "ohmyhost.yaml"), "utf8")).toBe(yaml);
    }
  });

  it("counts disabled custom migration inventory without selecting managed database checks", async () => {
    const directory = await repository({
      name: "unselected-custom-migrations",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(join(directory, "custom/migrations"), { recursive: true });
    await writeFile(
      join(directory, "custom/migrations/001_unused.sql"),
      "DROP TABLE public.unused;\n",
    );
    await mkdir(join(directory, "postgres/migrations"), { recursive: true });
    for (const name of ["001_other.sql", "002_other.sql"])
      await writeFile(join(directory, "postgres/migrations", name), "DROP TABLE public.unused;\n");
    const yaml = JSON.stringify({
      version: 1,
      project: "unselected-custom-migrations",
      build: {
        install: "pnpm install --frozen-lockfile --ignore-scripts",
        command: "pnpm run build",
        output: "dist",
      },
      runtime: { mode: "static" },
      database: { enabled: false, migrations: "custom/migrations" },
    });
    await writeFile(join(directory, "ohmyhost.yaml"), yaml);
    const result = await initializeRepository({ directory, dryRun: true });
    expect(result.inventory.database).toEqual({ provider: "postgresql", migrationCount: 1 });
    expect(result.blockers).toEqual([]);
    expect(result.runtime).toBeNull();
    expect(result.companion).toBeNull();
    expect(result.configurationYaml).toBe(yaml);
    expect(await readFile(join(directory, "ohmyhost.yaml"), "utf8")).toBe(yaml);
  });

  it("keeps unselected database inventory out of managed blockers and runtime bindings", async () => {
    const directory = await repository({
      name: "selected-capabilities",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mkdir(join(directory, "postgres/migrations"), { recursive: true });
    for (const name of ["001_unused.sql", "20260909000000_unused.sql"])
      await writeFile(join(directory, "postgres/migrations", name), "DROP TABLE public.unused;\n");
    const base = {
      version: 1,
      project: "selected-capabilities",
      build: {
        install: "pnpm install --frozen-lockfile --ignore-scripts",
        command: "pnpm run build",
        output: "dist",
      },
      runtime: { mode: "static", healthcheck: "/" },
      auth: { provider: "none" },
      mail: { enabled: false },
    };
    for (const database of [
      undefined,
      { enabled: false },
      { enabled: false, migrations: "postgres/migrations" },
    ]) {
      const bytes = JSON.stringify({ ...base, ...(database === undefined ? {} : { database }) });
      await writeFile(join(directory, "ohmyhost.yaml"), bytes);
      const result = await initializeRepository({ directory, dryRun: true });
      expect(result.inventory.database).toEqual({ provider: "postgresql", migrationCount: 2 });
      expect(result.blockers).toEqual([]);
      expect(result.runtime).toBeNull();
      expect(result.companion).toBeNull();
      expect(result.configurationYaml).toBe(bytes);
      expect(await readFile(join(directory, "ohmyhost.yaml"), "utf8")).toBe(bytes);
    }
    await mkdir(join(directory, "supabase/migrations"), { recursive: true });
    await writeFile(
      join(directory, "supabase/migrations/20260909000000_unused.sql"),
      "CREATE TABLE public.unselected(id uuid);\n",
    );
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      JSON.stringify({
        ...base,
        database: { enabled: true, migrations: "postgres/migrations" },
        runtime: { mode: "edge", healthcheck: "/" },
      }),
    );
    const selected = await initializeRepository({ directory, dryRun: true });
    expect(selected.inventory.database).toEqual({ provider: "supabase", migrationCount: 1 });
    expect(selected.runtime?.bindings).toContain("OHMYHOST_DATABASE");
    expect(selected.blockers).toContainEqual(
      expect.objectContaining({ code: "migration_filename_noncanonical" }),
    );
    await unlink(join(directory, "postgres/migrations/001_unused.sql"));
    const selectedSql = await initializeRepository({ directory, dryRun: true });
    expect(selectedSql.blockers).toContainEqual(
      expect.objectContaining({ code: "migration_sql_not_admitted" }),
    );
    await unlink(join(directory, "ohmyhost.yaml"));
    await unlink(join(directory, "supabase/migrations/20260909000000_unused.sql"));
    const inferred = await initializeRepository({ directory, dryRun: true });
    expect(parseOhmyhostConfigYaml(inferred.configurationYaml).database?.enabled).toBe(true);
    expect(inferred.runtime?.bindings).toContain("OHMYHOST_DATABASE");
    expect(inferred.blockers).toContainEqual(
      expect.objectContaining({ code: "migration_sql_not_admitted" }),
    );
  });

  it("blocks noncanonical PostgreSQL migration filenames before repository initialization", async () => {
    const directory = await repository({
      name: "portable-postgres",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "001_foundation.sql"),
      "create table public.items(id uuid primary key);\n",
    );

    const analyzed = await initializeRepository({ directory, dryRun: true });

    // Planning checks migration filenames before the framework rules, so they lead.
    expect(analyzed.blockers).toEqual([
      {
        code: "migration_filename_noncanonical",
        path: "postgres/migrations/001_foundation.sql",
        message:
          "Migration file '001_foundation.sql' in postgres/migrations is not named YYYYMMDDHHMMSS_name.sql (14 digits, an underscore, then lowercase letters, digits, _ or -). Every file in that directory must match, README and .gitkeep included: rename or move it, keeping the run order.",
      },
      blocker("companion_entry_required", "src/ohmyhost/companion.ts"),
    ]);
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toMatchObject({
      code: "repository_init_blocked",
      blockers: [
        {
          code: "migration_filename_noncanonical",
        },
      ],
    });
  });

  it("blocks PostgreSQL migration SQL that the deployment artifact gate will reject", async () => {
    const directory = await repository({
      name: "portable-postgres",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "20260823000000_foundation.sql"),
      "SET search_path TO public;\ncreate table public.items(id uuid primary key);\n",
    );
    await writeFile(
      join(directory, "postgres", "migrations", "20260823010000_seed.sql"),
      "insert into public.items(id) values ('00000000-0000-4000-8000-000000000001');\n",
    );
    await mkdir(join(directory, "src/ohmyhost"), { recursive: true });
    await writeFile(join(directory, "src/ohmyhost/companion.ts"), COMPANION);

    const analyzed = await initializeRepository({ directory, dryRun: true });

    expect(analyzed.blockers).toEqual([
      {
        code: "migration_sql_not_admitted",
        path: "postgres/migrations/20260823000000_foundation.sql",
        message: `PostgreSQL migration '20260823000000_foundation.sql' is not admitted (unsupported): ${MIGRATION_REASON.unsupported} Migrations are expand-only. Fix the file before its first deployment; never edit a migration a deployment already applied.`,
      },
      {
        code: "migration_sql_not_admitted",
        path: "postgres/migrations/20260823010000_seed.sql",
        message: `PostgreSQL migration '20260823010000_seed.sql' is not admitted (destructive): ${MIGRATION_REASON.destructive} Migrations are expand-only. Fix the file before its first deployment; never edit a migration a deployment already applied.`,
      },
    ]);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toMatchObject({
      code: "repository_init_blocked",
      blockers: [{ code: "migration_sql_not_admitted" }, { code: "migration_sql_not_admitted" }],
    });
  });

  it("selects one self-contained nested application and keeps repository-root configuration authority", async () => {
    const directory = await repository({
      name: "thomas-restaurant-next",
      scripts: { build: "cd site && npm run build" },
      dependencies: { next: "16.4.5" },
    });
    await writeFile(join(directory, "package-lock.json"), "{}\n", "utf8");
    await mkdir(join(directory, "site", "src", "app", "api", "anfrage"), { recursive: true });
    await writeFile(
      join(directory, "site", "package.json"),
      `${JSON.stringify({
        name: "thomas-restaurant",
        scripts: { build: "next build" },
        dependencies: { next: "16.4.5", react: "18.3.1", "react-dom": "18.3.1" },
      })}\n`,
      "utf8",
    );
    await writeFile(join(directory, "site", "package-lock.json"), "{}\n", "utf8");
    await writeFile(
      join(directory, "site", "src", "app", "api", "anfrage", "route.ts"),
      "export const runtime = 'nodejs';\n",
      "utf8",
    );
    await writeFile(join(directory, "site", "ohmyhost.yaml"), "must: be-ignored\n", "utf8");

    const discovered = await initializeRepository({ directory, dryRun: true });
    const explicit = await initializeRepository({ directory, root: "site", dryRun: true });

    for (const result of [discovered, explicit]) {
      expect(result).toMatchObject({
        applicationRoot: "site",
        inventory: {
          framework: "nextjs",
          packageManager: { name: "npm", version: null, lockfile: "package-lock.json" },
          apiRouteCount: 1,
        },
      });
      // Paths are relative to the repository root, as in the planning detail.
      expect(result.blockers).toEqual([
        blocker("package_manager_missing", "site/package.json"),
        blocker("framework_config_required", "site/next.config.ts"),
      ]);
      expect(result.configurationYaml).toContain(
        "project: thomas-restaurant\napplicationRoot: site\n",
      );
      expect(result.configurationYaml).not.toContain("nested_application_root_unsupported");
    }
    expect(discovered.applicationRootSource).toBe("nested");
    expect(explicit.applicationRootSource).toBe("explicit");
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(directory, "site", "ohmyhost.yaml"), "utf8")).resolves.toBe(
      "must: be-ignored\n",
    );
  });

  it("names the two database clients that cannot work before they are deployed", async () => {
    // Both applications deployed on 2026-09-18 failed their health check for exactly these two
    // reasons, after building green. The source says so before anything is built.
    const project = await repository({
      name: "database-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(project, "src", "ohmyhost"), { recursive: true });
    await writeFile(
      join(project, "src", "ohmyhost", "companion.ts"),
      'import { Pool } from "pg";\n' +
        "export default {\n" +
        "  fetch(request: Request, env: { HYPERDRIVE: { connectionString: string } }) {\n" +
        "    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });\n" +
        "    return new Response(String(pool));\n" +
        "  },\n" +
        "};\n",
      "utf8",
    );
    // A TanStack Router `$param` file gets the catalog sentence; a name with a space lies outside
    // the catalog's path grammar, so its blocker gets a sentence that does not quote the path.
    await mkdir(join(project, "src", "routes"), { recursive: true });
    await writeFile(
      join(project, "src", "routes", "items.$id.ts"),
      'import postgres from "postgres";\nexport const items = postgres;\n',
    );
    await writeFile(
      join(project, "src", "routes", "old items.ts"),
      "export const url = process.env.DATABASE_URL;\n",
    );
    const yaml = (database: string) =>
      `version: 1\nproject: database-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: edge\ndatabase:\n${database}`;
    await writeFile(
      join(project, "ohmyhost.yaml"),
      yaml("  enabled: true\n  migrations: migrations\n"),
    );
    const databaseBlockers = async () =>
      (await initializeRepository({ directory: project, dryRun: true })).blockers.filter(
        ({ code }) => code.startsWith("database_"),
      );

    expect(await databaseBlockers()).toEqual([
      blocker("database_binding_private", "src/ohmyhost/companion.ts"),
      blocker("database_driver_unsupported", "src/ohmyhost/companion.ts"),
      blocker("database_driver_unsupported", "src/routes/items.$id.ts"),
      {
        code: "database_binding_private",
        path: "src/routes/old items.ts",
        message:
          'The module at path reads a database connection string (DATABASE_URL, HYPERDRIVE, connectionString or a postgres:// URL); none reaches a customer Worker. Call the database with createPrivateDatabaseClient from "@ohmyhost/customer-runtime/database". Commit and push the change, then plan the new commit.',
      },
    ]);
    // Init judges a module exactly as planning does: a URL in a string and a type-only driver
    // import count, and only a configuration that enables the database is scanned.
    await unlink(join(project, "src", "routes", "items.$id.ts"));
    await unlink(join(project, "src", "routes", "old items.ts"));
    await writeFile(
      join(project, "src", "ohmyhost", "companion.ts"),
      'import type { Pool } from "pg";\nconst url = "postgres://app@db.example.com/app"; // a URL\n' +
        "export default { fetch() { return new Response(url); } };\n",
    );
    const companion = [
      blocker("database_binding_private", "src/ohmyhost/companion.ts"),
      blocker("database_driver_unsupported", "src/ohmyhost/companion.ts"),
    ];
    expect(await databaseBlockers()).toEqual(companion);
    await writeFile(join(project, "ohmyhost.yaml"), yaml("  enabled: false\n"));
    expect(await databaseBlockers()).toEqual([]);
    // Without ohmyhost.yaml the proposed configuration decides; its migrations enable the database.
    await unlink(join(project, "ohmyhost.yaml"));
    expect(await databaseBlockers()).toEqual([]);
    await mkdir(join(project, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(project, "postgres", "migrations", "20260901000000_items.sql"),
      "CREATE TABLE public.items(id uuid);\n",
    );
    expect(await databaseBlockers()).toEqual(companion);
    // Declaration files such as `wrangler types` output never run, and local build output is not
    // source, so neither blocks a fresh init.
    await writeFile(
      join(project, "worker-configuration.d.ts"),
      "interface Hyperdrive { readonly connectionString: string }\n",
    );
    for (const output of [".open-next", ".wrangler"]) {
      await mkdir(join(project, output, "tmp"), { recursive: true });
      await writeFile(
        join(project, output, "tmp", "index.mjs"),
        "export const url = process.env.DATABASE_URL;\n",
      );
    }
    expect(await databaseBlockers()).toEqual(companion);
  });

  it("refuses the raw cloudflare:sockets primitive in any scanned module, with or without a database", async () => {
    // A customer Worker has no raw TCP socket: only fetch() passes the egress policy. Init judges
    // the primitive as planning does, in every module and whether or not the database is enabled.
    const project = await repository({
      name: "socket-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "8.2.2" },
    });
    await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(project, "src", "ohmyhost"), { recursive: true });
    await writeFile(
      join(project, "src", "ohmyhost", "companion.ts"),
      'import { connect } from "cloudflare:sockets";\n' +
        "export default { fetch() { return new Response(String(connect)); } };\n",
      "utf8",
    );
    await mkdir(join(project, "src", "routes"), { recursive: true });
    await writeFile(
      join(project, "src", "routes", "dynamic.js"),
      'export const open = () => import("cloudflare:sockets");\n',
    );
    // A file name outside the catalog's path grammar gets a sentence that does not quote it.
    await writeFile(
      join(project, "src", "routes", "old sockets.ts"),
      'export const tcp = require("cloudflare:sockets");\n',
    );
    // Declaration files, other Node modules and local build output are not judged.
    await writeFile(
      join(project, "src", "routes", "quiet.ts"),
      'import net from "node:net";\nimport tls from "node:tls";\nexport { net, tls };\n',
    );
    // The hint reads the raw text, so a regex literal cannot hide the import and a string escape
    // cannot spell it away; a mention in a comment is an accepted false positive.
    await writeFile(
      join(project, "src", "routes", "escaped.ts"),
      'export const open = () => import("cloudflare\\x3asockets");\n',
    );
    await writeFile(
      join(project, "src", "routes", "hidden.ts"),
      'export const re = /[/*]/;\nimport { connect } from "cloudflare:sockets";\nexport { connect };\n',
    );
    await writeFile(
      join(project, "src", "routes", "mention.ts"),
      '// import { connect } from "cloudflare:sockets";\nexport {};\n',
    );
    await writeFile(
      join(project, "worker-configuration.d.ts"),
      'declare module "cloudflare:sockets" {}\n',
    );
    await mkdir(join(project, ".wrangler", "tmp"), { recursive: true });
    await writeFile(
      join(project, ".wrangler", "tmp", "index.mjs"),
      'import { connect } from "cloudflare:sockets";\nexport { connect };\n',
    );
    const socketBlockers = async () =>
      (await initializeRepository({ directory: project, dryRun: true })).blockers.filter(
        ({ code }) => code === "socket_primitive_unsupported",
      );
    const expected = [
      blocker("socket_primitive_unsupported", "src/ohmyhost/companion.ts"),
      blocker("socket_primitive_unsupported", "src/routes/dynamic.js"),
      blocker("socket_primitive_unsupported", "src/routes/escaped.ts"),
      blocker("socket_primitive_unsupported", "src/routes/hidden.ts"),
      blocker("socket_primitive_unsupported", "src/routes/mention.ts"),
      {
        code: "socket_primitive_unsupported",
        path: "src/routes/old sockets.ts",
        message:
          "The module at path loads cloudflare:sockets; customer Workers cannot open sockets. Call HTTPS services through the global fetch function and declare each origin in runtime.egress.allow in ohmyhost.yaml. Commit and push the change, then plan the new commit.",
      },
    ];

    expect(await socketBlockers()).toEqual(expected);
    // The same answer with the database enabled in the judged configuration.
    await writeFile(
      join(project, "ohmyhost.yaml"),
      "version: 1\nproject: socket-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: edge\ndatabase:\n  enabled: true\n  migrations: migrations\n",
    );
    expect(await socketBlockers()).toEqual(expected);
  });

  it("prefers a valid direct-build repository root over nested candidates", async () => {
    const directory = await repository({
      name: "root-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, "site"), { recursive: true });
    await writeFile(
      join(directory, "site", "package.json"),
      `${JSON.stringify({ name: "nested-app", scripts: { build: "vite build" }, devDependencies: { vite: "7.1.0" } })}\n`,
      "utf8",
    );
    await writeFile(join(directory, "site", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const result = await initializeRepository({ directory, dryRun: true });
    const explicit = await initializeRepository({ directory, root: ".", dryRun: true });

    expect(result).toMatchObject({ applicationRoot: ".", applicationRootSource: "repository" });
    expect(result.configurationYaml).not.toContain("applicationRoot:");
    expect(explicit).toMatchObject({ applicationRoot: ".", applicationRootSource: "explicit" });
    expect(explicit.configurationYaml).toBe(result.configurationYaml);
    expect(explicit.configurationSha256).toBe(result.configurationSha256);
  });

  it.each([
    [{ next: "16.4.5", vite: "7.1.0" }, "Next.js and Vite"],
    [{ next: "16.4.5", "@tanstack/react-start": "1.168.48" }, "Next.js and TanStack Start"],
  ])("rejects an ambiguous direct-build package declaring %j (%s)", async (dependencies, label) => {
    expect(label).toMatch(/^Next\.js and /u);
    const directory = await repository({
      name: "ambiguous-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies,
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    await expect(initializeRepository({ directory, dryRun: true })).rejects.toMatchObject({
      code: "application_root_not_found",
    });
  });

  it("consumes the shared application-root conformance corpus", async () => {
    for (const { value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted) {
      const directory = await repository({ name: "wrapper", scripts: { build: "cd app" } });
      const applicationDirectory = value === "." ? directory : join(directory, ...value.split("/"));
      await mkdir(applicationDirectory, { recursive: true });
      await writeFile(
        join(applicationDirectory, "package.json"),
        `${JSON.stringify({ name: "fixture", scripts: { build: "vite build" }, devDependencies: { vite: "7.1.0" } })}\n`,
      );
      await writeFile(join(applicationDirectory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      await expect(
        initializeRepository({ directory, root: value, dryRun: true }),
      ).resolves.toMatchObject({ applicationRoot: value, applicationRootSource: "explicit" });
    }

    const directory = await repository({ name: "wrapper", scripts: { build: "cd app" } });
    for (const { value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected) {
      if (typeof value !== "string") continue;
      await expect(
        initializeRepository({ directory, root: value, dryRun: true }),
      ).rejects.toMatchObject({ code: "application_root_invalid" });
    }
  });

  // Planning answers every source of the shared corpus; init must answer it alike: no blocker for
  // an admitted or pending source, and planning's refusal as the first blocker of a refused one.
  it.each([
    ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.admitted.map(({ name, files }) => ({
      name,
      files,
      packages: [] as readonly string[],
      diagnostic: null,
    })),
    ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.pending.map(({ name, files, packages }) => ({
      name,
      files,
      packages,
      diagnostic: null,
    })),
    ...FRAMEWORK_ADMISSION_CONFORMANCE_CORPUS.refused.map(({ name, files, diagnostic }) => ({
      name,
      files,
      packages: [] as readonly string[],
      diagnostic,
    })),
  ])(
    "judges the shared framework admission corpus as planning does: $name",
    async ({ files, packages, diagnostic }) => {
      const directory = await mkdtemp(join(tmpdir(), "ohmyhost-init-corpus-"));
      temporaryDirectories.push(directory);
      for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(directory, path)), { recursive: true });
        await writeFile(join(directory, path), text, "utf8");
      }

      const result = await initializeRepository({ directory, dryRun: true });

      if (diagnostic === null) {
        expect(result.blockers).toEqual([]);
        expect(result.compatibility.frameworks.length).toBeGreaterThan(0);
        expect(
          result.compatibility.frameworks.every(({ status }) => status !== "unsupported"),
        ).toBe(true);
        expect(
          result.compatibility.frameworks
            .filter(({ status }) => status === "pending")
            .map((entry) => entry.package),
        ).toEqual(packages);
        // Pending versions are reported, never blocking.
        expect(result.pending.map(({ code }) => code)).toEqual(
          packages.length > 0 ? ["installed_version", ...PENDING] : PENDING,
        );
        return;
      }
      // The same catalog sentence planning answers with; only for ohmyhost.yaml init, which
      // planning sends the agent to, names the exact field instead.
      expect(result.blockers[0]).toEqual({
        code: diagnostic.code,
        path: diagnostic.path,
        message:
          diagnostic.code === "repository_configuration_invalid"
            ? "ohmyhost.yaml is not valid YAML. Fix that in ohmyhost.yaml and run init again; init never rewrites an existing ohmyhost.yaml, so do not delete it."
            : frameworkConversionDetail(diagnostic),
      });
    },
  );

  it("returns stable errors for invalid, missing, unsupported, absent, and ambiguous roots", async () => {
    const invalid = await repository({
      name: "wrapper",
      scripts: { build: "cd site && pnpm build" },
    });
    await writeFile(join(invalid, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    await expect(
      initializeRepository({ directory: invalid, root: "../site", dryRun: true }),
    ).rejects.toMatchObject({ code: "application_root_invalid" });
    await expect(
      initializeRepository({ directory: invalid, root: "missing", dryRun: true }),
    ).rejects.toMatchObject({ code: "application_root_missing" });
    await expect(
      initializeRepository({ directory: invalid, root: ".", dryRun: true }),
    ).rejects.toMatchObject({ code: "application_root_unsupported" });
    await expect(initializeRepository({ directory: invalid, dryRun: true })).rejects.toMatchObject({
      code: "application_root_not_found",
    });

    for (const name of ["a", "b"]) {
      await mkdir(join(invalid, name), { recursive: true });
      await writeFile(
        join(invalid, name, "package.json"),
        `${JSON.stringify({ name, scripts: { build: "vite build" }, devDependencies: { vite: "7.1.0" } })}\n`,
      );
      await writeFile(join(invalid, name, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    }
    await expect(initializeRepository({ directory: invalid, dryRun: true })).rejects.toMatchObject({
      code: "application_root_ambiguous",
    });
  });

  it("discovers supported apps before reporting ambiguous locks and unsafe build commands", async () => {
    const directory = await repository({
      name: "wrapper",
      scripts: { build: "cd site && pnpm build" },
    });
    await mkdir(join(directory, "site"), { recursive: true });
    await writeFile(
      join(directory, "site", "package.json"),
      `${JSON.stringify({ name: "site", scripts: { build: "vite build && ../escape" }, devDependencies: { vite: "7.1.0" } })}\n`,
    );
    await writeFile(join(directory, "site", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(directory, "site", "package-lock.json"), "{}\n");

    await expect(initializeRepository({ directory, dryRun: true })).resolves.toMatchObject({
      applicationRoot: "site",
      blockers: [
        blocker("lockfile_ambiguous", "site/package.json"),
        blocker("build_script_unsupported", "site/package.json", { framework: "vite-static" }),
      ],
    });

    const ambiguous = await repository({
      name: "ambiguous",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(ambiguous, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await expect(
      initializeRepository({ directory: ambiguous, root: ".", dryRun: true }),
    ).rejects.toMatchObject({ code: "application_root_unsupported" });
  });

  it("blocks incomplete or unsupported Next.js deployment setup before writing", async () => {
    const unconfigured = await repository({
      name: "next-unconfigured",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(unconfigured, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    await expect(
      initializeRepository({ directory: unconfigured, dryRun: true }),
    ).resolves.toMatchObject({
      blockers: [blocker("framework_config_required", "next.config.ts")],
    });
    // The config text is judged like planning judges it: too large to inspect, or not text.
    for (const [contents, code] of [
      [`export default {};\n${"//".repeat(150 * 1024)}\n`, "framework_config_too_large"],
      [new Uint8Array(5 * 1024 * 1024 + 1).fill(0x20), "framework_config_too_large"],
      [new Uint8Array([0x65, 0xff, 0x0a]), "source_syntax_invalid"],
    ] as const) {
      await writeFile(join(unconfigured, "next.config.ts"), contents);
      expect(
        (await initializeRepository({ directory: unconfigured, dryRun: true })).blockers,
      ).toEqual([blocker(code, "next.config.ts")]);
    }

    const proxy = await repository({
      name: "next-proxy",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(proxy, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(proxy, "next.config.ts"), "export default {};\n", "utf8");
    await mkdir(join(proxy, "src"), { recursive: true });
    await writeFile(join(proxy, "src", "proxy.ts"), "export function proxy() {}\n", "utf8");

    await expect(initializeRepository({ directory: proxy, dryRun: true })).resolves.toMatchObject({
      blockers: [],
      written: false,
    });
    await expect(initializeRepository({ directory: proxy, dryRun: false })).resolves.toMatchObject({
      status: "initialized",
      blockers: [],
      written: true,
    });
  });

  it("blocks standalone Next.js output and leaves runtime imports pending for planning", async () => {
    const directory = await repository({
      name: "standalone-next",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(directory, "next.config.ts"),
      [
        'const ignored = "output: standalone";',
        "// output: 'standalone',",
        "export default { output: 'standalone' };",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(directory, "src", "app", "api", "runtime"), { recursive: true });
    await writeFile(
      join(directory, "src", "app", "api", "runtime", "route.ts"),
      'import { execFile } from "node:child_process";\nexport const runtime = "nodejs";\nvoid execFile;\n',
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    // Comments and strings never count; the node:child_process route is planning's to walk.
    expect(result.blockers).toEqual([blocker("next_output_unsupported", "next.config.ts")]);
    expect(result.pending.map(({ code }) => code)).toEqual(PENDING);
    expect(result.requirements).toEqual(["nextjs-adapter"]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      build: {
        install: "pnpm install --frozen-lockfile --ignore-scripts",
        command: "pnpm run build",
        output: ".open-next/assets",
      },
      runtime: { mode: "edge" },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
    });
  });

  it("keeps an explicitly configured OpenNext application on the edge path", async () => {
    const directory = await repository({
      name: "next-edge",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build", "build:cloudflare": "opennextjs-cloudflare build" },
      dependencies: {
        "@opennextjs/cloudflare": "1.20.2",
        next: "16.4.5",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: { wrangler: "4.125.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "next.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(directory, "open-next.config.ts"), "export default {};\n", "utf8");
    await writeFile(join(directory, "wrangler.jsonc"), "{}\n", "utf8");
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      [
        "version: 1",
        "project: next-edge",
        "build:",
        "  install: pnpm install --frozen-lockfile --ignore-scripts",
        "  command: pnpm run build",
        "  output: .open-next/assets",
        "runtime:",
        "  mode: edge",
        "database:",
        "  enabled: false",
        "auth:",
        "  provider: none",
        "mail:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      build: { command: "pnpm run build", output: ".open-next/assets" },
      runtime: { mode: "edge" },
    });
  });

  it("blocks an existing configuration that still selects the withdrawn container mode and names the field", async () => {
    const directory = await repository({
      name: "withdrawn-mode",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5", react: "19.2.8", "react-dom": "19.2.8" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "next.config.ts"), "export default {};\n", "utf8");
    const existing = [
      "version: 1",
      "project: withdrawn-mode",
      "build:",
      "  install: pnpm install --frozen-lockfile --ignore-scripts",
      "  command: pnpm run build",
      "  output: .open-next/assets",
      "runtime:",
      "  mode: container",
      "",
    ].join("\n");
    await writeFile(join(directory, "ohmyhost.yaml"), existing, "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    // Planning refuses the same file and sends the agent here for the exact field. Nothing else
    // is judged against a configuration that does not parse.
    expect(result.blockers).toEqual([
      {
        code: "repository_configuration_invalid",
        path: "ohmyhost.yaml",
        message:
          "ohmyhost.yaml is invalid: /runtime/mode must be equal to one of the allowed values. Fix that in ohmyhost.yaml and run init again; init never rewrites an existing ohmyhost.yaml, so do not delete it.",
      },
    ]);
    expect(result.compatibility.frameworks).toEqual([]);
    expect(result.configurationYaml).toBe(existing);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toBeInstanceOf(
      RepositoryInitBlockedError,
    );
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).resolves.toBe(existing);

    // Planning decodes ohmyhost.yaml as strict UTF-8, so bytes that are not UTF-8 block even in a
    // comment, where a lossy decoding would still parse.
    await writeFile(
      join(directory, "ohmyhost.yaml"),
      new Uint8Array([
        0x23,
        0xff,
        0xfe,
        0x0a,
        ...new TextEncoder().encode(existing.replace("container", "edge")),
      ]),
    );
    expect((await initializeRepository({ directory, dryRun: true })).blockers).toEqual([
      {
        code: "repository_configuration_invalid",
        path: "ohmyhost.yaml",
        message:
          "ohmyhost.yaml is not valid UTF-8. Fix that in ohmyhost.yaml and run init again; init never rewrites an existing ohmyhost.yaml, so do not delete it.",
      },
    ]);
  });

  it("creates one validated config atomically and never overwrites it", async () => {
    const directory = await repository({
      name: "vite-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const result = await initializeRepository({ directory, dryRun: false });

    expect(result).toMatchObject({ status: "initialized", written: true, blockers: [] });
    const original = await readFile(join(directory, "ohmyhost.yaml"), "utf8");
    expect(parseOhmyhostConfigYaml(original)).toMatchObject({
      project: "vite-app",
      runtime: { mode: "static" },
      database: { enabled: false },
      mail: { enabled: false },
    });
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toBeInstanceOf(
      RepositoryInitConflictError,
    );
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).resolves.toBe(original);
  });

  it("preserves an existing validated root configuration byte-for-byte during analysis", async () => {
    const directory = await repository({
      name: "vite-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    const existing = [
      "version: 1",
      "project: vite-app",
      "build:",
      "  install: pnpm install --frozen-lockfile --ignore-scripts",
      "  command: pnpm run build",
      "  output: dist",
      "runtime:",
      "  mode: static",
      "  egress:",
      "    allow:",
      "      - https://api.example.com",
      "database:",
      "  enabled: false",
      "auth:",
      "  provider: none",
      "mail:",
      "  enabled: false",
      "",
    ].join("\n");
    await writeFile(join(directory, "ohmyhost.yaml"), existing, "utf8");

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.configurationYaml).toBe(existing);
    expect(result.configurationSha256).toBe(createHash("sha256").update(existing).digest("hex"));
    expect(parseOhmyhostConfigYaml(result.configurationYaml).runtime.egress.allow).toEqual([
      "https://api.example.com",
    ]);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toBeInstanceOf(
      RepositoryInitConflictError,
    );
    await expect(readFile(join(directory, "ohmyhost.yaml"), "utf8")).resolves.toBe(existing);
  });

  it("renders the official TanStack Start static client output instead of legacy Nitro output", async () => {
    const directory = await repository({
      name: "tanstack-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build && tsc --noEmit" },
      dependencies: { "@tanstack/react-start": "1.168.48" },
      devDependencies: { vite: "8.0.14" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(directory, "vite.config.ts"),
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart({ prerender: { enabled: true, failOnError: true } })] };\n",
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      project: "tanstack-app",
      build: { output: "dist/client" },
      runtime: { mode: "static" },
    });
    expect(result.requirements).toEqual([]);
    expect(result.companion).toBeNull();
  });

  it("blocks a TanStack config that misses the plugin contract of its proposed runtime", async () => {
    const directory = await repository({
      name: "tanstack-ambiguous",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.41",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.8",
        "react-dom": "19.2.8",
      },
      devDependencies: { "@vitejs/plugin-react": "6.1.0", vite: "8.0.14" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "vite.config.ts"), "tanstackStart();\n", "utf8");

    const analyzed = await initializeRepository({ directory, dryRun: true });

    // Without the Cloudflare plugin the proposal is static; the rules name what its config lacks.
    expect(parseOhmyhostConfigYaml(analyzed.configurationYaml).runtime.mode).toBe("static");
    expect(analyzed.blockers).toEqual([
      blocker("tanstack_vite_plugins_required", "vite.config.ts"),
      blocker("tanstack_prerender_required", "vite.config.ts"),
    ]);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toBeInstanceOf(
      RepositoryInitBlockedError,
    );
    // Storage binds only on edge, so even a complete static contract is proposed as edge.
    await writeFile(
      join(directory, "vite.config.ts"),
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart({ prerender: { enabled: true } })] };\n",
    );
    await mkdir(join(directory, "supabase", "storage", "avatars"), { recursive: true });
    await writeFile(join(directory, "supabase", "storage", "avatars", ".gitkeep"), "");
    const storage = await initializeRepository({ directory, dryRun: true });
    expect(parseOhmyhostConfigYaml(storage.configurationYaml)).toMatchObject({
      runtime: { mode: "edge" },
      storage: { provider: "r2" },
    });
    expect(storage.blockers).toEqual([
      blocker("framework_dependency_required", "package.json", {
        package: "@cloudflare/vite-plugin",
      }),
      blocker("tanstack_vite_plugins_required", "vite.config.ts"),
    ]);
  });

  it("recognizes a complete TanStack Cloudflare edge contract without a conversion", async () => {
    const directory = await repository({
      name: "tanstack-edge",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.31",
        "@tanstack/react-start": "1.168.60",
        "better-auth": "1.7.7",
        react: "19.2.0",
        "react-dom": "19.2.0",
      },
      devDependencies: {
        "@cloudflare/vite-plugin": "1.53.1",
        "@vitejs/plugin-react": "6.0.1",
        vite: "8.2.2",
      },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(directory, "vite.config.ts"),
      "import { cloudflare } from '@cloudflare/vite-plugin'; import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart()] };\n",
      "utf8",
    );
    await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
    await writeFile(
      join(directory, "postgres", "migrations", "20260824000001_foundation.sql"),
      "create table public.items(id uuid primary key);\n",
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(result.requirements).toEqual(["application-auth-review"]);
    expect(result.companion).toBeNull();
    expect(result.inventory.database).toEqual({ provider: "postgresql", migrationCount: 1 });
    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      build: { output: "dist/client" },
      runtime: { mode: "edge" },
      database: { enabled: true, migrations: "postgres/migrations" },
      auth: { provider: "none" },
      mail: { enabled: false },
    });
  });

  it.each([
    [
      "missing active Cloudflare plugin",
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [tanstackStart()] };\n",
    ],
    [
      "only commented edge configuration",
      "import { tanstackStart } from '@tanstack/react-start/plugin/vite'; /* import { cloudflare } from '@cloudflare/vite-plugin'; cloudflare({ viteEnvironment: { name: 'ssr' } }); */ export default { plugins: [tanstackStart()] };\n",
    ],
  ])("blocks a TanStack edge dependency with %s", async (_label, viteConfig) => {
    const directory = await repository({
      name: "tanstack-inert-edge",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.31",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.0",
        "react-dom": "19.2.0",
      },
      devDependencies: {
        "@cloudflare/vite-plugin": "1.53.1",
        "@vitejs/plugin-react": "6.0.1",
        vite: "8.2.2",
        wrangler: "4.125.0",
      },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(directory, "vite.config.ts"), viteConfig, "utf8");
    await writeFile(
      join(directory, "wrangler.jsonc"),
      '{"name":"tanstack-inert-edge","compatibility_date":"2026-08-24","compatibility_flags":["nodejs_compat"],"main":"@tanstack/react-start/server-entry"}\n',
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    // The declared Cloudflare plugin aims at the edge runtime, whose plugin contract is incomplete.
    expect(parseOhmyhostConfigYaml(result.configurationYaml).runtime.mode).toBe("edge");
    expect(result.blockers).toEqual([blocker("tanstack_vite_plugins_required", "vite.config.ts")]);
  });

  it("admits TanStack edge without customer-owned Wrangler configuration", async () => {
    const directory = await repository({
      name: "tanstack-missing-wrangler",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      dependencies: {
        "@tanstack/react-router": "1.170.31",
        "@tanstack/react-start": "1.168.60",
        react: "19.2.0",
        "react-dom": "19.2.0",
      },
      devDependencies: {
        "@cloudflare/vite-plugin": "1.53.1",
        "@vitejs/plugin-react": "6.0.1",
        vite: "8.2.2",
      },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(
      join(directory, "vite.config.ts"),
      "import { cloudflare } from '@cloudflare/vite-plugin'; import { tanstackStart } from '@tanstack/react-start/plugin/vite'; export default { plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart()] };\n",
      "utf8",
    );

    const result = await initializeRepository({ directory, dryRun: true });

    expect(result.blockers).toEqual([]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml).runtime.mode).toBe("edge");
  });

  it("reports an unpinned npm repository and refuses to write a guessed configuration", async () => {
    const directory = await repository({
      name: "ausbildungsnavigator-pro",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5" },
    });
    await writeFile(join(directory, "package-lock.json"), "{}\n", "utf8");

    const analyzed = await initializeRepository({ directory, dryRun: true });

    expect(parseOhmyhostConfigYaml(analyzed.configurationYaml).build).toMatchObject({
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      command: "pnpm run build",
    });
    expect(analyzed.blockers).toEqual([
      blocker("package_manager_missing", "package.json"),
      blocker("framework_config_required", "next.config.ts"),
      blocker("framework_dependency_required", "package.json", { package: "react" }),
      blocker("framework_dependency_required", "package.json", { package: "react-dom" }),
    ]);
    await expect(initializeRepository({ directory, dryRun: false })).rejects.toBeInstanceOf(
      RepositoryInitBlockedError,
    );
  });

  it("rejects repository symlinks instead of following files outside the selected root", async () => {
    const directory = await repository({
      name: "vite-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "vite build" },
      devDependencies: { vite: "7.1.0" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await symlink(tmpdir(), join(directory, "outside"));

    await expect(initializeRepository({ directory, dryRun: true })).rejects.toMatchObject({
      code: "repository_symlink_forbidden",
    });
  });

  it("ignores generated Vercel output, including provider-created symlinks", async () => {
    const directory = await repository({
      name: "next-app",
      packageManager: "pnpm@10.28.2",
      scripts: { build: "next build" },
      dependencies: { next: "16.4.5" },
    });
    await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await mkdir(join(directory, ".vercel", "output", "functions"), { recursive: true });
    await symlink(tmpdir(), join(directory, ".vercel", "output", "functions", "page.func"));

    await expect(initializeRepository({ directory, dryRun: true })).resolves.toMatchObject({
      inventory: { framework: "nextjs" },
      blockers: [
        blocker("framework_config_required", "next.config.ts"),
        blocker("framework_dependency_required", "package.json", { package: "react" }),
        blocker("framework_dependency_required", "package.json", { package: "react-dom" }),
      ],
    });
  });
});

it.each(["static", "edge"] as const)(
  "inspects native Astro %s endpoints and preserves the root configuration contract",
  async (mode) => {
    const directory = await repository({
      name: "astro-app",
      packageManager: "npm@11.5.1",
      scripts: { build: "astro build" },
      dependencies: {
        astro: "7.4.0",
        ...(mode === "edge" ? { "@astrojs/cloudflare": "14.4.0" } : {}),
      },
    });
    await mkdir(join(directory, "src/pages/api"), { recursive: true });
    await writeFile(join(directory, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    await writeFile(
      join(directory, "astro.config.mjs"),
      mode === "edge"
        ? 'import cloudflare from "@astrojs/cloudflare"; export default {output:"server",adapter:cloudflare({imageService:"passthrough"}),session:false};'
        : 'export default {output:"static"};',
    );
    await writeFile(join(directory, "src/pages/index.astro"), "<h1>Astro</h1>");
    await writeFile(
      join(directory, "src/pages/api/health.ts"),
      "export const GET = () => Response.json({ok:true});",
    );
    await writeFile(
      join(directory, "src/pages/rss.xml.ts"),
      'export const GET = () => new Response("feed");',
    );
    const result = await initializeRepository({ directory, dryRun: true });
    expect(result.inventory).toMatchObject({ framework: "astro", apiRouteCount: 2 });
    expect(result.blockers).toEqual([]);
    expect(parseOhmyhostConfigYaml(result.configurationYaml)).toMatchObject({
      runtime: { mode, healthcheck: "/api/health" },
      build: { output: mode === "edge" ? "dist/client" : "dist" },
    });
  },
);
