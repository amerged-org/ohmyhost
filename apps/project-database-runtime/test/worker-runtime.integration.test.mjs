import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("carries fixed customer scope through real Worker RPC and persists encrypted registration in a Durable Object", async () => {
  const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const prodId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const dataId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
  const physical = {
    organizationId,
    projectId,
    physicalEnvironmentId: dataId,
    region: "us",
  };
  const scope = { ...physical, environmentId, registrationVersion: 1 };
  const registration = {
    ...physical,
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    registrationVersion: 1,
    providerProjectId: "test-project",
    branchId: "br-test",
    originHost: "ep-test-pooler.us-east-1.aws.neon.tech",
    originDatabase: "neondb",
    originUser: `ohmyho_rw_${dataId.toLowerCase()}`,
    authorizedEnvironmentIds: [environmentId, prodId],
    pooledConnectionString: `postgresql://ohmyho_rw_${dataId.toLowerCase()}:private-password@ep-test-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require`,
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "test-client",
          compatibilityDate: "2026-08-24",
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./runtime-client.mjs", import.meta.url)),
              contents: `
        export default { async fetch(request, env) {
          const { operation, input } = await request.json();
          try {
            if (operation === 'register') return Response.json(await env.ADMIN.register(input));
            if (operation === 'inspect') return Response.json(await env.ADMIN.inspect(input));
            if (operation === 'revoke') return Response.json(await env.ADMIN.revoke(input));
            if (operation === 'forged') return Response.json(await env.FOREIGN.query(input));
            if (operation === 'prod') return Response.json(await env.PROD.query(input));
            if (operation === 'dev-current') return Response.json(await env.DEV_CURRENT.query(input));
            if (operation === 'customer-register') return Response.json(await env.DB.register(input));
            return Response.json(await env.DB.query(input));
          } catch (error) { return Response.json({ error: error.message }, { status: 403 }); }
        }};
      `,
            },
          ],
          serviceBindings: {
            ADMIN: { name: "database-runtime", entrypoint: "ProjectDatabaseAdmin" },
            DB: { name: "database-runtime", entrypoint: "ProjectDatabaseService", props: scope },
            PROD: {
              name: "database-runtime",
              entrypoint: "ProjectDatabaseService",
              props: { ...scope, environmentId: prodId },
            },
            DEV_CURRENT: {
              name: "database-runtime",
              entrypoint: "ProjectDatabaseService",
              props: { ...scope, registrationVersion: 3 },
            },
            FOREIGN: {
              name: "database-runtime",
              entrypoint: "ProjectDatabaseService",
              props: { ...scope, projectId: organizationId },
            },
          },
        },
        {
          name: "database-runtime",
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          modules: [
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./runtime-local.mjs", import.meta.url)),
              contents: `
        import { ProjectDatabaseAdmin as Admin, ProjectDatabaseService as Service } from './database-runtime.mjs';
        export { ProjectDatabaseEnvironment } from './database-runtime.mjs';
        // Workerd explicitly lacks jurisdiction placement; this local provider adapter preserves
        // every real RPC/storage path while checking the requested jurisdiction without placing it.
        function local(env) { return { ...env, DATABASE_ENVIRONMENTS: {
          jurisdiction(region) { if (region !== 'us') throw new Error('Unexpected jurisdiction'); return env.DATABASE_ENVIRONMENTS; }
        }}; }
        export class ProjectDatabaseAdmin extends Admin { constructor(ctx, env) { super(ctx, local(env)); } }
        export class ProjectDatabaseService extends Service { constructor(ctx, env) { super(ctx, local(env)); } }
        export default { fetch() { return new Response(null, {status:404}); } };
      `,
            },
            {
              type: "ESModule",
              path: fileURLToPath(new URL("./database-runtime.mjs", import.meta.url)),
              contents: readFileSync(
                new URL("../dist/worker-bundle/worker-main.js", import.meta.url),
                "utf8",
              ),
            },
          ],
          durableObjects: {
            DATABASE_ENVIRONMENTS: { className: "ProjectDatabaseEnvironment", useSQLite: true },
          },
          bindings: {
            DATABASE_REGION: "us",
            DATABASE_REGISTRY_KEY: Buffer.from("k".repeat(32)).toString("base64"),
          },
        },
      ],
    }),
  );
  /** @param {string} operation @param {unknown} input */
  const call = async (operation, input) => {
    const response = await mf.dispatchFetch("https://test.invalid/", {
      method: "POST",
      body: JSON.stringify({ operation, input }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    expect(await call("inspect", physical)).toEqual({ status: 200, body: null });
    expect((await call("query", { text: "SELECT 1", values: [] })).status).toBe(403);
    const registered = await call("register", registration);
    expect(registered).toMatchObject({
      status: 200,
      body: { status: "active", registrationVersion: 1 },
    });
    expect(JSON.stringify(registered)).not.toContain("password");
    expect(await call("register", registration)).toEqual(registered);
    expect(await call("inspect", physical)).toEqual(registered);
    expect((await call("customer-register", registration)).status).toBe(403);
    expect((await call("forged", { text: "SELECT 1", values: [] })).status).toBe(403);
    // A forged scope key is refused before any connection opens, as a non-retryable input limit.
    expect(
      await call("query", { text: "SELECT 1", values: [], projectId: organizationId }),
    ).toEqual({ status: 200, body: { type: "ohmyhost.database-error/v1", sqlstate: "54000" } });
    const invalidStatement = { text: "SELECT 1", values: [], projectId: organizationId };
    expect(
      await call("register", {
        ...registration,
        registrationVersion: 2,
        authorizedEnvironmentIds: [prodId],
      }),
    ).toMatchObject({ status: 200, body: { registrationVersion: 2 } });
    expect((await call("query", invalidStatement)).status).toBe(403);
    // A validation failure proves that the old Prod generation reached the genuine SQL boundary.
    expect(await call("prod", invalidStatement)).toEqual({
      status: 200,
      body: { type: "ohmyhost.database-error/v1", sqlstate: "54000" },
    });
    expect(await call("register", { ...registration, registrationVersion: 3 })).toMatchObject({
      status: 200,
      body: { registrationVersion: 3 },
    });
    expect((await call("query", invalidStatement)).status).toBe(403);
    expect(await call("dev-current", invalidStatement)).toEqual({
      status: 200,
      body: { type: "ohmyhost.database-error/v1", sqlstate: "54000" },
    });
    expect(
      (await call("register", { ...registration, registrationVersion: 4, branchId: "br-foreign" }))
        .status,
    ).toBe(403);
    expect(
      await call("revoke", {
        ...physical,
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        registrationVersion: 4,
      }),
    ).toMatchObject({ status: 200, body: { status: "revoked", registrationVersion: 4 } });
    expect((await call("query", { text: "SELECT 1", values: [] })).status).toBe(403);
    expect((await call("prod", { text: "SELECT 1", values: [] })).status).toBe(403);
  } finally {
    await mf.dispose();
  }
});

it("reuses PostgreSQL TCP sockets across real Durable Object calls and carries interactive transaction RPC targets", async () => {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");
  const { startTestPostgres } = await import("../../control-api/test/postgres.js");
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-database-worker-proof-"));
  const db = await startTestPostgres();
  let mf;
  try {
    await promisify(execFile)(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "test/fixtures/socket-worker.ts",
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
    if (typeof connectionString !== "string") throw new Error("Local PostgreSQL URL missing");
    const uri = new URL(connectionString);
    uri.password = "local-test-password";
    uri.searchParams.set("sslmode", "require");
    mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "socket-proof",
        cf: false,
        compatibilityDate: "2026-08-24",
        compatibilityFlags: ["nodejs_compat"],
        modules: [
          {
            type: "ESModule",
            path: fileURLToPath(new URL("./socket-proof.mjs", import.meta.url)),
            contents: readFileSync(join(directory, "socket-worker.js"), "utf8"),
          },
        ],
        durableObjects: {
          DATABASE_ENVIRONMENTS: { className: "ProjectDatabaseEnvironment", useSQLite: true },
          SCOPE_ENVIRONMENTS: { className: "ScopedDatabaseEnvironment", useSQLite: true },
        },
        bindings: { TEST_DATABASE_URI: uri.href },
      }),
    );
    const firstResponse = await mf.dispatchFetch("https://test.invalid/query");
    const first = await firstResponse.json();
    expect(firstResponse.status, JSON.stringify(first)).toBe(200);
    const secondResponse = await mf.dispatchFetch("https://test.invalid/query");
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual(first);
    const transaction = await mf.dispatchFetch("https://test.invalid/transaction");
    const result = await transaction.json();
    expect(transaction.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ rows: [{ answer: 42 }] });
    const transition = await mf.dispatchFetch("https://test.invalid/data-transition");
    expect(await transition.json()).toMatchObject({
      devDenied: true,
      staleDevDenied: true,
      prodRows: [{ answer: 42 }],
      devRows: [{ answer: 43 }],
    });
    expect(transition.status).toBe(200);
    expect((await mf.dispatchFetch("https://test.invalid/close")).status).toBe(204);
  } finally {
    await mf?.dispose();
    await db.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
