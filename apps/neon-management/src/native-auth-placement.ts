import { DatabaseProviderConflictError } from "@ohmyhost/database";
import type {
  PgcfDatabase,
  PgcfMutationReceipt,
  PgcfProjectProvider,
} from "@ohmyhost/provider-pgcf";

/** A Native Auth database is a project resource, never a business-data environment. */
export interface NativeAuthPlacementClaim {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly regionId: "us-dev" | "eu-dev";
}

export interface NativeAuthPlacement {
  readonly organizationId: string;
  readonly projectId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly providerOperationId: string;
  readonly regionId: "us-dev" | "eu-dev";
  readonly sizeClassId: "r256-s500m";
  readonly targetVersion: number;
}

interface CreateOperation {
  readonly idempotencyKey: string;
  readonly databaseId: string | null;
  readonly providerOperationId: string | null;
}

export interface NativeAuthDatabaseReconciliation {
  readonly claim: NativeAuthPlacementClaim;
  readonly providerProjectId: string;
  readonly name: string;
  readonly sizeClassId: "r256-s500m";
  readonly operation: CreateOperation;
}

/** Current admission is required for creation; uncertain effects retain only their original replay identity. */
export interface NativeAuthPlacementPersistence {
  readDispatchedCreate(
    input: Omit<NativeAuthPlacementClaim, "regionId">,
  ): Promise<NativeAuthDatabaseReconciliation | null>;
  resolveClaim(
    input: Omit<NativeAuthPlacementClaim, "regionId">,
  ): Promise<NativeAuthPlacementClaim>;
  readTarget(claim: NativeAuthPlacementClaim): Promise<NativeAuthPlacement | null>;
  reserveCreate(
    claim: NativeAuthPlacementClaim,
    input: {
      readonly providerProjectId: string;
      readonly name: string;
      readonly regionId: "us-dev" | "eu-dev";
      readonly sizeClassId: "r256-s500m";
    },
  ): Promise<CreateOperation>;
  authorizeDispatch(claim: NativeAuthPlacementClaim, operation: CreateOperation): Promise<void>;
  /** Atomically records the provider identity and billing attribution, even while still provisioning. */
  recordCreated(
    claim: NativeAuthPlacementClaim,
    operation: CreateOperation,
    result: PgcfMutationReceipt,
  ): Promise<NativeAuthPlacement>;
}

/** Create/reconcile with the original provider idempotency key and attribute on the first receipt. */
export async function placeNativeAuthDatabase(
  provider: PgcfProjectProvider,
  persistence: NativeAuthPlacementPersistence,
  input: Omit<NativeAuthPlacementClaim, "regionId">,
): Promise<{
  readonly status: "ready" | "reconciliation_required";
  readonly target: NativeAuthPlacement;
}> {
  const reconciliation = await persistence.readDispatchedCreate(input);
  const claim = reconciliation?.claim ?? (await persistence.resolveClaim(input));
  if (
    claim.organizationId !== input.organizationId ||
    claim.projectId !== input.projectId ||
    claim.environmentId !== input.environmentId ||
    claim.operationId !== input.operationId ||
    claim.claimId !== input.claimId
  )
    throw new DatabaseProviderConflictError();
  if (
    reconciliation &&
    (reconciliation.providerProjectId !== provider.projectId ||
      reconciliation.name !== `ohmyho-auth-${claim.projectId.toLowerCase()}` ||
      reconciliation.sizeClassId !== "r256-s500m" ||
      reconciliation.operation.databaseId !== null ||
      reconciliation.operation.providerOperationId !== null ||
      !/^omh-[a-f0-9]{64}$/u.test(reconciliation.operation.idempotencyKey))
  )
    throw new DatabaseProviderConflictError();
  let admissionLost = false;
  let target = reconciliation ? null : await persistence.readTarget(claim);
  if (!target) {
    const name = `ohmyho-auth-${claim.projectId.toLowerCase()}`;
    const operation =
      reconciliation?.operation ??
      (await persistence.reserveCreate(claim, {
        providerProjectId: provider.projectId,
        name,
        regionId: claim.regionId,
        sizeClassId: "r256-s500m",
      }));
    if (!reconciliation) await persistence.authorizeDispatch(claim, operation);
    const receipt =
      operation.databaseId && operation.providerOperationId
        ? {
            database: await provider.readDatabase(operation.databaseId),
            operation: await provider.readOperation(operation.providerOperationId),
          }
        : await provider.createDatabase({
            name,
            regionId: claim.regionId,
            sizeClassId: "r256-s500m",
            idempotencyKey: operation.idempotencyKey,
          });
    assertDatabase(receipt.database, claim, provider.projectId, name);
    if (
      receipt.operation.projectId !== provider.projectId ||
      receipt.operation.databaseId !== receipt.database.id ||
      receipt.operation.kind !== "database.create" ||
      (receipt.operation.generation !== receipt.database.generation &&
        !(
          receipt.operation.status === "succeeded" &&
          receipt.database.generation > receipt.operation.generation
        ))
    )
      throw new DatabaseProviderConflictError();
    target = await persistence.recordCreated(claim, operation, receipt);
    if (
      target.databaseId !== receipt.database.id ||
      target.providerOperationId !== receipt.operation.id
    )
      throw new DatabaseProviderConflictError();
    if (receipt.operation.status === "failed") throw new DatabaseProviderConflictError();
    if (reconciliation) {
      // Accounting the uncertain effect never resumes provisioning after admission was lost.
      try {
        await persistence.resolveClaim(input);
      } catch {
        admissionLost = true;
      }
    }
  }
  if (
    target.organizationId !== claim.organizationId ||
    target.projectId !== claim.projectId ||
    target.providerProjectId !== provider.projectId ||
    target.regionId !== claim.regionId ||
    target.sizeClassId !== "r256-s500m" ||
    !/^[a-z][a-z0-9]{19}$/u.test(target.databaseId) ||
    !Number.isSafeInteger(target.targetVersion) ||
    target.targetVersion < 1
  )
    throw new DatabaseProviderConflictError();
  if (admissionLost) return { status: "reconciliation_required", target };
  const database = await provider.readDatabase(target.databaseId);
  const operation = await provider.readOperation(target.providerOperationId);
  if (database.id !== target.databaseId) throw new DatabaseProviderConflictError();
  assertDatabase(
    database,
    claim,
    provider.projectId,
    `ohmyho-auth-${claim.projectId.toLowerCase()}`,
  );
  if (
    operation.id !== target.providerOperationId ||
    operation.databaseId !== target.databaseId ||
    operation.projectId !== provider.projectId ||
    operation.kind !== "database.create" ||
    operation.status === "failed" ||
    operation.generation > database.generation
  )
    throw new DatabaseProviderConflictError();
  return {
    status:
      operation.status === "succeeded" &&
      database.observedGeneration === database.generation &&
      ["ready", "hibernated"].includes(database.observedState) &&
      (database.desiredState === "running" ||
        (database.desiredState === "suspended" &&
          database.suspensionReason === "idle" &&
          database.observedState === "hibernated"))
        ? "ready"
        : "reconciliation_required",
    target,
  };
}

function assertDatabase(
  database: PgcfDatabase,
  claim: NativeAuthPlacementClaim,
  providerProjectId: string,
  name: string,
): void {
  if (
    database.projectId !== providerProjectId ||
    database.name !== name ||
    database.regionId !== claim.regionId ||
    database.sizeClassId !== "r256-s500m" ||
    database.resources.memoryMiB !== 256 ||
    database.resources.cpuMillicores !== 250 ||
    database.resources.storageMiB !== 500
  )
    throw new DatabaseProviderConflictError();
}
