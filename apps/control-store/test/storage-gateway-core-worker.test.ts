import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import {
  migrate,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedOrganization, projectInput } from "../../control-store/test/support/seed.js";
import {
  seedAcceptedOperation,
  seedCleanupRun,
} from "../../control-store/test/support/accepted-operation.js";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import {
  claimStorageUpload,
  completeStorageUpload,
} from "../../control-store/src/catalog/storage-gateway/uploads.js";
import { authenticateStorageGateway } from "../../control-store/src/catalog/storage-gateway/auth.js";
import { storageErasureMarkerDigest } from "@ohmyhost/database";
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function bundle(contents: string) {
  const output = await build({
    stdin: { contents, loader: "ts", resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    plugins: [
      {
        name: "native-builtins",
        setup(b) {
          b.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
            const name = args.path.replace(/^node:/u, "");
            if (!builtinModules.includes(name)) return;
            return args.kind === "require-call"
              ? { path: name, namespace: "native-builtins" }
              : { path: `node:${name}`, external: true };
          });
          b.onLoad({ filter: /.*/, namespace: "native-builtins" }, (args) => ({
            contents: `import value from ${JSON.stringify(`node:${args.path}`)};module.exports=value;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!output.outputFiles[0]) throw new Error("Missing R2 worker bundle");
  return output.outputFiles[0].text;
}

const gatewayMethods = {
  auth: ["authenticateStorageGateway"],
  uploads: [
    "claimStorageUpload",
    "readStorageUploadReservation",
    "completeStorageUpload",
    "readStorageObject",
    "readStorageObjects",
  ],
  deletes: [
    "claimStorageDelete",
    "claimStorageDeletes",
    "completeStorageErasure",
    "completeStorageErasures",
  ],
  retired: [
    "readRetiredStorageInventory",
    "claimRetiredStorageDeletes",
    "completeRetiredStorageDeletes",
  ],
};
it("runs actual default Storage HTTP and private retired purger through fixed Core RPC with atomic frozen scope", async () => {
  const imports = Object.entries(gatewayMethods)
    .map(
      ([file, names]) =>
        `import{${names.map((n) => `${n} as ${n}Catalog`).join(",")}}from'./apps/control-store/src/catalog/storage-gateway/${file}.ts';`,
    )
    .join("\n");
  const methods = Object.values(gatewayMethods)
    .flat()
    .map(
      (n) =>
        `async ${n}(input){try{return await ${n}Catalog({directory:this.env.CONTROL_CORE,router:new SharedCoreRouter(this.env.CONTROL_CORE)},input)}catch(e){console.error("STORAGE CORE",${JSON.stringify(n)},e);throw e}}`,
    )
    .join("\n");
  const core = await bundle(
    `import{WorkerEntrypoint}from'cloudflare:workers';import{SharedCoreRouter}from'./apps/control-store/src/router.ts';${imports}export class StorageRuntime extends WorkerEntrypoint{${methods}}export default{fetch(){return new Response(null,{status:404})}}`,
  );
  const caller =
    await bundle(`import Worker from'./apps/storage-gateway/src/worker-main.ts';import{StorageDataManagementEntrypoint}from'./apps/storage-gateway/src/management-entrypoint.ts';
 export default{async fetch(request,env,ctx){const url=new URL(request.url),scope=JSON.parse(request.headers.get('x-fixture-scope')),cfg={RUNTIME_CONFIGURATION_STATE:'configured',STORAGE_GATEWAY_RUNTIME:env.CORE,STORAGE_DATA_RUNTIME:env.CORE,GATEWAY_RATE_LIMITER:{limit:async()=>({success:true})},CONTROL_CORE_DATABASE_ID:'00000000-0000-4000-8000-000000000001',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_R2_API_TOKEN:'synthetic-token-'+ 'a'.repeat(32),CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID:'b'.repeat(32)};
 if(url.searchParams.has('raw'))Object.defineProperty(cfg,'CONTROL_SHARD_hidden',{get(){throw new Error('POISON RAW')}});globalThis.fetch=(a,i)=>env.PROVIDER.fetch(new Request(a,i));
 if(url.pathname==='/purge'){try{return Response.json(await new StorageDataManagementEntrypoint(ctx,cfg).purgeRetiredData(await request.json()))}catch(e){return Response.json({name:e.name,message:e.message},{status:409})}}
 return Worker.fetch(new Request('https://storage.example.test'+url.pathname,{method:request.method,headers:request.headers,body:request.body,duplex:'half'}),cfg,{props:scope})}}`);
  const files = new Map<
    string,
    { size: number; type: string; etag: string; modified: string; metadata: Record<string, string> }
  >();
  let providerCalls = 0;
  const mf = new Miniflare({
    workers: [
      {
        name: "core",
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        modulesRoot: root,
        modules: [{ type: "ESModule", path: root + "storage-core.mjs", contents: core }],
        d1Databases: { CONTROL_CORE: "storage-core" },
      },
      {
        name: "gateway",
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        modulesRoot: root,
        modules: [{ type: "ESModule", path: root + "storage-gateway.mjs", contents: caller }],
        serviceBindings: {
          CORE: { name: "core", entrypoint: "StorageRuntime" },
          PROVIDER: async (request: Request) => {
            providerCalls++;
            const key = decodeURIComponent(new URL(request.url).pathname);
            if (request.method === "PUT") {
              const metadata: Record<string, string> = {};
              request.headers.forEach((v, k) => {
                if (k.startsWith("x-amz-meta-")) metadata[k] = v;
              });
              files.set(key, {
                size: 0,
                type: "application/octet-stream",
                etag: "d41d8cd98f00b204e9800998ecf8427e",
                modified: new Date().toUTCString(),
                metadata,
              });
              return new Response(null, {
                headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' },
              });
            }
            const f = files.get(key);
            if (!f) return new Response(null, { status: 404 });
            return new Response(request.method === "HEAD" ? null : "abc", {
              headers: {
                "content-length": String(f.size),
                "content-type": f.type,
                etag: '"' + f.etag + '"',
                "last-modified": f.modified,
                ...f.metadata,
              },
            });
          },
        },
      },
    ],
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as unknown as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const c: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const store = createControlStore(c.bindings),
      org = await seedOrganization(store, 2, 0),
      p = projectInput(org, "storage-native-" + newUlid().toLowerCase(), false);
    p.developmentDataEnvironmentId = p.developmentEnvironmentId;
    p.productionDataEnvironmentId = p.productionEnvironmentId;
    await store.projects.createInitialProject(p);
    const time = "2026-10-28T12:00:00.000000Z",
      scope = {
        organizationId: org,
        projectId: p.projectId,
        environmentId: p.developmentEnvironmentId,
        dataEnvironmentId: p.developmentDataEnvironmentId,
      },
      bucket = "ohmyho-" + p.projectId.toLowerCase() + "-" + scope.environmentId.toLowerCase(),
      key = "s".repeat(43),
      keySha = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    await db.batch([
      db
        .prepare(
          "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
        )
        .bind(
          org,
          p.projectId,
          scope.environmentId,
          newUlid(),
          newUlid(),
          bucket,
          "c".repeat(32),
          time,
        ),
      db
        .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
        .bind(org, p.projectId, scope.environmentId, keySha, time),
    ]);
    const context = { directory: db, router: new SharedCoreRouter(db) };
    expect(
      await authenticateStorageGateway(context, {
        scope: null,
        input: {
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          keySha256: keySha,
        },
      }),
    ).toMatchObject(scope);
    const oldKeys = ["old-one.bin", "old-two.bin", "retired.bin"];

    for (const objectKey of oldKeys) {
      const input = {
        ...scope,
        transferId: newUlid(),
        idempotencyKey: objectKey,
        requestSha256: new Uint8Array(32).fill(7),
        objectKey,
        contentType: "application/octet-stream",
        expectedBytes: 3,
        requestedAt: time,
        expiresAt: "2026-10-28T12:05:00.000Z",
      };
      const { dataEnvironmentId, ...q } = input;
      void dataEnvironmentId;
      const physicalObjectKey = `d/${scope.dataEnvironmentId}/${objectKey}`;
      expect(await claimStorageUpload(context, { scope, input: q })).toEqual({
        outcome: "claimed",
        transferId: q.transferId,
        expiresAt: new Date(q.expiresAt),
        physicalObjectKey,
        dataEnvironmentId: scope.dataEnvironmentId,
      });
      const receipt = {
        organizationId: org,
        projectId: p.projectId,
        environmentId: scope.environmentId,
        transferId: q.transferId,
        objectKey,
        contentType: q.contentType,
        size: 3,
        etag: "a".repeat(32),
        uploadedAt: new Date("2026-10-28T12:00:30Z"),
      };
      expect(await completeStorageUpload(context, { scope, input: receipt })).toBe("created");
      files.set("/" + bucket + "/d/" + scope.dataEnvironmentId + "/" + objectKey, {
        size: 3,
        type: "application/octet-stream",
        etag: "a".repeat(32),
        modified: new Date("2026-10-28T12:00:30Z").toUTCString(),
        metadata: {},
      });
    }
    const gateway = await mf.getWorker("gateway");
    const call = async (path: string, body: unknown, idempotency?: string) =>
      gateway.fetch("https://fixture" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + key,
          "x-fixture-scope": JSON.stringify(scope),
          ...(idempotency ? { "idempotency-key": idempotency } : {}),
        },
        body: JSON.stringify({
          projectId: p.projectId,
          environmentId: scope.environmentId,
          ...(body as object),
        }),
      });
    const upload = await call(
      "/v1/uploads",
      { objectKey: "new.bin", contentType: "application/octet-stream", contentLength: 3 },
      "fresh",
    );
    expect(upload.status, await upload.clone().text()).toBe(200);
    const uploaded = (await upload.json()) as { transfer_id: string; capability: { url: string } };
    files.set(new URL(uploaded.capability.url).pathname, {
      size: 3,
      type: "application/octet-stream",
      etag: "a".repeat(32),
      modified: new Date().toUTCString(),
      metadata: {},
    });
    expect((await call("/v1/uploads/complete", { transferId: uploaded.transfer_id })).status).toBe(
      200,
    );
    expect((await call("/v1/downloads", { objectKey: "new.bin" })).status).toBe(200);
    const batch = await call("/v1/downloads/batch", { objectKeys: ["new.bin", "missing.bin"] });
    expect(batch.status).toBe(200);
    expect((await batch.arrayBuffer()).byteLength).toBeGreaterThan(3);
    const deleted = await call("/v1/deletions", { objectKey: "old-one.bin" }, "delete-one");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ state: "completed" });
    const many = await call("/v1/deletions/batch", {
      objects: [{ objectKey: "old-two.bin", idempotencyKey: "delete-many-1" }],
    });
    expect(many.status).toBe(200);
    expect(await many.json()).toMatchObject({ state: "completed" });
    expect((await call("/v1/downloads", { objectKey: "old-one.bin" })).status).toBe(404);
    const before = providerCalls;
    await expect(
      call(
        "/v1/uploads?raw=1",
        { objectKey: "forbidden.bin", contentType: "application/octet-stream", contentLength: 3 },
        "raw",
      ),
    ).rejects.toThrow("mixed Control authority");
    expect(providerCalls).toBe(before);
    const rows = (await db.prepare("SELECT * FROM project_r2_erasure_barriers").all()).results;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const proof = {
        organizationId: String(r["organization_id"]),
        projectId: String(r["project_id"]),
        environmentId: String(r["environment_id"]),
        dataEnvironmentId: String(r["data_environment_id"]),
        transferId: String(r["transfer_id"]),
        physicalObjectKey: String(r["physical_object_key"]),
      };
      expect(Buffer.from(r["marker_sha256"] as number[])).toEqual(
        Buffer.from(storageErasureMarkerDigest(proof)),
      );
    }

    // A distinct accepted reset retires an expired area; the private real purger completes all three ports.
    const retiredProject = projectInput(org, "retired-native-" + newUlid().toLowerCase(), false);
    retiredProject.developmentDataEnvironmentId = retiredProject.developmentEnvironmentId;
    retiredProject.productionDataEnvironmentId = retiredProject.productionEnvironmentId;
    await store.projects.createInitialProject(retiredProject);
    const retiredScope = {
        organizationId: org,
        projectId: retiredProject.projectId,
        environmentId: retiredProject.developmentEnvironmentId,
        dataEnvironmentId: retiredProject.developmentDataEnvironmentId,
      },
      retiredBucket =
        "ohmyho-" +
        retiredScope.projectId.toLowerCase() +
        "-" +
        retiredScope.environmentId.toLowerCase(),
      newData = newUlid(),
      retiredTransfer = newUlid();
    await db
      .prepare(
        "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at)VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
      )
      .bind(
        org,
        retiredScope.projectId,
        retiredScope.environmentId,
        newUlid(),
        newUlid(),
        retiredBucket,
        "d".repeat(32),
        time,
      )
      .run();
    await claimStorageUpload(context, {
      scope: retiredScope,
      input: {
        organizationId: org,
        projectId: retiredScope.projectId,
        environmentId: retiredScope.environmentId,
        transferId: retiredTransfer,
        idempotencyKey: "retire",
        requestSha256: new Uint8Array(32).fill(8),
        objectKey: "retired.bin",
        contentType: "application/octet-stream",
        expectedBytes: 3,
        requestedAt: time,
        expiresAt: "2026-10-28T12:05:00.000Z",
      },
    });
    files.set("/" + retiredBucket + "/d/" + retiredScope.dataEnvironmentId + "/retired.bin", {
      size: 3,
      type: "application/octet-stream",
      etag: "a".repeat(32),
      modified: new Date("2026-10-28T12:00:30Z").toUTCString(),
      metadata: {},
    });
    // The accepted data-change of the retired scope, holding the project's provider claim.
    const retiredIds = {
      organizationId: org,
      projectId: retiredScope.projectId,
      billingEpochId: retiredProject.billingEpochId,
      shard: db,
    };
    const { operationId, claimId } = await seedAcceptedOperation(
      retiredIds,
      retiredScope.environmentId,
      {
        eventType: "ProjectDataChangeRequestedV1",
        at: time,
        intent: async (operation) => ({
          expected_etag: "fixture-etag",
          cleanup_run_id: await seedCleanupRun(retiredIds, operation),
          data_change: "reset_dev",
          data_change_snapshot: JSON.stringify({
            transition: { redeployEnvironments: ["dev"] },
            environmentHeads: [{}, {}],
            registrationGenerations: [],
          }),
        }),
      },
    );
    await db.batch([
      db
        .prepare(
          "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at)VALUES(?1,?2,?3,?4)",
        )
        .bind(org, retiredScope.projectId, newData, time),
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,operation_id,assigned_at)VALUES(?1,?2,?3,?4,2,?5,?6)",
        )
        .bind(org, retiredScope.projectId, retiredScope.environmentId, newData, operationId, time),
    ]);
    const retiredInput = { ...retiredScope, operationId, claimId };
    const purged = await call("/purge", retiredInput);
    expect(purged.status).toBe(200);
    expect(await purged.json()).toEqual({ status: "ready", deletedFiles: 1 });
    const replayPurge = await call("/purge", retiredInput);
    expect(await replayPurge.json()).toEqual({ status: "ready", deletedFiles: 1 });
    // The old frozen deployment is refused before any provider call, including reads.
    const beforeStale = providerCalls;
    await expect(
      claimStorageUpload(context, {
        scope: retiredScope,
        input: {
          organizationId: org,
          projectId: retiredScope.projectId,
          environmentId: retiredScope.environmentId,
          transferId: newUlid(),
          idempotencyKey: "stale",
          requestSha256: new Uint8Array(32),
          objectKey: "stale.bin",
          contentType: "application/octet-stream",
          expectedBytes: 3,
          requestedAt: time,
          expiresAt: "2026-10-28T12:05:00.000Z",
        },
      }),
    ).rejects.toMatchObject({ name: "StorageGatewayBindingChangedError" });
    expect(providerCalls).toBe(beforeStale);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120000);
