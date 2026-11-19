import { createHash } from "node:crypto";
import {
  assertProjectDatabaseAccessCredential,
  type ProjectDatabaseAccessCredential,
} from "@ohmyhost/contracts/database-access";
import {
  ProjectDatabaseAccessError,
  type IssuedProjectDatabaseAccess,
  type PgcfPostgresTarget,
  type ProjectDatabaseAccessRecord,
} from "@ohmyhost/database";
import { PERSISTING_FUNCTION_SIGNATURES } from "@ohmyhost/platform";
import type { PgcfProjectProvider, PgcfOperation, PgcfRole } from "@ohmyhost/provider-pgcf";
import { PgcfProviderError } from "@ohmyhost/provider-pgcf";
import { ensureProjectRoleGrants, type EnsuredRoleGrants } from "./pgcf-role-grants.js";

interface DatabaseAccessSqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}
export interface DatabaseAccessConnection {
  client: DatabaseAccessSqlClient;
  close(): Promise<void>;
}
export type PgcfAccessProvider = Pick<
  PgcfProjectProvider,
  | "projectId"
  | "createRole"
  | "deleteRole"
  | "readDatabase"
  | "readRoles"
  | "readOperation"
  | "readConnection"
>;
type AccessTarget = Pick<
  ProjectDatabaseAccessRecord,
  "accessId" | "providerProjectId" | "databaseId" | "roleName"
> & { readonly providerDeleteOperationId?: string | null };
interface Dependencies {
  readonly provider: PgcfAccessProvider;
  readonly connect: (uri: string, target: PgcfPostgresTarget) => Promise<DatabaseAccessConnection>;
  readonly recordOperation: (
    kind: "create" | "delete",
    operationId: string,
    previousOperationId?: string,
  ) => Promise<void>;
  readonly waitForCompletion?: boolean;
}

/** Durable access_id exists before dispatch and gives each logical API mutation one stable key. */
function mutationKey(accessId: string, action: "create" | "delete", retryOf?: string): string {
  const scope = retryOf ? `${accessId}:${action}:${retryOf}` : `${accessId}:${action}`;
  return `omh-access-${createHash("sha256").update(scope).digest("hex")}`;
}

async function completedOperation(
  provider: PgcfAccessProvider,
  operation: PgcfOperation,
  databaseId: string,
  waitForCompletion = true,
): Promise<boolean> {
  const deadline = performance.now() + 12_000;
  let current = operation;
  while (true) {
    if (current.projectId !== provider.projectId || current.databaseId !== databaseId)
      throw new ProjectDatabaseAccessError("scope");
    if (current.status === "succeeded") return true;
    if (current.status === "failed" || !waitForCompletion || performance.now() >= deadline)
      return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await provider.readOperation(current.id);
    if (current.id !== operation.id) throw new ProjectDatabaseAccessError("scope");
  }
}

/**
 * What a read credential has to prove with privileges, because the session default `default_transaction_read_only`
 * is only a convenience: any login can switch it off. The role must hold no way to leave data, volume or WAL behind:
 * no temporary tables, no CREATE on the database or on a schema, no EXECUTE on any persisting pg_catalog function
 * (the large-object creators and `pg_logical_emit_message`), and no write on any table column or sequence of any
 * schema, the platform's `pgcf` schema included. Held privileges include those inherited from the member role.
 */
const READ_ONLY_PROOF_SQL = `SELECT
  NOT has_database_privilege(r.oid,current_database(),'TEMPORARY,CREATE') AS no_database_write,
  NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS no_schema_create,
  NOT EXISTS(SELECT 1 FROM unnest($1::text[]) f WHERE has_function_privilege(r.oid,f::regprocedure,'EXECUTE')) AS no_persisting_function,
  NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
    AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')
      WHEN c.relkind IN ('r','p','v','m','f') THEN has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE')
      ELSE false END) AS no_data_write,
  NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.prosecdef AND n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND n.nspname<>'pgcf'
    AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS no_definer_function
  FROM pg_roles r WHERE r.rolname=current_user`;

/**
 * Each proof column with the fixed code that names it: the codes are the only thing a refusal reports. The last column
 * is a SECURITY DEFINER function, which runs with its owner's rights, so a read login may not execute one. The platform's
 * own `pgcf` functions are the PGCF baseline's business, and their outbox is closed to PUBLIC, which the data check covers.
 */
const READ_ONLY_PROOF_CHECKS = [
  ["no_database_write", "database_privilege"],
  ["no_schema_create", "schema_create"],
  ["no_persisting_function", "persisting_function"],
  ["no_data_write", "data_write"],
  ["no_definer_function", "definer_function"],
] as const;
export type ReadOnlyProofFailure = (typeof READ_ONLY_PROOF_CHECKS)[number][1];
/** A read credential refused because its role is not provably read-only; `failed` tells that apart from an outage. */
export class ReadOnlyProofError extends ProjectDatabaseAccessError {
  /** `grants` is what the owner grants did just before: `busy` (a migration held the lock) explains a refusal that a retry fixes. */
  constructor(
    readonly failed: readonly ReadOnlyProofFailure[],
    readonly grants: EnsuredRoleGrants | null,
  ) {
    super("scope");
  }
}

/** A new role is usable only after PGCF has applied the database generation that created it. */
async function observedGeneration(provider: PgcfAccessProvider, databaseId: string): Promise<void> {
  const deadline = performance.now() + 12_000;
  while (true) {
    const database = await provider.readDatabase(databaseId);
    if (database.id !== databaseId) throw new ProjectDatabaseAccessError("scope");
    if (database.observedGeneration === database.generation) return;
    if (performance.now() >= deadline) throw new Error("PGCF access creation is not complete");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function verifiedRole(role: PgcfRole | undefined, accepted: IssuedProjectDatabaseAccess): void {
  if (
    !role ||
    role.databaseId !== accepted.databaseId ||
    role.name !== accepted.roleName ||
    role.owner ||
    role.bypassRls ||
    role.connectionLimit !== 5 ||
    role.validUntil === null ||
    Date.parse(role.validUntil) !== Date.parse(accepted.expiresAt) ||
    role.memberOf.length !== 1 ||
    role.memberOf[0] !== accepted.memberRole ||
    !role.membershipOptions.inherit ||
    role.membershipOptions.set
  )
    throw new ProjectDatabaseAccessError("scope");
}

export async function issuePgcfDatabaseAccess(
  input: Dependencies & {
    readonly accepted: IssuedProjectDatabaseAccess;
    readonly projectId: string;
    readonly assertScope: () => Promise<void>;
  },
): Promise<ProjectDatabaseAccessCredential> {
  const { accepted, provider } = input;
  if (provider.projectId !== accepted.providerProjectId)
    throw new ProjectDatabaseAccessError("scope");
  await input.assertScope();
  // An environment that has not migrated since D466 still lets PUBLIC hold TEMPORARY, and the PGCF baseline takes the
  // persisting functions from its writing roles: the owner grants are brought up to date here, so the proof below does
  // not wait for a deploy. They involve only the migration and runtime roles, so they run before the new role exists and
  // a failure of the owner path leaves nothing to take back. The proof, not this call, decides whether the credential is
  // issued.
  const grants =
    accepted.mode === "read"
      ? await ensureProjectRoleGrants({
          provider,
          connect: input.connect,
          databaseId: accepted.databaseId,
          environmentId: accepted.dataEnvironmentId,
          originHost: accepted.originHost,
        })
      : null;
  const created = await provider.createRole(
    accepted.databaseId,
    {
      name: accepted.roleName,
      valid_until: accepted.expiresAt,
      connection_limit: 5,
      member_of: [accepted.memberRole],
      membership_options: { inherit: true, set: false },
      bypass_rls: false,
    },
    mutationKey(accepted.accessId, "create"),
  );
  verifiedRole(created, accepted);
  verifiedRole(
    (await provider.readRoles(accepted.databaseId)).find((role) => role.name === accepted.roleName),
    accepted,
  );
  await observedGeneration(provider, accepted.databaseId);
  const handle = await provider.readConnection(accepted.databaseId, accepted.roleName);
  if (handle.host !== accepted.originHost) throw new ProjectDatabaseAccessError("scope");
  const target: PgcfPostgresTarget = {
    provider: "pgcf",
    host: handle.host,
    databaseId: accepted.databaseId,
    role: accepted.roleName,
  };
  return handle.consume(async (connectionUri) => {
    // A login can set its own session defaults; creation, membership, expiry and revocation remain
    // PGCF API operations. No owner, CREATEROLE, SQL password or COMMENT authority is used here.
    const setup = await input.connect(connectionUri, target);
    try {
      for (const statement of [
        "ALTER ROLE CURRENT_USER SET statement_timeout='60s'",
        "ALTER ROLE CURRENT_USER SET lock_timeout='5s'",
        "ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout='30s'",
        ...(accepted.mode === "read"
          ? ["ALTER ROLE CURRENT_USER SET default_transaction_read_only=on"]
          : []),
      ])
        await setup.client.query(statement);
    } finally {
      await setup.close();
    }
    const verification = await input.connect(connectionUri, target);
    try {
      const proof = await verification.client.query(
        `SELECT current_user,session_user,current_setting('default_transaction_read_only') AS read_only,
        r.rolvaliduntil AS valid_until,r.rolconnlimit AS connection_limit,
        r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AS restricted,
        EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid AND m.roleid=$1::regrole AND m.inherit_option AND NOT m.set_option) AS expected_membership,
        NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid AND m.roleid<>$1::regrole) AS no_other_membership
        FROM pg_roles r WHERE r.rolname=current_user`,
        [accepted.memberRole],
      );
      const row = proof.rows[0];
      const validUntil = row?.["valid_until"];
      if (
        !row ||
        row["current_user"] !== accepted.roleName ||
        row["session_user"] !== accepted.roleName ||
        row["restricted"] !== true ||
        row["expected_membership"] !== true ||
        row["no_other_membership"] !== true ||
        row["connection_limit"] !== 5 ||
        !(validUntil instanceof Date || typeof validUntil === "string") ||
        // PGCF applies VALID UNTIL at the exact whole-second floor; API metadata retains the nominal milliseconds.
        new Date(validUntil).getTime() !==
          Math.floor(Date.parse(accepted.expiresAt) / 1000) * 1000 ||
        (accepted.mode === "read" && row["read_only"] !== "on")
      )
        throw new ProjectDatabaseAccessError("scope");
      if (accepted.mode === "read") {
        // A database whose PGCF baseline does not cover all five functions still lets PUBLIC persist state or
        // WAL; the credential waits for it.
        const privileges = (
          await verification.client.query(READ_ONLY_PROOF_SQL, [PERSISTING_FUNCTION_SIGNATURES])
        ).rows[0];
        const failed = READ_ONLY_PROOF_CHECKS.filter(
          ([column]) => privileges?.[column] !== true,
        ).map(([, code]) => code);
        if (failed.length > 0) throw new ReadOnlyProofError(failed, grants);
      }
    } finally {
      await verification.close();
    }
    await input.assertScope();
    const credential: ProjectDatabaseAccessCredential = {
      provider: "pgcf",
      transport: "wss",
      websocket_url: `wss://${accepted.originHost}/`,
      access_id: accepted.accessId,
      environment: accepted.environment,
      mode: accepted.mode,
      role_name: accepted.roleName,
      host: accepted.originHost,
      database: accepted.databaseId,
      label: accepted.label,
      state: "active",
      issued_at: accepted.issuedAt,
      expires_at: accepted.expiresAt,
      revoked_at: null,
      revocation_reason: null,
      connection_uri: connectionUri,
      psql_command: `ohmyhost database psql --project ${input.projectId} --environment ${accepted.environment} --mode ${accepted.mode}`,
    };
    assertProjectDatabaseAccessCredential(credential);
    return credential;
  });
}

/**
 * PGCF keeps the row of a deleted database and answers its roles endpoint (and every role call) with 404, so a role
 * of such a database can never be listed or deleted again. Only that exact answer, the same database of this PGCF
 * project with its desired and observed state both `deleted`, ends its roles: a 404 on its own, a database still
 * deleting, a live one and a failing read prove nothing and leave the access to the next pass.
 */
async function databaseGone(provider: PgcfAccessProvider, databaseId: string): Promise<boolean> {
  try {
    const database = await provider.readDatabase(databaseId);
    return (
      database.id === databaseId &&
      database.projectId === provider.projectId &&
      database.desiredState === "deleted" &&
      database.observedState === "deleted"
    );
  } catch (error) {
    if (error instanceof PgcfProviderError && error.status === 404) return false;
    throw error;
  }
}

/** Whether PGCF still lists the role; the roles of a database PGCF reports deleted are gone with it. */
async function rolePresent(
  provider: PgcfAccessProvider,
  access: Pick<AccessTarget, "databaseId" | "roleName">,
): Promise<boolean> {
  try {
    return (await provider.readRoles(access.databaseId)).some(
      (role) => role.name === access.roleName,
    );
  } catch (error) {
    if (
      error instanceof PgcfProviderError &&
      error.status === 404 &&
      (await databaseGone(provider, access.databaseId))
    )
      return false;
    throw error;
  }
}

export async function revokePgcfDatabaseAccess(
  input: Dependencies & { readonly access: AccessTarget },
): Promise<{ dropped: boolean }> {
  const { access, provider } = input;
  if (provider.projectId !== access.providerProjectId)
    throw new ProjectDatabaseAccessError("scope");
  let operation: PgcfOperation;
  let stored: PgcfOperation | null = null;
  if (access.providerDeleteOperationId) {
    try {
      stored = await provider.readOperation(access.providerDeleteOperationId);
    } catch (error) {
      // The recorded deletion belongs to a database that may have been deleted since, and PGCF then no longer
      // serves its operation; only a database confirmed gone ends the access without it.
      if (
        error instanceof PgcfProviderError &&
        error.status === 404 &&
        (await databaseGone(provider, access.databaseId))
      )
        return { dropped: true };
      throw error;
    }
  }
  if (stored && stored.status !== "failed") operation = stored;
  else {
    try {
      // A failed deletion (for example PGCF role_not_droppable) is re-issued under a new key.
      const accepted = await provider.deleteRole(
        access.databaseId,
        access.roleName,
        stored
          ? mutationKey(access.accessId, "delete", stored.id)
          : mutationKey(access.accessId, "delete"),
      );
      operation = accepted.operation;
      // A failed deletion is re-issued under a key derived from the failed operation id, and the new
      // operation replaces the failed one in the access row (compare-and-set on the failed id), so the
      // next pass derives its key from the newest failed id.
      await input.recordOperation("delete", operation.id, stored?.id);
    } catch (error) {
      if (
        error instanceof PgcfProviderError &&
        error.status === 404 &&
        !(await rolePresent(provider, access))
      )
        return { dropped: true };
      throw error;
    }
  }
  const done = await completedOperation(
    provider,
    operation,
    access.databaseId,
    input.waitForCompletion,
  );
  // A deletion that stays pending because its database was deleted meanwhile is finished by that deletion. A failed
  // one is issued again by the next pass, which meets the same 404 and the same rule.
  if (!done)
    return {
      dropped: operation.status !== "failed" && (await databaseGone(provider, access.databaseId)),
    };
  return { dropped: !(await rolePresent(provider, access)) };
}
