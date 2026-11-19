import { DatabaseProviderConflictError } from "@ohmyhost/database";
import type { PgcfProjectProvider, PgcfRole, PgcfRoleCreate } from "@ohmyhost/provider-pgcf";
import { applyNativeAuthMigration } from "./native-auth-migration.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const DATABASE = /^[a-z][a-z0-9]{19}$/u;

export function nativeAuthRoleNames(projectId: string, environmentId: string) {
  if (!ULID.test(projectId) || !ULID.test(environmentId)) throw new DatabaseProviderConflictError();
  const project = projectId.toLowerCase(),
    environment = environmentId.toLowerCase();
  return Object.freeze({
    schema: `omh_auth_${environment}`,
    runtime: `omh_ar_${environment}`,
    migrator: `omh_am_${environment}`,
    backup: `omh_ab_${project}`,
  });
}

interface RoleOperation {
  readonly idempotencyKey: string;
  readonly providerOperationId: string | null;
  readonly state: "reserved" | "dispatched" | "succeeded" | "failed";
}
/** These methods persist and fence the original provider operation, not the credential. */
export interface NativeAuthRolePersistence {
  reserveRole(input: {
    readonly databaseId: string;
    readonly definition: PgcfRoleCreate;
  }): Promise<RoleOperation>;
  authorizeRole(operation: RoleOperation): Promise<"dispatch" | "observe">;
  recordRole(
    operation: RoleOperation,
    input: {
      readonly providerOperationId: string | null;
      readonly state: "dispatched" | "succeeded" | "failed";
    },
  ): Promise<void>;
}

export interface NativeAuthRealmRegistration {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly regionId: "us-dev" | "eu-dev";
  readonly originHost: string;
  readonly schema: string;
  readonly role: string;
  readonly targetVersion: number;
  readonly registryVersion: number;
  readonly registryReference: string;
  readonly status: "active";
}
export interface NativeAuthRegistry {
  register(
    input: Omit<NativeAuthRealmRegistration, "status"> & { readonly connectionString: string },
  ): Promise<NativeAuthRealmRegistration>;
}
export interface NativeAuthRegistrationPersistence {
  reserve(
    registration: Omit<NativeAuthRealmRegistration, "status">,
  ): Promise<Omit<NativeAuthRealmRegistration, "status">>;
  confirm(receipt: NativeAuthRealmRegistration): Promise<void>;
}

/** The registry receives credentials privately; its receipt is metadata only. */
export async function registerNativeAuthRealm(input: {
  readonly provider: PgcfProjectProvider;
  readonly registry: NativeAuthRegistry;
  readonly persistence: NativeAuthRegistrationPersistence;
  readonly registration: Omit<NativeAuthRealmRegistration, "status">;
  readonly authorize: () => Promise<void>;
}): Promise<NativeAuthRealmRegistration> {
  const registration = input.registration;
  const names = nativeAuthRoleNames(registration.projectId, registration.environmentId);
  if (
    !ULID.test(registration.organizationId) ||
    !ULID.test(registration.operationId) ||
    !ULID.test(registration.claimId) ||
    registration.registryReference !== `${registration.projectId}:${registration.environmentId}` ||
    !DATABASE.test(registration.databaseId) ||
    registration.providerProjectId !== input.provider.projectId ||
    (registration.regionId !== "us-dev" && registration.regionId !== "eu-dev") ||
    registration.schema !== names.schema ||
    registration.role !== names.runtime ||
    !Number.isSafeInteger(registration.targetVersion) ||
    registration.targetVersion < 1 ||
    !Number.isSafeInteger(registration.registryVersion) ||
    registration.registryVersion < 1
  )
    throw new DatabaseProviderConflictError();
  await input.authorize();
  const reserved = await input.persistence.reserve(registration);
  if (
    Object.keys(reserved).sort().join(",") !== Object.keys(registration).sort().join(",") ||
    Object.keys(registration).some(
      (key) => Reflect.get(reserved, key) !== Reflect.get(registration, key),
    )
  )
    throw new DatabaseProviderConflictError();
  await input.authorize();
  const handle = await input.provider.readConnection(registration.databaseId, registration.role);
  if (handle.host !== registration.originHost) throw new DatabaseProviderConflictError();
  const result = await handle.consume(async (connectionString) => {
    await input.authorize();
    return input.registry.register({ ...registration, connectionString });
  });
  const expected = { ...registration, status: "active" as const };
  if (
    Object.keys(result).sort().join(",") !== Object.keys(expected).sort().join(",") ||
    Object.keys(expected).some((key) => Reflect.get(result, key) !== Reflect.get(expected, key))
  )
    throw new DatabaseProviderConflictError();
  await input.persistence.confirm(expected);
  return Object.freeze(expected);
}

/** Reconcile role creation using its original idempotency key, never adopt an unverified role. */
export async function ensureNativeAuthRoles(input: {
  readonly provider: PgcfProjectProvider;
  readonly persistence: NativeAuthRolePersistence;
  readonly projectId: string;
  readonly environmentId: string;
  readonly databaseId: string;
}): Promise<"ready" | "reconciliation_required"> {
  if (!DATABASE.test(input.databaseId)) throw new DatabaseProviderConflictError();
  const names = nativeAuthRoleNames(input.projectId, input.environmentId);
  for (const [name, limit] of [
    [names.runtime, 2],
    [names.migrator, 2],
    [names.backup, 2],
  ] as const) {
    const definition = { name, connection_limit: limit, bypass_rls: false } as const;
    const operation = await input.persistence.reserveRole({
      databaseId: input.databaseId,
      definition,
    });
    if (operation.state === "failed") throw new DatabaseProviderConflictError();
    if (operation.state === "dispatched" && operation.providerOperationId === null)
      return "reconciliation_required";
    if (operation.state !== "succeeded") {
      const action = await input.persistence.authorizeRole(operation);
      if (operation.providerOperationId === null && action !== "dispatch")
        return "reconciliation_required";
      if (operation.providerOperationId) {
        const observed = await input.provider.readOperation(operation.providerOperationId);
        if (
          observed.id !== operation.providerOperationId ||
          observed.projectId !== input.provider.projectId ||
          observed.databaseId !== input.databaseId ||
          observed.kind !== "database.role.create" ||
          observed.status === "failed"
        )
          throw new DatabaseProviderConflictError();
        if (observed.status !== "succeeded") return "reconciliation_required";
        await input.persistence.recordRole(operation, {
          providerOperationId: observed.id,
          state: "succeeded",
        });
      } else {
        const created = await input.provider.createRole(
          input.databaseId,
          definition,
          operation.idempotencyKey,
        );
        assertNativeAuthProviderRole(created, input.databaseId, definition);
        await input.persistence.recordRole(operation, {
          providerOperationId: null,
          state: "succeeded",
        });
      }
    }
    const role = (await input.provider.readRoles(input.databaseId)).find(
      (entry) => entry.name === name,
    );
    if (!role) return "reconciliation_required";
    assertNativeAuthProviderRole(role, input.databaseId, definition);
  }
  return "ready";
}

export function assertNativeAuthProviderRole(
  role: PgcfRole,
  databaseId: string,
  definition: PgcfRoleCreate,
): void {
  if (
    role.databaseId !== databaseId ||
    role.name !== definition.name ||
    role.owner ||
    role.bypassRls ||
    role.connectionLimit !== definition.connection_limit ||
    role.memberOf.length !== 0 ||
    role.validUntil !== null
  )
    throw new DatabaseProviderConflictError();
}

interface SqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
interface SqlRoles {
  withRole<T>(role: string, work: (client: SqlClient) => Promise<T>): Promise<T>;
}

/** Register only after provider roles and the actual database schema have been verified. */
export async function ensureNativeAuthRealm(input: {
  readonly provider: PgcfProjectProvider;
  readonly persistence: NativeAuthRolePersistence;
  readonly registry: NativeAuthRegistry;
  readonly registrationPersistence: NativeAuthRegistrationPersistence;
  readonly registration: Omit<NativeAuthRealmRegistration, "status">;
  readonly environmentIds: readonly string[];
  readonly existingRegistration: NativeAuthRealmRegistration | null;
  readonly readExistingRegistration: () => Promise<NativeAuthRealmRegistration | null>;
  readonly roles: SqlRoles;
  readonly authorize: () => Promise<void>;
  readonly recordPreparation: (input: {
    readonly registration: Omit<NativeAuthRealmRegistration, "status">;
    readonly migrator: string;
    readonly backup: string;
  }) => Promise<void>;
}): Promise<
  | { readonly status: "reconciliation_required" }
  | { readonly status: "ready"; readonly registration: NativeAuthRealmRegistration }
> {
  const registration = input.registration;
  const state = await ensureNativeAuthRoles({
    provider: input.provider,
    persistence: input.persistence,
    projectId: registration.projectId,
    environmentId: registration.environmentId,
    databaseId: registration.databaseId,
  });
  if (state !== "ready") return { status: "reconciliation_required" };
  const guardedRoles: SqlRoles = {
    async withRole(role, work) {
      await input.authorize();
      return input.roles.withRole(role, (client) =>
        work({
          async query(sql, values) {
            await input.authorize();
            return client.query(sql, values);
          },
        }),
      );
    },
  };
  const names = await prepareNativeAuthSchema({
    projectId: registration.projectId,
    environmentId: registration.environmentId,
    databaseId: registration.databaseId,
    roles: guardedRoles,
  });
  await guardedRoles.withRole(names.migrator, (client) =>
    applyNativeAuthMigration({
      projectId: registration.projectId,
      environmentId: registration.environmentId,
      databaseId: registration.databaseId,
      client,
    }),
  );
  await verifyNativeAuthSchema({
    projectId: registration.projectId,
    environmentId: registration.environmentId,
    databaseId: registration.databaseId,
    environmentIds: input.environmentIds,
    roles: guardedRoles,
    authorize: input.authorize,
  });
  await input.authorize();
  await input.recordPreparation({ registration, migrator: names.migrator, backup: names.backup });
  if (input.existingRegistration !== null) {
    const prior = input.existingRegistration;
    if (
      prior.status !== "active" ||
      prior.organizationId !== registration.organizationId ||
      prior.projectId !== registration.projectId ||
      prior.environmentId !== registration.environmentId ||
      prior.providerProjectId !== registration.providerProjectId ||
      prior.databaseId !== registration.databaseId ||
      prior.regionId !== registration.regionId ||
      prior.originHost !== registration.originHost ||
      prior.schema !== registration.schema ||
      prior.role !== registration.role ||
      prior.targetVersion !== registration.targetVersion ||
      prior.registryReference !== registration.registryReference
    )
      throw new DatabaseProviderConflictError();
    const current = await input.readExistingRegistration();
    if (
      !current ||
      Object.keys(current).sort().join(",") !== Object.keys(prior).sort().join(",") ||
      Object.keys(prior).some((key) => Reflect.get(current, key) !== Reflect.get(prior, key))
    )
      throw new DatabaseProviderConflictError();
    return { status: "ready", registration: prior };
  }
  return {
    status: "ready",
    registration: await registerNativeAuthRealm({
      provider: input.provider,
      registry: input.registry,
      persistence: input.registrationPersistence,
      registration,
      authorize: input.authorize,
    }),
  };
}

/** Rechecks real effective privileges after migration, including other realms and backup access. */
export async function verifyNativeAuthSchema(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly databaseId: string;
  readonly environmentIds: readonly string[];
  readonly roles: SqlRoles;
  readonly authorize: () => Promise<void>;
}): Promise<void> {
  const names = nativeAuthRoleNames(input.projectId, input.environmentId);
  if (
    !DATABASE.test(input.databaseId) ||
    input.environmentIds.length < 1 ||
    input.environmentIds.length > 2 ||
    new Set(input.environmentIds).size !== input.environmentIds.length ||
    !input.environmentIds.includes(input.environmentId)
  )
    throw new DatabaseProviderConflictError();
  const allowedRoles = [
    ...new Set(
      input.environmentIds.flatMap((environmentId) => {
        const role = nativeAuthRoleNames(input.projectId, environmentId);
        return [role.runtime, role.migrator, role.backup];
      }),
    ),
  ];
  for (const role of [names.runtime, names.migrator, names.backup]) {
    await input.authorize();
    await input.roles.withRole(role, async (client) => {
      const result = await client.query(
        `SELECT current_database()=$1 AND current_user=$2 AND session_user=$2 AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=$2 AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit=2 AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity'::timestamptz) AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)) AS safe`,
        [input.databaseId, role],
      );
      if (result.rows.length !== 1 || result.rows[0]?.["safe"] !== true)
        throw new DatabaseProviderConflictError();
    });
  }
  await input.authorize();
  await input.roles.withRole("app", async (client) => {
    const boundary = await client.query(
      `SELECT current_database()=$1 AND current_user='app' AND session_user='app' AND d.datdba=current_user::regrole AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE a.privilege_type IN ('CONNECT','TEMPORARY') AND a.grantee<>d.datdba AND (a.grantee=0 OR r.rolname<>ALL($6::text[]))) AND NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=$2 AND a.grantee NOT IN(n.nspowner,$3::regrole,$4::regrole,$5::regrole)) AS safe FROM pg_database d WHERE d.datname=current_database()`,
      [input.databaseId, names.schema, names.runtime, names.migrator, names.backup, allowedRoles],
    );
    if (boundary.rows.length !== 1 || boundary.rows[0]?.["safe"] !== true)
      throw new DatabaseProviderConflictError();
    const result = await client.query(
      `SELECT n.nspowner=current_user::regrole AND NOT has_schema_privilege($2,n.oid,'CREATE') AND NOT has_schema_privilege($3,n.oid,'CREATE') AND has_schema_privilege($2,n.oid,'USAGE') AND has_schema_privilege($3,n.oid,'USAGE') AND NOT EXISTS(SELECT 1 FROM pg_namespace other WHERE other.nspname LIKE 'omh_auth_%' AND other.nspname<>$1 AND has_schema_privilege($2,other.oid,'USAGE')) AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN('r','p','S','v','m','f') AND (c.relowner<>$4::regrole OR c.relrowsecurity OR c.relforcerowsecurity OR CASE WHEN c.relkind='S' THEN NOT has_sequence_privilege($2,c.oid,'USAGE') OR NOT has_sequence_privilege($3,c.oid,'SELECT') OR has_sequence_privilege($3,c.oid,'UPDATE') WHEN c.relname='omh_native_migrations' THEN has_table_privilege($2,c.oid,'SELECT,INSERT,UPDATE,DELETE') OR NOT has_table_privilege($3,c.oid,'SELECT') WHEN c.relname='native_preview_policy_migrations' THEN has_table_privilege($2,c.oid,'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege($3,c.oid,'SELECT,INSERT,UPDATE,DELETE') WHEN c.relname='native_preview_realm_policy' THEN NOT has_table_privilege($2,c.oid,'SELECT') OR NOT has_table_privilege($2,c.oid,'INSERT') OR NOT has_table_privilege($2,c.oid,'UPDATE') OR has_table_privilege($2,c.oid,'DELETE') OR has_table_privilege($3,c.oid,'SELECT,INSERT,UPDATE,DELETE') ELSE NOT has_table_privilege($2,c.oid,'SELECT') OR NOT has_table_privilege($2,c.oid,'INSERT') OR NOT has_table_privilege($2,c.oid,'UPDATE') OR NOT has_table_privilege($2,c.oid,'DELETE') OR NOT has_table_privilege($3,c.oid,'SELECT') OR has_table_privilege($3,c.oid,'INSERT,UPDATE,DELETE') END)) AND EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname='user' AND c.relkind='r') AS safe FROM pg_namespace n WHERE n.nspname=$1`,
      [names.schema, names.runtime, names.backup, names.migrator],
    );
    if (result.rows.length !== 1 || result.rows[0]?.["safe"] !== true)
      throw new DatabaseProviderConflictError();
  });
}

/** Prepare one private schema only after both provider and live PostgreSQL role checks succeed. */
export async function prepareNativeAuthSchema(input: {
  readonly projectId: string;
  readonly environmentId: string;
  readonly databaseId: string;
  readonly roles: SqlRoles;
}): Promise<ReturnType<typeof nativeAuthRoleNames>> {
  if (!DATABASE.test(input.databaseId)) throw new DatabaseProviderConflictError();
  const names = nativeAuthRoleNames(input.projectId, input.environmentId);
  await input.roles.withRole("app", async (client) => {
    await client.query("BEGIN");
    try {
      const owner = await client.query(
        "SELECT current_database()=$1 AND current_user='app' AND session_user='app' AND d.datdba=current_user::regrole AS safe FROM pg_database d WHERE d.datname=current_database()",
        [input.databaseId],
      );
      if (owner.rows.length !== 1 || owner.rows[0]?.["safe"] !== true)
        throw new DatabaseProviderConflictError();
      const checked = await client.query(
        `SELECT count(*)::int AS safe FROM pg_roles r WHERE r.rolname=ANY($1::text[]) AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit=2 AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity'::timestamptz) AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)`,
        [[names.runtime, names.migrator, names.backup]],
      );
      if (checked.rows[0]?.["safe"] !== 3) throw new DatabaseProviderConflictError();
      await client.query(`REVOKE ALL ON DATABASE ${input.databaseId} FROM PUBLIC`);
      await client.query(
        `GRANT CONNECT ON DATABASE ${input.databaseId} TO ${names.runtime}, ${names.migrator}, ${names.backup}`,
      );
      await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${names.schema}`);
      const schema = await client.query(
        `SELECT n.nspowner=current_user::regrole AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee NOT IN(n.nspowner,$2::regrole,$3::regrole,$4::regrole)) AS safe FROM pg_namespace n WHERE n.nspname=$1`,
        [names.schema, names.runtime, names.migrator, names.backup],
      );
      if (schema.rows.length !== 1 || schema.rows[0]?.["safe"] !== true)
        throw new DatabaseProviderConflictError();
      await client.query(`REVOKE ALL ON SCHEMA ${names.schema} FROM PUBLIC`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA ${names.schema} TO ${names.migrator}`);
      await client.query(
        `GRANT USAGE ON SCHEMA ${names.schema} TO ${names.runtime}, ${names.backup}`,
      );
      await client.query(
        `REVOKE CREATE ON SCHEMA ${names.schema} FROM ${names.runtime}, ${names.backup}`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
  {
    for (const role of [names.runtime, names.migrator, names.backup]) {
      await input.roles.withRole(role, async (client) => {
        const verified = await client.query(
          `SELECT current_database()=$2 AND current_user=$1 AND session_user=$1 AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit=2 AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil = 'infinity'::timestamptz) AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS safe FROM pg_roles r WHERE r.rolname=$1`,
          [role, input.databaseId],
        );
        if (verified.rows.length !== 1 || verified.rows[0]?.["safe"] !== true)
          throw new DatabaseProviderConflictError();
        await client.query(
          `ALTER ROLE ${role} SET search_path = ${role === names.backup ? "pg_catalog" : `${names.schema}, pg_catalog`}`,
        );
      });
    }
    await input.roles.withRole(names.migrator, async (client) => {
      await client.query("BEGIN");
      try {
        const unsafe = await client.query(
          `SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE n.nspname=$1 AND c.relkind IN ('r','p','S','v','m','f') AND (c.relowner<>$4::regrole OR a.grantee NOT IN(c.relowner,$2::regrole,$3::regrole))) AS unsafe`,
          [names.schema, names.runtime, names.backup, names.migrator],
        );
        if (unsafe.rows[0]?.["unsafe"] !== false) throw new DatabaseProviderConflictError();
        const unsafeDefaults = await client.query(
          `SELECT EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=$2::regrole AND (d.defaclnamespace=0 OR d.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)) AND a.grantee NOT IN($2::regrole,$3::regrole,$4::regrole)) AS unsafe`,
          [names.schema, names.migrator, names.runtime, names.backup],
        );
        if (unsafeDefaults.rows[0]?.["unsafe"] !== false) throw new DatabaseProviderConflictError();
        await client.query(
          `REVOKE ALL ON ALL TABLES IN SCHEMA ${names.schema} FROM PUBLIC, ${names.runtime}, ${names.backup}`,
        );
        await client.query(
          `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${names.schema} FROM PUBLIC, ${names.runtime}, ${names.backup}`,
        );
        await client.query(
          `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${names.schema} FROM PUBLIC, ${names.runtime}, ${names.backup}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} REVOKE ALL ON TABLES FROM PUBLIC, ${names.runtime}, ${names.backup}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} REVOKE ALL ON SEQUENCES FROM PUBLIC, ${names.runtime}, ${names.backup}`,
        );
        await client.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${names.schema} TO ${names.runtime}`,
        );
        const migrationTable = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
          `${names.schema}.omh_native_migrations`,
        ]);
        if (migrationTable.rows[0]?.["present"] === true)
          await client.query(
            `REVOKE ALL ON ${names.schema}.omh_native_migrations FROM PUBLIC, ${names.runtime}`,
          );
        await client.query(
          `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${names.schema} TO ${names.runtime}`,
        );
        await client.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA ${names.schema} TO ${names.backup}`,
        );
        await client.query(
          `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${names.schema} TO ${names.backup}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${names.runtime}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${names.runtime}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} GRANT SELECT ON TABLES TO ${names.backup}`,
        );
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${names.schema} GRANT SELECT ON SEQUENCES TO ${names.backup}`,
        );
        const previewPolicy = await client.query(
          "SELECT to_regclass($1) IS NOT NULL AS policy,to_regclass($2) IS NOT NULL AS ledger",
          [
            `${names.schema}.native_preview_realm_policy`,
            `${names.schema}.native_preview_policy_migrations`,
          ],
        );
        if (previewPolicy.rows[0]?.["policy"] === true) {
          await client.query(
            `REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ${names.schema}.native_preview_realm_policy FROM ${names.runtime}`,
          );
          await client.query(
            `REVOKE ALL ON ${names.schema}.native_preview_realm_policy FROM PUBLIC, ${names.backup}`,
          );
        }
        if (previewPolicy.rows[0]?.["ledger"] === true)
          await client.query(
            `REVOKE ALL ON ${names.schema}.native_preview_policy_migrations FROM PUBLIC, ${names.runtime}, ${names.backup}`,
          );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }
  return names;
}
