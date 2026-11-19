import {
  BuildBrokerCapacityError,
  BuildBrokerConflictError,
  BuildBrokerTransportError,
  BuildBrokerUncertainError,
  fingerprintBuildStartInput,
  type BuildReceipt,
  type BuildUsage,
  type OperationScope,
  type RecoverableBuildBroker,
} from "@ohmyhost/build-broker";

export class BuildStartAbsentError extends Error {
  public readonly code = "build_start_absent";

  public constructor() {
    super("build_start_absent");
    this.name = "BuildStartAbsentError";
  }
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CLAIM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The receipts service allows a start for a few minutes; a claim lease must end well before that.
const START_WINDOW_MILLISECONDS = 5 * 60_000;
export const BUILD_RESERVATION_LEASE_MILLISECONDS = 30_000;

export interface PersistedBuildReceiptEnvelope {
  readonly receipt: BuildReceipt;
  readonly inputFingerprint: `sha256:${string}`;
  readonly claimId: string;
}

export interface BuildInputClaim {
  readonly scope: OperationScope;
  readonly inputFingerprint: `sha256:${string}`;
  readonly claimId: string;
  readonly leaseMilliseconds: number;
}

export type BuildInputClaimResult =
  | Readonly<{
      status: "claimed";
      mode: "start" | "observe";
      attemptNumber: number;
      reservationCreatedAt: Date;
      startAllowedUntil: Date;
      leaseExpiresAt: Date;
    }>
  | Readonly<{ status: "pending"; leaseExpiresAt: Date; startAllowedUntil: Date }>
  | Readonly<{ status: "completed"; envelope: PersistedBuildReceiptEnvelope }>;

export interface BuildReceiptPersistence {
  claimBuildInput(claim: BuildInputClaim): Promise<BuildInputClaimResult>;
  authorizeBuildStart(scope: OperationScope, claimId: string): Promise<boolean>;
  putBuildReceipt(envelope: PersistedBuildReceiptEnvelope): Promise<void>;
  putBuildUsage(input: Readonly<{ receipt: BuildReceipt; usage: BuildUsage }>): Promise<void>;
}

export interface PersistingBuildBrokerOptions {
  readonly buildProject: string;
  readonly claimIds?: Readonly<{ next: () => string }>;
  readonly leaseMilliseconds?: number;
}

export function createPersistingBuildBroker(
  broker: RecoverableBuildBroker,
  persistence: BuildReceiptPersistence,
  options: PersistingBuildBrokerOptions,
): RecoverableBuildBroker {
  const claimIds = options?.claimIds ?? systemClaimIds;
  const leaseMilliseconds = options?.leaseMilliseconds ?? BUILD_RESERVATION_LEASE_MILLISECONDS;
  if (
    typeof persistence?.claimBuildInput !== "function" ||
    typeof persistence.authorizeBuildStart !== "function" ||
    typeof persistence.putBuildReceipt !== "function" ||
    typeof persistence.putBuildUsage !== "function" ||
    typeof broker?.observeBuildStart !== "function" ||
    typeof options?.buildProject !== "string" ||
    options.buildProject.length === 0 ||
    typeof claimIds.next !== "function" ||
    !Number.isSafeInteger(leaseMilliseconds) ||
    leaseMilliseconds < 1 ||
    leaseMilliseconds >= START_WINDOW_MILLISECONDS
  ) {
    throw new Error("build_runner_configuration_invalid");
  }

  const wrapped: RecoverableBuildBroker = {
    beginArchive: (input) => broker.beginArchive(input),
    uploadArchivePart: (input) => broker.uploadArchivePart(input),
    completeArchive: (input) => broker.completeArchive(input),
    abortArchive: (upload) => broker.abortArchive(upload),
    observeArchive: (input) => broker.observeArchive(input),
    removeArchive: (archive) => broker.removeArchive(archive),
    async startBuild(input) {
      const inputFingerprint = await fingerprintBuildStartInput(input);
      const claimId = claimIds.next();
      validateClaimId(claimId);
      let claim: BuildInputClaimResult;
      try {
        claim = await persistence.claimBuildInput(
          Object.freeze({
            scope: input.scope,
            inputFingerprint,
            claimId,
            leaseMilliseconds,
          }),
        );
      } catch (error) {
        if (isBuildInputConflict(error)) throw new BuildBrokerConflictError();
        if (errorCode(error) === "build_capacity_reached") throw new BuildBrokerCapacityError();
        throw new BuildBrokerTransportError();
      }
      validateClaimResult(claim);
      if (claim.status === "completed") {
        validatePersistedEnvelope(
          claim.envelope,
          input.scope,
          options.buildProject,
          inputFingerprint,
        );
        return claim.envelope.receipt;
      }
      if (claim.status === "pending") {
        throw new BuildBrokerUncertainError();
      }

      if (claim.attemptNumber > 1 || claim.mode === "observe") {
        const observation = await broker.observeBuildStart(input, claim.reservationCreatedAt);
        validateBuildStartObservation(observation, input.scope, options.buildProject);
        if (observation.state === "found") {
          try {
            await persistence.putBuildReceipt(
              Object.freeze({ receipt: observation.receipt, inputFingerprint, claimId }),
            );
          } catch {
            throw new BuildBrokerUncertainError();
          }
          return observation.receipt;
        }
        if (observation.state === "unknown") {
          throw new BuildBrokerUncertainError();
        }
        if (claim.mode === "observe") throw new BuildStartAbsentError();
      }

      let authorized: boolean;
      try {
        authorized = await persistence.authorizeBuildStart(input.scope, claimId);
      } catch (error) {
        if (isBuildInputConflict(error)) throw new BuildBrokerConflictError();
        throw new BuildBrokerTransportError();
      }
      if (typeof authorized !== "boolean") throw new BuildBrokerConflictError();
      if (authorized !== true) throw new BuildBrokerUncertainError();

      const receipt = await broker.startBuild(input);
      try {
        await persistence.putBuildReceipt(Object.freeze({ receipt, inputFingerprint, claimId }));
      } catch {
        throw new BuildBrokerUncertainError();
      }
      return receipt;
    },
    async readBuild(receipt) {
      const observation = await broker.readBuild(receipt);
      if (observation.status !== "running") {
        if (observation.usage === null) throw new BuildBrokerUncertainError();
        try {
          await persistence.putBuildUsage({ receipt, usage: observation.usage });
        } catch {
          throw new BuildBrokerUncertainError();
        }
      }
      return observation;
    },
    stopBuild: (receipt) => broker.stopBuild(receipt),
    observeBuildArtifact: (input) => broker.observeBuildArtifact(input),
    readBuildArtifact: (input) => broker.readBuildArtifact(input),
    removeBuildArtifact: (artifact) => broker.removeBuildArtifact(artifact),
    removeBuildArtifactObject: (artifact) => broker.removeBuildArtifactObject(artifact),
    observeBuildStart: (input, reservationCreatedAt) =>
      broker.observeBuildStart(input, reservationCreatedAt),
  };
  return Object.freeze(wrapped);
}

const systemClaimIds = Object.freeze({ next: () => globalThis.crypto.randomUUID() });

function validateClaimResult(claim: BuildInputClaimResult): void {
  if (claim === null || typeof claim !== "object") throw new BuildBrokerConflictError();
  if (claim.status === "claimed") {
    if (
      !hasExactKeys(claim, [
        "attemptNumber",
        "leaseExpiresAt",
        "mode",
        "reservationCreatedAt",
        "startAllowedUntil",
        "status",
      ]) ||
      (claim.mode !== "start" && claim.mode !== "observe") ||
      !Number.isSafeInteger(claim.attemptNumber) ||
      claim.attemptNumber < 1 ||
      (claim.attemptNumber === 1 && claim.mode !== "start")
    ) {
      throw new BuildBrokerConflictError();
    }
    const reservationCreatedAt = checkedDate(claim.reservationCreatedAt);
    const startAllowedUntil = checkedDate(claim.startAllowedUntil);
    const leaseExpiresAt = checkedDate(claim.leaseExpiresAt);
    if (
      reservationCreatedAt.getTime() >= startAllowedUntil.getTime() ||
      leaseExpiresAt.getTime() <= reservationCreatedAt.getTime()
    ) {
      throw new BuildBrokerConflictError();
    }
    return;
  }
  if (claim.status === "pending") {
    if (!hasExactKeys(claim, ["leaseExpiresAt", "startAllowedUntil", "status"])) {
      throw new BuildBrokerConflictError();
    }
    checkedDate(claim.leaseExpiresAt);
    checkedDate(claim.startAllowedUntil);
    return;
  }
  if (claim.status === "completed" && hasExactKeys(claim, ["envelope", "status"])) return;
  throw new BuildBrokerConflictError();
}

function validateBuildStartObservation(
  observation: Awaited<ReturnType<RecoverableBuildBroker["observeBuildStart"]>>,
  scope: OperationScope,
  buildProject: string,
): void {
  if (observation === null || typeof observation !== "object") {
    throw new BuildBrokerConflictError();
  }
  if (
    (observation.state === "absent" || observation.state === "unknown") &&
    hasExactKeys(observation, ["state"])
  ) {
    return;
  }
  if (observation.state === "found" && hasExactKeys(observation, ["receipt", "state"])) {
    validatePersistedReceipt(observation.receipt, scope, buildProject);
    return;
  }
  throw new BuildBrokerConflictError();
}

function isBuildInputConflict(error: unknown): boolean {
  return errorCode(error) === "build_input_conflict";
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function validatePersistedEnvelope(
  envelope: PersistedBuildReceiptEnvelope,
  scope: OperationScope,
  buildProject: string,
  inputFingerprint: `sha256:${string}`,
): void {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    !hasExactKeys(envelope, ["claimId", "inputFingerprint", "receipt"]) ||
    !CLAIM_ID_PATTERN.test(envelope.claimId) ||
    !FINGERPRINT_PATTERN.test(envelope.inputFingerprint) ||
    envelope.inputFingerprint !== inputFingerprint
  ) {
    throw new BuildBrokerConflictError();
  }
  validatePersistedReceipt(envelope.receipt, scope, buildProject);
}

function validateClaimId(value: string): void {
  if (!CLAIM_ID_PATTERN.test(value)) throw new BuildBrokerConflictError();
}

function checkedDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new BuildBrokerConflictError();
  }
  return new Date(value.getTime());
}

function validatePersistedReceipt(
  receipt: BuildReceipt,
  scope: OperationScope,
  buildProject: string,
): void {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !hasExactKeys(receipt, ["buildId", "projectName", "scope"]) ||
    typeof receipt.buildId !== "string" ||
    receipt.buildId.length === 0 ||
    receipt.buildId.length > 512 ||
    receipt.projectName !== buildProject ||
    !sameScope(receipt.scope, scope)
  ) {
    throw new BuildBrokerConflictError();
  }
}

function sameScope(left: OperationScope, right: OperationScope): boolean {
  return (
    validScope(left) &&
    validScope(right) &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.operationId === right.operationId
  );
}

function validScope(scope: OperationScope): boolean {
  return (
    scope !== null &&
    typeof scope === "object" &&
    hasExactKeys(scope, ["environmentId", "operationId", "projectId"]) &&
    ULID_PATTERN.test(scope.projectId) &&
    ULID_PATTERN.test(scope.environmentId) &&
    ULID_PATTERN.test(scope.operationId)
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
