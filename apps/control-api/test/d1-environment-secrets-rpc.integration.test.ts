import { createRequire, builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { applyWorkosSnapshot } from "../../control-store/src/catalog/identity/membership-state.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  activateTestCore,
  migrate,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { digest } from "../../control-store/test/support/seed.js";
import { seedProject, bytes } from "../../control-store/test/support/platform-fixtures.js";

interface Harness {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("../../control-store/package.json"))(
  "miniflare",
) as { Miniflare: new (options: unknown) => Harness };
const root = fileURLToPath(new URL("..", import.meta.url));
async function bundle(contents: string) {
  const built = await build({
    stdin: { contents, resolveDir: root, sourcefile: "secret-rpc-fixture.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
    banner: {
      js: 'import {createRequire as __fixtureRequire} from "node:module"; const require=__fixtureRequire("file:///fixture.mjs");',
    },
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[^.:/][^:]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  const output = built.outputFiles?.[0];
  if (!output) throw new Error("The real secret Worker fixture did not bundle");
  return output.text;
}
const CONTROL = `export {ControlRuntime} from "../control-store/src/worker-main.ts"; export default {fetch(){return new Response("private")}};`;
const API = `
import {createControlApiWorkerEntrypoint} from "./src/worker-main.ts";
const worker=createControlApiWorkerEntrypoint({fetcher:()=>{throw new Error("FETCHER_WAS_CALLED")}});
export default {async fetch(request,env,ctx){
  const bindings={...env,CONTROL_API_PUBLIC_ORIGIN:"https://dev.app.ohmyho.st",CONTROL_API_RATE_LIMITER:{limit:async()=>({success:true})},OPERATION_PUBLISHER:{wake:async()=>{}},WORKOS_JWKS_URL:"https://fixture.authkit.app/jwks",WORKOS_ISSUER:"https://api.workos.com/user_management/client_fixture",WORKOS_CLIENT_ID:"client_fixture",WORKOS_AUDIENCE:"control-api",ENVIRONMENT_SECRET_KEY_BASE64:"Y2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2M=",ENVIRONMENT_SECRET_KEY_VERSION:"1"};
  return worker.fetch(request,bindings,ctx);
}};`;

it("stores, replays and deletes public environment secrets across actual API-to-Core RPC with ciphertext-only storage", async () => {
  let workosOrganization = "";
  const harness = new Miniflare({
    workers: [
      {
        name: "core",
        modules: true,
        script: await bundle(CONTROL),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { CONTROL_CORE: "core" },
      },
      {
        name: "api",
        modules: true,
        script: await bundle(API),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          CONTROL_RUNTIME: { name: "core", entrypoint: "ControlRuntime" },
          AUTH_STATUS: async (request: Request) => {
            const raw = (await request.json()) as { value?: string };
            return Response.json(
              {
                key:
                  raw.value === "sk_aaaaaaaaaaaaaaaaaaaaaaaa"
                    ? {
                        id: "api_key_secret_rpc",
                        userId: "user_secret_rpc",
                        organizationId: workosOrganization,
                        permissions: [
                          "projects:create",
                          "projects:read",
                          "secrets:read",
                          "secrets:write",
                          "secrets:delete",
                        ],
                        expiresAt: null,
                      }
                    : null,
              },
              { headers: { "cache-control": "no-store" } },
            );
          },
        },
      },
    ],
  });
  try {
    const db = (await harness.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const organizationId = newUlid();
    workosOrganization = "org_secret_rpc";
    await applyWorkosSnapshot(
      { directory: db, router: new SharedCoreRouter(db) },
      {
        organizationId,
        workosOrganizationId: workosOrganization,
        state: "active",
        snapshotDigest: digest(910),
        snapshotFetchedAt: "2026-10-28T12:00:00.000Z",
        synchronizedAt: "2026-10-28T12:00:00.000Z",
        triggerEventId: "evt_secret_rpc",
        auditEventId: newUlid(),
        memberships: [
          { workosUserId: "user_secret_rpc", role: "admin", status: "active", digest: digest(911) },
        ],
      },
    );
    await db
      .prepare(
        "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
      )
      .bind(organizationId)
      .run();
    const api = await harness.getWorker("api");
    const headers = {
      authorization: "Bearer sk_aaaaaaaaaaaaaaaaaaaaaaaa",
      "content-type": "application/json",
      "idempotency-key": "secret-rpc-set",
    };
    const created = await api.fetch("https://dev.app.ohmyho.st/v1/projects", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "secret-rpc-project" },
      body: JSON.stringify({ organization_id: organizationId, name: "Fresh secret RPC project" }),
    });
    expect(created.status, await created.clone().text()).toBe(202);
    const fresh = await db
      .prepare(
        "SELECT p.project_id, dev.environment_id dev_id, prod.environment_id prod_id FROM projects p JOIN environments dev ON dev.organization_id=p.organization_id AND dev.project_id=p.project_id AND dev.name='dev' JOIN environments prod ON prod.organization_id=p.organization_id AND prod.project_id=p.project_id AND prod.name='prod' WHERE p.organization_id=?",
      )
      .bind(organizationId)
      .first<{ project_id: string; dev_id: string; prod_id: string }>();
    if (!fresh) throw new Error("The public API did not create its real environment graph");
    const project = {
      organizationId,
      projectId: fresh.project_id,
      devEnvironmentId: fresh.dev_id,
      prodEnvironmentId: fresh.prod_id,
    };
    const path = (environmentId: string) =>
      `https://dev.app.ohmyho.st/v1/projects/${project.projectId}/environments/${environmentId}/secrets`;
    const firstList = await api.fetch(path(project.devEnvironmentId), { headers });
    expect(firstList.status, await firstList.clone().text()).toBe(200);
    expect(await firstList.json()).toMatchObject({ items: [] });
    const value = "synthetic application acceptance key";
    const put = (environmentId: string, input = value) =>
      api.fetch(`${path(environmentId)}/ACCEPTANCE_KEY`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ value: input }),
      });
    const foreign = newUlid();
    const denied = await put(foreign);
    expect(denied.status).toBe(404);
    expect(
      await db
        .prepare("SELECT count(*) n FROM runtime_secret_delivery_states WHERE environment_id=?")
        .bind(foreign)
        .first(),
    ).toEqual({ n: 0 });
    const states = () =>
      db
        .prepare(
          "SELECT desired_generation FROM runtime_secret_delivery_states WHERE organization_id=? AND project_id=? AND environment_id=?",
        )
        .bind(project.organizationId, project.projectId, project.devEnvironmentId)
        .first();
    expect(await states()).toBeNull();
    // Force a failure after the new delivery state, encrypted secret and generation would have been written.
    await db
      .prepare(
        "CREATE TRIGGER secret_first_write_failure BEFORE INSERT ON environment_secret_requests WHEN NEW.idempotency_key='secret-rpc-late-failure' BEGIN SELECT RAISE(ABORT,'synthetic late receipt failure'); END",
      )
      .run();
    const failed = await api.fetch(`${path(project.devEnvironmentId)}/LATE_VALUE`, {
      method: "PUT",
      headers: { ...headers, "idempotency-key": "secret-rpc-late-failure" },
      body: JSON.stringify({ value }),
    });
    expect(failed.status).toBe(503);
    expect(await states()).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM environment_secrets WHERE organization_id=? AND project_id=?",
        )
        .bind(project.organizationId, project.projectId)
        .first(),
    ).toEqual({ n: 0 });
    await db.prepare("DROP TRIGGER secret_first_write_failure").run();

    const [first, second] = await Promise.all([
      put(project.devEnvironmentId),
      api.fetch(`${path(project.devEnvironmentId)}/SECOND_VALUE`, {
        method: "PUT",
        headers: { ...headers, "idempotency-key": "secret-rpc-second" },
        body: JSON.stringify({ value: "second synthetic application value" }),
      }),
    ]);
    const firstBody = await first.text();
    expect(first.status, firstBody).toBe(200);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(firstBody).not.toContain(value);
    expect(JSON.parse(firstBody)).toMatchObject({
      name: "ACCEPTANCE_KEY",
      revision: 1,
      key_version: 1,
      delivery_state: "not_deployed",
    });
    expect(await states()).toEqual({ desired_generation: 2 });
    const replay = await (await put(project.devEnvironmentId)).json();
    expect(replay).toEqual({ ...JSON.parse(firstBody), desired_generation: 2 });
    expect((await put(project.devEnvironmentId, "different synthetic value")).status).toBe(409);
    expect(await states()).toEqual({ desired_generation: 2 });
    expect((await put(project.prodEnvironmentId)).status).toBe(200);
    const devList = await api.fetch(path(project.devEnvironmentId), { headers });
    expect(devList.status).toBe(200);
    expect(await devList.json()).toMatchObject({
      items: [
        { name: "ACCEPTANCE_KEY", revision: 1 },
        { name: "SECOND_VALUE", revision: 1 },
      ],
      desired_generation: 2,
    });
    const prodList = await api.fetch(path(project.prodEnvironmentId), { headers });
    expect(prodList.status).toBe(200);
    expect(await prodList.json()).toMatchObject({
      items: [{ name: "ACCEPTANCE_KEY", revision: 1 }],
      desired_generation: 1,
    });
    const digests = await db
      .prepare(
        "SELECT environment_id,name,lower(hex(value_sha256)) digest FROM environment_secrets WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId)
      .all<{ environment_id: string; name: string; digest: string }>();
    const storedDigests = Object.fromEntries(
      digests.results.map((row) => [`${row.environment_id}/${row.name}`, row.digest]),
    );
    expect(storedDigests).toEqual({
      [`${project.devEnvironmentId}/ACCEPTANCE_KEY`]: expect.stringMatching(/^[0-9a-f]{64}$/u),
      [`${project.devEnvironmentId}/SECOND_VALUE`]: expect.stringMatching(/^[0-9a-f]{64}$/u),
      [`${project.prodEnvironmentId}/ACCEPTANCE_KEY`]: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    // The stored digests are keyed: none is the unsalted SHA-256 of its value, yet an equal value keeps one digest.
    const unsalted = createHash("sha256").update(value).digest("hex");
    expect(storedDigests[`${project.devEnvironmentId}/ACCEPTANCE_KEY`]).not.toBe(unsalted);
    expect(storedDigests[`${project.prodEnvironmentId}/ACCEPTANCE_KEY`]).toBe(
      storedDigests[`${project.devEnvironmentId}/ACCEPTANCE_KEY`],
    );
    expect(Object.values(storedDigests)).not.toContain(
      createHash("sha256").update("second synthetic application value").digest("hex"),
    );
    const stored = await db
      .prepare(
        "SELECT typeof(request_sha256) type,length(request_sha256) size FROM environment_secret_requests WHERE name='ACCEPTANCE_KEY'",
      )
      .all<{ type: string; size: number }>();
    expect(stored.results).toEqual([
      { type: "blob", size: 32 },
      { type: "blob", size: 32 },
    ]);
    const encrypted = await db
      .prepare("SELECT ciphertext FROM environment_secrets WHERE name='ACCEPTANCE_KEY'")
      .all<{ ciphertext: number[] }>();
    expect(encrypted.results).toHaveLength(2);
    for (const row of encrypted.results)
      expect(new TextDecoder().decode(Uint8Array.from(row.ciphertext))).not.toContain(value);
    const deletion = () =>
      api.fetch(`${path(project.devEnvironmentId)}/ACCEPTANCE_KEY`, {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": "secret-rpc-delete" },
      });
    const deleted = await deletion();
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json();
    expect(deletedBody).toMatchObject({
      name: "ACCEPTANCE_KEY",
      status: "deleted",
      desired_generation: 3,
    });
    expect(await (await deletion()).json()).toEqual(deletedBody);
    expect(
      await (await api.fetch(path(project.devEnvironmentId), { headers })).json(),
    ).toMatchObject({ items: [{ name: "SECOND_VALUE" }], desired_generation: 3 });
    expect(
      await (await api.fetch(path(project.prodEnvironmentId), { headers })).json(),
    ).toMatchObject({ items: [{ name: "ACCEPTANCE_KEY" }], desired_generation: 1 });
  } finally {
    await harness.dispose();
  }
}, 120_000);

it("preserves first-created and accepted timestamps when delayed earlier secret writes commit over real Core RPC", async () => {
  const writer = `export default {async fetch(request,env){
    const input=await request.json();
    for(const name of ["ciphertext","nonce","valueSha256","requestSha256"]) if(input[name]) input[name]=new Uint8Array(input[name]);
    try{return Response.json(await env.CONTROL_RUNTIME.mutateApiEnvironmentSecret(input));}
    catch(error){return Response.json({error:error?.message},{status:500});}
  }};`;
  const harness = new Miniflare({
    workers: [
      {
        name: "core",
        modules: true,
        script: await bundle(CONTROL),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { CONTROL_CORE: "core" },
      },
      {
        name: "writer",
        modules: true,
        script: writer,
        compatibilityDate: "2026-08-06",
        serviceBindings: { CONTROL_RUNTIME: { name: "core", entrypoint: "ControlRuntime" } },
      },
    ],
  });
  try {
    const db = (await harness.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const project = await seedProject(control);
    // Public creation's absent initial state is reproduced without changing any existing audit timestamp.
    await db
      .prepare(
        "DELETE FROM runtime_secret_delivery_states WHERE organization_id=? AND project_id=?",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    const scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.prodEnvironmentId,
    };
    const rpc = await harness.getWorker("writer");
    const mutate = (input: unknown) =>
      rpc.fetch("https://writer.internal/", { method: "POST", body: JSON.stringify(input) });
    const put = (name: string, at: string, fill: number, key: string) => ({
      ...scope,
      action: "set",
      name,
      ciphertext: Array.from(bytes(32, fill)),
      nonce: Array.from(bytes(12, fill)),
      valueSha256: Array.from(bytes(32, fill)),
      keyVersion: 1,
      writtenAt: at,
      requestedAt: at,
      idempotencyKey: key,
      requestSha256: Array.from(bytes(32, fill)),
    });
    const newer = put("FIRST_NEWER", "2026-10-28T10:31:00.000Z", 1, "newer");
    const older = put("SECOND_OLDER", "2026-10-28T10:30:00.000Z", 2, "older");
    const sameName = put("FIRST_NEWER", "2026-10-28T10:29:00.000Z", 3, "same-name");
    for (const input of [newer, older, sameName]) {
      const response = await mutate(input);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        response: {
          status: "stored",
          secret: { name: input.name, revision: input === sameName ? 2 : 1 },
        },
      });
    }
    const state = () =>
      db
        .prepare(
          "SELECT desired_generation,created_at,updated_at FROM runtime_secret_delivery_states WHERE organization_id=? AND environment_id=?",
        )
        .bind(scope.organizationId, scope.environmentId)
        .first();
    expect(await state()).toEqual({
      desired_generation: 3,
      created_at: "2026-10-28T10:31:00.000000Z",
      updated_at: "2026-10-28T10:31:00.000000Z",
    });
    expect(
      await db
        .prepare(
          "SELECT revision,created_at,updated_at,lower(hex(value_sha256)) digest FROM environment_secrets WHERE organization_id=? AND environment_id=? AND name='FIRST_NEWER'",
        )
        .bind(scope.organizationId, scope.environmentId)
        .first(),
    ).toEqual({
      revision: 2,
      created_at: "2026-10-28T10:31:00.000000Z",
      updated_at: "2026-10-28T10:29:00.000000Z",
      digest: "03".repeat(32),
    });
    const removed = await mutate({
      ...scope,
      action: "delete",
      name: "SECOND_OLDER",
      idempotencyKey: "remove-older",
      requestedAt: "2026-10-28T10:28:00.000Z",
      requestSha256: Array.from(bytes(32, 4)),
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({
      response: { status: "deleted" },
      delivery: { desiredGeneration: 4 },
    });
    expect(await state()).toEqual({
      desired_generation: 4,
      created_at: "2026-10-28T10:31:00.000000Z",
      updated_at: "2026-10-28T10:31:00.000000Z",
    });
    const replay = await mutate(sameName);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      response: { secret: { revision: 2 } },
      delivery: { desiredGeneration: 4 },
    });
    const audit = await db
      .prepare(
        "SELECT idempotency_key,requested_at FROM environment_secret_requests WHERE organization_id=? AND environment_id=?",
      )
      .bind(scope.organizationId, scope.environmentId)
      .all<{ idempotency_key: string; requested_at: string }>();
    expect(
      Object.fromEntries(audit.results.map((row) => [row.idempotency_key, row.requested_at])),
    ).toEqual({
      newer: "2026-10-28T10:31:00.000000Z",
      older: "2026-10-28T10:30:00.000000Z",
      "same-name": "2026-10-28T10:29:00.000000Z",
      "remove-older": "2026-10-28T10:28:00.000000Z",
    });
  } finally {
    await harness.dispose();
  }
}, 120_000);
