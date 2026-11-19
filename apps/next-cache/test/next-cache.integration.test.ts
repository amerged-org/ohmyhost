import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";
import { fileURLToPath } from "node:url";

it("isolates deployment-scoped cache values and path tags over real Worker RPC and SQLite DO transactions", async () => {
  const entry = fileURLToPath(new URL("../src/worker-main.ts", import.meta.url));
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
  });
  const code = bundle.outputFiles[0]?.text;
  if (code === undefined) throw new Error("missing bundle");
  // Local workerd rejects all jurisdictioned namespaces. Routing itself is tested separately;
  // the emulated name retains the region and the database/RPC path remains real.
  const localCode = code.replace(".jurisdiction(region).getByName(", ".getByName(");
  if (localCode === code) throw new Error("local jurisdiction shim did not match");
  const ids = [
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  ];
  const scope = {
    organizationId: ids[0],
    projectId: ids[1],
    environmentId: ids[2],
    deploymentId: ids[3],
    region: "eu",
  };
  const retireInput = {
    organizationId: ids[0],
    projectId: ids[1],
    environmentId: ids[2],
    deploymentId: ids[3],
    operationId: ids[4],
    cleanupRunId: ids[4],
  };
  const target = (props: Record<string, unknown>) => ({
    name: "cache",
    entrypoint: "NextCacheRuntime",
    props,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "client",
          compatibilityDate: "2026-09-14",
          modules: [
            {
              type: "ESModule",
              path: "client.mjs",
              contents: `export default { async fetch(request,env) { try { const {binding,method,input}=await request.json(); return Response.json(await env[binding][method](input)); } catch(e) { return Response.json({error:String(e.message)}, {status:409}); } } };`,
            },
          ],
          serviceBindings: {
            A: target(scope),
            SAME: target(scope),
            DEPLOY: target({ ...scope, deploymentId: ids[4] }),
            ENV: target({ ...scope, environmentId: ids[4] }),
            FOREIGN: target({ ...scope, organizationId: ids[4] }),
            INVALID: target({ ...scope, projectId: "other" }),
            RETIRE: { name: "cache", entrypoint: "NextCacheRetirementRuntime" },
          },
        },
        {
          name: "cache",
          compatibilityDate: "2026-09-14",
          modules: [{ type: "ESModule", path: "cache.mjs", contents: localCode }],
          durableObjects: { NEXT_CACHE_OBJECT: { className: "NextCacheObject", useSQLite: true } },
          serviceBindings: {
            NEXT_CACHE_RETIREMENT_AUTHORITY: {
              name: "authority",
              entrypoint: "RetirementAuthority",
            },
          },
        },
        {
          name: "authority",
          compatibilityDate: "2026-09-14",
          modules: [
            {
              type: "ESModule",
              path: "authority.mjs",
              contents: `import { WorkerEntrypoint } from 'cloudflare:workers'; export class RetirementAuthority extends WorkerEntrypoint { authorizeRetirement(input) { return JSON.stringify(input) === ${JSON.stringify(JSON.stringify(retireInput))} ? { region:'eu' } : null; } } export default {};`,
            },
          ],
        },
      ],
    }),
  );
  try {
    const call = async (binding: string, method: string, input: unknown) => {
      const response = await mf.dispatchFetch("https://client.invalid/", {
        method: "POST",
        body: JSON.stringify({ binding, method, input }),
      });
      return { status: response.status, body: await response.json() };
    };
    const key = "/article",
      cacheType = "cache",
      missing = { kind: "missing", generation: 0 };
    expect((await call("A", "get", { key, cacheType })).body).toEqual(missing);
    const valueJson = JSON.stringify({ type: "app", html: "x".repeat(10 * 1024 * 1024) });
    expect(
      (await call("A", "put", { key, cacheType, valueJson, expectedGeneration: 0 })).body,
    ).toMatchObject({ kind: "stored", generation: 0 });
    const stored = await call("SAME", "get", { key, cacheType });
    expect(stored.body).toMatchObject({
      kind: "value",
      valueJson,
      entryGeneration: 0,
      generation: 0,
    });
    for (const other of ["DEPLOY", "ENV", "FOREIGN"])
      expect((await call(other, "get", { key, cacheType })).body).toEqual(missing);
    const invalidated = (
      await call("A", "writeTags", { tags: [{ tag: "_N_T_/article", expire: Date.now() }] })
    ).body as { generation: number; revalidatedAt: number };
    expect(invalidated).toMatchObject({ generation: 1 });
    expect(invalidated.revalidatedAt).toBeGreaterThan(
      (stored.body as { lastModified: number }).lastModified,
    );
    expect(
      (await call("A", "readTags", { tags: ["_N_T_/article", "_N_T_/missing"] })).body,
    ).toMatchObject({ generation: 1, tags: [{ tag: "_N_T_/article", generation: 1 }, null] });
    expect(
      (await call("A", "put", { key, cacheType, valueJson: "{}", expectedGeneration: 0 })).status,
    ).toBe(409);
    expect((await call("SAME", "get", { key, cacheType })).body).toMatchObject({
      kind: "value",
      valueJson,
      entryGeneration: 0,
      generation: 1,
    });
    expect(
      (
        await call("A", "put", {
          key,
          cacheType,
          valueJson: '{"fresh":true}',
          expectedGeneration: 1,
        })
      ).body,
    ).toMatchObject({ kind: "stored", generation: 1 });
    expect((await call("A", "delete", { key, expectedGeneration: 1 })).body).toEqual({
      kind: "deleted",
      generation: 2,
    });
    expect((await call("SAME", "get", { key, cacheType })).body).toEqual({
      kind: "tombstone",
      generation: 2,
    });
    expect((await call("INVALID", "get", { key, cacheType })).status).toBe(409);
    expect((await call("A", "get", { key, cacheType, organizationId: ids[4] })).status).toBe(409);
    expect(
      (
        await call("A", "put", {
          key,
          cacheType,
          valueJson: "x".repeat(12 * 1024 * 1024 + 1),
          expectedGeneration: 2,
        })
      ).status,
    ).toBe(409);
    expect((await call("A", "readTags", { tags: ["_N_T_/article", "_N_T_/article"] })).status).toBe(
      409,
    );
    expect((await call("A", "get", { key, cacheType })).body).toEqual({
      kind: "tombstone",
      generation: 2,
    });
    expect((await call("A", "retire", retireInput)).status).toBe(409);
    expect((await call("RETIRE", "retire", { key })).status).toBe(409);
    expect(
      (await call("RETIRE", "retire", { ...retireInput, organizationId: ids[4] })).status,
    ).toBe(409);
    expect((await call("RETIRE", "retire", retireInput)).body).toEqual({ kind: "retired" });
    expect((await call("RETIRE", "retire", retireInput)).body).toEqual({ kind: "retired" });
    expect((await call("A", "get", { key, cacheType })).status).toBe(409);
    expect(
      (await call("A", "put", { key, cacheType, valueJson: "{}", expectedGeneration: 2 })).status,
    ).toBe(409);
    expect((await call("DEPLOY", "get", { key, cacheType })).body).toEqual(missing);
  } finally {
    await mf.dispose();
  }
}, 120_000);
