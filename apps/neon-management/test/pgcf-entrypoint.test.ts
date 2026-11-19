import { builtinModules, createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { bundleManagementFixture } from "./support/d1-management-worker.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const profile = async (filename: string) => {
  const source = await readFile(new URL(`../${filename}`, import.meta.url), "utf8");
  return JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
};

it("serves existing PGCF RPC through both entrypoints while the bounded entrypoint refuses Native authority", async () => {
  const require = createRequire(new URL("../package.json", import.meta.url));
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    require.resolve("wrangler/package.json"),
  )("miniflare");
  const bounded = await bundleManagementFixture(
    'export{NeonManagementService,default}from"./apps/neon-management/src/pgcf-worker-main.ts";',
  );
  const full = await bundleManagementFixture(
    'export{NeonManagementService,default}from"./apps/neon-management/src/worker-main.ts";',
  );
  const env = {
    RUNTIME_CONFIGURATION_STATE: "configured",
    PGCF_API_URL: "https://pgcf.fixture",
    PGCF_APPS_PROJECT_ID: `prj_${"a".repeat(20)}`,
    PGCF_APPS_API_KEY: "fixture-only-pgcf-key",
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "bounded",
          modules: true,
          script: bounded,
          compatibilityDate: "2026-08-21",
          compatibilityFlags: ["nodejs_compat"],
          bindings: env,
          serviceBindings: {
            DATABASE_PRODUCT_RUNTIME: { name: "core", entrypoint: "Product" },
          },
        },
        {
          name: "full",
          modules: true,
          script: full,
          compatibilityDate: "2026-08-21",
          compatibilityFlags: ["nodejs_compat"],
          bindings: env,
          serviceBindings: {
            DATABASE_PRODUCT_RUNTIME: { name: "core", entrypoint: "Product" },
          },
        },
        {
          name: "core",
          modules: true,
          script:
            'import{WorkerEntrypoint}from"cloudflare:workers";export class Product extends WorkerEntrypoint{readProductComputeScope(){return{target:null,dataMode:"shared"}}};export default{fetch(){return new Response("private")}};',
          compatibilityDate: "2026-08-21",
        },
        {
          name: "caller",
          modules: true,
          compatibilityDate: "2026-08-21",
          serviceBindings: {
            PGCF: { name: "bounded", entrypoint: "NeonManagementService" },
            FULL: { name: "full", entrypoint: "NeonManagementService" },
          },
          script: `export default{async fetch(request,env){const input={organizationId:"01ARZ3NDEKTSV4RRFFQ69G5FAV",projectId:"01ARZ3NDEKTSV4RRFFQ69G5FAW",environment:"prod"};const denied={};for(const method of["placeNativeAuthDatabase","deleteNativeAuthProject","prepareNativeAuthRealm"]){try{await env.PGCF[method](null);denied[method]="unexpected success"}catch(error){denied[method]=error.message}}let fullNative;try{await env.FULL.placeNativeAuthDatabase(null)}catch(error){fullNative=error.message}return Response.json({bounded:await env.PGCF.readCompute(input),full:await env.FULL.readCompute(input),denied,fullNative})}}`,
        },
      ],
    }),
  );
  try {
    const caller = await mf.getWorker("caller");
    const response = await caller.fetch("https://fixture/");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      bounded: null,
      full: null,
      fullNative: "Invalid Native Auth placement request",
    });
    expect(Object.keys(result.denied)).toHaveLength(3);
    for (const message of Object.values(result.denied))
      expect(message).toMatch(/does not implement|not a function|No such method/u);
    const worker = await mf.getWorker("bounded");
    const privateResponse = await worker.fetch("https://fixture/");
    expect(privateResponse.status).toBe(404);
    expect(privateResponse.headers.get("cache-control")).toBe("no-store");
  } finally {
    await mf.dispose();
  }
});

it("bounds Production to existing capabilities while preserving the full Development entrypoint and excluding Native modules from the bounded bundle", async () => {
  const development = await profile("wrangler.development.jsonc"),
    production = await profile("wrangler.pgcf.production.jsonc");
  expect(development.main).toBe("src/worker-main.ts");
  expect(development.services).toEqual(
    expect.arrayContaining([
      {
        binding: "NATIVE_AUTH_RESOURCE_RUNTIME",
        service: "ohmyho-control-store-poc-private-fullstack",
        entrypoint: "NativeAuthResourceRuntime",
      },
      {
        binding: "NATIVE_AUTH_REGISTRY_EU",
        service: "ohmyho-native-auth-development-eu",
        entrypoint: "NativeRegistryAdminService",
      },
      {
        binding: "NATIVE_AUTH_REGISTRY_US",
        service: "ohmyho-native-auth-development-us",
        entrypoint: "NativeRegistryAdminService",
      },
    ]),
  );
  expect(production.main).toBe("src/pgcf-worker-main.ts");
  expect(production.workers_dev).toBe(false);
  expect(production.preview_urls).toBe(false);
  expect(production.routes).toBeUndefined();
  expect(production.triggers.crons).toEqual(["*/15 * * * *"]);
  expect(production.services).toEqual([
    {
      binding: "DATABASE_MANAGEMENT_RUNTIME",
      service: "ohmyho-control-store-production",
      entrypoint: "DatabaseManagementRuntime",
    },
    {
      binding: "DATABASE_PRODUCT_RUNTIME",
      service: "ohmyho-control-store-production",
      entrypoint: "DatabaseProductRuntime",
    },
    {
      binding: "PROJECT_DATABASE_ADMIN_US",
      service: "ohmyho-project-database-production-us",
      entrypoint: "ProjectDatabaseAdmin",
    },
    {
      binding: "PROJECT_DATABASE_ADMIN_EU",
      service: "ohmyho-project-database-production-eu",
      entrypoint: "ProjectDatabaseAdmin",
    },
  ]);
  const out = await build({
    absWorkingDir: root,
    entryPoints: ["apps/neon-management/src/pgcf-worker-main.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*", ...builtinModules],
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const inputs = Object.values(out.metafile.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, contribution]) => contribution.bytesInOutput > 0)
      .map(([file]) => file),
  );
  expect(inputs).toContain("apps/neon-management/src/pgcf-entitlements.ts");
  expect(inputs).toContain("packages/provider-pgcf/src/pgcf-provider.ts");
  expect(inputs).not.toContain("apps/neon-management/src/worker-main.ts");
  expect(inputs.filter((file) => /\/native-auth-/u.test(file))).toEqual([]);
});
