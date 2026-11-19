import { recoveryCaptureHeldGuard } from "../../control-store/src/catalog/recovery/fence.js";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { createRecoveryInputCipher, parseRecoveryCommand } from "@ohmyhost/platform";
import { createRecoveryControlClient } from "../../project-recovery-worker/src/control-client.js";
import { createRecoveryRuntime } from "../../project-recovery-worker/src/recovery-runtime.js";
import { startTestPostgres, type TestPostgres } from "./postgres.js";
import { ZipReader, Uint8ArrayReader, TextWriter } from "@zip.js/zip.js";
import { build } from "esbuild";
import { parseUlid } from "@ohmyhost/platform";
import { createRequire, builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { applyWorkosSnapshot } from "../../control-store/src/catalog/identity/membership-state.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { activateTestCore, migrate } from "../../control-store/test/support/control-d1.js";
import { digest } from "../../control-store/test/support/seed.js";

const hostState = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env = hostState.env;
  },
}));

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("Fixture value is missing");
  return value;
};

interface Harness {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<unknown>;
  dispose(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve("../../control-store/package.json"))(
  "miniflare",
) as { Miniflare: new (options: unknown) => Harness };
const root = fileURLToPath(new URL("..", import.meta.url));
const CONTROL = `export { ControlRuntime, MaintenanceRuntime, RecoveryRuntime } from "../control-store/src/worker-main.ts"; export default {fetch(){return new Response("private")}};`;
const CONSUMER = `
import {createControlApiWorkerEntrypoint} from "./src/worker-main.ts";
const forbidden=()=>{throw new Error("FETCHER_WAS_CALLED")};
const worker=createControlApiWorkerEntrypoint({fetcher:forbidden});
export default {async fetch(request,env,ctx){
  const mode=request.headers.get("x-fixture-mode");
  const bindings={...env,CONTROL_API_PUBLIC_ORIGIN:"https://dev.app.ohmyho.st",CONTROL_API_RATE_LIMITER:{limit:async()=>({success:true})},OPERATION_PUBLISHER:{wake:async()=>{}},WORKOS_JWKS_URL:"https://fixture.authkit.app/jwks",WORKOS_ISSUER:"https://api.workos.com/user_management/client_fixture",WORKOS_CLIENT_ID:"client_fixture",WORKOS_AUDIENCE:"control-api"};
  if(request.headers.get("x-fixture-recovery")==="1") { bindings.RECOVERY_R2_ACCOUNT_ID="00000000000000000000000000000001"; bindings.RECOVERY_INPUT_KEY_BASE64="Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=";bindings.RECOVERY_SERVICE=env.RECOVERY_PROVIDER; }
  if(new URL(request.url).pathname==="/fixture/scheduled")return Response.json(await worker.scheduled({cron:"* * * * *",scheduledTime:Date.now()},bindings,ctx));
  if(mode==="missing")delete bindings.CONTROL_RUNTIME;
  return worker.fetch(request,bindings,ctx);
}};
`;
const AUTH = `export default { async fetch(request){const {value}=await request.json();return Response.json({key:value==="sk_aaaaaaaaaaaaaaaaaaaaaaaa"?{id:"api_key_fixture",userId:"user_rpcproject",organizationId:"org_rpcproject",permissions:["projects:create","projects:read","projects:write","operations:read"],expiresAt:null}:null},{headers:{"cache-control":"no-store"}})}};`;
async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: root, sourcefile: "fixture.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    plugins: [
      {
        name: "node-builtins",
        setup(build) {
          build.onResolve({ filter: /^[^.:/][^:]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
    banner: {
      js: 'import {createRequire as __fixtureRequire} from "node:module"; const require=__fixtureRequire("file:///fixture.mjs");',
    },
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
  });
  return required(result.outputFiles[0]).text;
}
let nodeInvoke: ((value: unknown) => Promise<unknown>) | undefined;
let bridge: { fetch(url: string, init?: RequestInit): Promise<Response> };
let source: TestPostgres | undefined;
let archiveDirectory: string | undefined;
let harness: Harness,
  db: D1Database,
  api: { fetch(url: string, init?: RequestInit): Promise<Response> },
  organizationId: string;
beforeAll(async () => {
  harness = new Miniflare({
    workers: [
      {
        name: "control",
        modules: true,
        script: await bundle(CONTROL),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { CONTROL_CORE: "core" },
      },
      { name: "auth", modules: true, script: AUTH, compatibilityDate: "2026-08-06" },
      {
        name: "recovery-provider",
        modules: true,
        compatibilityDate: "2026-08-06",
        script: `import {WorkerEntrypoint} from "cloudflare:workers";export class Executor extends WorkerEntrypoint {async invokeRecovery(input){return (await this.env.NODE.fetch("http://node/invoke",{method:"POST",body:JSON.stringify(input)})).json();}};export default {fetch(){return new Response("private")}};`,
        serviceBindings: {
          NODE: async (request: Request) => {
            if (nodeInvoke === undefined) throw new Error("Node executor not ready");
            return Response.json(await nodeInvoke(await request.json()));
          },
        },
      },
      {
        name: "recovery-bridge",
        modules: true,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        script:
          await bundle(`import {createRecoveryControlHandler} from "../recovery-container/src/control-mediator.ts";
        const handler=createRecoveryControlHandler({dependencies:env=>({store:env.STORE})});
        export default {fetch(request,env){const params=JSON.parse(request.headers.get("x-fixture-outbound-context"));return handler(request,env,{containerId:"fixture",className:"RecoverySandbox",params});}};`),
        serviceBindings: { STORE: { name: "control", entrypoint: "RecoveryRuntime" } },
      },
      {
        name: "api",
        modules: true,
        script: await bundle(CONSUMER),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: {
          CONTROL_RUNTIME: { name: "control", entrypoint: "ControlRuntime" },
          AUTH_STATUS: "auth",
          CONTROL_MAINTENANCE_RUNTIME: { name: "control", entrypoint: "MaintenanceRuntime" },
          RECOVERY_PROVIDER: { name: "recovery-provider", entrypoint: "Executor" },
        },
      },
    ],
  });
  db = (await harness.getD1Database("CONTROL_CORE", "control")) as D1Database;
  await migrate(db, "core");
  await activateTestCore(db);
  organizationId = newUlid();
  await applyWorkosSnapshot(
    { directory: db, router: new SharedCoreRouter(db) },
    {
      organizationId,
      workosOrganizationId: "org_rpcproject",
      state: "active",
      snapshotDigest: digest(810),
      snapshotFetchedAt: "2026-10-28T12:00:00.000Z",
      synchronizedAt: "2026-10-28T12:00:00.000Z",
      triggerEventId: "evt_rpcproject",
      auditEventId: newUlid(),
      memberships: [
        { workosUserId: "user_rpcproject", role: "admin", status: "active", digest: digest(811) },
      ],
    },
  );
  await db
    .prepare(
      "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  api = (await harness.getWorker("api")) as typeof api;
  bridge = (await harness.getWorker("recovery-bridge")) as typeof bridge;
}, 120000);
afterAll(async () => {
  await harness?.dispose();
  await source?.stop();
  if (archiveDirectory !== undefined) await rm(archiveDirectory, { recursive: true, force: true });
});
const headers = {
  authorization: "Bearer sk_aaaaaaaaaaaaaaaaaaaaaaaa",
  "content-type": "application/json",
  "idempotency-key": "worker-project",
};
async function post(
  extra: Record<string, string> = {},
  body: unknown = {
    organization_id: organizationId,
    name: "RPC project",
    source: { provider: "managed", template: "empty" },
  },
) {
  return api.fetch("https://dev.app.ohmyho.st/v1/projects", {
    method: "POST",
    headers: { ...headers, ...extra },
    body: JSON.stringify(body),
  });
}
describe("the actual public project Worker uses the private D1 authority", () => {
  it("accepts and replays through real ControlRuntime RPC, authorizes list/get", async () => {
    const response = await post();
    const body = (await response.json()) as { id: string; project_id: string };
    expect(response.status, JSON.stringify(body)).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/operations/${body.id}`);
    const replay = await post();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(body);
    const changed = await post({}, { organization_id: organizationId, name: "Changed" });
    expect(changed.status).toBe(409);
    const projects = (
      await db
        .prepare("SELECT project_id FROM projects WHERE organization_id=?")
        .bind(organizationId)
        .all<{ project_id: string }>()
    ).results;
    expect(projects).toHaveLength(1);
    const projectId = required(projects[0]).project_id;
    expect(body.project_id).toBe(projectId);
    const page = await api.fetch("https://dev.app.ohmyho.st/v1/projects", { headers });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ items: [{ id: projectId }] });
    const project = await api.fetch(`https://dev.app.ohmyho.st/v1/projects/${projectId}`, {
      headers,
    });
    expect(project.status).toBe(200);
    expect(await project.json()).toMatchObject({ id: projectId });
    expect(
      (await api.fetch("https://dev.app.ohmyho.st/v1/projects/not-a-ulid", { headers })).status,
    ).toBe(400);
    expect(
      (await api.fetch("https://dev.app.ohmyho.st/v1/projects", { method: "HEAD", headers }))
        .status,
    ).toBe(200);
    const refused = await post({ "x-fixture-mode": "missing" });
    expect(refused.status).toBe(503);
    expect((await api.fetch("https://dev.app.ohmyho.st/v1/credits", { headers })).status).toBe(404);
    const foreign = await post(
      { "idempotency-key": "foreign" },
      { organization_id: newUlid(), name: "Foreign" },
    );
    expect(foreign.status).toBe(403);
    const unauthenticated = await post({ authorization: "Bearer sk_bbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(unauthenticated.status).toBe(401);
    // The same production entrypoint in the instrumented Node process, over the same real D1 and actual class.
    // Only WorkerEntrypoint's host base is replaced; the separate workerd calls above prove real RPC invocation semantics.
    hostState.env = { CONTROL_CORE: db };
    const entry = await import("../../control-store/src/worker-main.js");
    const runtime = new (entry.ControlRuntime as unknown as new () => InstanceType<
      typeof entry.ControlRuntime
    >)();
    const { createControlApiWorkerEntrypoint } = await import("../src/worker-main.js");
    const { createD1WorkosOrganizationResolver } = await import("../src/d1-project-application.js");
    const { createD1ControlApiPersistence } = await import("../src/d1-project-persistence.js");
    const authWorker = (await harness.getWorker("auth")) as {
      fetch(url: string, init?: RequestInit): Promise<Response>;
    };
    // Miniflare's Node proxy uses its own Undici Request constructor; carry bytes across that test-only realm boundary.
    const auth = {
      async fetch(request: Request) {
        return authWorker.fetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: await request.text() }),
        });
      },
    };
    const forbidden = vi.fn(() => {
      throw new Error("The fetcher must not be called");
    });
    const host = createControlApiWorkerEntrypoint({ fetcher: forbidden });
    const hostBindings = {
      CONTROL_RUNTIME: runtime,
      AUTH_STATUS: auth,
      CONTROL_API_PUBLIC_ORIGIN: "https://dev.app.ohmyho.st",
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OPERATION_PUBLISHER: { wake: async () => undefined },
      WORKOS_JWKS_URL: "https://fixture.authkit.app/jwks",
      WORKOS_ISSUER: "https://api.workos.com/user_management/client_fixture",
      WORKOS_CLIENT_ID: "client_fixture",
      WORKOS_AUDIENCE: "control-api",
    };
    expect(
      await runtime.resolveWorkosOrganization({ workosOrganizationId: "org_rpcproject" }),
    ).toBe(organizationId);
    const providerReply = await auth.fetch(
      new Request("https://auth-status.internal/api-key-validate", {
        method: "POST",
        body: JSON.stringify({ value: "sk_aaaaaaaaaaaaaaaaaaaaaaaa" }),
      }),
    );
    expect(providerReply.status).toBe(200);
    expect(await providerReply.json()).toMatchObject({ key: { organizationId: "org_rpcproject" } });
    const hostReply = await host.fetch(
      new Request("https://dev.app.ohmyho.st/v1/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ organization_id: organizationId, name: "Host project" }),
      }),
      hostBindings,
      { waitUntil: () => undefined },
    );
    // Reusing the existing HTTP identity with changed content reaches the exact typed conflict across the actual class.
    expect(hostReply.status).toBe(409);
    expect(
      (
        await host.fetch(
          new Request("https://dev.app.ohmyho.st/v1/projects", { headers }),
          hostBindings,
          { waitUntil: () => undefined },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await host.fetch(
          new Request(`https://dev.app.ohmyho.st/v1/projects/${projectId}`, { headers }),
          hostBindings,
          { waitUntil: () => undefined },
        )
      ).status,
    ).toBe(200);
    expect(
      await host.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, hostBindings),
    ).toEqual({ ok: false, error: "unavailable" });
    expect(forbidden).not.toHaveBeenCalled();
    const resolver = createD1WorkosOrganizationResolver(runtime);
    expect(await resolver.resolve("org_rpcproject")).toBe(organizationId);
    expect(await resolver.resolve("org_absent")).toBeNull();
    const machine = {
      connectClientId: "client_machine",
      workosOrganizationId: "org_rpcproject",
      observedAt: "2026-12-01T00:00:00.000Z",
    };
    expect(await resolver.resolveM2m(machine)).toBeNull();
    await db
      .prepare(
        "INSERT INTO m2m_organization_bindings(organization_id,connect_client_id,scopes,state,mapping_revision,created_at) VALUES(?,?,'[\"projects:read\"]','active',1,'2026-10-28T12:00:00.000000Z')",
      )
      .bind(organizationId, machine.connectClientId)
      .run();
    expect(await resolver.resolveM2m(machine)).toEqual({
      organizationId,
      scopes: ["projects:read"],
    });
    const handle = required(
      await db
        .prepare("SELECT handle FROM projects WHERE project_id=?")
        .bind(projectId)
        .first<{ handle: string }>(),
    ).handle;
    expect(await runtime.readTakenProjectHandles({ candidates: [handle] })).toEqual([handle]);
    expect(await runtime.readTakenProjectHandles({ candidates: [] })).toEqual([]);
    expect(await runtime.getCustomerProject({ organizationId, projectId: newUlid() })).toBeNull();
    const persistence = createD1ControlApiPersistence({
      platform: "development",
      runtime,
      clock: { now: () => new Date() },
      ids: {
        next: () => {
          throw new Error("read needs no new identity");
        },
      },
    });
    await expect(
      persistence.getOperation(parseUlid(organizationId), parseUlid(projectId)),
    ).resolves.toBeNull();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("creates, dispatches, captures and downloads an isolated export through the actual HTTP Worker, D1 RPC and scoped Node port", async () => {
    const recoveryHeaders = {
      ...headers,
      "x-fixture-recovery": "1",
      "idempotency-key": "recovery-worker-project",
    };
    const projectResponse = await post(
      { "idempotency-key": "recovery-worker-project" },
      { organization_id: organizationId, name: "Recovery RPC project", data_mode: "isolated" },
    );
    expect(projectResponse.status).toBe(202);
    const project = required(
      await db
        .prepare(
          "SELECT project_id FROM projects WHERE organization_id=? AND name='Recovery RPC project'",
        )
        .bind(organizationId)
        .first<{ project_id: string }>(),
    );
    const environments = (
      await db
        .prepare(
          "SELECT environment_id,name FROM environments WHERE organization_id=? AND project_id=? ORDER BY name",
        )
        .bind(organizationId, project.project_id)
        .all<{ environment_id: string; name: string }>()
    ).results;
    expect(environments.map((e) => e.name)).toEqual(["dev", "prod"]);
    source = await startTestPostgres();
    const base = source.pool.options.connectionString;
    if (typeof base !== "string") throw new Error("Local SQL source unavailable");
    const connections = new Map<string, string>();
    for (const [index, environment] of environments.entries()) {
      const databaseId = `d${"b".repeat(15)}${String(index).padStart(4, "0")}`;
      const name = `recovery_rpc_${environment.name}`;
      await source.pool.query(`CREATE DATABASE ${name}`);
      const backupRole = `ohmyho_backup_${environment.environment_id.toLowerCase()}`;
      await source.pool.query(
        `CREATE ROLE ${backupRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`,
      );
      const url = new URL(base);
      url.pathname = `/${name}`;
      const sql = new Client({ connectionString: url.toString() });
      await sql.connect();
      try {
        await sql.query(
          `CREATE TABLE documents(id integer PRIMARY KEY,body text);INSERT INTO documents VALUES(1,'rpc-${environment.name}');ALTER TABLE documents ENABLE ROW LEVEL SECURITY;ALTER TABLE documents FORCE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA public TO ${backupRole};GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backupRole}`,
        );
      } finally {
        await sql.end();
      }
      url.username = backupRole;
      connections.set(databaseId, url.toString());
      await db.batch([
        db
          .prepare(
            "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','r512-s1g',?6,'sealed:test',NULL,'2026-10-28T12:00:00.000000Z')",
          )
          .bind(
            organizationId,
            project.project_id,
            environment.environment_id,
            `prj_${"a".repeat(20)}`,
            databaseId,
            `ohmyho_rw_${environment.environment_id.toLowerCase()}`,
          ),
        db
          .prepare(
            "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active',NULL,'2026-10-28T12:00:00.000000Z')",
          )
          .bind(organizationId, project.project_id, environment.environment_id),
      ]);
    }
    const directory = await mkdtemp(join(tmpdir(), "omh-d1-export-rpc-"));
    archiveDirectory = directory;
    const objectPath = (key: string) =>
      join(directory, createHash("sha256").update(key).digest("hex"));
    let captures = 0,
      writes = 0;
    nodeInvoke = async (raw) => {
      const command = parseRecoveryCommand(raw),
        token = randomBytes(32).toString("base64url");
      if (command.action === "restore" || command.action === "reconcile-restore-pin")
        throw new Error("Unexpected restore in export fixture");
      const grant = {
        containerId: "fixture",
        action: command.action,
        organizationId: command.organizationId,
        projectId: command.projectId,
        operationId: command.operationId,
        ...(command.action === "run" ? { claimId: command.claimId } : {}),
        ...(command.action === "purge" ? { exportId: command.exportId } : {}),
        tokenSha256: createHash("sha256").update(token).digest("hex"),
        expiresAtMs: Date.now() + 14 * 60_000,
      };
      const control = createRecoveryControlClient({
        token,
        fetch: async (url, init) => {
          const outgoing = new Headers(init?.headers);
          outgoing.set("x-fixture-outbound-context", JSON.stringify(grant));
          return bridge.fetch(String(url), { ...init, headers: Object.fromEntries(outgoing) });
        },
      });
      return createRecoveryRuntime({
        control,
        cipher: createRecoveryInputCipher({
          key: new Uint8Array(32).fill(31),
          keyVersion: 1,
          crypto: globalThis.crypto,
        }),
        clock: { now: () => new Date() },
        database: {
          async read(reference, signal) {
            signal.throwIfAborted();
            captures++;
            if (
              reference.provider !== "pgcf" ||
              !("databaseEnvironmentId" in reference) ||
              reference.roleName !==
                `ohmyho_backup_${reference.databaseEnvironmentId.toLowerCase()}`
            )
              throw new Error("Wrong private backup reference");
            const connection = connections.get(reference.databaseId);
            if (connection === undefined) throw new Error("Unknown local SQL target");
            return connection;
          },
        },
        archives: {
          async put(input) {
            await copyFile(input.path, objectPath(input.key));
            writes++;
          },
          async verify(input) {
            const value = await readFile(objectPath(input.key));
            return value.length === input.archive.bytes &&
              createHash("sha256").update(value).digest("hex") ===
                Buffer.from(input.archive.sha256).toString("hex")
              ? "verified"
              : "different";
          },
        },
        archiveDownloads: {
          async inspectRestorePin() {
            throw new Error("Unexpected restore pin in export fixture");
          },
          async removeRestorePin() {
            throw new Error("Unexpected restore pin in export fixture");
          },
          async remove(input) {
            await rm(objectPath(input.key), { force: true });
          },
          async download(input) {
            expect((await readFile(objectPath(input.key))).length).toBeGreaterThan(0);
            const now = new Date(),
              url = new URL(
                `https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com/${input.bucket}/${input.key}`,
              );
            url.searchParams.set("X-Amz-Date", now.toISOString().replace(/[-:]|\.\d{3}/g, ""));
            url.searchParams.set("X-Amz-Expires", "86400");
            url.searchParams.set("X-Amz-Signature", "a".repeat(64));
            return {
              url: url.toString(),
              expiresAt: new Date(now.getTime() + 86400000).toISOString(),
            };
          },
        },
      })(command);
    };
    const path = `https://dev.app.ohmyho.st/v1/projects/${project.project_id}/exports`;
    const created = await api.fetch(path, {
      method: "POST",
      headers: { ...recoveryHeaders, "idempotency-key": "recovery-http-idempotency" },
      body: JSON.stringify({ password: "test-export-1234" }),
    });
    const accepted = (await created.json()) as { id: string; state: string };
    expect(created.status, JSON.stringify(accepted)).toBe(202);
    expect(accepted.state).toBe("queued");
    const operation = accepted.id;
    const before = await api.fetch(`${path}/${operation}`, { headers: recoveryHeaders });
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ state: "queued", archive: null });
    const changed = await api.fetch(path, {
      method: "POST",
      headers: { ...recoveryHeaders, "idempotency-key": "recovery-http-idempotency" },
      body: JSON.stringify({ password: "other-passphrase" }),
    });
    expect(changed.status).toBe(409);
    const quota = await api.fetch(path, {
      method: "POST",
      headers: { ...recoveryHeaders, "idempotency-key": "recovery-other-request" },
      body: JSON.stringify({ password: "test-export-1234" }),
    });
    expect(quota.status).toBe(429);
    const idempotency = required(
      await db
        .prepare(
          "SELECT lower(hex(canonical_request_sha256)) AS digest FROM api_idempotency_records WHERE organization_id=? AND idempotency_key='recovery-http-idempotency'",
        )
        .bind(organizationId)
        .first<{ digest: string }>(),
    );
    expect(idempotency.digest).toHaveLength(64);
    const scheduled = await api.fetch("https://fixture/fixture/scheduled", {
      headers: recoveryHeaders,
    });
    const pass = await scheduled.json();
    // The Stripe and public-entry capabilities are not bound in this fixture; recovery still dispatches.
    expect(pass).toMatchObject({
      ok: false,
      recovery: { status: "acknowledged", operationId: operation },
      settlement: { webhooks: { status: "unavailable" }, publicEntries: { status: "unavailable" } },
    });
    expect(captures).toBe(2);
    expect(
      writes,
      JSON.stringify(
        await db
          .prepare(
            "SELECT operation.state,job.failure_code FROM operations operation JOIN project_recovery_jobs job ON job.organization_id=operation.organization_id AND job.operation_id=operation.operation_id WHERE operation.operation_id=?",
          )
          .bind(operation)
          .first(),
      ),
    ).toBe(1);
    const after = await api.fetch(`${path}/${operation}`, { headers: recoveryHeaders });
    expect(after.status).toBe(200);
    const publicArchive = await after.json();
    expect(publicArchive).toMatchObject({
      id: operation,
      state: "succeeded",
      archive: { sql_files: ["dev.sql", "prod.sql"] },
    });
    expect(JSON.stringify(publicArchive)).not.toContain("test-export-1234");
    const polling = await api.fetch(`https://dev.app.ohmyho.st/v1/operations/${operation}`, {
      headers: recoveryHeaders,
    });
    expect(polling.status).toBe(200);
    expect(await polling.json()).toMatchObject({ id: operation, state: "succeeded" });
    const replay = await api.fetch(path, {
      method: "POST",
      headers: { ...recoveryHeaders, "idempotency-key": "recovery-http-idempotency" },
      body: JSON.stringify({ password: "test-export-1234" }),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ id: operation, state: "succeeded" });
    expect(writes).toBe(1);
    const job = required(
      await db
        .prepare(
          "SELECT archive_key,input_ciphertext FROM project_recovery_jobs WHERE operation_id=?",
        )
        .bind(operation)
        .first<{ archive_key: string; input_ciphertext: unknown }>(),
    );
    expect(job.input_ciphertext).toBeNull();
    const zip = new ZipReader(
      new Uint8ArrayReader(new Uint8Array(await readFile(objectPath(job.archive_key)))),
    );
    try {
      const entries = await zip.getEntries();
      for (const name of ["dev", "prod"]) {
        const entry = entries.find((e) => e.filename === `${name}.sql`);
        if (entry === undefined || !("getData" in entry) || entry.getData === undefined)
          throw new Error("SQL file missing");
        expect(await entry.getData(new TextWriter(), { password: "test-export-1234" })).toContain(
          `rpc-${name}`,
        );
      }
    } finally {
      await zip.close();
    }
    // The upstream multi-provider deletion writer is intentionally NOT claimed here: this fixture writes only the
    // already accepted/open frozen facts needed to qualify the guarded reader and actual purge wire/R2 operation.
    const deletion = newUlid(),
      cleanup = newUlid(),
      epoch = required(
        await db
          .prepare(
            "SELECT active_billing_epoch_id FROM projects WHERE organization_id=? AND project_id=?",
          )
          .bind(organizationId, project.project_id)
          .first<{ active_billing_epoch_id: string }>(),
      ).active_billing_epoch_id;
    const storedNow = new Date().toISOString().replace(/Z$/u, "000Z");
    const scope = {
      organizationId,
      projectId: project.project_id,
      operationId: deletion,
      exportId: operation,
    };
    await expect(required(nodeInvoke)({ action: "purge", ...scope })).rejects.toMatchObject({
      code: "recovery_cleanup_scope_unavailable",
    });
    const locator = `encoded/${Buffer.from(`ohmyho-development-backups/${job.archive_key}`).toString("base64url")}`;
    await db.batch([
      db
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(organizationId, project.project_id, storedNow),
      db
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'queued',?4,?5,?5)",
        )
        .bind(organizationId, deletion, project.project_id, epoch, storedNow),
      db
        .prepare(
          "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'pending',1,?5,?5)",
        )
        .bind(organizationId, cleanup, project.project_id, deletion, storedNow),
      db
        .prepare(
          "INSERT INTO product_command_intents(organization_id,operation_id,event_type,project_id,environment_id,billing_epoch_id,cleanup_run_id,expected_etag,created_at) VALUES(?1,?2,'ProjectDeletionRequestedV1',?3,?4,?5,?6,?7,?8)",
        )
        .bind(
          organizationId,
          deletion,
          project.project_id,
          required(environments[0]).environment_id,
          epoch,
          cleanup,
          `"${"a".repeat(64)}"`,
          storedNow,
        ),
      db
        .prepare(
          "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'cloudflare','sql-export',?5,?6,?7)",
        )
        .bind(
          organizationId,
          newUlid(),
          project.project_id,
          deletion,
          new Uint8Array(32).fill(19),
          storedNow,
          locator,
        ),
    ]);
    expect(await required(nodeInvoke)({ action: "purge", ...scope })).toEqual({
      status: "absent",
      exportId: operation,
    });
    await expect(readFile(objectPath(job.archive_key))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 120_000);
  it("instruments the same actual classes on real D1, rejects a forged clock and fake executor success, and preserves owner/member export authority", async () => {
    hostState.env = { CONTROL_CORE: db };
    const entry = await import("../../control-store/src/worker-main.js");
    const runtime = new entry.ControlRuntime({}, { CONTROL_CORE: db });
    const maintenance = new entry.MaintenanceRuntime({}, { CONTROL_CORE: db });
    const executor = new entry.RecoveryRuntime({}, { CONTROL_CORE: db });
    const { createControlApiWorkerEntrypoint } = await import("../src/worker-main.js");
    const { recoveryOperationView } = await import("../src/d1-recovery-operation.js");
    const authWorker = (await harness.getWorker("auth")) as {
      fetch(url: string, init?: RequestInit): Promise<Response>;
    };
    const forbidden = vi.fn(() => {
      throw new Error("The fetcher must not be called");
    });
    const worker = createControlApiWorkerEntrypoint({ fetcher: forbidden });
    const bindings = {
      CONTROL_RUNTIME: runtime,
      CONTROL_MAINTENANCE_RUNTIME: maintenance,
      AUTH_STATUS: {
        fetch: async (request: Request) =>
          authWorker.fetch(request.url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            body: await request.text(),
          }),
      },
      CONTROL_API_PUBLIC_ORIGIN: "https://dev.app.ohmyho.st",
      CONTROL_API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      OPERATION_PUBLISHER: { wake: async () => undefined },
      WORKOS_JWKS_URL: "https://fixture.authkit.app/jwks",
      WORKOS_ISSUER: "https://api.workos.com/user_management/client_fixture",
      WORKOS_CLIENT_ID: "client_fixture",
      WORKOS_AUDIENCE: "control-api",
      RECOVERY_INPUT_KEY_BASE64: Buffer.from(new Uint8Array(32).fill(31)).toString("base64"),
      RECOVERY_R2_ACCOUNT_ID: "00000000000000000000000000000001",
      RECOVERY_SERVICE: {
        async invokeRecovery(raw: unknown) {
          return typeof raw === "object" &&
            raw !== null &&
            Reflect.get(raw, "action") === "download"
            ? { status: "unavailable" }
            : { status: "succeeded" };
        },
      },
    };
    const call = (path: string, method = "GET", body?: unknown, key = "host-recovery") =>
      worker.fetch(
        new Request(`https://dev.app.ohmyho.st${path}`, {
          method,
          headers: { ...headers, "idempotency-key": key },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        bindings,
        { waitUntil: () => undefined },
      );
    expect(
      (
        await call(
          "/v1/projects",
          "POST",
          { organization_id: organizationId, name: "Host Recovery" },
          "host-recovery-project",
        )
      ).status,
    ).toBe(202);
    const project = required(
      await db
        .prepare(
          "SELECT project_id,active_billing_epoch_id FROM projects WHERE organization_id=? AND name='Host Recovery'",
        )
        .bind(organizationId)
        .first<{ project_id: string; active_billing_epoch_id: string }>(),
    );
    const environment = required(
      await db
        .prepare(
          "SELECT environment_id FROM environments WHERE organization_id=? AND project_id=? AND name='dev'",
        )
        .bind(organizationId, project.project_id)
        .first<{ environment_id: string }>(),
    );
    expect(
      (
        await call(
          `/v1/projects/${project.project_id}/exports`,
          "POST",
          { password: "test-export-1234" },
          "host-not-ready",
        )
      ).status,
    ).toBe(409);
    await db.batch([
      db
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','r512-s1g',?6,'sealed:test',NULL,'2026-10-28T12:00:00.000000Z')",
        )
        .bind(
          organizationId,
          project.project_id,
          environment.environment_id,
          `prj_${"c".repeat(20)}`,
          `d${"c".repeat(19)}`,
          `ohmyho_rw_${environment.environment_id.toLowerCase()}`,
        ),
      db
        .prepare(
          "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active',NULL,'2026-10-28T12:00:00.000000Z')",
        )
        .bind(organizationId, project.project_id, environment.environment_id),
    ]);
    const path = `/v1/projects/${project.project_id}/exports`;
    const created = await call(path, "POST", { password: "test-export-1234" });
    const accepted = (await created.json()) as { id: string };
    expect(created.status, JSON.stringify(accepted)).toBe(202);
    const scope = { organizationId, projectId: project.project_id, operationId: accepted.id };
    expect((await call(path, "POST", { password: "different-password" })).status).toBe(409);
    expect(
      (await call(path, "POST", { password: "test-export-1234" }, "host-recovery-quota")).status,
    ).toBe(429);
    const pass = await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, bindings);
    expect(pass).toMatchObject({
      ok: false,
      recovery: { status: "retry_scheduled", operationId: accepted.id },
    });
    expect(await executor.readClaimState(scope)).toEqual({ status: "running" });
    const delivery = required(
      await db
        .prepare(
          "SELECT event.event_id,json_extract(audit.payload,'$.attemptId') AS attempt_id FROM outbox_events event JOIN audit_events audit ON audit.organization_id=event.organization_id AND audit.operation_id=event.operation_id AND audit.event_type='OutboxRetryScheduled' WHERE event.organization_id=? AND event.operation_id=?",
        )
        .bind(organizationId, accepted.id)
        .first<{ event_id: string; attempt_id: string }>(),
    );
    expect(
      await runtime.acknowledgeProjectRecoveryOutbox({
        ...scope,
        eventId: delivery.event_id,
        attemptId: delivery.attempt_id,
      }),
    ).toBe(false);
    const job = required(
      await db
        .prepare("SELECT claim_id,input_ciphertext FROM project_recovery_jobs WHERE operation_id=?")
        .bind(accepted.id)
        .first<{ claim_id: string; input_ciphertext: unknown }>(),
    );
    expect(job.input_ciphertext).not.toBeNull();
    const future = "2099-01-01T00:00:00.000Z",
      holder = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const mutation = {
      ...scope,
      claimId: job.claim_id,
      occurredAt: future,
      operationEventId: newUlid(),
      auditEventId: newUlid(),
    };
    const claimed = await executor.claim(mutation);
    expect(claimed.status).toBe("claimed");
    const lease = await executor.acquireFence({
      ...scope,
      claimId: job.claim_id,
      holderId: holder,
      now: future,
      leaseMilliseconds: 300_000,
    });
    expect(Date.parse(lease.leaseExpiresAt)).toBeLessThan(Date.now() + 360_000);
    expect(
      await runtime.readProjectRecoveryCaptureHeld({
        organizationId,
        projectId: project.project_id,
        now: future,
      }),
    ).toEqual({ held: true });
    await expect(
      db.batch([
        db.prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES('recovery-owner-clock-probe','probe','d','{}',1)",
        ),
        recoveryCaptureHeldGuard(db, { organizationId, projectId: project.project_id }, future),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM command_log WHERE command_id='recovery-owner-clock-probe'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (await executor.readScope({ organizationId, projectId: project.project_id }))?.environments,
    ).toHaveLength(2);
    expect(
      await executor.renewFence({
        ...scope,
        holderId: holder,
        epoch: lease.epoch,
        now: future,
        leaseMilliseconds: 300_000,
      }),
    ).toMatchObject({ outcome: "renewed" });
    const archive = {
        sqlFiles: ["shared.sql"],
        bytes: 10,
        sha256: new Uint8Array(32).fill(12),
        capturedAt: new Date().toISOString(),
      },
      fence = { epoch: lease.epoch, holderId: holder };
    await executor.prepareArchive({
      ...mutation,
      operationEventId: newUlid(),
      auditEventId: newUlid(),
      archive,
      fence,
    });
    expect(
      await executor.finish({
        ...mutation,
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        archive,
        fence,
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(await executor.releaseFence({ ...scope, ...fence, now: future })).toMatchObject({
      outcome: "replayed",
    });
    expect(await executor.readArchive({ ...scope, now: future })).toMatchObject({
      operationId: accepted.id,
      bytes: 10,
    });
    expect(await runtime.readProjectRecoveryArchive({ ...scope, now: future })).toMatchObject({
      operationId: accepted.id,
      bytes: 10,
    });
    const status = await call(`${path}/${accepted.id}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      state: "succeeded",
      archive: { download_url: null },
    });
    const operation = await call(`/v1/operations/${accepted.id}`);
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({ state: "succeeded" });
    const replay = await call(path, "POST", { password: "test-export-1234" });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ id: accepted.id, state: "succeeded" });
    await expect(executor.readCleanupTarget({ ...scope, exportId: accepted.id })).rejects.toThrow(
      "recovery_cleanup_scope_unavailable",
    );
    await expect(async () => runtime.readProjectRecoveryCaptureHeld([])).rejects.toThrow(
      "Recovery command is invalid",
    );
    await expect(
      runtime.acceptProjectRecoveryJob({
        ...scope,
        environmentId: environment.environment_id,
        billingEpochId: project.active_billing_epoch_id,
        operationId: newUlid(),
        operationEventId: newUlid(),
        auditEventId: newUlid(),
        outboxEventId: newUlid(),
        principalId: "user:user_rpcproject",
        requestId: "clock-bypass",
        idempotencyKey: "clock-bypass",
        canonicalRequestDigest: "ad".repeat(32),
        occurredAt: future,
        httpMethod: "POST",
        routeTemplate: "/v1/projects/{project_id}/exports",
        archiveBucket: "ohmyho-development-backups",
        sealedInput: { ciphertext: new Uint8Array(17), nonce: new Uint8Array(12), keyVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: "project_recovery_daily_limit" });
    const facts = await runtime.readProjectRecoveryOperation({
      organizationId,
      operationId: accepted.id,
    });
    if (facts.outcome !== "ready") throw new Error("Operation missing");
    expect(() => recoveryOperationView({ ...facts.operation, state: "failed" }, null)).toThrow(
      "inconsistent",
    );
    expect(
      await runtime.authorizeOrganizationAction({
        organizationId,
        principalId: "user:user_rpcproject",
        projectId: project.project_id,
        action: "projects:write",
      }),
    ).toBe("allow");
    const roleStamp = new Date().toISOString();
    await applyWorkosSnapshot(
      { directory: db, router: new SharedCoreRouter(db) },
      {
        organizationId,
        workosOrganizationId: "org_rpcproject",
        state: "active",
        snapshotDigest: digest(912),
        snapshotFetchedAt: roleStamp,
        synchronizedAt: roleStamp,
        triggerEventId: "evt_member_export",
        auditEventId: newUlid(),
        memberships: [
          {
            workosUserId: "user_rpcproject",
            role: "member",
            status: "active",
            digest: digest(913),
          },
        ],
      },
    );
    expect(
      await runtime.authorizeOrganizationAction({
        organizationId,
        principalId: "user:user_rpcproject",
        projectId: project.project_id,
        action: "projects:write",
      }),
    ).toBe("deny");
    expect(
      await runtime.authorizeOrganizationAction({
        organizationId,
        principalId: "user:user_rpcproject",
        projectId: project.project_id,
        action: "operations:read",
      }),
    ).toBe("allow");
    expect(
      (await call(path, "POST", { password: "test-export-1234" }, "member-export-denied")).status,
    ).toBe(404);
    expect((await call(`/v1/operations/${accepted.id}`)).status).toBe(200);
    const restoreStamp = new Date(Date.now() + 1).toISOString();
    await applyWorkosSnapshot(
      { directory: db, router: new SharedCoreRouter(db) },
      {
        organizationId,
        workosOrganizationId: "org_rpcproject",
        state: "active",
        snapshotDigest: digest(914),
        snapshotFetchedAt: restoreStamp,
        synchronizedAt: restoreStamp,
        triggerEventId: "evt_owner_export",
        auditEventId: newUlid(),
        memberships: [
          { workosUserId: "user_rpcproject", role: "admin", status: "active", digest: digest(915) },
        ],
      },
    );
    expect(forbidden).not.toHaveBeenCalled();
  }, 60_000);
});
