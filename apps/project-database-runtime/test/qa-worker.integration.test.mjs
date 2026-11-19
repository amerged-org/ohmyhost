import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";
import { startTestPostgres } from "../../control-api/test/postgres.js";

it("executes the actual QA entrypoint through workerd and a PostgreSQL socket with assignment and commit fences", async () => {
  /** @param {number} n */
  const id = (n) => String(n).padStart(26, "0");
  const fixtures = [
    "react-vite",
    "vanilla-vite",
    "tanstack-start",
    "next-edge",
    "astro-edge",
    "next-native-auth",
    "next-app-mail",
  ];
  const manifest = {
    platform: "development",
    projects: fixtures.map((fixture, index) => ({
      fixture,
      organizationId: id(1),
      projectId: id(10 + index),
      environmentId: id(20 + index),
      physicalEnvironmentId: id(30 + index),
      registrationVersion: 1,
      region: "eu",
      handle: `qa-${index}`,
      origin: `https://dev-qa-${index}.dev.check.omh.st`,
      principalId: "qa-operator",
      devAccessEpoch: 1,
    })),
  };
  const scope = manifest.projects[0];
  if (!scope) throw new Error("fixture_missing");
  const registration = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    physicalEnvironmentId: scope.physicalEnvironmentId,
    region: "eu",
    operationId: id(50),
    registrationVersion: 1,
    provider: "pgcf",
    providerProjectId: "p1234567890123456789",
    databaseId: "d1234567890123456789",
    originHost: "database.example.com",
    originDatabase: "d1234567890123456789",
    originUser: `ohmyho_rw_${scope.physicalEnvironmentId.toLowerCase()}`,
    authorizedEnvironmentIds: [scope.environmentId],
    connectionString: `postgres://ohmyho_rw_${scope.physicalEnvironmentId.toLowerCase()}:fixture-password@database.example.com/d1234567890123456789`,
  };
  const { connectionString: _private, ...metadata } = registration;
  void _private;
  const receipt = { ...metadata, status: "active" };
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-qa-socket-"));
  const db = await startTestPostgres();
  /** @type {Miniflare | undefined} */
  let runtime;
  try {
    await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "test/fixtures/qa-socket-worker.ts",
        "--dry-run",
        "--outdir",
        directory,
        "--config",
        "wrangler.jsonc",
        "--env-file",
        "/dev/null",
      ],
      { cwd: fileURLToPath(new URL("../", import.meta.url)) },
    );
    const connectionString = db.pool.options.connectionString;
    if (typeof connectionString !== "string") throw new Error("local_database_missing");
    const uri = new URL(connectionString);
    uri.password = "fixture-password";
    uri.searchParams.set("sslmode", "require");
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        cf: false,
        workers: [
          {
            name: "caller",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: "caller.mjs",
                contents: `
            export default { async fetch(request, env) {
              const { method, value } = await request.json();
              try {
                if (method === 'prepare' || method === 'close') return env.SETUP.fetch('https://setup/' + method, { method:'POST', body:JSON.stringify(value) });
                if (method === 'mode') return env.CORE.fetch('https://core/mode', { method:'POST', body:JSON.stringify(value) });
                return Response.json(await env.QA.execute(value));
              } catch { return Response.json({error:'unavailable'}, {status:403}); }
            } };`,
              },
            ],
            serviceBindings: {
              QA: { name: "db", entrypoint: "ProjectDatabaseQa" },
              SETUP: "db",
              CORE: "core",
            },
          },
          {
            name: "db",
            compatibilityDate: "2026-08-24",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              {
                type: "ESModule",
                path: "qa-socket-worker.js",
                contents: readFileSync(join(directory, "qa-socket-worker.js"), "utf8"),
              },
            ],
            durableObjects: {
              DATABASE_ENVIRONMENTS: { className: "QaEnvironment", useSQLite: true },
            },
            bindings: {
              DATABASE_REGION: "eu",
              DATABASE_REGISTRY_KEY: Buffer.from("k".repeat(32)).toString("base64"),
              QA_DATABASE_PLATFORM: "development",
              QA_DATABASE_MANIFEST: JSON.stringify(manifest),
              TEST_DATABASE_URI: uri.href,
            },
            serviceBindings: {
              QA_DATABASE_AUTHORITY: { name: "core", entrypoint: "Authority" },
              QA_DEV_ACCESS: { name: "core", entrypoint: "DevAccess" },
              QA_CREDIT: { name: "core", entrypoint: "Credit" },
            },
          },
          {
            name: "core",
            compatibilityDate: "2026-08-24",
            modules: [
              {
                type: "ESModule",
                path: "core.mjs",
                contents: `
            import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
            const expected = ${JSON.stringify(scope)};
            const receipt = ${JSON.stringify(receipt)};
            export class State extends DurableObject {
              async set(mode) { await this.ctx.storage.put('mode', mode); await this.ctx.storage.put('count', 0); }
              async next() {
                const count = (await this.ctx.storage.get('count') ?? 0) + 1;
                await this.ctx.storage.put('count', count);
                const mode = await this.ctx.storage.get('mode');
                return (mode === 'before-commit' && count >= 3) || (mode === 'after-commit' && count >= 4);
              }
            }
            export class Authority extends WorkerEntrypoint {
              async readApiProjectDataChangeState(input) {
                const changed = await this.env.STATES.getByName('qa').next();
                if (input.organizationId !== expected.organizationId || input.projectId !== expected.projectId || input.principalId !== expected.principalId) return null;
                return { assignments: { dataMode:'isolated', dev: {environment:'dev', environmentId:expected.environmentId, dataEnvironmentId:changed ? ${JSON.stringify(id(99))} : expected.physicalEnvironmentId }, prod: {environment:'prod', environmentId:${JSON.stringify(id(40))}, dataEnvironmentId:${JSON.stringify(id(41))}} }, registrationGenerations:[{dataEnvironmentId:expected.physicalEnvironmentId, registrationVersion:1}] };
              }
              readRuntimeBinding(input) { return input.organizationId === expected.organizationId && input.projectId === expected.projectId && input.environmentId === expected.environmentId ? receipt : null; }
            }
            export class DevAccess extends WorkerEntrypoint { authorizeDevAccessSession(input) { return input.projectId === expected.projectId && input.environmentId === expected.environmentId && input.handle === expected.handle && input.origin === expected.origin && input.principalId === expected.principalId && input.devAccessEpoch === expected.devAccessEpoch; } }
            export class Credit extends WorkerEntrypoint { read(input) { return {organizationId:input.organizationId, projectId:input.projectId, environmentId:input.environmentId, allowed:true, paidAllowed:true, reason:null, checkedAt:input.now, expiresAt:new Date(Date.now()+60000).toISOString()}; } }
            export default { async fetch(request, env) { await env.STATES.getByName('qa').set(await request.json()); return new Response(null,{status:204}); } };`,
              },
            ],
            durableObjects: { STATES: { className: "State", useSQLite: true } },
          },
        ],
      }),
    );
    const server = runtime;
    /** @param {string} method @param {unknown} value */
    const send = async (method, value) => {
      const response = await server.dispatchFetch("https://caller/", {
        method: "POST",
        body: JSON.stringify({ method, value }),
      });
      return {
        status: response.status,
        body: response.status === 204 ? null : await response.json(),
      };
    };
    /** @param {string} text @param {typeof scope} actualScope */
    const execute = (text, actualScope = scope) =>
      send("execute", {
        platform: "development",
        scope: actualScope,
        operation: "query",
        input: { text, values: [] },
      });
    expect((await send("prepare", registration)).status).toBe(200);
    expect((await send("mode", "normal")).status).toBe(204);
    expect((await execute("CREATE TEMP TABLE preview_qa_notes(id integer)")).status).toBe(200);
    expect((await execute("INSERT INTO preview_qa_notes VALUES (1)")).status).toBe(200);
    expect(
      (
        await execute("INSERT INTO preview_qa_notes VALUES (9)", {
          ...scope,
          organizationId: id(99),
        })
      ).status,
    ).toBe(403);
    expect((await send("mode", "before-commit")).status).toBe(204);
    expect((await execute("INSERT INTO preview_qa_notes VALUES (2)")).status).toBe(403);
    expect((await send("mode", "normal")).status).toBe(204);
    expect(await execute("SELECT id FROM preview_qa_notes ORDER BY id")).toMatchObject({
      body: { rows: [{ id: 1 }] },
    });
    expect((await send("mode", "after-commit")).status).toBe(204);
    expect((await execute("INSERT INTO preview_qa_notes VALUES (3)")).status).toBe(403);
    expect((await send("mode", "normal")).status).toBe(204);
    expect(await execute("SELECT id FROM preview_qa_notes ORDER BY id")).toMatchObject({
      body: { rows: [{ id: 1 }, { id: 3 }] },
    });
    expect(
      await send("execute", {
        platform: "development",
        scope,
        operation: "transaction",
        input: [
          { text: "INSERT INTO preview_qa_notes VALUES (4)", values: [] },
          { text: "SELECT count(*) AS count FROM preview_qa_notes", values: [] },
        ],
      }),
    ).toMatchObject({ status: 200, body: [{ command: "INSERT" }, { rows: [{ count: "3" }] }] });
    expect((await send("close", registration)).status).toBe(204);
  } finally {
    await runtime?.dispose();
    await db.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
