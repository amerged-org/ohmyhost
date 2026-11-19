import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type {
  PgcfEntitlementAction,
  PgcfEntitlementScope,
  PgcfEntitlementObservation,
} from "@ohmyhost/database";
import {
  PgcfProviderError,
  isPgcfResumeReceipt,
  type PgcfProjectProvider,
} from "@ohmyhost/provider-pgcf";

export interface PgcfEntitlementPersistence {
  listTargets(providerProjectId: string): Promise<PgcfEntitlementScope[]>;
  claim(
    scope: PgcfEntitlementScope,
    observation: PgcfEntitlementObservation,
    input: { now: string; actionId: string; claimId: string },
  ): Promise<
    { status: "idle" } | { status: "waiting" } | { status: "action"; job: PgcfEntitlementAction }
  >;
  begin(
    job: PgcfEntitlementAction,
    now: string,
    observation: PgcfEntitlementObservation,
  ): Promise<boolean>;
  record(
    job: PgcfEntitlementAction,
    input: {
      now: string;
      providerOperationId: string | null;
      providerGeneration: number | null;
      state: "pending" | "succeeded" | "failed" | "superseded";
    },
  ): Promise<void>;
  /** Records that the target could not be checked now; the next pass reaches the targets behind it (CORE-58). */
  recordCheckFailure(scope: PgcfEntitlementScope, now: string): Promise<void>;
}

/** Uses only metadata and suspend/resume: expiry never changes a class, volume, or SQL data. */
export function createPgcfEntitlementReconciler(input: {
  persistence: PgcfEntitlementPersistence;
  provider: PgcfProjectProvider;
  clock: Clock;
  ids: UlidFactory;
}) {
  const { persistence } = input;
  return {
    async reconcile() {
      const result = { accepted: 0, unchanged: 0, unmanaged: 0, waiting: 0, failed: 0 };
      const targets = await persistence.listTargets(input.provider.projectId);
      const deadline = input.clock.now().getTime() + 45_000;
      for (const target of targets) {
        if (input.clock.now().getTime() >= deadline) {
          result.waiting += 1;
          break;
        }
        let job: PgcfEntitlementAction | undefined;
        try {
          const observed = await input.provider.readDatabase(target.databaseId);
          const claimed = await persistence.claim(target, observed, {
            now: input.clock.now().toISOString(),
            actionId: input.ids.next(),
            claimId: input.ids.next(),
          });
          if (claimed.status === "idle") {
            result.unchanged += 1;
            continue;
          }
          if (claimed.status === "waiting") {
            result.waiting += 1;
            continue;
          }
          const action = claimed.job;
          job = action;
          const dispatchObservation =
            action.action === "resume" && action.providerOperationId === null
              ? await input.provider.readDatabase(action.databaseId)
              : observed;
          if (
            !(await persistence.begin(action, input.clock.now().toISOString(), dispatchObservation))
          ) {
            result.unchanged += 1;
            continue;
          }
          // An uncertain request is recovered under its original idempotency key, never a new action.
          const receipt =
            action.providerOperationId === null
              ? await input.provider.changeDatabase(
                  action.databaseId,
                  action.action,
                  action.idempotencyKey,
                  undefined,
                  action.expectedGeneration,
                )
              : {
                  database: await input.provider.readDatabase(action.databaseId),
                  operation: await input.provider.readOperation(action.providerOperationId),
                };
          const { database, operation } = receipt;
          if (
            operation.projectId !== action.providerProjectId ||
            operation.databaseId !== action.databaseId ||
            database.id !== action.databaseId ||
            database.projectId !== action.providerProjectId ||
            (action.providerOperationId !== null && operation.id !== action.providerOperationId) ||
            (action.action === "resume"
              ? !isPgcfResumeReceipt(receipt, action.expectedGeneration)
              : operation.kind !== "database.suspend" ||
                operation.generation !== action.expectedGeneration + 1)
          )
            throw new Error("PGCF entitlement observation differs from its action");
          const parentCompleted =
            action.action === "resume" &&
            operation.kind === "database.archive" &&
            database.storageResidency === "local" &&
            (database.generation === action.expectedGeneration + 1 ||
              database.generation === action.expectedGeneration + 2);
          const applied =
            operation.status === "succeeded" &&
            (!["database.archive", "database.rehydrate"].includes(operation.kind) ||
              database.storageResidency === "local") &&
            (database.generation === operation.generation || parentCompleted) &&
            database.observedGeneration === database.generation &&
            (action.action === "suspend"
              ? database.desiredState === "suspended" &&
                database.suspensionReason === "manual" &&
                database.observedState === "hibernated"
              : (database.desiredState === "running" ||
                  (database.desiredState === "suspended" &&
                    database.suspensionReason === "idle")) &&
                ["ready", "hibernated"].includes(database.observedState));
          const failed = operation.status === "failed";
          const superseded =
            operation.status === "succeeded" &&
            !applied &&
            database.generation > operation.generation;
          await persistence.record(action, {
            now: input.clock.now().toISOString(),
            providerOperationId: operation.id,
            // Core retains the immutable accepted action generation. Cold activation advances
            // the provider operation from N+1 to N+2; only resume uses this stable anchor, while
            // actual completion above still requires the real provider/database readiness.
            providerGeneration:
              action.action === "resume" && operation.kind === "database.rehydrate"
                ? Math.min(operation.generation, action.expectedGeneration + 1)
                : operation.generation,
            state: failed
              ? "failed"
              : applied
                ? "succeeded"
                : superseded
                  ? "superseded"
                  : "pending",
          });
          if (failed) result.failed += 1;
          else if (applied) result.accepted += 1;
          else if (superseded) result.unchanged += 1;
          else result.waiting += 1;
        } catch (error) {
          if (
            job &&
            job.providerOperationId === null &&
            error instanceof PgcfProviderError &&
            error.code === "rejected" &&
            error.status === 409 &&
            error.conflictReason === "generation_changed" &&
            !error.outcomeUnknown
          ) {
            const action = job;
            let observed: Awaited<ReturnType<typeof input.provider.readDatabase>> | null = null;
            try {
              observed = await input.provider.readDatabase(action.databaseId);
            } catch {
              // An unreadable database proves nothing: the action stays failed and is retried.
            }
            if (observed && observed.generation !== action.expectedGeneration) {
              await persistence.record(action, {
                now: input.clock.now().toISOString(),
                providerOperationId: null,
                providerGeneration: null,
                state: "superseded",
              });
              result.unchanged += 1;
              continue;
            }
          }
          if (
            job &&
            job.providerOperationId === null &&
            error instanceof PgcfProviderError &&
            error.code === "rejected" &&
            !error.outcomeUnknown &&
            error.status !== 409 &&
            error.status !== 429
          ) {
            const action = job;
            try {
              await persistence.record(action, {
                now: input.clock.now().toISOString(),
                providerOperationId: action.providerOperationId,
                providerGeneration: null,
                state: "failed",
              });
            } catch {
              // The refusal itself is reported through the failed count; the next pass retries the record.
            }
          }
          // The check time moves past this target, so a persistently failing target cannot starve the targets behind it (CORE-58).
          try {
            await persistence.recordCheckFailure(target, input.clock.now().toISOString());
          } catch {
            // The failure is counted below; the next pass reads this target again.
          }
          result.failed += 1;
        }
      }
      return result;
    },
  };
}
