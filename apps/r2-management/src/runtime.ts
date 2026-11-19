import { parseUlid } from "@ohmyhost/platform";
import {
  CloudflareR2BucketUncertainError,
  projectR2BucketTarget,
  type R2BucketObservation,
  type R2BucketReceipt,
} from "@ohmyhost/provider-cloudflare";
import {
  ProjectR2BucketConflictError,
  type ProjectR2BucketClaimResult,
  type ProjectR2BucketInput,
  type ProjectR2BucketReceipt,
} from "@ohmyhost/database";

export interface R2Persistence {
  claim(input: ProjectR2BucketInput): Promise<ProjectR2BucketClaimResult>;
  authorize(input: ProjectR2BucketInput): Promise<boolean>;
  put(receipt: ProjectR2BucketReceipt): Promise<"created" | "existing">;
  read(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }): Promise<ProjectR2BucketReceipt | null>;
  proveBucketAbsence(input: ProjectR2BucketAbsence): Promise<"proven">;
  /** `operation_open` while the reservation's operation has not ended; the reservation then stays. */
  supersedeBucketReservation(
    input: ProjectR2BucketAbsence,
  ): Promise<"superseded" | "operation_open">;
}

/** A provider read that found the reserved bucket absent, taken at `observedAt`. */
export type ProjectR2BucketAbsence = ProjectR2BucketInput & { readonly observedAt: Date };

interface Provider {
  observeBucket(target: ReturnType<typeof projectR2BucketTarget>): Promise<R2BucketObservation>;
  ensureBucket(
    target: ReturnType<typeof projectR2BucketTarget>,
    priorObservation?: R2BucketObservation,
  ): Promise<{
    outcome: "created" | "existing" | "recovered";
    receipt: R2BucketReceipt;
  }>;
  purgeAndDeleteBucket(receipt: R2BucketReceipt): Promise<{
    outcome: "absent" | "deleted";
    bucketName: string;
    objectCount: number;
    bytes: number;
  }>;
}

export class R2ManagementReceiptMismatchError extends Error {
  public readonly code = "r2_management_receipt_mismatch";
  public constructor() {
    super("R2 management receipt does not match durable state");
    this.name = "R2ManagementReceiptMismatchError";
  }
}

export function createR2Management(dependencies: {
  readonly persistence: R2Persistence;
  readonly provider: Provider;
}) {
  if (
    typeof dependencies?.persistence?.claim !== "function" ||
    typeof dependencies.persistence.authorize !== "function" ||
    typeof dependencies.persistence.put !== "function" ||
    typeof dependencies.persistence.read !== "function" ||
    typeof dependencies.persistence.proveBucketAbsence !== "function" ||
    typeof dependencies.persistence.supersedeBucketReservation !== "function" ||
    typeof dependencies.provider?.observeBucket !== "function" ||
    typeof dependencies.provider.ensureBucket !== "function" ||
    typeof dependencies.provider.purgeAndDeleteBucket !== "function"
  ) {
    throw new TypeError("R2 management dependencies are invalid");
  }
  return Object.freeze({
    ensureBucket: (value: unknown) => ensureBucket(value, dependencies),
    purgeAndDeleteBucket: (value: unknown) => purgeAndDeleteBucket(value, dependencies),
    readRuntimeBinding: (value: unknown) => readRuntimeBinding(value, dependencies.persistence),
  });
}

async function purgeAndDeleteBucket(
  value: unknown,
  dependencies: { readonly persistence: R2Persistence; readonly provider: Provider },
) {
  const expected = parseDeletionReceipt(value);
  const stored = await dependencies.persistence.read(expected);
  if (stored === null || !sameReceipt(stored, expected)) {
    throw new R2ManagementReceiptMismatchError();
  }
  const providerReceipt = providerReceiptFrom(stored);
  try {
    const deleted = await dependencies.provider.purgeAndDeleteBucket(providerReceipt);
    return Object.freeze({
      status: "absent" as const,
      outcome: deleted.outcome === "absent" ? ("replayed" as const) : ("deleted" as const),
      receipt: stored,
      purge: Object.freeze({ objectCount: deleted.objectCount, bytes: deleted.bytes }),
    });
  } catch (error) {
    if (error instanceof CloudflareR2BucketUncertainError)
      return reconciliation("provider_unknown");
    throw error;
  }
}

async function ensureBucket(
  value: unknown,
  dependencies: { readonly persistence: R2Persistence; readonly provider: Provider },
) {
  const scope = parseMutationScope(value);
  const target = projectR2BucketTarget(scope.projectId, scope.environmentId, scope.jurisdiction);
  const input = Object.freeze({ ...scope, ...target });
  let claim: ProjectR2BucketClaimResult;
  try {
    claim = await dependencies.persistence.claim(input);
  } catch (error) {
    // The environment already owns a bucket with another target (jurisdiction). Retrying the
    // same plan can never succeed, so the caller fails the deployment instead of reconciling.
    if (error instanceof ProjectR2BucketConflictError) {
      return Object.freeze({ status: "conflict" as const, reason: "target_changed" as const });
    }
    throw error;
  }
  if (claim.status === "completed") {
    return Object.freeze({
      status: "ready" as const,
      outcome: "replayed" as const,
      receipt: claim.receipt,
    });
  }
  if (claim.mode === "observe") {
    let observation: R2BucketObservation;
    try {
      observation = await dependencies.provider.observeBucket(target);
    } catch (error) {
      if (error instanceof CloudflareR2BucketUncertainError)
        return reconciliation("provider_unknown");
      throw error;
    }
    if (observation.state === "absent") {
      // The spent create authorization left no bucket. The absence, observed after the spend, releases the reservation
      // so that a later operation of the target can reserve it again.
      const absence = Object.freeze({ ...input, observedAt: new Date() });
      await dependencies.persistence.proveBucketAbsence(absence);
      await dependencies.persistence.supersedeBucketReservation(absence);
      return reconciliation("provider_absent");
    }
    const receipt = persistedReceipt(input, observation);
    await dependencies.persistence.put(receipt);
    return Object.freeze({ status: "ready" as const, outcome: "reconciled" as const, receipt });
  }
  // The read comes before the single create authorization: a failed read must not spend it. Its result is handed
  // to the create, which then reads nothing after the authorization.
  let observation: R2BucketObservation;
  try {
    observation = await dependencies.provider.observeBucket(target);
  } catch (error) {
    if (error instanceof CloudflareR2BucketUncertainError)
      return reconciliation("provider_unknown");
    throw error;
  }
  if (!(await dependencies.persistence.authorize(input))) return reconciliation("claim_changed");
  try {
    const ensured = await dependencies.provider.ensureBucket(target, observation);
    const receipt = persistedReceipt(input, ensured.receipt);
    await dependencies.persistence.put(receipt);
    return Object.freeze({ status: "ready" as const, outcome: ensured.outcome, receipt });
  } catch (error) {
    if (error instanceof CloudflareR2BucketUncertainError)
      return reconciliation("provider_unknown");
    throw error;
  }
}

async function readRuntimeBinding(value: unknown, persistence: R2Persistence) {
  const scope = parseReadScope(value);
  const receipt = await persistence.read(scope);
  return receipt === null
    ? Object.freeze({ status: "unavailable" as const })
    : Object.freeze({
        status: "ready" as const,
        bucketName: receipt.bucketName,
        jurisdiction: receipt.jurisdiction,
      });
}

function persistedReceipt(
  input: ProjectR2BucketInput,
  receipt: R2BucketReceipt,
): ProjectR2BucketReceipt {
  return Object.freeze({
    ...input,
    bucketId: receipt.bucketId,
    observedAt: new Date(receipt.observedAt.getTime()),
  });
}

function providerReceiptFrom(receipt: ProjectR2BucketReceipt): R2BucketReceipt {
  return Object.freeze({
    bucketName: receipt.bucketName,
    bucketId: receipt.bucketId,
    jurisdiction: receipt.jurisdiction,
    storageClass: receipt.storageClass,
    publicAccess: receipt.publicAccess,
    observedAt: new Date(receipt.observedAt.getTime()),
  });
}

export function parseDeletionReceipt(value: unknown): ProjectR2BucketReceipt {
  const record = exactRecord(value, [
    "bucketId",
    "bucketName",
    "claimId",
    "environmentId",
    "jurisdiction",
    "observedAt",
    "operationId",
    "organizationId",
    "projectId",
    "publicAccess",
    "storageClass",
  ]);
  const organizationId = parseField(record["organizationId"]);
  const projectId = parseField(record["projectId"]);
  const environmentId = parseField(record["environmentId"]);
  if (record["jurisdiction"] !== "eu" && record["jurisdiction"] !== "us") {
    throw new TypeError("R2 management request is invalid");
  }
  const target = projectR2BucketTarget(projectId, environmentId, record["jurisdiction"]);
  const observedAt = record["observedAt"];
  if (
    record["bucketName"] !== target.bucketName ||
    typeof record["bucketId"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(record["bucketId"]) ||
    record["jurisdiction"] !== target.jurisdiction ||
    record["storageClass"] !== target.storageClass ||
    record["publicAccess"] !== target.publicAccess ||
    !(observedAt instanceof Date) ||
    !Number.isFinite(observedAt.getTime())
  ) {
    throw new TypeError("R2 management request is invalid");
  }
  return Object.freeze({
    organizationId,
    projectId,
    environmentId,
    operationId: parseField(record["operationId"]),
    claimId: parseField(record["claimId"]),
    ...target,
    bucketId: record["bucketId"],
    observedAt: new Date(observedAt.getTime()),
  });
}

function sameReceipt(left: ProjectR2BucketReceipt, right: ProjectR2BucketReceipt): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.operationId === right.operationId &&
    left.claimId === right.claimId &&
    left.bucketName === right.bucketName &&
    left.bucketId === right.bucketId &&
    left.jurisdiction === right.jurisdiction &&
    left.storageClass === right.storageClass &&
    left.publicAccess === right.publicAccess &&
    left.observedAt.getTime() === right.observedAt.getTime()
  );
}

function parseMutationScope(value: unknown) {
  const record = exactRecord(value, [
    "claimId",
    "jurisdiction",
    "environmentId",
    "operationId",
    "organizationId",
    "projectId",
  ]);
  if (record["jurisdiction"] !== "eu" && record["jurisdiction"] !== "us") {
    throw new TypeError("R2 management request is invalid");
  }
  return Object.freeze({
    jurisdiction: record["jurisdiction"],
    organizationId: parseField(record["organizationId"]),
    projectId: parseField(record["projectId"]),
    environmentId: parseField(record["environmentId"]),
    operationId: parseField(record["operationId"]),
    claimId: parseField(record["claimId"]),
  });
}

function parseReadScope(value: unknown) {
  const record = exactRecord(value, ["environmentId", "organizationId", "projectId"]);
  return Object.freeze({
    organizationId: parseField(record["organizationId"]),
    projectId: parseField(record["projectId"]),
    environmentId: parseField(record["environmentId"]),
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("R2 management request is invalid");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("R2 management request is invalid");
  }
  return record;
}

function parseField(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("R2 management request is invalid");
  return parseUlid(value);
}

function reconciliation(reason: "claim_changed" | "provider_absent" | "provider_unknown") {
  return Object.freeze({ status: "reconciliation_required" as const, reason });
}
