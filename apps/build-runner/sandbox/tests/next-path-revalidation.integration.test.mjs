import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  createNextPlatformConfig,
  createOpenNextPlatformConfig,
  populateNextStaticCache,
  validateNextCacheSupport,
} from "../build-runtime.mjs";
import { patchOpenNextPackage } from "../open-next-patch.mjs";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const nextFixture = path.join(repository, "fixtures/next-edge");

// A real Next build is expensive, but verifies the framework response and private RPC together.
test(
  "revalidatePath crosses real Next, OpenNext, the Worker wrapper and deployment-scoped SQLite cache",
  { timeout: 180_000 },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ohmyhost-next-path-test-"));
    let mf;
    try {
      const app = path.join(temp, "app"),
        platform = path.join(temp, "platform");
      fs.mkdirSync(path.join(app, "src/app/api/revalidate"), { recursive: true });
      fs.mkdirSync(path.join(app, "src/app/api/large"), { recursive: true });
      fs.mkdirSync(path.join(app, "src/app/api/slow"), { recursive: true });
      fs.mkdirSync(path.join(app, "src/app/blog"), { recursive: true });
      for (const name of ["package.json", "pnpm-lock.yaml", "tsconfig.json"])
        fs.copyFileSync(path.join(nextFixture, name), path.join(app, name));
      fs.writeFileSync(
        path.join(app, "next.config.mjs"),
        "export default { experimental: { cpus: 2 } };\n",
      );
      fs.writeFileSync(
        path.join(app, "src/app/layout.tsx"),
        "export default function Layout({children}:{children:React.ReactNode}){return <html><body>{children}</body></html>};\n",
      );
      fs.writeFileSync(
        path.join(app, "src/app/actions.ts"),
        '"use server"; import {revalidatePath} from "next/cache"; export async function refreshPage(){revalidatePath("/", "page")}\n',
      );
      fs.writeFileSync(
        path.join(app, "src/app/page.tsx"),
        'import {refreshPage} from "./actions"; export const dynamic="force-static"; export default function Page(){return <main><p id="version">{Math.random()}</p><form action={refreshPage}><button>Refresh</button></form></main>}\n',
      );
      fs.writeFileSync(
        path.join(app, "src/app/blog/page.tsx"),
        'export const dynamic="force-static"; export default function Blog(){return <p id="blog">{Math.random()}</p>}\n',
      );
      fs.writeFileSync(
        path.join(app, "src/app/api/revalidate/route.ts"),
        'import {revalidatePath} from "next/cache"; export async function POST(request:Request){const input=await request.json();revalidatePath(input.path,input.type);return Response.json({ok:true})}\n',
      );
      fs.writeFileSync(
        path.join(app, "src/app/api/large/route.ts"),
        'export function GET(){return new Response("x".repeat(12582913))}\n',
      );
      fs.writeFileSync(
        path.join(app, "src/app/api/slow/route.ts"),
        "export function GET(){return new Response(new ReadableStream({start(){}}))}\n",
      );
      const env = {
        ...process.env,
        CI: "true",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PRIVATE_STANDALONE: "true",
        NEXT_REVALIDATE_PATH: "1",
        WRANGLER_SEND_METRICS: "false",
      };
      const run = (file, args, cwd = app) =>
        execFileSync(file, args, {
          cwd,
          env,
          stdio: "pipe",
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      // Canonical verification installs this fixture first. Copy its local dependency tree into
      // the temporary app, preserving pnpm's relative links, so this test needs no network or
      // package-store state and Next's standalone trace stays within the application root.
      fs.cpSync(path.join(nextFixture, "node_modules"), path.join(app, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      run(process.execPath, [
        path.join(app, "node_modules/next/dist/bin/next"),
        "build",
        "--webpack",
      ]);

      const installed = fs.realpathSync(
        path.join(nextFixture, "node_modules/@opennextjs/cloudflare"),
      );
      const sourceDeps = path.dirname(path.dirname(installed));
      const aws = fs.realpathSync(path.join(sourceDeps, "@opennextjs/aws"));
      const awsDeps = path.dirname(path.dirname(aws));
      const tool = path.join(platform, "cloudflare"),
        deps = path.join(platform, "node_modules");
      fs.mkdirSync(path.join(deps, "@opennextjs"), { recursive: true });
      fs.cpSync(installed, tool, { recursive: true });
      fs.cpSync(aws, path.join(deps, "@opennextjs/aws"), { recursive: true });
      for (const source of [sourceDeps, awsDeps, path.join(repository, "node_modules")])
        for (const name of fs.readdirSync(source)) {
          if (
            name.startsWith(".") ||
            name === "@opennextjs" ||
            fs.existsSync(path.join(deps, name))
          )
            continue;
          fs.symlinkSync(path.join(source, name), path.join(deps, name));
        }
      patchOpenNextPackage(tool);
      const plan = {
        FRAMEWORK_ADAPTER: "nextjs",
        FRAMEWORK_RUNTIME: "edge",
        BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
        SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
        SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
        SERVER_CONFIG_PATH: "wrangler.jsonc",
        COMPATIBILITY_DATE: "2026-08-21",
        COMPATIBILITY_FLAGS: "nodejs_compat",
        NEXT_REVALIDATE_PATH: "1",
      };
      validateNextCacheSupport({ applicationRoot: app, environment: plan });
      createNextPlatformConfig({
        applicationRoot: app,
        outputPath: path.join(app, ".ohmyhost-next-wrangler.jsonc"),
        environment: plan,
      });
      createOpenNextPlatformConfig({
        applicationRoot: app,
        outputPath: path.join(app, ".ohmyhost-open-next.config.ts"),
        environment: plan,
        platformPackageRoot: tool,
      });
      run(process.execPath, [
        path.join(tool, "dist/cli/index.js"),
        "build",
        "--skipNextBuild",
        "--config=.ohmyhost-next-wrangler.jsonc",
        "--openNextConfigPath=.ohmyhost-open-next.config.ts",
      ]);
      await populateNextStaticCache({
        applicationRoot: app,
        platformPackageRoot: tool,
        environment: plan,
      });
      run(path.join(repository, "apps/build-runner/node_modules/.bin/wrangler"), [
        "deploy",
        "--dry-run",
        "--outdir",
        ".ohmyhost-worker",
        "--metafile",
        ".ohmyhost-next-metafile.json",
        "--config",
        ".ohmyhost-next-wrangler.jsonc",
      ]);

      const wrapperModule = path.join(temp, "wrapper.mjs");
      await build({
        stdin: {
          contents:
            'export {createEdgeRuntimeWrapperSource} from "./apps/wfp-management/src/management.ts"',
          resolveDir: repository,
          loader: "ts",
        },
        outfile: wrapperModule,
        bundle: true,
        format: "esm",
        platform: "node",
        conditions: ["source"],
        external: ["cloudflare:workers"],
        banner: {
          js: `import {createRequire as cr} from "node:module"; const require=cr(${JSON.stringify(path.join(repository, "package.json"))});`,
        },
        logLevel: "silent",
      });
      const { createEdgeRuntimeWrapperSource } = await import(pathToFileURL(wrapperModule).href);
      const runtime = {
        kind: "cloudflare-worker",
        mainModule: "index.js",
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        entryWrapperVersion: "nextjs-opennext-wrapper-v1",
        nextRevalidatePath: true,
      };
      const server = path.join(app, ".ohmyhost-worker"),
        main = fs.readFileSync(path.join(server, "worker.js"), "utf8");
      const modules = [
        {
          type: "ESModule",
          path: path.join(server, "entry.mjs"),
          contents: createEdgeRuntimeWrapperSource(runtime),
        },
        { type: "ESModule", path: path.join(server, "index.js"), contents: main },
      ];
      for (const name of fs.readdirSync(server))
        if (name.endsWith(".mjs"))
          modules.push({
            type: "ESModule",
            path: path.join(server, name),
            contents: fs.readFileSync(path.join(server, name), "utf8"),
          });
      const built = await build({
        entryPoints: [path.join(repository, "apps/next-cache/src/worker-main.ts")],
        bundle: true,
        format: "esm",
        platform: "browser",
        external: ["cloudflare:workers"],
        write: false,
      });
      const original = built.outputFiles[0].text,
        cache = original.replace(".jurisdiction(region).getByName(", ".getByName(");
      assert.notEqual(cache, original, "local workerd needs the jurisdiction shim");
      const scope = {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        region: "eu",
      };
      const site = (name, props, target = "cache") => ({
        name,
        modules,
        assets: {
          directory: path.join(app, ".open-next/assets"),
          binding: "ASSETS",
          run_worker_first: true,
        },
        compatibilityDate: "2026-08-21",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          OHMYHOST_NEXT_CACHE: { name: target, entrypoint: "NextCacheRuntime", props },
        },
      });
      mf = new Miniflare(
        convertV4MiniflareOptions({
          rootPath: server,
          cf: false,
          workers: [
            site("site", scope),
            site("other", { ...scope, deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ" }),
            site("prod", {
              ...scope,
              environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAM",
              deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAN",
            }),
            site("offline", scope, "offline-cache"),
            site("write-failure", scope, "write-failure-cache"),
            {
              name: "cache",
              compatibilityDate: "2026-09-14",
              modules: [{ type: "ESModule", path: "cache.mjs", contents: cache }],
              durableObjects: {
                NEXT_CACHE_OBJECT: { className: "NextCacheObject", useSQLite: true },
              },
            },
            {
              name: "offline-cache",
              compatibilityDate: "2026-09-14",
              modules: [
                {
                  type: "ESModule",
                  path: "offline.mjs",
                  contents:
                    'import {WorkerEntrypoint} from "cloudflare:workers"; export class NextCacheRuntime extends WorkerEntrypoint {get(){throw Error("offline")} put(){throw Error("offline")} delete(){throw Error("offline")} readTags(){throw Error("offline")} writeTags(){throw Error("offline")}} export default {};',
                },
              ],
            },
            {
              name: "write-failure-cache",
              compatibilityDate: "2026-09-14",
              modules: [
                {
                  type: "ESModule",
                  path: "write-failure.mjs",
                  contents:
                    'import {WorkerEntrypoint} from "cloudflare:workers"; export class NextCacheRuntime extends WorkerEntrypoint {get(){return {kind:"missing",generation:1}} readTags({tags}){return {generation:1,tags:tags.map(tag=>({tag,generation:1,revalidatedAt:Date.now(),stale:null,expire:0}))}} put(){throw Error("write unavailable")} delete(){throw Error("delete unavailable")} writeTags(){return {generation:1,revalidatedAt:Date.now()}}} export default {};',
                },
              ],
            },
          ],
        }),
      );
      const siteWorker = await mf.getWorker("site"),
        otherWorker = await mf.getWorker("other"),
        prodWorker = await mf.getWorker("prod"),
        writeFailureWorker = await mf.getWorker("write-failure"),
        offlineWorker = await mf.getWorker("offline");
      const get = (worker, url, init = {}) => worker.fetch(`https://fixture.example${url}`, init);
      const version = async (worker, url = "/") => {
        const response = await get(worker, url),
          text = await response.text();
        assert.equal(response.status, 200);
        const match = /id="(?:version|blog)">([^<]+)/u.exec(text);
        assert.ok(match);
        return match[1];
      };
      const invalidate = (worker, target, type) =>
        get(worker, "/api/revalidate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target, type }),
        });
      const originalPage = await version(siteWorker),
        otherPage = await version(otherWorker),
        prodPage = await version(prodWorker);
      assert.equal(await version(siteWorker), originalPage);
      assert.equal((await invalidate(siteWorker, "/", "page")).status, 200);
      const newPage = await version(siteWorker);
      assert.notEqual(newPage, originalPage);
      assert.equal(await version(siteWorker), newPage);
      assert.equal(
        await version(otherWorker),
        otherPage,
        "another deployment retains its own cache",
      );
      assert.equal(
        await version(prodWorker),
        prodPage,
        "promotion uses a separate environment cache",
      );
      assert.equal((await invalidate(otherWorker, "/", "page")).status, 200);
      const rollbackPage = await version(otherWorker);
      assert.notEqual(rollbackPage, otherPage);
      assert.equal(
        await version(siteWorker),
        newPage,
        "returning to the newer deployment restores its own cache",
      );
      assert.equal(await version(prodWorker), prodPage);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(app, ".next/server/server-reference-manifest.json"), "utf8"),
      );
      const actionId = Object.keys(manifest.node)[0];
      const action = (worker) =>
        get(worker, "/", {
          method: "POST",
          headers: {
            "next-action": actionId,
            "content-type": "text/plain;charset=UTF-8",
            accept: "text/x-component",
          },
          body: "[]",
        });
      assert.equal((await action(siteWorker)).status, 200);
      assert.notEqual(await version(siteWorker), newPage);
      const blog = await version(siteWorker, "/blog"),
        otherBlog = await version(otherWorker, "/blog");
      assert.equal((await invalidate(siteWorker, "/", "layout")).status, 200);
      assert.notEqual(await version(siteWorker, "/blog"), blog);
      assert.equal(await version(otherWorker, "/blog"), otherBlog);
      const concurrent = await Promise.all(Array.from({ length: 4 }, () => version(siteWorker)));
      assert.ok(concurrent.every(Boolean));
      const settled = await version(siteWorker);
      assert.equal(await version(siteWorker), settled);
      assert.ok((await get(offlineWorker, "/")).status >= 500);
      assert.equal((await invalidate(offlineWorker, "/", "page")).status, 503);
      assert.equal((await action(offlineWorker)).status, 503);
      assert.equal((await get(writeFailureWorker, "/")).status, 503);
      assert.equal((await get(siteWorker, "/api/large")).status, 503);
      assert.equal((await get(siteWorker, "/api/slow")).status, 503);
    } finally {
      if (mf) await mf.dispose();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
