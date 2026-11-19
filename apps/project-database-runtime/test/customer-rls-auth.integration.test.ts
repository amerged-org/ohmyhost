import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  executeExpandOnlyMigrations,
  projectSqlRoleName,
  type DatabaseMigrationClient,
} from "@ohmyhost/platform";

vi.mock("cloudflare:workers", () => ({
  // Only the native superclass is substituted; auth, RPC target and PostgreSQL are real.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  RpcTarget: class {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  WorkerEntrypoint: class {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  DurableObject: class {},
}));

import {
  createCustomerAuth,
  createCustomerAuthPostgresPool,
} from "../../../packages/customer-auth-better-auth/src/runtime.js";
import { createPrivateDatabaseClient } from "../../../packages/customer-runtime/src/database.js";
import { prepareProjectRlsHelpers } from "../../neon-management/src/sql-role-bootstrap.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { connectRlsProjectDatabase, createProjectDatabaseService } from "../src/service.js";
import { ProjectDatabaseRlsConnection } from "../src/worker-service.js";
import { pooledClientDependencies } from "../src/connection-pool.js";

it("opts existing populated data into RLS with immutable migrations and verified Better Auth sessions", async () => {
  const db = await startTestPostgres();
  const authPool = createCustomerAuthPostgresPool(db.pool.options.connectionString as string);
  const origin = "https://rls.example.test";
  const environment = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const migration = projectSqlRoleName(environment, "migration");
  const runtime = projectSqlRoleName(environment, "runtime");
  const verificationUrls: string[] = [];
  const password = randomBytes(24).toString("hex");
  const request = (path: string, body?: Record<string, unknown>, cookie?: string) =>
    new Request(`${origin}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "cf-connecting-ip": "192.0.2.47",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let migrationClient: Client | undefined;
  let runtimePool: Pool | undefined;
  try {
    await db.pool.query(
      await readFile(
        new URL(
          "../../../packages/customer-auth-better-auth/migrations/20260822000000_better_auth.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const auth = createCustomerAuth({
      appName: "Customer RLS",
      publicOrigin: origin,
      secret: randomBytes(32).toString("hex"),
      database: authPool,
      email: {
        send: async (message) => {
          verificationUrls.push(message.url);
        },
      },
    });
    const users: { id: string; cookie: string }[] = [];
    for (const name of ["Alice", "Bob"]) {
      const email = `${name.toLowerCase()}@example.test`;
      expect(
        (await auth.handler(request("/sign-up/email", { name, email, password }))).status,
      ).toBe(200);
      const verification = verificationUrls.at(-1);
      if (!verification) throw new Error("Missing local verification link");
      expect((await auth.handler(new Request(verification))).status).toBe(302);
      const response = await auth.handler(request("/sign-in/email", { email, password }));
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const session = (await (
        await auth.handler(request("/get-session", undefined, cookie))
      ).json()) as { user: { id: string } };
      expect(session.user.id).toEqual(expect.any(String));
      users.push({ id: session.user.id, cookie });
    }
    const alice = users[0];
    const bob = users[1];
    if (!alice || !bob) throw new Error("Missing verified local sessions");
    for (const purpose of ["migration", "runtime", "readonly"] as const) {
      await db.pool.query(
        `CREATE ROLE ${projectSqlRoleName(environment, purpose)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
    }
    const base = new URL(db.pool.options.connectionString as string);
    const databaseName = decodeURIComponent(base.pathname.slice(1)).replaceAll('"', '""');
    await db.pool.query(`GRANT CREATE ON DATABASE "${databaseName}" TO ${migration}`);
    await db.pool.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${migration}`);
    const migrationUrl = new URL(base);
    migrationUrl.username = migration;
    migrationClient = new Client({ connectionString: migrationUrl.href });
    await migrationClient.connect();
    await prepareProjectRlsHelpers(migrationClient, environment);
    const immutableMigration = (path: string, sql: string) => {
      const body = new TextEncoder().encode(sql);
      return {
        path,
        body,
        size: body.byteLength,
        digest: `sha256:${createHash("sha256").update(body).digest("hex")}` as const,
      };
    };
    const foundation = immutableMigration(
      "20261009000000_customer_notes.sql",
      "CREATE TABLE public.customer_rls_notes(id text PRIMARY KEY, owner_id text NOT NULL, body text NOT NULL);",
    );
    const activateRls = immutableMigration(
      "20261009000001_customer_notes_rls.sql",
      "CREATE POLICY own_notes ON public.customer_rls_notes TO PUBLIC USING(owner_id=ohmyhost.user_id()) WITH CHECK(owner_id=ohmyhost.user_id()); ALTER TABLE public.customer_rls_notes ENABLE ROW LEVEL SECURITY; ALTER TABLE public.customer_rls_notes FORCE ROW LEVEL SECURITY;",
    );
    const migrationPort = migrationClient as unknown as DatabaseMigrationClient;
    await expect(executeExpandOnlyMigrations(migrationPort, [foundation])).resolves.toMatchObject({
      appliedPaths: [foundation.path],
      replayedPaths: [],
    });
    await migrationClient.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON public.customer_rls_notes TO ${runtime}`,
    );
    await db.pool.query(
      "INSERT INTO public.customer_rls_notes VALUES('a',$1,'Alice private'),('b',$2,'Bob private')",
      [alice.id, bob.id],
    );
    const originalRows = (
      await db.pool.query("SELECT * FROM public.customer_rls_notes ORDER BY id")
    ).rows;
    const runtimeUrl = new URL(base);
    runtimeUrl.username = runtime;
    runtimePool = new Pool({ connectionString: runtimeUrl.href, max: 2 });
    const dependencies = pooledClientDependencies(runtimePool);
    const ordinary = createProjectDatabaseService(runtimeUrl.href, dependencies);
    let opened = 0;
    const database = createPrivateDatabaseClient({
      ...ordinary,
      async openRls(identity) {
        opened += 1;
        return new ProjectDatabaseRlsConnection(
          await connectRlsProjectDatabase(
            runtimeUrl.href,
            dependencies,
            9184,
            identity,
            async () => undefined,
          ),
          () => undefined,
        );
      },
    });
    type NoteAction =
      | { kind: "create"; id: string; body: string; owner?: string }
      | { kind: "update"; id: string; body: string }
      | { kind: "owner"; id: string; owner: string }
      | { kind: "delete"; id: string };
    const backendPids: number[] = [];
    let rendezvous: (() => Promise<void>) | undefined;
    const protectedNotes = async (cookie?: string, action?: NoteAction) => {
      const session = (await (
        await auth.handler(request("/get-session", undefined, cookie))
      ).json()) as { user: { id: string } } | null;
      if (session === null) return new Response(null, { status: 401 });
      const result = await database.withRls({ subject: session.user.id }, async (tx) => {
        const context = (
          await tx.query({
            text: "SELECT pg_backend_pid() AS pid,ohmyhost.user_id() AS actor",
            values: [],
          })
        ).rows[0];
        expect(context?.["actor"]).toBe(session.user.id);
        backendPids.push(Number(context?.["pid"]));
        await rendezvous?.();
        const mutation =
          action === undefined
            ? undefined
            : action.kind === "create"
              ? {
                  text: "INSERT INTO public.customer_rls_notes VALUES($1,$2,$3)",
                  values: [action.id, action.owner ?? session.user.id, action.body],
                }
              : action.kind === "update"
                ? {
                    text: "UPDATE public.customer_rls_notes SET body=$1 WHERE id=$2",
                    values: [action.body, action.id],
                  }
                : action.kind === "owner"
                  ? {
                      text: "UPDATE public.customer_rls_notes SET owner_id=$1 WHERE id=$2",
                      values: [action.owner, action.id],
                    }
                  : {
                      text: "DELETE FROM public.customer_rls_notes WHERE id=$1",
                      values: [action.id],
                    };
        const changed = mutation === undefined ? null : (await tx.query(mutation)).rowCount;
        const rows = (
          await tx.query({
            text: "SELECT id,body FROM public.customer_rls_notes ORDER BY id",
            values: [],
          })
        ).rows;
        return { rows, changed };
      });
      return Response.json(result);
    };
    const allVisibleRows = originalRows.map((row) => ({ id: row["id"], body: row["body"] }));
    // Existing applications still read and write the populated table before explicit opt-in.
    expect(
      (
        await database.query({
          text: "SELECT id,body FROM public.customer_rls_notes ORDER BY id",
          values: [],
        })
      ).rows,
    ).toEqual(allVisibleRows);
    expect(
      await database.transaction([
        {
          text: "INSERT INTO public.customer_rls_notes VALUES('legacy-write',$1,'before RLS')",
          values: [alice.id],
        },
        {
          text: "UPDATE public.customer_rls_notes SET body='updated before RLS' WHERE id='legacy-write'",
          values: [],
        },
        { text: "DELETE FROM public.customer_rls_notes WHERE id='legacy-write'", values: [] },
      ]),
    ).toMatchObject([{ rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }]);
    for (const actor of [alice, bob]) {
      expect(await (await protectedNotes(actor.cookie)).json()).toEqual({
        rows: allVisibleRows,
        changed: null,
      });
    }
    expect(
      (
        await db.pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.customer_rls_notes'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);
    const originalLedger = (
      await migrationClient.query("SELECT * FROM ohmyhost.schema_migrations ORDER BY path")
    ).rows;
    // The next immutable file protects the already-populated table, retaining its ledger prefix.
    await expect(
      executeExpandOnlyMigrations(migrationPort, [foundation, activateRls]),
    ).resolves.toMatchObject({
      appliedPaths: [activateRls.path],
      replayedPaths: [foundation.path],
    });
    expect(
      (
        await db.pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.customer_rls_notes'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      (await db.pool.query("SELECT * FROM public.customer_rls_notes ORDER BY id")).rows,
    ).toEqual(originalRows);
    const activatedLedger = (
      await migrationClient.query("SELECT * FROM ohmyhost.schema_migrations ORDER BY path")
    ).rows;
    expect(activatedLedger).toHaveLength(2);
    expect(activatedLedger.slice(0, 1)).toEqual(originalLedger);
    expect(activatedLedger[1]).toMatchObject({
      path: activateRls.path,
      sha256: Buffer.from(activateRls.digest.slice("sha256:".length), "hex"),
    });
    await expect(
      executeExpandOnlyMigrations(migrationPort, [foundation, activateRls]),
    ).resolves.toMatchObject({
      appliedPaths: [],
      replayedPaths: [foundation.path, activateRls.path],
    });
    expect(
      (await migrationClient.query("SELECT * FROM ohmyhost.schema_migrations ORDER BY path")).rows,
    ).toEqual(activatedLedger);
    backendPids.length = 0;
    expect(await (await protectedNotes(alice.cookie)).json()).toEqual({
      rows: [{ id: "a", body: "Alice private" }],
      changed: null,
    });
    expect(await (await protectedNotes(bob.cookie)).json()).toEqual({
      rows: [{ id: "b", body: "Bob private" }],
      changed: null,
    });
    // Sequential A/B scopes actually reuse a PostgreSQL connection without inheriting identity.
    expect(backendPids[1]).toBe(backendPids[0]);
    for (const [actor, other, ownId, foreignId] of [
      [alice, bob, "a", "b"],
      [bob, alice, "b", "a"],
    ] as const) {
      const createdId = `${ownId}-new`;
      expect(
        await (
          await protectedNotes(actor.cookie, { kind: "create", id: createdId, body: "created" })
        ).json(),
      ).toMatchObject({
        changed: 1,
        rows: expect.arrayContaining([{ id: createdId, body: "created" }]),
      });
      expect(
        await (
          await protectedNotes(actor.cookie, { kind: "update", id: createdId, body: "updated" })
        ).json(),
      ).toMatchObject({
        changed: 1,
        rows: expect.arrayContaining([{ id: createdId, body: "updated" }]),
      });
      for (const action of [
        { kind: "update", id: foreignId, body: "forged" },
        { kind: "delete", id: foreignId },
      ] as const) {
        expect(await (await protectedNotes(actor.cookie, action)).json()).toMatchObject({
          changed: 0,
        });
        expect(
          (await db.pool.query("SELECT * FROM public.customer_rls_notes WHERE id=$1", [foreignId]))
            .rows,
        ).toEqual(originalRows.filter((row) => row["id"] === foreignId));
      }
      await expect(
        protectedNotes(actor.cookie, { kind: "owner", id: createdId, owner: other.id }),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await db.pool.query("SELECT * FROM public.customer_rls_notes WHERE id=$1", [createdId]))
          .rows,
      ).toEqual([{ id: createdId, owner_id: actor.id, body: "updated" }]);
      await expect(
        protectedNotes(actor.cookie, {
          kind: "create",
          id: "forged",
          owner: other.id,
          body: "forged",
        }),
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        (await db.pool.query("SELECT * FROM public.customer_rls_notes WHERE id='forged'")).rows,
      ).toEqual([]);
      expect(
        await (await protectedNotes(actor.cookie, { kind: "delete", id: createdId })).json(),
      ).toMatchObject({ changed: 1 });
      expect(
        (await db.pool.query("SELECT * FROM public.customer_rls_notes ORDER BY id")).rows,
      ).toEqual(originalRows);
    }
    const pair = Promise.withResolvers<undefined>();
    let entered = 0;
    rendezvous = async () => {
      entered += 1;
      if (entered === 2) pair.resolve(undefined);
      await pair.promise;
    };
    try {
      const concurrent = await Promise.all([
        protectedNotes(alice.cookie),
        protectedNotes(bob.cookie),
      ]);
      expect(await Promise.all(concurrent.map((response) => response.json()))).toEqual([
        { rows: [{ id: "a", body: "Alice private" }], changed: null },
        { rows: [{ id: "b", body: "Bob private" }], changed: null },
      ]);
      expect(new Set(backendPids.slice(-2)).size).toBe(2);
    } finally {
      pair.resolve(undefined);
      rendezvous = undefined;
    }
    expect(
      (await db.pool.query("SELECT count(*)::int n FROM public.customer_rls_notes")).rows,
    ).toEqual([{ n: 2 }]);
    expect(
      (await database.query({ text: "SELECT id FROM public.customer_rls_notes", values: [] })).rows,
    ).toEqual([]);
    expect(
      (
        await database.query({
          text: "SELECT ohmyhost.user_id() AS actor,ohmyhost.claims() AS claims",
          values: [],
        })
      ).rows,
    ).toEqual([{ actor: null, claims: {} }]);
    for (const text of [
      "UPDATE public.customer_rls_notes SET body='anonymous'",
      "DELETE FROM public.customer_rls_notes",
    ]) {
      await expect(
        database.withRls(null, (tx) => tx.query({ text, values: [] })),
      ).resolves.toMatchObject({ rowCount: 0 });
    }
    await expect(
      database.withRls(null, (tx) =>
        tx.query({
          text: "INSERT INTO public.customer_rls_notes VALUES('anonymous',$1,'anonymous')",
          values: [alice.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await db.pool.query("SELECT * FROM public.customer_rls_notes ORDER BY id")).rows,
    ).toEqual(originalRows);
    expect(
      await database.withRls(
        null,
        async (tx) =>
          (await tx.query({ text: "SELECT id FROM public.customer_rls_notes", values: [] })).rows,
      ),
    ).toEqual([]);
    const beforeDenied = opened;
    expect((await protectedNotes()).status).toBe(401);
    expect((await protectedNotes(`${alice.cookie}tampered`)).status).toBe(401);
    expect((await auth.handler(request("/sign-out", {}, alice.cookie))).status).toBe(200);
    expect((await protectedNotes(alice.cookie)).status).toBe(401);
    await db.pool.query(
      'UPDATE auth."session" SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1',
      [bob.id],
    );
    expect((await protectedNotes(bob.cookie)).status).toBe(401);
    expect(opened).toBe(beforeDenied);
  } finally {
    await runtimePool?.end();
    await migrationClient?.end();
    await authPool.end();
    await db.stop();
  }
}, 60_000);
