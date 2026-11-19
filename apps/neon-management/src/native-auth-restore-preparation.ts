import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import type { PgcfPostgresTarget } from "@ohmyhost/database";
import type { DatabaseMigrationClient } from "@ohmyhost/platform";
import { parseUlid } from "@ohmyhost/platform";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { applyNativeAuthMigration } from "./native-auth-migration.js";
import {
  nativeAuthRoleNames,
  prepareNativeAuthSchema,
  verifyNativeAuthSchema,
} from "./native-auth-roles.js";

type Scope = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly restoreId: string;
  readonly claimId: string;
};
export interface NativeRestorePreparationProof extends Scope {
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly regionId: "us-dev" | "eu-dev";
  readonly originHost: string;
  readonly targetVersion: number;
  readonly registryVersion: number;
  readonly schema: string;
  readonly runtimeRole: string;
  readonly migratorRole: string;
  readonly backupRole: string;
  readonly environmentIds: readonly string[];
  readonly revocationEpoch: number;
  readonly configurationRevision: number;
}
export interface NativeRestorePreparationAuthority {
  read(input: Scope): Promise<NativeRestorePreparationProof | null>;
  recordVerification(
    input: Scope & {
      targetVersion: number;
      registryVersion: number;
      schema: string;
      runtimeRole: string;
      migratorRole: string;
      backupRole: string;
      migrationVersion: number;
      migrationDigest: string;
    },
  ): Promise<{ status: "verified" }>;
}
type Connection = { readonly client: DatabaseMigrationClient; close(): Promise<void> };

/** Post-import revalidation only. No caller can supply a target, credentials, SQL, or migration. */
export async function prepareNativeAuthRestore(input: {
  readonly scope: Scope;
  readonly authority: NativeRestorePreparationAuthority;
  readonly provider: PgcfProjectProvider;
  readonly connect: (uri: string, target: PgcfPostgresTarget) => Promise<Connection>;
}): Promise<{ readonly status: "verified" }> {
  const raw = input.scope;
  if (
    !raw ||
    Object.keys(raw).sort().join(",") !== "claimId,environmentId,organizationId,projectId,restoreId"
  )
    throw new TypeError("Invalid Native restore preparation");
  const scope = {
    organizationId: parseUlid(raw.organizationId),
    projectId: parseUlid(raw.projectId),
    environmentId: parseUlid(raw.environmentId),
    restoreId: parseUlid(raw.restoreId),
    claimId: raw.claimId,
  };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(scope.claimId))
    throw new TypeError("Invalid Native restore claim");
  const proof = await input.authority.read(scope);
  if (!proof) throw new Error("native_restore_preparation_unavailable");
  const names = nativeAuthRoleNames(scope.projectId, scope.environmentId);
  if (
    Object.entries(scope).some(([key, value]) => Reflect.get(proof, key) !== value) ||
    proof.providerProjectId !== input.provider.projectId ||
    proof.schema !== names.schema ||
    proof.runtimeRole !== names.runtime ||
    proof.migratorRole !== names.migrator ||
    proof.backupRole !== names.backup
  )
    throw new Error("native_restore_preparation_unavailable");
  const authorize = async () => {
    const next = await input.authority.read(scope);
    if (
      !next ||
      Object.keys(next).sort().join(",") !== Object.keys(proof).sort().join(",") ||
      Object.keys(proof).some(
        (key) => JSON.stringify(Reflect.get(next, key)) !== JSON.stringify(Reflect.get(proof, key)),
      )
    )
      throw new Error("native_restore_preparation_unavailable");
  };
  const roles = {
    async withRole<T>(
      role: string,
      work: (client: DatabaseMigrationClient) => Promise<T>,
    ): Promise<T> {
      await authorize();
      const handle = await input.provider.readConnection(proof.databaseId, role);
      if (handle.host !== proof.originHost)
        throw new Error("native_restore_preparation_unavailable");
      return handle.consume(async (uri) => {
        await authorize();
        const connection = await input.connect(uri, {
          provider: "pgcf",
          host: handle.host,
          databaseId: proof.databaseId,
          role,
        });
        let transactionOpen = false;
        const settlementKey = `ohmyho-native-restore/v1:${scope.organizationId}:${scope.projectId}:${proof.databaseId}`;
        const begin = async () => {
          if (transactionOpen) throw new Error("native_restore_nested_transaction");
          await connection.client.query("BEGIN");
          transactionOpen = true;
          try {
            await connection.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
              settlementKey,
            ]);
            await authorize();
          } catch (error) {
            await connection.client.query("ROLLBACK").catch(() => undefined);
            transactionOpen = false;
            throw error;
          }
        };
        const finish = async () => {
          if (!transactionOpen) throw new Error("native_restore_transaction_missing");
          await authorize();
          await connection.client.query("COMMIT");
          transactionOpen = false;
        };
        const rollback = async () => {
          await connection.client.query("ROLLBACK");
          transactionOpen = false;
        };
        try {
          const result = await work({
            ...connection.client,
            async query<
              Row extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>,
            >(sql: string, params?: readonly unknown[]) {
              const command = sql.trim().toUpperCase();
              if (command === "BEGIN") {
                await begin();
                return { rows: [], rowCount: null };
              }
              if (command === "COMMIT") {
                await finish();
                return { rows: [], rowCount: null };
              }
              if (command === "ROLLBACK") {
                await rollback();
                return { rows: [], rowCount: null };
              }
              if (transactionOpen) {
                await authorize();
                return connection.client.query<Row>(sql, params);
              }
              await begin();
              try {
                const response = await connection.client.query<Row>(sql, params);
                await finish();
                return response;
              } catch (error) {
                await rollback().catch(() => undefined);
                throw error;
              }
            },
          });
          if (transactionOpen) throw new Error("native_restore_transaction_unfinished");
          return result;
        } finally {
          if (transactionOpen) await rollback().catch(() => undefined);
          await connection.close();
        }
      });
    },
  };
  await prepareNativeAuthSchema({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    databaseId: proof.databaseId,
    roles,
  });
  await roles.withRole(names.migrator, (client) =>
    applyNativeAuthMigration({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      databaseId: proof.databaseId,
      client,
    }),
  );
  await verifyNativeAuthSchema({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    databaseId: proof.databaseId,
    environmentIds: proof.environmentIds,
    roles,
    authorize,
  });
  await authorize();
  const result = await input.authority.recordVerification({
    ...scope,
    targetVersion: proof.targetVersion,
    registryVersion: proof.registryVersion,
    schema: names.schema,
    runtimeRole: names.runtime,
    migratorRole: names.migrator,
    backupRole: names.backup,
    migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  });
  if (!result || result.status !== "verified")
    throw new Error("native_restore_preparation_unavailable");
  return { status: "verified" };
}
