import type { PgcfManagementPersistence } from "./pgcf-persistence.js";
import { databaseSizeForClass } from "@ohmyhost/contracts/database-sizes";
import {
  DatabaseProviderConflictError,
  pgcfBackupRoleName,
  type PgcfDatabaseDeletionRequest,
  type AnyProjectDatabaseRegistrationMetadata,
  type DatabaseProviderClaim,
  type DatabaseProviderOperation,
  type DatabaseProviderScope,
  type DatabaseProviderTarget,
  type PgcfProjectDatabaseRegistrationMetadata,
  type PgcfPostgresTarget,
} from "@ohmyhost/database";
import {
  admitMigrationsAfterAppliedPrefix,
  DatabaseMigrationExecutionError,
  executeExpandOnlyMigrations,
  PROJECT_SQL_DEFINER_REVOKE_STATEMENT,
  projectSqlRoleGrants,
  projectSqlRoleName,
  projectSqlRuntimeGrants,
  parseUlid,
  type DatabaseMigrationClient,
} from "@ohmyhost/platform";
import {
  PgcfProjectProvider,
  PgcfProviderError,
  type PgcfDatabase,
  type PgcfMutationReceipt,
  type PgcfOperation,
  type PgcfRole,
  type PgcfRoleCreate,
} from "@ohmyhost/provider-pgcf";
import {
  WebhookListLimitError,
  databaseWebhooks,
  webhookCleanupKey,
} from "./pgcf-database-events.js";
import { migrationTransaction } from "./pgcf-migration-session.js";
import { migrationBundleDigest, parseMigrationRequest } from "./request-parsing.js";
import {
  adaptGeneratedServiceRolePredicate,
  isDatabaseOwnerLogin,
  prepareProjectRlsHelpers,
  verifyProjectSqlRoleLogin,
} from "./sql-role-bootstrap.js";

export interface PgcfDatabaseAdminBinding {
  register(
    input: Omit<PgcfProjectDatabaseRegistrationMetadata, "status"> & {
      readonly connectionString: string;
    },
  ): Promise<AnyProjectDatabaseRegistrationMetadata>;
  inspect(
    input: DatabaseProviderScope & { readonly region: "us" | "eu" },
  ): Promise<AnyProjectDatabaseRegistrationMetadata | null>;
  revoke(
    input: DatabaseProviderScope & {
      readonly operationId: string;
      readonly region: "us" | "eu";
      readonly registrationVersion: number;
      readonly expectedRegistration: AnyProjectDatabaseRegistrationMetadata;
    },
  ): Promise<AnyProjectDatabaseRegistrationMetadata>;
  rebind(input: {
    readonly expectedRegistration: AnyProjectDatabaseRegistrationMetadata;
    readonly registration: Omit<PgcfProjectDatabaseRegistrationMetadata, "status"> & {
      readonly connectionString: string;
    };
  }): Promise<AnyProjectDatabaseRegistrationMetadata>;
}
interface PgcfConnection {
  readonly client: DatabaseMigrationClient;
  close(): Promise<void>;
}
interface PgcfManagementBase {
  readonly provider: PgcfProjectProvider;
  readonly connect: (uri: string, target: PgcfPostgresTarget) => Promise<PgcfConnection>;
  readonly admin: (region: "us" | "eu") => PgcfDatabaseAdminBinding;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}
export type PgcfManagementDependencies = PgcfManagementBase & {
  readonly persistence: PgcfManagementPersistence;
};
type PgcfTarget = Extract<DatabaseProviderTarget, { provider: "pgcf" }>;
const pending = () => ({
  status: "reconciliation_required" as const,
  reason: "provider_provisioning" as const,
});
/** One placement shares this wait budget across the database and all four roles. */
export const PGCF_PLACEMENT_WAIT_ATTEMPTS = 30;
export const PGCF_PLACEMENT_WAIT_INTERVAL_MS = 1000;
export const PGCF_PLACEMENT_WAIT_BUDGET_MS = 45_000;
/** Re-reads of a PGCF delete operation within one call before the deletion goes to reconciliation. */
export const PGCF_DELETE_WAIT_ATTEMPTS = 30;
/** Pause between re-reads of a PGCF delete operation, in milliseconds. */
export const PGCF_DELETE_WAIT_INTERVAL_MS = 1000;

/** Pause before the one retry of a deployment's owner grants when the migrations lock is held, in milliseconds. */
export const OWNER_GRANTS_RETRY_DELAY_MS = 10_000;

/** The production pause between provider re-reads. */
export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Every provider mutation is preceded by committed Control authorization and idempotency. */
export function createPgcfManagement(dependencies: PgcfManagementDependencies) {
  const { provider, persistence } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? pause;
  async function resolveClaim(
    raw: unknown,
  ): Promise<DatabaseProviderClaim & { readonly regionId: "us-dev" | "eu-dev" }> {
    const value = record(raw);
    const input = logicalScope(value),
      operationId = id(value["operationId"]),
      claimId = id(value["claimId"]);
    return persistence.resolveClaim({ ...input, operationId, claimId });
  }

  async function target(scope: DatabaseProviderScope): Promise<PgcfTarget> {
    const current = await persistence.readTarget(scope);
    if (!current || current.provider !== "pgcf" || current.providerProjectId !== provider.projectId)
      throw new DatabaseProviderConflictError();
    return current;
  }
  async function connection<T>(
    claim: DatabaseProviderClaim,
    placement: PgcfTarget,
    role: string,
    work: (client: DatabaseMigrationClient) => Promise<T>,
    verify = true,
    progress?: (phase: "credential" | "connect" | "sql" | "close") => void,
  ): Promise<T> {
    await persistence.authorizeClaim({ ...claim, step: "database.create" });
    progress?.("credential");
    const handle = await provider.readConnection(placement.databaseId, role);
    return handle.consume(async (uri) => {
      progress?.("connect");
      const connected = await dependencies.connect(uri, {
        provider: "pgcf",
        host: handle.host,
        databaseId: placement.databaseId,
        role,
      });
      const close = async () => {
        try {
          await connected.close();
        } catch (error) {
          progress?.("close");
          throw error;
        }
      };
      try {
        progress?.("sql");
        if (role === "app") {
          if (!(await isDatabaseOwnerLogin(connected.client, role)))
            throw new DatabaseProviderConflictError();
        } else if (verify) await verifyProjectSqlRoleLogin(connected.client, role);
        return await work(connected.client);
      } finally {
        await close();
      }
    });
  }
  async function persistObservation(
    operation: DatabaseProviderOperation,
    observation: PgcfMutationReceipt,
  ): Promise<boolean> {
    const { database, operation: observed } = observation;
    if (
      observed.projectId !== operation.providerProjectId ||
      database.projectId !== operation.providerProjectId
    )
      throw new DatabaseProviderConflictError();
    await persistence.recordOperation(
      operation,
      {
        databaseId: database.id,
        providerOperationId: observed.id,
        state:
          observed.status === "failed"
            ? "failed"
            : observed.status === "succeeded"
              ? "succeeded"
              : "pending",
      },
      now().toISOString(),
    );
    if (observed.status === "failed") throw new Error("PGCF management operation failed");
    return observed.status === "succeeded" && database.observedGeneration === database.generation;
  }
  async function observe(
    operation: DatabaseProviderOperation,
  ): Promise<PgcfMutationReceipt | null> {
    if (!operation.databaseId || !operation.providerOperationId) return null;
    const [database, observed] = await Promise.all([
      provider.readDatabase(operation.databaseId),
      provider.readOperation(operation.providerOperationId),
    ]);
    const created = operation.step === "database.create";
    if (
      database.id !== observed.databaseId ||
      observed.projectId !== operation.providerProjectId ||
      (created &&
        (observed.kind !== "database.create" ||
          database.name !== operation.requestBody["name"] ||
          database.regionId !== operation.requestBody["region_id"] ||
          database.sizeClassId !== operation.requestBody["size_class_id"])) ||
      (database.generation !== observed.generation &&
        !(created && observed.status === "succeeded" && database.generation > observed.generation))
    )
      throw new DatabaseProviderConflictError();
    return { database, operation: observed };
  }
  async function waitForPlacement(
    operation: DatabaseProviderOperation,
    initial: PgcfMutationReceipt,
    budget: { remaining: number; deadline: number },
  ): Promise<PgcfMutationReceipt | null> {
    let observation = initial;
    const originalDatabaseId = initial.database.id,
      originalOperationId = initial.operation.id;
    for (;;) {
      const { database, operation: providerOperation } = observation;
      const creatingDatabase = operation.step === "database.create";
      if (
        database.id !== originalDatabaseId ||
        providerOperation.id !== originalOperationId ||
        database.id !== providerOperation.databaseId ||
        (operation.databaseId !== null && operation.databaseId !== database.id) ||
        (operation.providerOperationId !== null &&
          operation.providerOperationId !== providerOperation.id) ||
        providerOperation.kind !== "database.create" ||
        (!creatingDatabase && operation.requestBody["database_id"] !== database.id) ||
        (creatingDatabase &&
          (database.name !== operation.requestBody["name"] ||
            database.regionId !== operation.requestBody["region_id"] ||
            database.sizeClassId !== operation.requestBody["size_class_id"])) ||
        (database.generation !== providerOperation.generation &&
          !(
            creatingDatabase &&
            providerOperation.status === "succeeded" &&
            database.generation > providerOperation.generation
          ))
      )
        throw new DatabaseProviderConflictError();
      if (await persistObservation(operation, observation)) return observation;
      if (budget.remaining === 0 || performance.now() >= budget.deadline) return null;
      budget.remaining--;
      await sleep(PGCF_PLACEMENT_WAIT_INTERVAL_MS);
      if (performance.now() >= budget.deadline) return null;
      // Always observe the operation returned by the original mutation, never dispatch another create.
      const next = await observe({
        ...operation,
        databaseId: observation.database.id,
        providerOperationId: observation.operation.id,
      });
      if (next === null) throw new DatabaseProviderConflictError();
      observation = next;
    }
  }
  async function ensureRole(
    claim: DatabaseProviderClaim,
    placement: PgcfTarget,
    definition: PgcfRoleCreate,
  ): Promise<boolean> {
    const existing = (await provider.readRoles(placement.databaseId)).find(
      (role) => role.name === definition.name,
    );
    if (existing) {
      assertRole(existing, definition);
      const pendingRole = await persistence.readOperation({
        ...claim,
        step: `role.create:${definition.name}`,
      });
      if (pendingRole && pendingRole.state !== "succeeded") {
        if (pendingRole.state === "failed") throw new DatabaseProviderConflictError();
        // A lost response can leave the role visible before its operation id was recorded.
        await roleReady(claim, placement, definition);
        if (pendingRole.state === "reserved")
          await persistence.beginOperation(pendingRole, now().toISOString());
        await persistence.recordOperation(
          pendingRole,
          { databaseId: placement.databaseId, providerOperationId: null, state: "succeeded" },
          now().toISOString(),
        );
      }
      await roleReady(claim, placement, definition);
      return true;
    }
    const operation = await persistence.reserveOperation({
      ...claim,
      step: `role.create:${definition.name}`,
      providerProjectId: placement.providerProjectId,
      requestBody: { database_id: placement.databaseId, ...definition },
    });
    if (operation.state !== "succeeded") {
      if (operation.state === "failed") throw new DatabaseProviderConflictError();
      await persistence.beginOperation(operation, now().toISOString());
      // The exact stored idempotency key safely recovers an accepted response after transport loss.
      const created = await provider.createRole(
        placement.databaseId,
        definition,
        operation.idempotencyKey,
      );
      assertRole(created, definition);
      await persistence.recordOperation(
        operation,
        {
          databaseId: placement.databaseId,
          providerOperationId: null,
          state: "succeeded",
        },
        now().toISOString(),
      );
    }
    const roles = await provider.readRoles(placement.databaseId),
      current = roles.find((role) => role.name === definition.name);
    if (!current) return false;
    assertRole(current, definition);
    await roleReady(claim, placement, definition);
    return true;
  }
  async function roleReady(
    claim: DatabaseProviderClaim,
    placement: PgcfTarget,
    definition: PgcfRoleCreate,
  ): Promise<void> {
    let phase: "claim" | "credential" | "connect" | "sql" | "close" | "verification" = "claim";
    let ready: boolean;
    try {
      ready = await connection(
        claim,
        placement,
        definition.name,
        async (client) => {
          const result = await client.query<{
            safe: boolean;
            memberships: { name: string; admin: boolean; inherit: boolean; set: boolean }[];
          }>(
            `SELECT role.rolname=$1 AND current_user=$1 AND session_user=$1 AND role.rolcanlogin AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole AND NOT role.rolreplication AND role.rolbypassrls=$2 AND role.rolconnlimit=$3 AS safe,COALESCE((SELECT jsonb_agg(jsonb_build_object('name',parent.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY parent.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=role.oid),'[]'::jsonb) memberships FROM pg_roles role WHERE role.rolname=$1`,
            [definition.name, definition.bypass_rls ?? false, definition.connection_limit ?? -1],
          );
          const row = result.rows[0];
          const members = [...(definition.member_of ?? [])].sort().map((name) => ({
            name,
            admin: false,
            inherit: definition.membership_options?.inherit ?? true,
            set: definition.membership_options?.set ?? true,
          }));
          return (
            row?.safe === true &&
            Array.isArray(row.memberships) &&
            row.memberships.length === members.length &&
            row.memberships.every(
              (member, index) =>
                member.name === members[index]?.name &&
                member.admin === false &&
                member.inherit === members[index]?.inherit &&
                member.set === members[index]?.set,
            )
          );
        },
        false,
        (current) => {
          phase = current;
        },
      );
      if (!ready) {
        phase = "verification";
        throw new DatabaseProviderConflictError();
      }
    } catch (error) {
      // The diagnostic contains only a fixed phase; the original error still reaches Workflow handling.
      console.error(JSON.stringify({ event: "pgcf_role_readiness_failed", phase }));
      throw error;
    }
  }
  async function placeProject(raw: unknown) {
    const claim = await resolveClaim(raw);
    const budget = {
      remaining: PGCF_PLACEMENT_WAIT_ATTEMPTS,
      deadline: performance.now() + PGCF_PLACEMENT_WAIT_BUDGET_MS,
    };
    let current = await persistence.readTarget(claim);
    if (current && current.provider !== "pgcf") throw new DatabaseProviderConflictError();
    if (!current) {
      // A create reserved by an earlier placement is replayed with the body it was placed with, so its class never changes.
      const reserved = await persistence.readOperation({ ...claim, step: "database.create" });
      const replayed = reserved?.requestBody;
      const fresh = replayed === undefined;
      const targetVersion = fresh
        ? await persistence.nextTargetVersion(claim)
        : Number(replayed["target_version"]);
      // Every new database starts at the smallest class, Paid or not: a lapsed Paid project must stay usable on Free.
      const size = fresh
        ? databaseSizeForClass("r256-s500m")
        : databaseSizeForClass(String(replayed["size_class_id"]));
      const name = fresh
        ? `ohmyho-${claim.projectId.toLowerCase()}-${claim.physicalEnvironmentId.toLowerCase()}`
        : String(replayed["name"]);
      const operation = await persistence.reserveOperation({
        ...claim,
        step: "database.create",
        providerProjectId: provider.projectId,
        requestBody: {
          name,
          region_id: claim.regionId,
          size_class_id: size.sizeClassId,
          target_version: targetVersion,
        },
      });
      await persistence.beginOperation(operation, now().toISOString());
      const observed =
        (await observe(operation)) ??
        (await provider.createDatabase({
          name,
          regionId: claim.regionId,
          sizeClassId: size.sizeClassId,
          idempotencyKey: operation.idempotencyKey,
        }));
      assertDatabaseRecipe(observed.database, size.sizeClassId, claim.regionId);
      const ready = await waitForPlacement(operation, observed, budget);
      if (!ready || !canProvisionDatabase(ready.database)) return pending();
      const placement: PgcfTarget = {
        organizationId: claim.organizationId,
        projectId: claim.projectId,
        physicalEnvironmentId: claim.physicalEnvironmentId,
        targetVersion,
        provider: "pgcf",
        providerProjectId: provider.projectId,
        databaseId: observed.database.id,
        regionId: claim.regionId,
        sizeClassId: size.sizeClassId,
        runtimeRole: projectSqlRoleName(claim.physicalEnvironmentId, "runtime"),
        credentialReference: `registry:${claim.physicalEnvironmentId}`,
        activatedAt: null,
      };
      await persistence.activateNewTarget(claim, placement, now().toISOString());
      current = placement;
    }
    if (current.providerProjectId !== provider.projectId || current.regionId !== claim.regionId)
      throw new DatabaseProviderConflictError();
    const database = await provider.readDatabase(current.databaseId);
    assertDatabaseRecipe(database, current.sizeClassId, current.regionId);
    if (!canProvisionDatabase(database)) return pending();
    const size = databaseSizeForClass(current.sizeClassId);
    for (const purpose of ["migration", "runtime", "readonly"] as const)
      if (
        !(await ensureRole(claim, current, {
          name: projectSqlRoleName(claim.physicalEnvironmentId, purpose),
          connection_limit: purpose === "runtime" ? Math.min(5, size.maxConnections) : 2,
          bypass_rls: false,
        }))
      )
        return pending();
    if (
      !(await ensureRole(claim, current, {
        name: pgcfBackupRoleName(claim.physicalEnvironmentId),
        connection_limit: 2,
        member_of: [projectSqlRoleName(claim.physicalEnvironmentId, "readonly")],
        membership_options: { inherit: true, set: false },
        bypass_rls: true,
      }))
    )
      return pending();
    return {
      status: "ready" as const,
      provider: "pgcf" as const,
      providerProjectId: current.providerProjectId,
      databaseId: current.databaseId,
      outcome: "ready" as const,
    };
  }
  async function migrateProject(raw: unknown) {
    const parsed = parseMigrationRequest(raw);
    // Only the structure: the SQL policy applies to the files the database ledger has not applied, and only the
    // executor reads that ledger under the migrations lock.
    admitMigrationsAfterAppliedPrefix(parsed.migrations, parsed.migrations.length);
    const digest = await migrationBundleDigest(parsed.migrations, parsed.auth),
      claim = await resolveClaim(raw),
      placement = await target(claim);
    // The same migrations lock as the grants of a read credential (ensureProjectRoleGrants): two writers of the
    // database's ACL rows must not overlap. A lock held for the lock timeout (5 s) is retried once after a pause, so a
    // table, watch or short migration that holds it never parks the deployment: at most 5 s + 10 s + 5 s inside the
    // step's two minutes. Only a lock that is still held answers reconciliation_required, with nothing applied.
    const applyOwnerGrants = () =>
      connection(claim, placement, "app", (client) =>
        migrationTransaction(
          client,
          async () => {
            for (const sql of projectSqlRoleGrants(
              claim.physicalEnvironmentId,
              placement.databaseId,
            ).filter((sql) => !sql.startsWith("ALTER ROLE") && !sql.startsWith("DO $omh_timeout$")))
              await client.query(sql);
            return "applied" as const;
          },
          "busy" as const,
        ),
      );
    let ownerGrants = await applyOwnerGrants();
    if (ownerGrants === "busy") {
      await sleep(OWNER_GRANTS_RETRY_DELAY_MS);
      ownerGrants = await applyOwnerGrants();
    }
    if (ownerGrants === "busy")
      return {
        status: "reconciliation_required" as const,
        reason: "owner_grants_busy" as const,
      };
    await connection(claim, placement, placement.runtimeRole, async (client) => {
      for (const sql of projectSqlRoleGrants(
        claim.physicalEnvironmentId,
        placement.databaseId,
      ).filter((sql) => sql.startsWith("ALTER ROLE") || sql.startsWith("DO $omh_timeout$")))
        await client.query(sql);
    });
    let migration;
    try {
      migration = await connection(
        claim,
        placement,
        projectSqlRoleName(claim.physicalEnvironmentId, "migration"),
        async (client) => {
          await prepareProjectRlsHelpers(client, claim.physicalEnvironmentId);
          const receipt = await executeExpandOnlyMigrations(client, parsed.migrations);
          await client.query(PROJECT_SQL_DEFINER_REVOKE_STATEMENT);
          await adaptGeneratedServiceRolePredicate(client);
          const schemas = await client.query<{ schema_name: "auth" | "private" | "extensions" }>(
            "SELECT nspname schema_name FROM pg_namespace WHERE nspname IN ('auth','private','extensions') AND nspowner=current_user::regrole ORDER BY nspname",
          );
          for (const sql of projectSqlRuntimeGrants(
            claim.physicalEnvironmentId,
            parsed.auth.provider === "better-auth",
            schemas.rows.map((row) => row.schema_name),
          ))
            await client.query(sql);
          return receipt;
        },
      );
    } catch (error) {
      if (!(error instanceof DatabaseMigrationExecutionError)) throw error;
      if (error.reason === "uncertain") return { status: "reconciliation_required" as const };
      return {
        status: "failed" as const,
        errorCode: "DATABASE_MIGRATION_FAILED" as const,
        migration: {
          reason: error.reason,
          path: error.path,
          ...(error.statementIndex === undefined ? {} : { statementIndex: error.statementIndex }),
          ...(error.sqlstate === undefined ? {} : { sqlstate: error.sqlstate }),
        },
      };
    }
    await persistence.recordMigrationReceipt({
      claim,
      providerProjectId: placement.providerProjectId,
      databaseId: placement.databaseId,
      bundleSha256: Buffer.from(digest).toString("hex"),
      appliedPaths: migration.appliedPaths,
      replayedPaths: migration.replayedPaths,
      completedAt: migration.completedAt,
    });
    const handle = await provider.readConnection(placement.databaseId, placement.runtimeRole);
    const reserved = await persistence.reserveRegistration(claim, handle.host);
    const observed = reserved.completed
      ? await dependencies
          .admin(reserved.registration.region)
          .inspect(inspectionScope(reserved.registration))
      : await handle.consume(async (connectionString) => {
          const { status: _status, ...registration } = reserved.registration;
          void _status;
          // A same-target PGCF refresh uses register so existing environment authorizations survive.
          // Rebind is reserved for the explicitly authorized legacy Neon cutover.
          if (
            reserved.previous &&
            reserved.previous.region === registration.region &&
            "branchId" in reserved.previous &&
            !("provider" in reserved.previous)
          )
            return dependencies.admin(registration.region).rebind({
              expectedRegistration: reserved.previous,
              registration: { ...registration, connectionString },
            });
          if (reserved.previous && reserved.previous.region !== registration.region) {
            const revoked = await dependencies.admin(reserved.previous.region).revoke({
              ...inspectionScope(reserved.previous),
              operationId: claim.operationId,
              registrationVersion: reserved.previous.registrationVersion + 1,
              expectedRegistration: reserved.previous,
            });
            assertRegistration(revoked, {
              ...reserved.previous,
              operationId: claim.operationId,
              registrationVersion: reserved.previous.registrationVersion + 1,
              status: "revoked",
            });
          }
          return dependencies
            .admin(registration.region)
            .register({ ...registration, connectionString });
        });
    assertRegistration(observed, reserved.registration);
    if (!reserved.completed) await persistence.putRegistration(claim, reserved.registration);
    return {
      status: "ready" as const,
      provider: "pgcf" as const,
      providerProjectId: placement.providerProjectId,
      databaseId: placement.databaseId,
      appliedPaths: migration.appliedPaths,
      replayedPaths: migration.replayedPaths,
      completedAt: migration.completedAt,
      databaseRegistration: reserved.registration,
    };
  }
  async function readRuntimeBinding(raw: unknown) {
    const logical = logicalScope(record(raw));
    const receipt = await persistence.readRuntimeBinding(logical);
    return receipt?.status === "active" &&
      receipt.authorizedEnvironmentIds.includes(logical.environmentId)
      ? { status: "ready" as const, databaseRegistration: receipt }
      : { status: "unavailable" as const };
  }
  async function reauthorizeDataEnvironment(raw: unknown) {
    const value = record(raw),
      logical = logicalScope(value);
    if (!Array.isArray(value["authorizedEnvironmentIds"]))
      throw new DatabaseProviderConflictError();
    const request = {
      ...logical,
      operationId: id(value["operationId"]),
      claimId: id(value["claimId"]),
      physicalEnvironmentId: id(value["physicalEnvironmentId"]),
      authorizedEnvironmentIds: value["authorizedEnvironmentIds"].map(id),
    };
    const reserved = await persistence.reserveReauthorization(request);
    if (!reserved) return { status: "ready" as const, databaseRegistration: null };
    const { registration, previous } = reserved,
      admin = dependencies.admin(registration.region);
    let observed: AnyProjectDatabaseRegistrationMetadata | null;
    if (reserved.completed) observed = await admin.inspect(inspectionScope(registration));
    else if (registration.status === "revoked")
      observed = await admin.revoke({
        organizationId: registration.organizationId,
        projectId: registration.projectId,
        physicalEnvironmentId: registration.physicalEnvironmentId,
        operationId: registration.operationId,
        region: registration.region,
        registrationVersion: registration.registrationVersion,
        expectedRegistration: previous,
      });
    else {
      const handle = await provider.readConnection(
        registration.databaseId,
        registration.originUser,
      );
      if (handle.host !== registration.originHost) throw new DatabaseProviderConflictError();
      observed = await handle.consume((connectionString) => {
        const { status: _status, ...input } = registration;
        void _status;
        return admin.register({ ...input, connectionString });
      });
    }
    assertRegistration(observed, registration);
    if (!reserved.completed) await persistence.putReauthorization(request, registration);
    return { status: "ready" as const, databaseRegistration: registration };
  }
  async function deleteProject(raw: unknown) {
    const value = record(raw);
    const request: PgcfDatabaseDeletionRequest = {
      organizationId: id(value["organizationId"]),
      projectId: id(value["projectId"]),
      operationId: id(value["operationId"]),
      physicalEnvironmentId: id(value["physicalEnvironmentId"]),
      providerProjectId: String(value["providerProjectId"]),
      databaseId: String(value["databaseId"]),
      registrationVersion:
        value["registrationVersion"] === null ? null : Number(value["registrationVersion"]),
    };
    if (
      request.providerProjectId !== provider.projectId ||
      !/^[a-z][a-z0-9]{19}$/u.test(request.databaseId) ||
      (request.registrationVersion !== null &&
        (!Number.isSafeInteger(request.registrationVersion) || request.registrationVersion < 1))
    )
      throw new DatabaseProviderConflictError();
    const authorized = await persistence.readDeletion(request);
    let registration = authorized.registration;
    const admin = dependencies.admin(authorized.region);
    if (registration?.status === "active") {
      const expected: PgcfProjectDatabaseRegistrationMetadata = {
        ...registration,
        status: "revoked",
        operationId: request.operationId,
        registrationVersion: registration.registrationVersion + 1,
      };
      const existing = await admin.inspect(
        inspectionScope({ ...request, region: authorized.region }),
      );
      const observed =
        existing?.status === "revoked"
          ? existing
          : await admin.revoke({
              organizationId: request.organizationId,
              projectId: request.projectId,
              physicalEnvironmentId: request.physicalEnvironmentId,
              operationId: request.operationId,
              region: authorized.region,
              registrationVersion: expected.registrationVersion,
              expectedRegistration: registration,
            });
      assertRegistration(observed, expected);
      await persistence.recordDeletionRevocation(request, expected, now().toISOString());
      registration = expected;
    } else if (
      registration === null &&
      (await admin.inspect(inspectionScope({ ...request, region: authorized.region }))) !== null
    )
      throw new DatabaseProviderConflictError();
    const operation = await persistence.reserveOperation({
      ...authorized.claim,
      step: "database.delete",
      providerProjectId: request.providerProjectId,
      requestBody: { database_id: request.databaseId },
    });
    await persistence.beginOperation(operation, now().toISOString());
    if (operation.state !== "succeeded") {
      let result = operation.providerOperationId
        ? await provider.readOperation(operation.providerOperationId)
        : (await provider.changeDatabase(request.databaseId, "delete", operation.idempotencyKey))
            .operation;
      const assertSameDeletion = (observed: PgcfOperation) => {
        if (
          observed.databaseId !== request.databaseId ||
          observed.projectId !== request.providerProjectId ||
          observed.kind !== "database.delete"
        )
          throw new DatabaseProviderConflictError();
      };
      assertSameDeletion(result);
      // PGCF deletes asynchronously: wait a bounded time on the same operation before reconciling.
      for (
        let attempt = 0;
        attempt < PGCF_DELETE_WAIT_ATTEMPTS &&
        (result.status === "pending" || result.status === "running");
        attempt++
      ) {
        await sleep(PGCF_DELETE_WAIT_INTERVAL_MS);
        result = await provider.readOperation(result.id);
        assertSameDeletion(result);
      }
      if (result.status === "failed") throw new Error("PGCF database deletion failed");
      if (result.status !== "succeeded") {
        await persistence.recordOperation(
          operation,
          {
            databaseId: request.databaseId,
            providerOperationId: result.id,
            state: "pending",
          },
          now().toISOString(),
        );
        return {
          status: "reconciliation_required" as const,
          phase: "pgcf" as const,
          databaseRegistration: registration,
        };
      }
      try {
        const database = await provider.readDatabase(request.databaseId);
        if (
          database.observedState !== "deleted" ||
          database.observedGeneration !== result.generation
        )
          return {
            status: "reconciliation_required" as const,
            phase: "pgcf" as const,
            databaseRegistration: registration,
          };
      } catch (error) {
        if (!(error instanceof PgcfProviderError) || error.status !== 404) throw error;
      }
      await persistence.recordOperation(
        operation,
        {
          databaseId: request.databaseId,
          providerOperationId: result.id,
          state: "succeeded",
        },
        now().toISOString(),
      );
    }
    try {
      // PGCF keeps the webhooks of a deleted database, and they count against the cap that every customer shares.
      // Removing them is part of the deletion: the target is retired only once none is left, and a replay repeats it.
      // A webhook that is already gone counts as removed; one the strict parser rejects is left alone and counted.
      const { webhooks, skipped } = await databaseWebhooks(provider, request.databaseId, true);
      if (skipped > 0)
        console.log(JSON.stringify({ event: "database_webhook_cleanup_skipped", count: skipped }));
      for (const webhook of webhooks)
        await provider
          .deleteWebhook(webhook.id, { key: webhookCleanupKey(webhook.id) })
          .catch((error: unknown) => {
            if (!(error instanceof PgcfProviderError && error.status === 404)) throw error;
          });
    } catch (error) {
      if (!(error instanceof PgcfProviderError || error instanceof WebhookListLimitError))
        throw error;
      return {
        status: "reconciliation_required" as const,
        phase: "pgcf" as const,
        databaseRegistration: registration,
      };
    }
    await persistence.retireTarget(request, now().toISOString());
    return {
      status: "absent" as const,
      provider: "pgcf" as const,
      providerProjectId: request.providerProjectId,
      databaseId: request.databaseId,
      databaseRegistration: registration,
      outcome: operation.state === "succeeded" ? ("replayed" as const) : ("deleted" as const),
    };
  }
  return {
    placeProject,
    migrateProject,
    readRuntimeBinding,
    reauthorizeDataEnvironment,
    deleteProject,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DatabaseProviderConflictError();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string") throw new DatabaseProviderConflictError();
  return parseUlid(value);
}
function logicalScope(value: Record<string, unknown>) {
  return {
    organizationId: id(value["organizationId"]),
    projectId: id(value["projectId"]),
    environmentId: id(value["environmentId"]),
  };
}
function assertRole(role: PgcfRole, requested: PgcfRoleCreate): void {
  if (
    role.name !== requested.name ||
    role.owner ||
    role.bypassRls !== (requested.bypass_rls ?? false) ||
    role.connectionLimit !== (requested.connection_limit ?? null) ||
    JSON.stringify([...role.memberOf].sort()) !==
      JSON.stringify([...(requested.member_of ?? [])].sort()) ||
    role.membershipOptions.inherit !== (requested.membership_options?.inherit ?? true) ||
    role.membershipOptions.set !== (requested.membership_options?.set ?? true)
  )
    throw new DatabaseProviderConflictError();
}
function assertRegistration(
  actual: AnyProjectDatabaseRegistrationMetadata | null,
  expected: AnyProjectDatabaseRegistrationMetadata,
): void {
  if (
    !actual ||
    Object.keys(actual).sort().join(",") !== Object.keys(expected).sort().join(",") ||
    Object.keys(expected).some(
      (key) =>
        JSON.stringify(Reflect.get(actual, key)) !== JSON.stringify(Reflect.get(expected, key)),
    )
  )
    throw new DatabaseProviderConflictError();
}
export function computeState(
  database: PgcfDatabase,
): "provisioning" | "cold" | "warm" | "suspended" | "error" {
  if (database.desiredState === "suspended" && database.suspensionReason !== "idle")
    return "suspended";
  if (database.observedState === "ready") return "warm";
  if (database.observedState === "hibernated") return "cold";
  if (database.observedState === "pending" || database.observedState === "provisioning")
    return "provisioning";
  return "error";
}

function inspectionScope(value: {
  organizationId: string;
  projectId: string;
  physicalEnvironmentId: string;
  region: "us" | "eu";
}) {
  return {
    organizationId: value.organizationId,
    projectId: value.projectId,
    physicalEnvironmentId: value.physicalEnvironmentId,
    region: value.region,
  };
}
/** Idle sleep is wakeable through SQL; manual or entitlement suspensions never are. */
function canProvisionDatabase(database: PgcfDatabase): boolean {
  if (database.observedState === "error") throw new Error("PGCF database readiness failed");
  return (
    database.observedGeneration === database.generation &&
    ["ready", "hibernated"].includes(database.observedState) &&
    (database.desiredState === "running" ||
      (database.desiredState === "suspended" &&
        database.suspensionReason === "idle" &&
        database.observedState === "hibernated"))
  );
}
function assertDatabaseRecipe(database: PgcfDatabase, sizeClassId: string, regionId: string): void {
  const size = databaseSizeForClass(sizeClassId);
  if (
    database.regionId !== regionId ||
    database.sizeClassId !== size.sizeClassId ||
    database.resources.memoryMiB !== size.memoryMiB ||
    database.resources.cpuMillicores !== size.cpuMillicores ||
    database.resources.storageMiB !== size.storageMiB
  )
    throw new DatabaseProviderConflictError();
}
