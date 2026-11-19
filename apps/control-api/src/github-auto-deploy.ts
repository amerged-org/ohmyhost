import { GithubAutoDeployTargetDeniedError } from "@ohmyhost/database";
import type { FrameworkConversionDiagnostic } from "@ohmyhost/contracts/framework-admission";

import { SourceAdmissionPolicyInconsistentError } from "./contracts.js";

export interface GithubPushClaim {
  readonly inboxEventId: string;
  readonly deliveryGuid: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly ref: string;
  readonly commitSha: string | null;
  readonly deleted: boolean;
  readonly claimId: string;
  readonly claimedAt: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
}
export interface GithubTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly sourceConnectionId: string;
  readonly configGeneration: number;
  readonly branchRef: string;
  readonly installationId: string;
  readonly repositoryId: string;
  readonly grantActive: boolean;
  /** The stored owner and name no longer name the repository: GitHub renamed it since it was linked (CORE-44). */
  readonly repositoryRenamed: boolean;
}
export interface GithubReservation extends GithubTarget {
  readonly pushDeploymentId: string;
  readonly outcome: "reserved" | "replay";
  readonly operationId: string | null;
  readonly workflowAttached: boolean;
}
export type GithubFailureCode =
  | "GITHUB_AUTO_DEPLOY_GRANT_REVOKED"
  | "GITHUB_AUTO_DEPLOY_PERSISTENCE_UNCERTAIN"
  | "GITHUB_AUTO_DEPLOY_POLICY_INCONSISTENT"
  | "GITHUB_AUTO_DEPLOY_REQUEST_FAILED";
export type GithubPlanningFailureCode =
  | "WORKERS_RUNTIME_INCOMPATIBLE"
  | "FRAMEWORK_CONVERSION_REQUIRED"
  | "MIGRATION_FILENAME_NONCANONICAL"
  | "MAIL_DOMAIN_REQUIRED"
  | "PAID_PLAN_REQUIRED"
  | "INSUFFICIENT_ORGANIZATION_CREDITS"
  | "PROJECT_BUDGET_EXCEEDED"
  | "SOURCE_ADMISSION_REJECTED"
  | "REPOSITORY_RENAMED";
export interface GithubAutoDeployDatabase {
  claimOne(): Promise<GithubPushClaim | null>;
  targetsFor(claim: GithubPushClaim): Promise<readonly GithubTarget[]>;
  reserve(input: GithubPushClaim & GithubTarget): Promise<GithubReservation>;
  renew(input: Pick<GithubPushClaim, "inboxEventId" | "claimId">): Promise<boolean>;
  deny(
    input: GithubPushClaim &
      GithubTarget & {
        readonly denialCode?: "GITHUB_AUTO_DEPLOY_GRANT_REVOKED" | "GITHUB_AUTO_DEPLOY_DISABLED";
      },
  ): Promise<"created" | "existing">;
  failPlanning(
    input: GithubPushClaim &
      GithubTarget &
      GithubReservation & {
        readonly planningFailureCode: GithubPlanningFailureCode;
        readonly diagnostic: FrameworkConversionDiagnostic | null;
      },
  ): Promise<"failed" | "superseded" | "existing">;
  acknowledge(input: Pick<GithubPushClaim, "inboxEventId" | "claimId">): Promise<boolean>;
  fail(
    input: GithubPushClaim & { readonly code: GithubFailureCode },
  ): Promise<"retry" | "reconciliation_required">;
}
export interface GithubAutoDeploymentPort {
  requestDev(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly commitSha: string;
    readonly idempotencyKey: string;
    readonly expectedConfigGeneration: number;
    readonly pushDeploymentId: string;
    readonly sourceConnectionId: string;
    readonly operationId: string;
  }): Promise<
    | { readonly status: "attached"; readonly operationId: string }
    | {
        readonly status: "rejected";
        readonly operationId: string;
        readonly code: GithubPlanningFailureCode;
        /** The typed refusal of a framework conversion rejection; null for every other code. */
        readonly diagnostic: FrameworkConversionDiagnostic | null;
      }
  >;
}

export function createGithubAutoDeployConsumer(input: {
  readonly database: GithubAutoDeployDatabase;
  readonly deployments: GithubAutoDeploymentPort;
}) {
  return Object.freeze({
    async pollOne() {
      const claim = await input.database.claimOne();
      if (claim === null) return { status: "idle" as const };
      try {
        if (claim.deleted || claim.commitSha === null) {
          await acknowledge(input.database, claim);
          return { status: "ignored" as const, reason: "deleted" as const };
        }
        const commitSha = claim.commitSha;
        const configured = await input.database.targetsFor(claim);
        if (!(await input.database.renew(claim))) return { status: "stale" as const };
        const targets = configured.filter(
          (target) =>
            target.branchRef === claim.ref &&
            target.installationId === claim.installationId &&
            target.repositoryId === claim.repositoryId,
        );
        if (targets.length === 0) {
          await acknowledge(input.database, claim);
          return {
            status: "ignored" as const,
            reason: configured.length === 0 ? ("unconfigured" as const) : ("branch" as const),
          };
        }
        const operationIds: string[] = [];
        const deniedProjectIds: string[] = [];
        const failedProjectIds: string[] = [];
        let queued = false;
        for (const target of targets) {
          if (!(await input.database.renew(claim))) return { status: "stale" as const };
          if (!target.grantActive) {
            await input.database.deny({ ...claim, ...target });
            deniedProjectIds.push(target.projectId);
            continue;
          }
          let reserved: GithubReservation;
          try {
            reserved = await input.database.reserve({ ...claim, ...target });
          } catch (error) {
            if (error instanceof GithubAutoDeployTargetDeniedError) {
              await input.database.deny({ ...claim, ...target, denialCode: error.denialCode });
              deniedProjectIds.push(target.projectId);
              continue;
            }
            throw error;
          }
          if (
            reserved.outcome === "replay" &&
            reserved.operationId !== null &&
            reserved.workflowAttached
          ) {
            operationIds.push(reserved.operationId);
            continue;
          }
          if (!(await input.database.renew(claim))) return { status: "stale" as const };
          if (reserved.operationId === null)
            throw new Error("Push operation reservation is missing");
          // A repository renamed on GitHub since the project linked it is never planned under its stored name: the push
          // ends in a visible failed operation that tells the customer to re-link it (CORE-44).
          if (target.repositoryRenamed) {
            await input.database.failPlanning({
              ...claim,
              ...target,
              ...reserved,
              planningFailureCode: "REPOSITORY_RENAMED",
              diagnostic: null,
            });
            failedProjectIds.push(target.projectId);
            continue;
          }
          const operationId = reserved.operationId;
          const operation = await withClaimHeartbeat(input.database, claim, () =>
            input.deployments.requestDev({
              organizationId: target.organizationId,
              projectId: target.projectId,
              commitSha,
              idempotencyKey: `github-push:${claim.deliveryGuid}:${target.projectId}`,
              expectedConfigGeneration: target.configGeneration,
              pushDeploymentId: reserved.pushDeploymentId,
              sourceConnectionId: target.sourceConnectionId,
              operationId,
            }),
          );
          if (operation.status === "rejected") {
            await input.database.failPlanning({
              ...claim,
              ...target,
              ...reserved,
              planningFailureCode: operation.code,
              diagnostic: operation.diagnostic,
            });
            failedProjectIds.push(target.projectId);
            continue;
          }
          operationIds.push(operation.operationId);
          queued = true;
          if (!(await input.database.renew(claim))) return { status: "stale" as const };
        }
        await acknowledge(input.database, claim);
        return {
          status: queued
            ? ("queued" as const)
            : operationIds.length > 0
              ? ("replayed" as const)
              : failedProjectIds.length > 0
                ? ("failed" as const)
                : ("denied" as const),
          operationIds,
          deniedProjectIds,
          ...(failedProjectIds.length === 0 ? {} : { failedProjectIds }),
        };
      } catch (error) {
        // Disagreeing admission policies are retried like any platform fault, under their own code.
        return fail(
          input.database,
          claim,
          error instanceof SourceAdmissionPolicyInconsistentError
            ? "GITHUB_AUTO_DEPLOY_POLICY_INCONSISTENT"
            : "GITHUB_AUTO_DEPLOY_REQUEST_FAILED",
        );
      }
    },
  });
}
async function acknowledge(database: GithubAutoDeployDatabase, claim: GithubPushClaim) {
  if (!(await database.acknowledge(claim))) throw new Error("GitHub push claim is stale");
}
async function withClaimHeartbeat<T>(
  database: GithubAutoDeployDatabase,
  claim: GithubPushClaim,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stale = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      void database.renew(claim).then(
        (renewed) => {
          if (!renewed) reject(new Error("GitHub push claim became stale"));
        },
        () => reject(new Error("GitHub push claim renewal failed")),
      );
    }, 20_000);
  });
  try {
    return await Promise.race([work(), stale]);
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}
async function fail(
  database: GithubAutoDeployDatabase,
  claim: GithubPushClaim,
  code: GithubFailureCode,
) {
  return { status: await database.fail({ ...claim, code }), code };
}

/** Claims one scheduled tick may make, and the wall time it may spend, below the cron limits. */
export const PUSH_DRAIN_CLAIM_LIMIT = 20;
export const PUSH_DRAIN_WALL_MILLISECONDS = 30_000;
/** A tick that has processed nothing stops after this many failed claims in a row: the inbox is down. */
export const PUSH_DRAIN_CONSECUTIVE_FAILURES = 3;

export type GithubPushDrainResult = {
  readonly status: "idle" | "budget" | "failed";
  readonly processed: number;
  readonly failed: number;
};

/**
 * One scheduled tick of the shared push inbox: claims until the inbox is idle or the budget ends. A claim that
 * throws is counted and skipped past. Its lease keeps the row out of the rest of this tick, and the attempt limit
 * of the inbox ends its retries, so one unreadable push cannot hold back the pushes behind it. A tick that processed
 * nothing and failed is reported as `failed`, and it stops early when the inbox keeps failing (a total outage).
 */
export async function drainGithubPushes(
  consumer: { pollOne(): Promise<{ status: string }> },
  options: { readonly now: () => number },
): Promise<GithubPushDrainResult> {
  const started = options.now();
  let processed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const finish = (status: "idle" | "budget"): GithubPushDrainResult =>
    processed === 0 && failed > 0
      ? { status: "failed", processed, failed }
      : { status, processed, failed };
  while (processed + failed < PUSH_DRAIN_CLAIM_LIMIT) {
    if (options.now() - started >= PUSH_DRAIN_WALL_MILLISECONDS) return finish("budget");
    if (processed === 0 && consecutiveFailures >= PUSH_DRAIN_CONSECUTIVE_FAILURES)
      return finish("budget");
    try {
      const claim = await consumer.pollOne();
      consecutiveFailures = 0;
      if (claim.status === "idle") return finish("idle");
      processed += 1;
    } catch {
      failed += 1;
      consecutiveFailures += 1;
    }
  }
  return finish("budget");
}
