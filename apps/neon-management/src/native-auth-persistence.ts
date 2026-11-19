import type { PgcfMutationReceipt, PgcfRoleCreate } from "@ohmyhost/provider-pgcf";
import type {
  NativeAuthPlacement,
  NativeAuthPlacementClaim,
  NativeAuthPlacementPersistence,
  NativeAuthDatabaseReconciliation,
} from "./native-auth-placement.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import type {
  NativeAuthRegistrationPersistence,
  NativeAuthRealmRegistration,
  NativeAuthRolePersistence,
} from "./native-auth-roles.js";

type Scope = Omit<NativeAuthPlacementClaim, "regionId">;
type CreateReservation = {
  readonly idempotencyKey: string;
  readonly state: string;
  readonly providerOperationId: string | null;
  readonly databaseId: string | null;
};
type RoleReservation = Scope & {
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly roleName: string;
  readonly idempotencyKey: string;
  readonly providerOperationId: string | null;
  readonly state: "reserved" | "dispatched" | "succeeded" | "failed";
};
/** The private Native resource entrypoint only; no generic Core or credential access. */
export interface NativeAuthResourceRuntime {
  readNativeAuthPreviewReconciliation(input: Scope): Promise<{
    readonly databasePending: boolean;
    readonly roles: readonly (Scope & {
      readonly providerProjectId: string;
      readonly databaseId: string;
      readonly roleName: string;
      readonly idempotencyKey: string;
      readonly providerOperationId: string | null;
    })[];
  }>;
  readNativeAuthDatabaseReconciliation(
    input: Scope,
  ): Promise<NativeAuthDatabaseReconciliation | null>;
  initializeNativeAuthRealm(input: Scope): Promise<{
    status: "ready" | "origin_pending";
    enabled: boolean;
    configurationRevision: number;
    revocationEpoch: number;
    canonicalOrigin: string | null;
  }>;
  readProvisioningPolicy(input: Scope): Promise<{
    organizationId: string;
    region: "us" | "eu";
    ownerEnabled: boolean;
    revocationEpoch: number;
    realm: {
      projectId: string;
      environmentId: string;
      canonicalOrigin: string | null;
      configurationRevision: number;
    };
  }>;
  resolveNativeAuthDatabaseClaim(input: Scope): Promise<NativeAuthPlacementClaim>;
  readNativeAuthTarget(input: {
    organizationId: string;
    projectId: string;
  }): Promise<NativeAuthPlacement | null>;
  reserveNativeAuthDatabaseOperation(
    input: Scope & {
      providerProjectId: string;
      name: string;
      regionId: "us-dev" | "eu-dev";
      sizeClassId: "r256-s500m";
    },
  ): Promise<CreateReservation>;
  beginNativeAuthDatabaseOperation(input: Scope): Promise<"dispatch" | "observe">;
  recordNativeAuthDatabaseObservation(
    input: Scope & { providerProjectId: string; databaseId: string; providerOperationId: string },
  ): Promise<NativeAuthPlacement>;
  reserveNativeAuthRoleOperation(
    input: Scope & { providerProjectId: string; databaseId: string; roleName: string },
  ): Promise<RoleReservation>;
  beginNativeAuthRoleOperation(
    input: Scope & { providerProjectId: string; databaseId: string; roleName: string },
  ): Promise<"dispatch" | "observe">;
  recordNativeAuthRoleObservation(
    input: Scope & {
      providerProjectId: string;
      databaseId: string;
      roleName: string;
      idempotencyKey: string;
      providerOperationId: string | null;
      state: "dispatched" | "succeeded" | "failed";
    },
  ): Promise<{ status: "recorded" }>;
  recordNativeAuthPreparation(
    input: Scope & {
      providerProjectId: string;
      databaseId: string;
      targetVersion: number;
      schema: string;
      runtimeRole: string;
      migratorRole: string;
      backupRole: string;
      migrationDigest: string;
      migrationVersion: number;
    },
  ): Promise<{ status: "recorded" }>;
}

export interface NativeAuthRegistryAuthority {
  readRegistration(input: {
    projectId: string;
    environmentId: string;
  }): Promise<NativeAuthRealmRegistration | null>;
  readDatabaseEnvironments(input: Scope): Promise<{ environmentIds: string[] }>;
  resolveRegistrationGeneration(
    input: Scope & {
      providerProjectId: string;
      databaseId: string;
      regionId: "us-dev" | "eu-dev";
      targetVersion: number;
    },
  ): Promise<{ registryVersion: number; registryReference: string }>;
  reserveRegistration(receipt: NativeAuthRealmRegistration): Promise<NativeAuthRealmRegistration>;
  confirmRegistration(receipt: NativeAuthRealmRegistration): Promise<NativeAuthRealmRegistration>;
}

export function createNativeAuthRegistrationPersistence(
  core: NativeAuthRegistryAuthority,
): NativeAuthRegistrationPersistence {
  return {
    async reserve(registration) {
      const receipt = await core.reserveRegistration({ ...registration, status: "active" });
      const { status, ...metadata } = receipt;
      if (status !== "active") throw new Error("native_auth_registration_invalid");
      return metadata;
    },
    async confirm(receipt) {
      const confirmed = await core.confirmRegistration(receipt);
      if (
        Object.keys(confirmed).sort().join(",") !== Object.keys(receipt).sort().join(",") ||
        Object.keys(receipt).some(
          (key) => Reflect.get(confirmed, key) !== Reflect.get(receipt, key),
        )
      )
        throw new Error("native_auth_registration_invalid");
    },
  };
}

export function recordNativeAuthPreparation(
  core: NativeAuthResourceRuntime,
  input: {
    registration: Omit<NativeAuthRealmRegistration, "status">;
    migrator: string;
    backup: string;
  },
): Promise<{ status: "recorded" }> {
  const r = input.registration;
  return core.recordNativeAuthPreparation({
    ...scopeOf(r),
    providerProjectId: r.providerProjectId,
    databaseId: r.databaseId,
    targetVersion: r.targetVersion,
    schema: r.schema,
    runtimeRole: r.role,
    migratorRole: input.migrator,
    backupRole: input.backup,
    migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
    migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  });
}

export function createNativeAuthPlacementPersistence(
  core: NativeAuthResourceRuntime,
): NativeAuthPlacementPersistence {
  return {
    readDispatchedCreate: (input) => core.readNativeAuthDatabaseReconciliation(input),
    resolveClaim: (input) => core.resolveNativeAuthDatabaseClaim(input),
    readTarget: (claim) =>
      core.readNativeAuthTarget({
        organizationId: claim.organizationId,
        projectId: claim.projectId,
      }),
    reserveCreate: (claim, input) =>
      core.reserveNativeAuthDatabaseOperation({ ...scopeOf(claim), ...input }),
    authorizeDispatch: async (claim) => {
      await core.beginNativeAuthDatabaseOperation(scopeOf(claim));
    },
    recordCreated: (claim, _operation, receipt: PgcfMutationReceipt) =>
      core.recordNativeAuthDatabaseObservation({
        ...scopeOf(claim),
        providerProjectId: receipt.database.projectId,
        databaseId: receipt.database.id,
        providerOperationId: receipt.operation.id,
      }),
  };
}

/** The adapter retains the immutable original role scope, while each dispatch rechecks the current claim. */
export function createNativeAuthRolePersistence(
  core: NativeAuthResourceRuntime,
  claim: NativeAuthPlacementClaim,
  providerProjectId: string,
): NativeAuthRolePersistence {
  const reservations = new Map<string, RoleReservation>();
  return {
    async reserveRole({
      databaseId,
      definition,
    }: {
      databaseId: string;
      definition: PgcfRoleCreate;
    }) {
      const row = await core.reserveNativeAuthRoleOperation({
        ...scopeOf(claim),
        providerProjectId,
        databaseId,
        roleName: definition.name,
      });
      reservations.set(row.idempotencyKey, row);
      return row;
    },
    async authorizeRole(operation) {
      const row = reservations.get(operation.idempotencyKey);
      if (!row) throw new Error("native_auth_role_reservation_missing");
      return core.beginNativeAuthRoleOperation({
        ...scopeOf(claim),
        providerProjectId,
        databaseId: row.databaseId,
        roleName: row.roleName,
      });
    },
    async recordRole(operation, observation) {
      const row = reservations.get(operation.idempotencyKey);
      if (!row) throw new Error("native_auth_role_reservation_missing");
      await core.recordNativeAuthRoleObservation({
        ...scopeOf(row),
        providerProjectId: row.providerProjectId,
        databaseId: row.databaseId,
        roleName: row.roleName,
        idempotencyKey: row.idempotencyKey,
        ...observation,
      });
    },
  };
}

function scopeOf(input: Scope): Scope {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    operationId: input.operationId,
    claimId: input.claimId,
  };
}
