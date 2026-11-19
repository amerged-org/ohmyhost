import { databaseSizeForMemory } from "@ohmyhost/contracts/database-sizes";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import {
  ProjectComputeChangeError,
  DeploymentPersistenceConflictError,
  OrganizationCreditError,
  type acceptPgcfComputeChange,
  type claimPgcfComputeJob,
  type completePgcfComputeJob,
  type readDatabaseProviderTarget,
  type replayPgcfComputeChange,
  type reserveDatabaseProviderOperation,
  type beginDatabaseProviderOperation,
  type recordDatabaseProviderOperation,
  type DatabaseProviderClaim,
} from "@ohmyhost/database";
import { PgcfProviderError, type PgcfProjectProvider } from "@ohmyhost/provider-pgcf";

type Request = Parameters<typeof replayPgcfComputeChange>[1];
type Accept = Parameters<typeof acceptPgcfComputeChange>[1];
type Claim = Parameters<typeof claimPgcfComputeJob>[1];
type Complete = Parameters<typeof completePgcfComputeJob>[1];
type Operation = Awaited<ReturnType<typeof reserveDatabaseProviderOperation>>;
export interface PgcfComputePersistence {
  replay(input: Request): Promise<string | null>;
  readScope(input: {
    organizationId: string;
    projectId: string;
    environment: "dev" | "prod";
  }): Promise<{
    environmentId: string;
    billingEpochId: string;
    physicalEnvironmentId: string;
    target: Awaited<ReturnType<typeof readDatabaseProviderTarget>>;
  }>;
  accept(input: Accept): ReturnType<typeof acceptPgcfComputeChange>;
  claim(input: Claim): ReturnType<typeof claimPgcfComputeJob>;
  complete(input: Complete): Promise<void>;
  reserve(input: Parameters<typeof reserveDatabaseProviderOperation>[1]): Promise<Operation>;
  begin(operation: Operation): ReturnType<typeof beginDatabaseProviderOperation>;
  release(input: {
    organizationId: string;
    projectId: string;
    operationId: string;
    claimId: string;
  }): Promise<boolean>;
  record(
    operation: Operation,
    observation: Parameters<typeof recordDatabaseProviderOperation>[2],
    completion?: Complete,
  ): Promise<void>;
}
export function createPgcfComputeChanges(input: {
  persistence: PgcfComputePersistence;
  provider: PgcfProjectProvider;
  clock: Clock;
  ids: UlidFactory;
}) {
  const { persistence } = input;
  return {
    async accept(raw: unknown) {
      const value = record(raw);
      const organizationId = parseUlid(String(value["organizationId"])),
        projectId = parseUlid(String(value["projectId"]));
      if (value["environment"] !== "dev" && value["environment"] !== "prod")
        throw new TypeError("Invalid compute environment");
      if ("profile" in value)
        return { status: "rejected" as const, code: "compute_change_conflict" as const };
      const size = databaseSizeForMemory(value["memoryMiB"]);
      const digest = value["canonicalRequestSha256"];
      if (
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(digest) ||
        typeof value["principalId"] !== "string" ||
        typeof value["requestId"] !== "string" ||
        typeof value["idempotencyKey"] !== "string"
      )
        throw new TypeError("Invalid compute request identity");
      const request = {
        organizationId,
        projectId,
        principalId: value["principalId"],
        ...(value["delegation"] === undefined
          ? {}
          : { delegation: value["delegation"] as NonNullable<Accept["delegation"]> }),
        requestId: value["requestId"],
        idempotencyKey: value["idempotencyKey"],
        canonicalRequestDigest: Buffer.from(digest, "hex"),
      };
      try {
        const replay = await persistence.replay(request);
        if (replay) return { status: "accepted" as const, operationId: replay };
        const scope = await persistence.readScope({
          organizationId,
          projectId,
          environment: value["environment"],
        });
        if (!scope.target || scope.target.provider !== "pgcf") return { status: "absent" as const };
        if (scope.target.providerProjectId !== input.provider.projectId)
          throw new ProjectComputeChangeError("compute_change_scope_unavailable");
        const database = await input.provider.readDatabase(scope.target.databaseId);
        if (size.storageMiB < database.resources.storageMiB)
          return {
            status: "rejected" as const,
            code: "compute_storage_shrink_requires_migration" as const,
          };
        const expectedTargetVersion = scope.target.targetVersion;
        const result = await persistence.accept({
          ...request,
          environmentId: parseUlid(scope.environmentId),
          billingEpochId: parseUlid(scope.billingEpochId),
          operationId: input.ids.next(),
          operationEventId: input.ids.next(),
          auditEventId: input.ids.next(),
          outboxEventId: input.ids.next(),
          httpMethod: "POST",
          routeTemplate: "/v1/projects/{project_id}/database/compute",
          occurredAt: input.clock.now().toISOString(),
          memoryMiB: size.memoryMiB,
          currentStorageMiB: database.resources.storageMiB,
          expectedDatabaseId: database.id,
          expectedTargetVersion,
        });
        return { status: "accepted" as const, operationId: result.operationId };
      } catch (error) {
        if (error instanceof ProjectComputeChangeError)
          return { status: "rejected" as const, code: error.code };
        if (error instanceof OrganizationCreditError)
          return { status: "rejected" as const, code: "compute_paid_required" as const };
        if (error instanceof DeploymentPersistenceConflictError)
          return { status: "rejected" as const, code: "idempotency_key_reused" as const };
        throw error;
      }
    },
    async run(raw: unknown) {
      const value = record(raw),
        scope = {
          organizationId: parseUlid(String(value["organizationId"])),
          projectId: parseUlid(String(value["projectId"])),
          operationId: parseUlid(String(value["operationId"])),
        };
      const claimId = input.ids.next();
      const mutation = () => ({
        ...scope,
        claimId,
        occurredAt: input.clock.now().toISOString(),
        operationEventId: input.ids.next(),
        auditEventId: input.ids.next(),
      });
      const job = await persistence.claim(mutation());
      if (!job) return { status: "running" as const };
      if (job.completedAt) return { status: job.state };
      if (job.providerProjectId !== input.provider.projectId)
        throw new ProjectComputeChangeError("compute_change_scope_unavailable");
      const claim: DatabaseProviderClaim = {
        ...scope,
        claimId,
        physicalEnvironmentId: job.physicalEnvironmentId,
      };
      if (!job.mutationPermitted && !job.providerDispatchStarted) {
        await persistence.complete({
          ...mutation(),
          physicalEnvironmentId: job.physicalEnvironmentId,
          success: false,
          failureCode: "DATABASE_COMPUTE_PLAN_CHANGED",
        });
        return { status: "failed" as const };
      }
      const operation = await persistence.reserve({
        ...claim,
        step: "database.resize",
        providerProjectId: job.providerProjectId,
        requestBody: { database_id: job.databaseId, size_class_id: job.sizeClassId },
      });
      // A failed read keeps a job running until PGCF permanently refuses it or the observation ceiling passes; then the
      // job fails, so no job waits on PGCF reads forever. The operator log is written on every pass past the ceiling.
      const observationFailed = async (error: unknown, providerOperationId: string | null) => {
        const now = input.clock.now();
        logObservationOverdue(now, job, providerOperationId);
        if (!observationRefused(error) && !observationCeilingPassed(now, job))
          return { status: "running" as const };
        await persistence.record(
          operation,
          { databaseId: job.databaseId, providerOperationId, state: "failed" },
          { ...mutation(), physicalEnvironmentId: job.physicalEnvironmentId, success: false },
        );
        return { status: "failed" as const };
      };
      // A known operation can be observed after Paid expires. An uncertain dispatch cannot safely be retried: its
      // idempotency key might already have reached PGCF. At the deadline PGCF's own database decides, read without any
      // mutation: the job's target size settles it, any other size fails it, and a failed read is handled as above.
      if (!job.mutationPermitted && !operation.providerOperationId) {
        if (
          input.clock.now().getTime() <
          operationAcceptedAt(job.operationId) + COMPUTE_CHANGE_DEADLINE_MS
        )
          return { status: "running" as const };
        let database: Awaited<ReturnType<PgcfProjectProvider["readDatabase"]>>;
        try {
          database = await input.provider.readDatabase(
            job.databaseId,
            AbortSignal.timeout(COMPUTE_READ_TIMEOUT_MS),
          );
        } catch (error) {
          return observationFailed(error, null);
        }
        if (database.sizeClassId !== job.sizeClassId) {
          await persistence.record(
            operation,
            { databaseId: job.databaseId, providerOperationId: null, state: "failed" },
            { ...mutation(), physicalEnvironmentId: job.physicalEnvironmentId, success: false },
          );
          return { status: "failed" as const };
        }
        const size = databaseSizeForMemory(job.memoryMiB);
        const settled =
          database.observedGeneration === database.generation &&
          database.resources.memoryMiB === size.memoryMiB &&
          database.resources.cpuMillicores === size.cpuMillicores &&
          database.resources.storageMiB === size.storageMiB;
        await persistence.record(
          operation,
          {
            databaseId: job.databaseId,
            providerOperationId: null,
            state: settled ? "succeeded" : "pending",
          },
          settled
            ? { ...mutation(), physicalEnvironmentId: job.physicalEnvironmentId, success: true }
            : undefined,
        );
        return { status: settled ? ("succeeded" as const) : ("running" as const) };
      }
      const deadline = Date.now() + 40_000;
      await persistence.begin(operation);
      let receipt;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PgcfProviderError("timeout", null, true);
        const signal = AbortSignal.timeout(remaining);
        if (operation.providerOperationId) {
          const [database, observed] = await Promise.all([
            input.provider.readDatabase(job.databaseId, signal),
            input.provider.readOperation(operation.providerOperationId, signal),
          ]);
          receipt = { database, operation: observed };
        } else
          receipt = await input.provider.changeDatabase(
            job.databaseId,
            "resize",
            operation.idempotencyKey,
            job.sizeClassId,
            undefined,
            signal,
          );
      } catch (error) {
        // An accepted operation is only observed: a failed read keeps the job running until PGCF answers with a status,
        // a permanent refusal or the observation ceiling fails it.
        if (operation.providerOperationId)
          return observationFailed(error, operation.providerOperationId);
        // Only a dispatch that never reached PGCF can be refused or abandoned at the deadline.
        const deadlinePassed =
          input.clock.now().getTime() >=
          operationAcceptedAt(job.operationId) + COMPUTE_CHANGE_DEADLINE_MS;
        if (providerRefused(error) || deadlinePassed) {
          await persistence.record(
            operation,
            {
              databaseId: job.databaseId,
              providerOperationId: operation.providerOperationId,
              state: "failed",
            },
            { ...mutation(), physicalEnvironmentId: job.physicalEnvironmentId, success: false },
          );
          return { status: "failed" as const };
        }
        return { status: "running" as const };
      } finally {
        await persistence.release({ ...scope, claimId });
      }
      if (
        receipt.operation.databaseId !== job.databaseId ||
        receipt.operation.projectId !== job.providerProjectId
      )
        throw new ProjectComputeChangeError("compute_change_conflict");
      const size = databaseSizeForMemory(job.memoryMiB);
      const settled =
        receipt.operation.status === "succeeded" &&
        receipt.database.generation >= receipt.operation.generation &&
        receipt.database.observedGeneration === receipt.database.generation &&
        receipt.database.sizeClassId === job.sizeClassId &&
        receipt.database.resources.memoryMiB === size.memoryMiB &&
        receipt.database.resources.cpuMillicores === size.cpuMillicores &&
        receipt.database.resources.storageMiB === size.storageMiB;
      const failed = receipt.operation.status === "failed";
      // A readable operation that never settles ends at the same ceiling as an unreadable one, whatever its status.
      const observedAt = input.clock.now();
      const unsettled = !settled && !failed && observationCeilingPassed(observedAt, job);
      if (unsettled) logObservationOverdue(observedAt, job, receipt.operation.id);
      const ended = failed || unsettled;
      await persistence.record(
        operation,
        {
          databaseId: job.databaseId,
          providerOperationId: receipt.operation.id,
          state: ended ? "failed" : settled ? "succeeded" : "pending",
        },
        settled || ended
          ? { ...mutation(), physicalEnvironmentId: job.physicalEnvironmentId, success: settled }
          : undefined,
      );
      return {
        status: settled
          ? ("succeeded" as const)
          : ended
            ? ("failed" as const)
            : ("running" as const),
      };
    },
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid PGCF compute request");
  return value as Record<string, unknown>;
}
/** Dispatch retries stop after this long; the job then fails instead of waiting forever. */
const COMPUTE_CHANGE_DEADLINE_MS = 20 * 60_000;
/** One read-only PGCF observation at the deadline is bounded by the same budget as a dispatch. */
const COMPUTE_READ_TIMEOUT_MS = 40_000;
/**
 * A compute job that PGCF still cannot read, or whose operation has not settled, this long after acceptance is logged
 * for an operator and failed. Placeholder value, pending the owner's confirmation (D623).
 */
const COMPUTE_OBSERVATION_CEILING_MS = 24 * 60 * 60_000;
/** PGCF 409 reasons that describe a transient state; every other reason refuses the mutation. */
const RETRYABLE_CONFLICT_REASONS = new Set([
  "mutation_in_progress",
  "not_ready",
  "node_capacity",
  "idempotency_in_progress",
  "generation_changed",
]);
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A job's operation id is a ULID minted at acceptance; its first 10 characters are the time in ms. */
function operationAcceptedAt(operationId: string): number {
  let milliseconds = 0;
  for (const character of operationId.slice(0, 10))
    milliseconds = milliseconds * 32 + ULID_ALPHABET.indexOf(character);
  return milliseconds;
}
/** Whether a compute job has not settled for the whole observation ceiling since its acceptance. */
function observationCeilingPassed(now: Date, job: { readonly operationId: string }): boolean {
  return now.getTime() >= operationAcceptedAt(job.operationId) + COMPUTE_OBSERVATION_CEILING_MS;
}
/** Operator log line for a compute job that has not settled past the observation ceiling. */
function logObservationOverdue(
  now: Date,
  job: { readonly operationId: string; readonly databaseId: string },
  providerOperationId: string | null,
): void {
  if (!observationCeilingPassed(now, job)) return;
  console.error(
    JSON.stringify({
      event: "pgcf_compute_observation_overdue",
      operationId: job.operationId,
      databaseId: job.databaseId,
      providerOperationId,
    }),
  );
}
/** A refused mutation never reaches the database, so retrying it cannot succeed. */
function providerRefused(error: unknown): boolean {
  if (!(error instanceof PgcfProviderError) || error.code !== "rejected") return false;
  if (error.status === 409) return !RETRYABLE_CONFLICT_REASONS.has(error.conflictReason ?? "");
  if (error.status === 429) return false;
  return !error.outcomeUnknown;
}
/**
 * A read that PGCF permanently refuses, such as a vanished operation or database. providerRefused is written for
 * mutations, and a read's 5xx has no unknown outcome, so it would take that too. Only 4xx answers count here. Timeouts,
 * throttling and the platform's own credential failures (401, 403) are outages to wait out, not a verdict on the job.
 */
function observationRefused(error: unknown): boolean {
  if (!providerRefused(error) || !(error instanceof PgcfProviderError)) return false;
  const status = error.status ?? 0;
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 408;
}
