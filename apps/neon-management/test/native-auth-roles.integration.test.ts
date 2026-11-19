import { Client } from "pg";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { PgcfProjectProvider, PgcfRole } from "@ohmyhost/provider-pgcf";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import {
  ensureNativeAuthRoles,
  nativeAuthRoleNames,
  prepareNativeAuthSchema,
  registerNativeAuthRealm,
  verifyNativeAuthSchema,
} from "../src/native-auth-roles.js";
import { applyNativePreviewPolicyMigration } from "../src/native-preview-policy-migration.js";
import { NATIVE_PREVIEW_POLICY_SQL } from "../src/native-preview-policy-schema.js";
import { applyNativeAuthMigration } from "../src/native-auth-migration.js";
import { NATIVE_AUTH_SCHEMA_SQL } from "../src/native-auth-schema.js";
import { NATIVE_AUTH_SCHEMA_V2_SQL } from "../src/native-auth-schema-v2.js";
import { NATIVE_AUTH_SCHEMA_V3_SQL } from "../src/native-auth-schema-v3.js";
import { NATIVE_AUTH_SCHEMA_V1_SHA256 } from "@ohmyhost/contracts/native-auth";
import { prepareNativeAuthRestore } from "../src/native-auth-restore-preparation.js";

const projectId = "00000000000000000000000001";
const dev = "00000000000000000000000002";
const prod = "00000000000000000000000003";
const databaseId = "a1234567890123456789";
const servers: TestPostgres[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

it("uses durable role operation keys and registers credentials only in the private registry", async () => {
  expect(NATIVE_AUTH_SCHEMA_SQL).toBe(
    await readFile(new URL("../../native-auth-runtime/schema.sql", import.meta.url), "utf8"),
  );
  expect(NATIVE_AUTH_SCHEMA_V2_SQL).toBe(
    await readFile(
      new URL(
        "../../native-auth-runtime/migrations/002-invitation-receipt-digest.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(NATIVE_AUTH_SCHEMA_V3_SQL).toBe(
    await readFile(
      new URL("../../native-auth-runtime/migrations/003-social-flow.sql", import.meta.url),
      "utf8",
    ),
  );
  expect(NATIVE_PREVIEW_POLICY_SQL).toBe(
    await readFile(
      new URL("../../native-auth-runtime/migrations/004-preview-policy.sql", import.meta.url),
      "utf8",
    ),
  );
  const roles: PgcfRole[] = [];
  const provider = {
    projectId: "prj_12345678901234567890",
    createRole: vi.fn(
      async (_db: string, definition: { name: string; connection_limit: number }) => {
        const role: PgcfRole = {
          databaseId,
          name: definition.name,
          owner: false,
          passwordRevision: 1,
          validUntil: null,
          connectionLimit: definition.connection_limit,
          memberOf: [],
          bypassRls: false,
          membershipOptions: { inherit: true, set: true },
        };
        roles.push(role);
        return role;
      },
    ),
    readRoles: vi.fn(async () => roles),
    readConnection: vi.fn(async () => ({
      host: "pgcf.example.test",
      consume: async <T>(work: (value: string) => Promise<T>) => work("private-credential"),
    })),
  } as unknown as PgcfProjectProvider;
  const persistence = {
    reserveRole: vi.fn(async ({ definition }: { definition: { name: string } }) => ({
      idempotencyKey: `key-${definition.name}`,
      providerOperationId: null,
      state: "reserved" as const,
    })),
    authorizeRole: vi.fn(async () => "dispatch" as "dispatch" | "observe"),
    recordRole: vi.fn(async () => undefined),
  };
  await expect(
    ensureNativeAuthRoles({ provider, persistence, projectId, environmentId: dev, databaseId }),
  ).resolves.toBe("ready");
  expect(provider.createRole).toHaveBeenCalledTimes(3);
  // A racing caller may have read "reserved" before the first caller dispatched it.
  // Core's observed dispatch result must prevent a second role creation.
  persistence.authorizeRole.mockResolvedValueOnce("observe");
  await expect(
    ensureNativeAuthRoles({ provider, persistence, projectId, environmentId: dev, databaseId }),
  ).resolves.toBe("reconciliation_required");
  expect(provider.createRole).toHaveBeenCalledTimes(3);
  await expect(
    ensureNativeAuthRoles({
      provider,
      persistence: {
        ...persistence,
        reserveRole: async () => ({
          idempotencyKey: "lost-response-key",
          providerOperationId: null,
          state: "dispatched" as const,
        }),
      },
      projectId,
      environmentId: dev,
      databaseId,
    }),
  ).resolves.toBe("reconciliation_required");
  expect(provider.createRole).toHaveBeenCalledTimes(3);
  const names = nativeAuthRoleNames(projectId, dev);
  expect(provider.createRole).toHaveBeenCalledWith(
    databaseId,
    expect.objectContaining({ name: names.runtime, bypass_rls: false }),
    `key-${names.runtime}`,
  );
  const registration = {
    organizationId: projectId,
    projectId,
    environmentId: dev,
    operationId: prod,
    claimId: prod,
    providerProjectId: provider.projectId,
    databaseId,
    regionId: "eu-dev" as const,
    originHost: "pgcf.example.test",
    schema: names.schema,
    role: names.runtime,
    targetVersion: 1,
    registryVersion: 1,
    registryReference: `${projectId}:${dev}`,
  };
  const registry = {
    register: vi.fn(async ({ connectionString, ...metadata }) => {
      void connectionString;
      return { ...metadata, status: "active" as const };
    }),
  };
  const authorize = vi.fn(async () => undefined);
  const registrationPersistence = {
    reserve: vi.fn(async () => registration),
    confirm: vi.fn(async () => undefined),
  };
  const receipt = await registerNativeAuthRealm({
    provider,
    registry,
    persistence: registrationPersistence,
    registration,
    authorize,
  });
  expect(registry.register).toHaveBeenCalledWith({
    ...registration,
    connectionString: "private-credential",
  });
  expect(receipt).toEqual({ ...registration, status: "active" });
  expect(receipt).not.toHaveProperty("connectionString");
  expect(authorize).toHaveBeenCalledTimes(3);
  expect(registrationPersistence.confirm).toHaveBeenCalledWith(receipt);
  const retryProvider = {
    ...provider,
    createRole: vi.fn(
      async (db: string, definition: { name: string; connection_limit: number }, key: string) => {
        if (key !== `key-${definition.name}`) throw new Error("changed idempotency key");
        return vi.mocked(provider.createRole)(db, definition, key);
      },
    ),
  } as unknown as PgcfProjectProvider;
  vi.mocked(retryProvider.createRole).mockRejectedValueOnce(new Error("response lost"));
  await expect(
    ensureNativeAuthRoles({
      provider: retryProvider,
      persistence,
      projectId,
      environmentId: dev,
      databaseId,
    }),
  ).rejects.toThrow("response lost");
  await expect(
    ensureNativeAuthRoles({
      provider: retryProvider,
      persistence,
      projectId,
      environmentId: dev,
      databaseId,
    }),
  ).resolves.toBe("ready");
  expect(vi.mocked(retryProvider.createRole).mock.calls[0]?.[2]).toBe(
    vi.mocked(retryProvider.createRole).mock.calls[1]?.[2],
  );
});

it.skipIf(Boolean(process.env["TEST_DATABASE_URL"]))(
  "isolates native realms and denies business, cross-realm and backup writes in PostgreSQL",
  async () => {
    const db = await startTestPostgres();
    servers.push(db);
    const devNames = nativeAuthRoleNames(projectId, dev),
      prodNames = nativeAuthRoleNames(projectId, prod);
    await db.pool.query(
      "CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    for (const role of new Set([
      devNames.runtime,
      devNames.migrator,
      devNames.backup,
      prodNames.runtime,
      prodNames.migrator,
      "business_role",
    ]))
      await db.pool.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`,
      );
    // PGCF represents unbounded password validity as positive infinity; keep one role at NULL.
    await db.pool.query(`ALTER ROLE ${devNames.runtime} VALID UNTIL 'infinity'`);
    await db.pool.query(`ALTER ROLE ${devNames.backup} VALID UNTIL 'infinity'`);
    await db.pool.query(`CREATE DATABASE ${databaseId} OWNER app`);
    const roles = {
      withRole: async <T>(
        role: string,
        work: (client: {
          query(
            text: string,
            values?: readonly unknown[],
          ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
        }) => Promise<T>,
      ): Promise<T> => {
        const url = new URL(String(db.pool.options.connectionString));
        url.pathname = `/${databaseId}`;
        url.username = role;
        url.search = "";
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        try {
          return await work({
            query: (sql, values) => client.query(sql, values ? [...values] : []),
          });
        } finally {
          await client.end();
        }
      },
    };
    try {
      await prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles });
      await prepareNativeAuthSchema({ projectId, environmentId: prod, databaseId, roles });
      await prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles });
      await roles.withRole(devNames.migrator, async (client) => {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path=${devNames.schema},pg_catalog`);
        await client.query(
          `CREATE TABLE ${devNames.schema}.omh_native_migrations(version integer PRIMARY KEY,digest text NOT NULL)`,
        );
        await client.query(NATIVE_AUTH_SCHEMA_SQL);
        await client.query(`INSERT INTO ${devNames.schema}.omh_native_migrations VALUES(1,$1)`, [
          NATIVE_AUTH_SCHEMA_V1_SHA256,
        ]);
        await client.query(
          `REVOKE ALL ON ${devNames.schema}.omh_native_migrations FROM PUBLIC,${devNames.runtime}`,
        );
        await client.query("COMMIT");
      });
      for (const [environmentId, names] of [
        [dev, devNames],
        [prod, prodNames],
      ] as const) {
        await roles.withRole(names.migrator, (client) =>
          applyNativeAuthMigration({ projectId, environmentId, databaseId, client }),
        );
        await roles.withRole(names.migrator, (client) =>
          applyNativeAuthMigration({ projectId, environmentId, databaseId, client }),
        );
        await verifyNativeAuthSchema({
          projectId,
          environmentId,
          databaseId,
          environmentIds: [dev, prod],
          roles,
          authorize: async () => undefined,
        });
      }
      await roles.withRole(devNames.migrator, (client) =>
        applyNativePreviewPolicyMigration({ projectId, environmentId: dev, databaseId, client }),
      );
      await roles.withRole(devNames.migrator, async (client) => {
        // The original scope refusal survives losing the rollback acknowledgement, and SQL is usable afterwards.
        await expect(
          applyNativePreviewPolicyMigration({
            projectId,
            environmentId: dev,
            databaseId: "b1234567890123456789",
            client: {
              query: async (sql, values) => {
                const result = await client.query(sql, values);
                if (sql === "ROLLBACK") throw new Error("rollback acknowledgement lost");
                return result;
              },
            },
          }),
        ).rejects.toThrow("Database provider scope or durable identity conflicts");
        expect((await client.query("SELECT current_database() AS database")).rows).toEqual([
          { database: databaseId },
        ]);
      });
      await roles.withRole(devNames.migrator, (client) =>
        applyNativePreviewPolicyMigration({ projectId, environmentId: dev, databaseId, client }),
      );
      await prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles });
      await verifyNativeAuthSchema({
        projectId,
        environmentId: dev,
        databaseId,
        environmentIds: [dev, prod],
        roles,
        authorize: async () => undefined,
      });
      await roles.withRole("app", async (client) => {
        const permissions = await client.query(
          "SELECT has_table_privilege($1,$3,'SELECT,INSERT,UPDATE') AS runtime_access,has_table_privilege($1,$3,'DELETE') AS runtime_delete,has_table_privilege($2,$3,'SELECT') AS backup_access",
          [devNames.runtime, devNames.backup, `${devNames.schema}.native_preview_realm_policy`],
        );
        expect(permissions.rows[0]).toEqual({
          runtime_access: true,
          runtime_delete: false,
          backup_access: false,
        });
      });
      // Positive infinity does not bypass any of the other role-safety conditions.
      await db.pool.query(`ALTER ROLE ${devNames.runtime} CONNECTION LIMIT 1`);
      await expect(
        prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles }),
      ).rejects.toThrow("Database provider scope or durable identity conflicts");
      await expect(
        verifyNativeAuthSchema({
          projectId,
          environmentId: dev,
          databaseId,
          environmentIds: [dev, prod],
          roles,
          authorize: async () => undefined,
        }),
      ).rejects.toThrow("Database provider scope or durable identity conflicts");
      await db.pool.query(`ALTER ROLE ${devNames.runtime} CONNECTION LIMIT 2`);

      // Expiring and already-expired values must fail each of the three independent SQL guards.
      for (const validity of ["2099-01-01 00:00:00+00", "-infinity"]) {
        await db.pool.query(`ALTER ROLE ${devNames.runtime} VALID UNTIL '${validity}'`);
        await expect(
          prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles }),
        ).rejects.toThrow("Database provider scope or durable identity conflicts");
        await expect(
          verifyNativeAuthSchema({
            projectId,
            environmentId: dev,
            databaseId,
            environmentIds: [dev, prod],
            roles,
            authorize: async () => undefined,
          }),
        ).rejects.toThrow("Database provider scope or durable identity conflicts");
        await db.pool.query(`ALTER ROLE ${devNames.runtime} VALID UNTIL 'infinity'`);

        // Change the role after the app aggregate check to exercise the later per-role guard.
        let changed = false;
        let reachedIndividualCheck = false;
        const racedRoles = {
          withRole: async <T>(
            role: string,
            work: (client: {
              query(
                text: string,
                values?: readonly unknown[],
              ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
            }) => Promise<T>,
          ): Promise<T> => {
            if (role === devNames.runtime && !changed) {
              changed = true;
              await db.pool.query(`ALTER ROLE ${devNames.runtime} VALID UNTIL '${validity}'`);
            }
            return roles.withRole(role, (client) =>
              work({
                query: (sql, values) => {
                  if (role === devNames.runtime && sql.includes("r.rolvaliduntil"))
                    reachedIndividualCheck = true;
                  return client.query(sql, values);
                },
              }),
            );
          },
        };
        await expect(
          prepareNativeAuthSchema({
            projectId,
            environmentId: dev,
            databaseId,
            roles: racedRoles,
          }),
        ).rejects.toThrow("Database provider scope or durable identity conflicts");
        expect(reachedIndividualCheck).toBe(true);
        await db.pool.query(`ALTER ROLE ${devNames.runtime} VALID UNTIL 'infinity'`);
      }

      const faultRoles = (point: "schema" | "grants" | "migration") => ({
        withRole: async <T>(
          role: string,
          work: (client: {
            query(
              text: string,
              values?: readonly unknown[],
            ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
          }) => Promise<T>,
        ): Promise<T> =>
          roles.withRole(role, async (client) => {
            let loseRollback = false;
            return work({
              query: async (sql, values) => {
                const result = await client.query(sql, values);
                const trigger =
                  point === "schema"
                    ? sql.startsWith("REVOKE ALL ON DATABASE")
                    : point === "grants"
                      ? sql.startsWith("REVOKE ALL ON ALL TABLES IN SCHEMA")
                      : sql.startsWith(`REVOKE ALL ON ${devNames.schema}.omh_native_migrations`);
                if (trigger) {
                  loseRollback = true;
                  throw new Error(`${point} response lost`);
                }
                if (sql === "ROLLBACK" && loseRollback) throw new Error("rollback response lost");
                return result;
              },
            });
          }),
      });
      await expect(
        prepareNativeAuthSchema({
          projectId,
          environmentId: dev,
          databaseId,
          roles: faultRoles("schema"),
        }),
      ).rejects.toThrow("schema response lost");
      await expect(
        prepareNativeAuthSchema({
          projectId,
          environmentId: dev,
          databaseId,
          roles: faultRoles("grants"),
        }),
      ).rejects.toThrow("grants response lost");
      await expect(
        faultRoles("migration").withRole(devNames.migrator, (client) =>
          applyNativeAuthMigration({ projectId, environmentId: dev, databaseId, client }),
        ),
      ).rejects.toThrow("migration response lost");
      await roles.withRole(devNames.migrator, async (client) => {
        expect(
          (
            await client.query(
              `SELECT version FROM ${devNames.schema}.omh_native_migrations ORDER BY version`,
            )
          ).rows,
        ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      });
      const restoreScope = {
        organizationId: projectId,
        projectId,
        environmentId: dev,
        restoreId: prod,
        claimId: "00000000-0000-4000-8000-000000000001",
      };
      const restoreProof = {
        ...restoreScope,
        providerProjectId: "prj_12345678901234567890",
        databaseId,
        regionId: "eu-dev" as const,
        originHost: "pgcf.example.test",
        targetVersion: 1,
        registryVersion: 1,
        schema: devNames.schema,
        runtimeRole: devNames.runtime,
        migratorRole: devNames.migrator,
        backupRole: devNames.backup,
        environmentIds: [dev, prod],
        revocationEpoch: 3,
        configurationRevision: 3,
      };
      let currentClaimId = restoreScope.claimId;
      const restoreAuthority = {
        read: vi.fn(async (scope: typeof restoreScope) =>
          scope.claimId === currentClaimId ? { ...restoreProof, claimId: currentClaimId } : null,
        ),
        recordVerification: vi.fn(async () => ({ status: "verified" as const })),
      };
      const restoreProvider = {
        projectId: restoreProof.providerProjectId,
        readConnection: async (_database: string, role: string) => ({
          host: "pgcf.example.test",
          consume: async <T>(work: (uri: string) => Promise<T>) => work(role),
        }),
      } as unknown as PgcfProjectProvider;
      let lockAttempt: (() => void) | undefined;
      let mutationCount = 0;
      let loseRollbackReply = false;
      let failAfterRoleChange = false;
      const restoreConnect = async (role: string) => {
        const url = new URL(String(db.pool.options.connectionString));
        url.pathname = `/${databaseId}`;
        url.username = role;
        url.search = "";
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        let locked = false;
        return {
          client: {
            query: async (sql: string, values?: readonly unknown[]) => {
              const command = sql.trim().toUpperCase();
              if (command === "BEGIN") locked = false;
              if (command.startsWith("SELECT PG_ADVISORY_XACT_LOCK")) {
                lockAttempt?.();
                lockAttempt = undefined;
              }
              if (/^(ALTER|CREATE|REVOKE|GRANT|INSERT|UPDATE|DELETE)\b/u.test(command)) {
                if (!locked) throw new Error("restore_mutation_without_lock");
                mutationCount++;
              }
              const result = await client.query(sql, values ? [...values] : []);
              if (command === "ROLLBACK" && loseRollbackReply)
                throw new Error("rollback reply lost");
              if (command.startsWith("ALTER ROLE") && failAfterRoleChange) {
                failAfterRoleChange = false;
                throw new Error("role mutation reply lost");
              }
              if (command.startsWith("SELECT PG_ADVISORY_XACT_LOCK")) locked = true;
              if (command === "COMMIT" || command === "ROLLBACK") locked = false;
              return result;
            },
          } as never,
          close: () => client.end(),
        };
      };
      const holderUrl = new URL(String(db.pool.options.connectionString));
      holderUrl.pathname = `/${databaseId}`;
      holderUrl.username = "app";
      holderUrl.search = "";
      const holder = new Client({ connectionString: holderUrl.toString() });
      await holder.connect();
      const settlementKey = `ohmyho-native-restore/v1:${projectId}:${projectId}:${databaseId}`;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          settlementKey,
        ]);
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
          entered = resolve;
        });
        lockAttempt = entered;
        const stale = prepareNativeAuthRestore({
          scope: restoreScope,
          authority: restoreAuthority,
          provider: restoreProvider,
          connect: restoreConnect,
        });
        const staleRejected = expect(stale).rejects.toThrow(
          "native_restore_preparation_unavailable",
        );
        await waiting;
        currentClaimId = "00000000-0000-4000-8000-000000000002";
        loseRollbackReply = true;
        await holder.query("COMMIT");
        await staleRejected;
        loseRollbackReply = false;
        expect(restoreAuthority.recordVerification).not.toHaveBeenCalled();
        expect(mutationCount).toBe(0);
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          settlementKey,
        ]);
        await holder.query("CREATE TABLE public.native_restore_settlement_marker (value integer)");
        await holder.query("INSERT INTO public.native_restore_settlement_marker VALUES (1)");
        let nextEntered!: () => void;
        const nextWaiting = new Promise<void>((resolve) => {
          nextEntered = resolve;
        });
        lockAttempt = nextEntered;
        const nextScope = { ...restoreScope, claimId: currentClaimId };
        const next = prepareNativeAuthRestore({
          scope: nextScope,
          authority: restoreAuthority,
          provider: restoreProvider,
          connect: restoreConnect,
        });
        await nextWaiting;
        expect(restoreAuthority.recordVerification).not.toHaveBeenCalled();
        await holder.query("COMMIT");
        await expect(next).resolves.toEqual({ status: "verified" });
        expect(
          (await holder.query("SELECT value FROM public.native_restore_settlement_marker")).rows,
        ).toEqual([{ value: 1 }]);
        expect(mutationCount).toBeGreaterThan(0);
        await roles.withRole(devNames.runtime, (client) =>
          client.query(`ALTER ROLE ${devNames.runtime} SET search_path = pg_catalog`),
        );
        failAfterRoleChange = true;
        loseRollbackReply = true;
        await expect(
          prepareNativeAuthRestore({
            scope: nextScope,
            authority: restoreAuthority,
            provider: restoreProvider,
            connect: restoreConnect,
          }),
        ).rejects.toThrow("role mutation reply lost");
        loseRollbackReply = false;
        const setting = await holder.query("SELECT rolconfig FROM pg_roles WHERE rolname=$1", [
          devNames.runtime,
        ]);
        expect(setting.rows[0]?.rolconfig).toEqual(["search_path=pg_catalog"]);
        await roles.withRole(devNames.runtime, (client) =>
          client.query(
            `ALTER ROLE ${devNames.runtime} SET search_path = ${devNames.schema}, pg_catalog`,
          ),
        );
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
      expect(restoreAuthority.recordVerification).toHaveBeenCalledOnce();
      await roles.withRole(devNames.migrator, async (client) => {
        expect(
          (
            await client.query(
              `SELECT version FROM ${devNames.schema}.omh_native_migrations ORDER BY version`,
            )
          ).rows,
        ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      });
      for (const names of [devNames, prodNames]) {
        await roles.withRole(names.migrator, async (client) => {
          await client.query(`CREATE TABLE ${names.schema}.users (id integer PRIMARY KEY)`);
        });
      }
      await roles.withRole(devNames.runtime, async (client) => {
        await client.query(`INSERT INTO ${devNames.schema}.users VALUES (1)`);
        await expect(client.query(`SELECT * FROM ${prodNames.schema}.users`)).rejects.toMatchObject(
          { code: "42501" },
        );
        await expect(
          client.query(`CREATE TABLE ${devNames.schema}.forbidden (id integer)`),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query("CREATE TABLE public.forbidden (id integer)"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          client.query(`SELECT * FROM ${devNames.schema}.omh_native_migrations`),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await roles.withRole(devNames.backup, async (client) => {
        expect((await client.query(`SELECT * FROM ${devNames.schema}.users`)).rows).toEqual([
          { id: 1 },
        ]);
        await expect(client.query(`DELETE FROM ${devNames.schema}.users`)).rejects.toMatchObject({
          code: "42501",
        });
      });
      await expect(
        roles.withRole("business_role", (client) =>
          client.query(`SELECT * FROM ${devNames.schema}.users`),
        ),
      ).rejects.toThrow();
      await roles.withRole("app", (client) =>
        client.query(`GRANT CONNECT ON DATABASE ${databaseId} TO business_role`),
      );
      await expect(
        verifyNativeAuthSchema({
          projectId,
          environmentId: dev,
          databaseId,
          environmentIds: [dev, prod],
          roles,
          authorize: async () => undefined,
        }),
      ).rejects.toThrow();
      await roles.withRole("app", (client) =>
        client.query(`REVOKE CONNECT ON DATABASE ${databaseId} FROM business_role`),
      );
      await roles.withRole("app", (client) =>
        client.query(`GRANT USAGE ON SCHEMA ${devNames.schema} TO business_role`),
      );
      await expect(
        prepareNativeAuthSchema({ projectId, environmentId: dev, databaseId, roles }),
      ).rejects.toThrow();
    } finally {
      await db.pool.query(`DROP DATABASE ${databaseId} WITH (FORCE)`);
    }
  },
  120_000,
);
