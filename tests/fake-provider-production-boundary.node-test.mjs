import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import test from "node:test";

import { verifyProductionFakeProviderBoundary } from "../scripts/check-fake-provider-production-boundary.mjs";

test("accepts production graphs while preserving the explicit local CLI exception", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", {
      name: "@ohmyhost/control-api",
      dependencies: { "@ohmyhost/platform": "workspace:*" },
    });
    await addApp(root, "cli", {
      name: "@ohmyhost/cli",
      dependencies: { "@ohmyhost/local-runner": "workspace:*" },
      source: 'import "@ohmyhost/local-runner";\n',
      artifact: 'import "@ohmyhost/local-runner";\n',
    });
    await addPackage(root, "platform", { name: "@ohmyhost/platform" });
    await addPackage(root, "local-runner", {
      name: "@ohmyhost/local-runner",
      dependencies: { "@ohmyhost/testkit": "workspace:*" },
    });
    await addPackage(root, "testkit", { name: "@ohmyhost/testkit" });

    const report = await verifyProductionFakeProviderBoundary({
      root,
      resolveTypescriptFiles: async ({ appName }) =>
        appName === "@ohmyhost/control-api" ? [join(root, "apps/control-api/src/index.ts")] : [],
    });

    assert.deepEqual(report.productionApps, ["@ohmyhost/control-api"]);
    assert.deepEqual(report.localOnlyApps, ["@ohmyhost/cli"]);
    assert.equal(report.artifactFiles, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatically rejects a newly added production app with a direct local-only dependency", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "future-worker", {
      name: "@ohmyhost/future-worker",
      dependencies: { "@ohmyhost/testkit": "workspace:*" },
    });
    await addPackage(root, "testkit", { name: "@ohmyhost/testkit" });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [],
      }),
      /@ohmyhost\/future-worker.*@ohmyhost\/testkit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a transitive workspace dependency on the local runner", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", {
      name: "@ohmyhost/control-api",
      dependencies: { "@ohmyhost/bridge": "workspace:*" },
    });
    await addPackage(root, "bridge", {
      name: "@ohmyhost/bridge",
      dependencies: { "@ohmyhost/local-runner": "workspace:*" },
    });
    await addPackage(root, "local-runner", { name: "@ohmyhost/local-runner" });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [],
      }),
      /@ohmyhost\/control-api.*@ohmyhost\/bridge.*@ohmyhost\/local-runner/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects forbidden files in the resolved TypeScript production graph", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", { name: "@ohmyhost/control-api" });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [
          join(root, "apps/control-api/src/index.ts"),
          join(root, "packages/testkit/src/provider/fake-static-hosting-provider.ts"),
        ],
      }),
      /resolved TypeScript graph.*packages\/testkit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects fake-provider code copied into a built production artifact", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", {
      name: "@ohmyhost/control-api",
      artifact: "const provider = new FakeStaticHostingProvider();\n",
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/control-api/src/index.ts")],
      }),
      /built artifact.*FakeStaticHostingProvider/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a production app has no build evidence", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", {
      name: "@ohmyhost/control-api",
      createArtifact: false,
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/control-api/src/index.ts")],
      }),
      /build evidence is missing.*@ohmyhost\/control-api/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a local-only exception whose package path is not apps/cli", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "lookalike", {
      name: "@ohmyhost/cli",
      dependencies: { "@ohmyhost/local-runner": "workspace:*" },
    });
    await addPackage(root, "local-runner", { name: "@ohmyhost/local-runner" });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/lookalike/src/index.ts")],
      }),
      /local-only exception.*apps\/cli/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects forbidden inputs recorded only in bundle metadata", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "worker", {
      name: "@ohmyhost/worker",
      build:
        "tsc --project tsconfig.build.json && esbuild src/index.ts --bundle --outfile=dist/bundle.js --metafile=dist/metafile.json",
      bundles: [{ entrypoint: "src/index.ts", metafile: "dist/metafile.json" }],
    });
    await writeJson(join(root, "apps/worker/dist/metafile.json"), {
      inputs: { "../../packages/testkit/src/provider/fake-static-hosting-provider.ts": {} },
      outputs: { "dist/bundle.js": {} },
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
      }),
      /built artifact.*packages\/testkit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows test-only devDependencies when absent from the production graph and artifact", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", {
      name: "@ohmyhost/control-api",
      devDependencies: { "@ohmyhost/testkit": "workspace:*" },
    });
    await addPackage(root, "testkit", { name: "@ohmyhost/testkit" });

    const report = await verifyProductionFakeProviderBoundary({
      root,
      resolveTypescriptFiles: async () => [join(root, "apps/control-api/src/index.ts")],
    });
    assert.deepEqual(report.productionApps, ["@ohmyhost/control-api"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when TypeScript resolution returns no production files", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "control-api", { name: "@ohmyhost/control-api" });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({ root, resolveTypescriptFiles: async () => [] }),
      /TypeScript graph is empty.*@ohmyhost\/control-api/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a divergent build script that is not bound to the declared production graph", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "worker", {
      name: "@ohmyhost/worker",
      build: "node scripts/build-uninspected-entrypoint.mjs",
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
      }),
      /build script is not bound.*tsconfig\.build\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a bundler command without a declared metafile", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "worker", {
      name: "@ohmyhost/worker",
      build:
        "tsc --project tsconfig.build.json && esbuild src/index.ts --bundle --outfile=dist/bundle.js",
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
      }),
      /bundler command requires exactly one --metafile/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, injected] of [
  ["semicolon", "node scripts/uninspected.mjs ; "],
  ["or operator", "node scripts/uninspected.mjs || "],
  ["pipe", "node scripts/uninspected.mjs | "],
  ["newline", "node scripts/uninspected.mjs\n"],
  ["backticks", "`node scripts/uninspected.mjs` "],
  ["command substitution", "$(node scripts/uninspected.mjs) "],
]) {
  test(`rejects ${label} before an otherwise declared bundler command`, async () => {
    const root = await fixtureRoot();
    try {
      await addApp(root, "worker", {
        name: "@ohmyhost/worker",
        build: `tsc --project tsconfig.build.json && ${injected}esbuild src/index.ts --bundle --outfile=dist/bundle.js --metafile=dist/metafile.json`,
        bundles: [{ entrypoint: "src/index.ts", metafile: "dist/metafile.json" }],
      });
      await writeJson(join(root, "apps/worker/dist/metafile.json"), {
        inputs: { "src/index.ts": {} },
        outputs: { "dist/bundle.js": {} },
      });

      await assert.rejects(
        verifyProductionFakeProviderBoundary({
          root,
          resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
        }),
        /unsafe shell syntax|uninspected command/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("rejects duplicate security-relevant bundler flags", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "worker", {
      name: "@ohmyhost/worker",
      build:
        "tsc --project tsconfig.build.json && esbuild src/index.ts --bundle --outfile=dist/bundle.js --metafile=dist/metafile.json --metafile=dist/decoy.json",
      bundles: [{ entrypoint: "src/index.ts", metafile: "dist/metafile.json" }],
    });
    await writeJson(join(root, "apps/worker/dist/metafile.json"), {
      inputs: { "src/index.ts": {} },
      outputs: { "dist/bundle.js": {} },
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
      }),
      /exactly one --metafile/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only the exact WFP database preparation build script", async () => {
  const root = await fixtureRoot();
  const prepareDatabase = "node scripts/prepare-project-database-module.mjs";
  try {
    await addApp(root, "wfp-management", {
      name: "@ohmyhost/wfp-management",
      build: "pnpm prepare:database && tsc --project tsconfig.build.json",
      additionalScripts: { "prepare:database": prepareDatabase },
    });

    const report = await verifyProductionFakeProviderBoundary({
      root,
      resolveTypescriptFiles: async () => [join(root, "apps/wfp-management/src/index.ts")],
    });
    assert.deepEqual(report.productionApps, ["@ohmyhost/wfp-management"]);

    await addApp(root, "wfp-management", {
      name: "@ohmyhost/wfp-management",
      build: "pnpm prepare:database && tsc --project tsconfig.build.json",
      additionalScripts: {
        "prepare:database": `${prepareDatabase} && node scripts/uninspected.mjs`,
      },
    });
    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/wfp-management/src/index.ts")],
      }),
      /uninspected command.*pnpm prepare:database/u,
    );

    // WFP management acts itself; the removed Lambda bundle verifier must not return to its build.
    await addApp(root, "wfp-management", {
      name: "@ohmyhost/wfp-management",
      build:
        "pnpm prepare:database && tsc --project tsconfig.build.json && node scripts/verify-lambda-bundle.mjs",
      additionalScripts: { "prepare:database": prepareDatabase },
    });
    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/wfp-management/src/index.ts")],
      }),
      /uninspected command.*verify-lambda-bundle/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts the inspected WFP dispatch cleanup before the declared build graph", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "wfp-dispatch", {
      name: "@ohmyhost/wfp-dispatch",
      build: "node scripts/clean-dist.mjs && tsc --project tsconfig.build.json",
    });
    await mkdir(join(root, "apps/wfp-dispatch/scripts"), { recursive: true });
    await writeFile(
      join(root, "apps/wfp-dispatch/scripts/clean-dist.mjs"),
      'import { rm } from "node:fs/promises";\nimport { URL } from "node:url";\nawait rm(new URL("../dist", import.meta.url), { recursive: true, force: true });\n',
    );

    const report = await verifyProductionFakeProviderBoundary({
      root,
      resolveTypescriptFiles: async () => [join(root, "apps/wfp-dispatch/src/index.ts")],
    });

    assert.deepEqual(report.productionApps, ["@ohmyhost/wfp-dispatch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unbound auxiliary build command in a future app", async () => {
  const root = await fixtureRoot();
  try {
    await addApp(root, "worker", {
      name: "@ohmyhost/worker",
      build: "pnpm types:check && tsc --project tsconfig.build.json",
      additionalScripts: { "types:check": "node scripts/build-uninspected.mjs" },
    });

    await assert.rejects(
      verifyProductionFakeProviderBoundary({
        root,
        resolveTypescriptFiles: async () => [join(root, "apps/worker/src/index.ts")],
      }),
      /uninspected command.*pnpm types:check/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only the reviewed static public-page generator", async () => {
  const generators = [
    {
      app: "public-site",
      generator: "apps/public-site/scripts/prepare-pages.mjs",
      command: "scripts/prepare-pages.mjs",
    },
    {
      app: "control-api",
      generator: "scripts/prepare-portal-assets.mjs",
      command: "../../scripts/prepare-portal-assets.mjs",
    },
  ];
  for (const { app, generator, command } of generators) {
    const root = await fixtureRoot();
    try {
      await addApp(root, app, {
        name: `@ohmyhost/${app}`,
        build: `node ${command} && tsc --project tsconfig.build.json`,
      });
      const file = join(root, generator);
      await mkdir(dirname(file), { recursive: true });
      const source = await readFile(new URL(`../${generator}`, import.meta.url), "utf8");
      await writeFile(file, source);
      const input = {
        root,
        resolveTypescriptFiles: async () => [join(root, `apps/${app}/src/index.ts`)],
      };
      assert.deepEqual((await verifyProductionFakeProviderBoundary(input)).productionApps, [
        `@ohmyhost/${app}`,
      ]);
      await writeFile(file, source + "\nimport 'unreviewed-provider';\n");
      await assert.rejects(verifyProductionFakeProviderBoundary(input), /reviewed page generator/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-fake-boundary-"));
  await mkdir(join(root, "apps"), { recursive: true });
  await mkdir(join(root, "packages"), { recursive: true });
  return root;
}

async function addApp(
  root,
  directory,
  {
    name,
    dependencies = {},
    devDependencies = {},
    source = "export {};\n",
    artifact = "export {};\n",
    createArtifact = true,
    build = "tsc --project tsconfig.build.json",
    bundles = [],
    additionalScripts = {},
  },
) {
  const appRoot = join(root, "apps", directory);
  await mkdir(join(appRoot, "src"), { recursive: true });
  const localOnly = directory === "cli" && name === "@ohmyhost/cli";
  await writeJson(join(appRoot, "package.json"), {
    name,
    private: true,
    dependencies,
    devDependencies,
    scripts: { ...additionalScripts, build },
    ohmyhost: localOnly
      ? { deployment: "local-only" }
      : {
          deployment: "production",
          fakeProviderBoundary: {
            typescriptProject: "tsconfig.build.json",
            artifactRoot: "dist",
            entrypoints: ["src/index.ts"],
            bundles,
          },
        },
  });
  await writeJson(join(appRoot, "tsconfig.build.json"), {
    compilerOptions: { noEmit: false, outDir: "dist", rootDir: "src" },
  });
  await writeFile(join(appRoot, "src/index.ts"), source);
  if (createArtifact) {
    await mkdir(join(appRoot, "dist"), { recursive: true });
    await writeFile(join(appRoot, "dist/index.js"), artifact);
  }
}

async function addPackage(root, directory, { name, dependencies = {} }) {
  const packageRoot = join(root, "packages", directory);
  await mkdir(packageRoot, { recursive: true });
  await writeJson(join(packageRoot, "package.json"), { name, private: true, dependencies });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
