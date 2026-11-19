import { PgcfProviderError, type PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import type { PgcfManagementDependencies } from "./pgcf-runtime.js";

export interface NativeDeletionScope {
  organizationId: string;
  projectId: string;
  operationId: string;
}
type Realm = {
  environmentId: string;
  registryVersion: number;
  registryReference: string;
  revocationEpoch: number;
  configurationRevision: number;
  schema: string;
  registrationState: string;
  prepared: boolean;
  quiesced: boolean;
  purged: boolean;
};
type Snapshot = NativeDeletionScope & {
  providerProjectId: string;
  databaseId: string;
  targetVersion: number;
  regionId: string;
  idempotencyKey: string;
  state: string;
  providerOperationId: string | null;
  realms: Realm[];
};
export interface NativeDeletionCore {
  readNativeAuthProjectDeletion(input: NativeDeletionScope): Promise<Snapshot | null>;
  recordNativeAuthDeletionQuiescence(
    input: NativeDeletionScope & { environmentId: string; registryVersion: number },
  ): Promise<unknown>;
  beginNativeAuthProjectDeletion(input: NativeDeletionScope): Promise<{ state: string }>;
  recordNativeAuthProjectDeletionObservation(
    input: NativeDeletionScope & { providerOperationId: string | null; absent: boolean },
  ): Promise<unknown>;
  recordNativeAuthDeletionPurge(
    input: NativeDeletionScope & {
      environmentId: string;
      registryVersion: number;
      registryReference: string;
    },
  ): Promise<unknown>;
  finishNativeAuthProjectDeletion(input: NativeDeletionScope): Promise<unknown>;
}
/** The fixed short-name Core RPC surface bound to database management. */
export interface NativeDeletionRuntime {
  read: NativeDeletionCore["readNativeAuthProjectDeletion"];
  recordQuiescence: NativeDeletionCore["recordNativeAuthDeletionQuiescence"];
  begin: NativeDeletionCore["beginNativeAuthProjectDeletion"];
  recordObservation: NativeDeletionCore["recordNativeAuthProjectDeletionObservation"];
  recordPurge: NativeDeletionCore["recordNativeAuthDeletionPurge"];
  finish: NativeDeletionCore["finishNativeAuthProjectDeletion"];
}
export interface NativeDeletionRegistry {
  quiesceForDeletion(
    input: NativeDeletionScope & {
      environmentId: string;
      registryVersion: number;
      registryReference: string;
    },
  ): Promise<{ status: "quiesced" }>;
  purgeForDeletion(
    input: NativeDeletionScope & {
      environmentId: string;
      registryVersion: number;
      registryReference: string;
    },
  ): Promise<{ status: "absent" }>;
}

/** Retire the project-scoped Native target without inventing a business environment. */
export async function deleteNativeAuthProject(input: {
  scope: NativeDeletionScope;
  core: NativeDeletionCore;
  registry: (region: string) => NativeDeletionRegistry;
  provider: PgcfProjectProvider;
  connect: PgcfManagementDependencies["connect"];
}) {
  const { scope, core, provider } = input;
  let snapshot = await core.readNativeAuthProjectDeletion(scope);
  if (!snapshot) return { status: "none" as const };
  if (
    snapshot.providerProjectId !== provider.projectId ||
    !["eu-dev", "us-dev"].includes(snapshot.regionId) ||
    !/^omh-[a-f0-9]{64}$/u.test(snapshot.idempotencyKey)
  )
    throw new Error("native_auth_deletion_conflict");
  const registry = input.registry(snapshot.regionId);
  if (snapshot.state === "reserved") {
    for (const realm of snapshot.realms) {
      if (realm.quiesced) continue;
      if (realm.schema !== `omh_auth_${realm.environmentId.toLowerCase()}`)
        throw new Error("native_auth_deletion_conflict");
      const proof = {
        ...scope,
        environmentId: realm.environmentId,
        registryVersion: realm.registryVersion,
        registryReference: realm.registryReference,
      };
      if ((await registry.quiesceForDeletion(proof)).status !== "quiesced")
        throw new Error("native_auth_deletion_unavailable");
      // Lock the same policy row as every Native mutation, so in-flight work finishes before deletion.
      const migrator = `omh_am_${realm.environmentId.toLowerCase()}`;
      const databaseId = snapshot.databaseId;
      const handle = await provider.readConnection(databaseId, migrator);
      await handle.consume(async (uri) => {
        const connection = await input.connect(uri, {
          provider: "pgcf",
          host: handle.host,
          databaseId,
          role: migrator,
        });
        try {
          await connection.client.query("begin");
          const found = await connection.client.query<{ policy: string | null }>(
            "select to_regclass($1)::text as policy",
            [`${realm.schema}.native_realm_policy`],
          );
          if (!found.rows[0]?.policy && (realm.prepared || realm.registrationState !== "reserved"))
            throw new Error("native_auth_deletion_conflict");
          if (found.rows[0]?.policy) {
            const result = await connection.client.query(
              `insert into "${realm.schema}".native_realm_policy(singleton,enabled,revocation_epoch,configuration_revision) values(true,false,$1,$2) on conflict(singleton) do update set enabled=false,revocation_epoch=excluded.revocation_epoch,configuration_revision=excluded.configuration_revision where "${realm.schema}".native_realm_policy.revocation_epoch<=excluded.revocation_epoch and "${realm.schema}".native_realm_policy.configuration_revision<=excluded.configuration_revision`,
              [realm.revocationEpoch, realm.configurationRevision],
            );
            if (result.rowCount !== 1) throw new Error("native_auth_deletion_conflict");
          }
          await connection.client.query("commit");
        } catch (error) {
          await connection.client.query("rollback");
          throw error;
        } finally {
          await connection.close();
        }
      });
      await core.recordNativeAuthDeletionQuiescence({
        ...scope,
        environmentId: realm.environmentId,
        registryVersion: realm.registryVersion,
      });
    }
    await core.beginNativeAuthProjectDeletion(scope);
    snapshot = await core.readNativeAuthProjectDeletion(scope);
    if (!snapshot) throw new Error("native_auth_deletion_unavailable");
  }
  if (snapshot.state !== "absent") {
    let operation;
    try {
      operation = snapshot.providerOperationId
        ? await provider.readOperation(snapshot.providerOperationId)
        : (await provider.changeDatabase(snapshot.databaseId, "delete", snapshot.idempotencyKey))
            .operation;
    } catch (error) {
      if (!(error instanceof PgcfProviderError) || error.status !== 404) throw error;
      // A vanished request is not itself proof. Only the exact target's independent GET can prove absence.
      try {
        await provider.readDatabase(snapshot.databaseId);
        return { status: "reconciliation_required" as const };
      } catch (readError) {
        if (!(readError instanceof PgcfProviderError) || readError.status !== 404) throw readError;
      }
      await core.recordNativeAuthProjectDeletionObservation({
        ...scope,
        providerOperationId: snapshot.providerOperationId,
        absent: true,
      });
    }
    if (operation) {
      if (
        operation.projectId !== snapshot.providerProjectId ||
        operation.databaseId !== snapshot.databaseId ||
        operation.kind !== "database.delete"
      )
        throw new Error("native_auth_deletion_conflict");
      await core.recordNativeAuthProjectDeletionObservation({
        ...scope,
        providerOperationId: operation.id,
        absent: false,
      });
      if (operation.status === "failed") throw new Error("native_auth_deletion_failed");
      if (operation.status !== "succeeded") return { status: "reconciliation_required" as const };
      try {
        const db = await provider.readDatabase(snapshot.databaseId);
        if (db.observedState !== "deleted" || db.observedGeneration !== operation.generation)
          return { status: "reconciliation_required" as const };
      } catch (error) {
        if (!(error instanceof PgcfProviderError) || error.status !== 404) throw error;
      }
      await core.recordNativeAuthProjectDeletionObservation({
        ...scope,
        providerOperationId: operation.id,
        absent: true,
      });
    }
  }
  for (const realm of snapshot.realms) {
    if (realm.purged) continue;
    const proof = {
      ...scope,
      environmentId: realm.environmentId,
      registryVersion: realm.registryVersion,
      registryReference: realm.registryReference,
    };
    if ((await registry.purgeForDeletion(proof)).status !== "absent")
      throw new Error("native_auth_deletion_unavailable");
    await core.recordNativeAuthDeletionPurge(proof);
  }
  await core.finishNativeAuthProjectDeletion(scope);
  return {
    status: "absent" as const,
    databaseId: snapshot.databaseId,
    registries: snapshot.realms.map((r) => r.registryReference),
  };
}
