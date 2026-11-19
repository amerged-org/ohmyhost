import { createHash } from "node:crypto";
import { GithubAutoDeployTargetDeniedError, OrganizationCreditError } from "@ohmyhost/database";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import { z } from "zod";

import { ProductSurfaceConflictError, type ProductSurfacePort } from "./contracts.js";
import {
  createD1ProductSurfaceDataPort,
  type D1ProductSurfaceRuntime,
} from "./d1-product-surface.js";
import {
  createGithubAutoDeployConsumer,
  type GithubAutoDeployDatabase,
  type GithubAutoDeploymentPort,
  type GithubPlanningFailureCode,
  type GithubPushClaim,
  type GithubReservation,
  type GithubTarget,
} from "./github-auto-deploy.js";
import { githubPlanningFailureCode } from "./product-surface.js";
import { notifyPreviewSources, type PreviewExecutionBinding } from "./preview-surface.js";
import type { ProductApiPreviewRuntime, PreviewCustomerScope } from "@ohmyhost/contracts/previews";

/** The Core's push ledger and the shared inbox: plain commands, no SQL and no provider authority. */
export interface D1GithubAutoDeployRuntime {
  readGithubAutoDeployTargets(input: unknown): Promise<unknown>;
  reserveGithubPushDeployment(input: unknown): Promise<unknown>;
  attachGithubPushOperation(input: unknown): Promise<unknown>;
  failGithubPushPlanning(input: unknown): Promise<unknown>;
}
/** Draining the shared inbox is the maintenance capability's; the ordinary one only touches an event it names. */
export interface D1InboxClaimRuntime {
  claimInboxEvent(input: unknown): Promise<unknown>;
}
export interface D1InboxRuntime {
  renewInboxLease(input: unknown): Promise<boolean>;
  acknowledgeInboxEvent(input: unknown): Promise<boolean>;
  failInboxEvent(input: unknown): Promise<"retry" | "reconciliation_required" | "stale">;
}
export const D1_GITHUB_AUTO_DEPLOY_METHODS = [
  "readGithubAutoDeployTargets",
  "reserveGithubPushDeployment",
  "attachGithubPushOperation",
  "failGithubPushPlanning",
] as const;
export function isD1GithubAutoDeployRuntime(value: unknown): value is D1GithubAutoDeployRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    D1_GITHUB_AUTO_DEPLOY_METHODS.every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}
export function isD1InboxClaimRuntime(value: unknown): value is D1InboxClaimRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "claimInboxEvent") === "function"
  );
}
export function isD1InboxRuntime(value: unknown): value is D1InboxRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    ["renewInboxLease", "acknowledgeInboxEvent", "failInboxEvent"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

const claimed = z.object({
  organizationId: z.string().nullable(),
  inboxEventId: z.string(),
  externalEventId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  claimId: z.string(),
  attemptNumber: z.number().int(),
  maxAttempts: z.number().int(),
});
const numeric = /^[1-9][0-9]{0,19}$/u;
const previewCandidate = z.strictObject({
  organizationId: z.string(),
  projectId: z.string(),
  sourceConnectionId: z.string(),
  sourceGeneration: z.number().int().positive().safe(),
  expectedSequence: z.number().int().nonnegative().safe(),
  branchRef: z.string().nullable(),
  configGeneration: z.number().int().positive().safe().nullable(),
  installationId: z.string(),
  repositoryId: z.string(),
  repositoryFullName: z.string(),
});
interface GithubPreviewCore {
  readGithubCandidates(input: { inboxEventId: string; claimId: string }): Promise<unknown>;
  acceptGithubSource(input: unknown): Promise<unknown>;
}
interface GithubPreviewSource {
  resolvePreviewGithubHead(input: {
    installationId: string;
    repositoryId: string;
    repositoryFullName: string;
    ref: string | null;
  }): Promise<unknown>;
}
/** Recover the current GitHub head on open, including a push whose preview notification failed. */
export function createGithubInitialPreviewSource(input: {
  readonly core: ProductApiPreviewRuntime;
  readonly source: GithubPreviewSource;
  readonly notify: (scope: { organizationId: string; projectId: string }) => Promise<void>;
}) {
  return async (scope: PreviewCustomerScope): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await input.core.get(scope);
      if (!current) return;
      const raw = await input.core.readInitialGithubCandidate(scope);
      if (raw === null) return;
      const candidate = previewCandidate.parse(raw);
      if (
        candidate.organizationId !== scope.organizationId ||
        candidate.projectId !== scope.projectId
      )
        throw new Error("Preview GitHub candidate is invalid");
      const head = z
        .strictObject({
          defaultBranch: z.string(),
          head: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
        })
        .parse(
          await input.source.resolvePreviewGithubHead({
            installationId: candidate.installationId,
            repositoryId: candidate.repositoryId,
            repositoryFullName: candidate.repositoryFullName,
            ref: candidate.branchRef,
          }),
        );
      try {
        const accepted = await input.core.acceptInitialGithubSource({
          ...scope,
          sourceConnectionId: candidate.sourceConnectionId,
          sourceGeneration: candidate.sourceGeneration,
          expectedSequence: candidate.expectedSequence,
          branchRef: candidate.branchRef ?? head.defaultBranch,
          configGeneration: candidate.configGeneration,
          observedDefaultBranch: candidate.branchRef === null ? head.defaultBranch : null,
          observedHead: head.head,
        });
        if (accepted.accepted) {
          try {
            await input.notify(scope);
          } catch {
            /* The durable pending record remains. */
          }
        }
        return;
      } catch (error) {
        if (
          errorCode(error) !== "preview_github_head_changed" &&
          errorCode(error) !== "precondition_changed"
        )
          throw error;
      }
    }
    throw new Error("Preview GitHub head changed repeatedly");
  };
}
/** Confirm the current provider head; a Core CAS forces a fresh observation after a racing push. */
export function createGithubPreviewAcceptor(input: {
  readonly core: GithubPreviewCore;
  readonly source: GithubPreviewSource;
  readonly notify: (scope: { organizationId: string; projectId: string }) => Promise<void>;
}) {
  return async (claim: GithubPushClaim): Promise<void> => {
    if (claim.deleted || claim.commitSha === null || !claim.ref.startsWith("refs/heads/")) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidates = z.array(previewCandidate).parse(
        await input.core.readGithubCandidates({
          inboxEventId: claim.inboxEventId,
          claimId: claim.claimId,
        }),
      );
      if (candidates.length === 0) return;
      const head = z
        .strictObject({
          defaultBranch: z.string(),
          head: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
        })
        .parse(
          await input.source.resolvePreviewGithubHead({
            installationId: claim.installationId,
            repositoryId: claim.repositoryId,
            repositoryFullName: claim.repositoryFullName,
            ref: claim.ref,
          }),
        );
      if (head.head !== claim.commitSha) return;
      let retry = false;
      for (const candidate of candidates) {
        if (
          candidate.installationId !== claim.installationId ||
          candidate.repositoryId !== claim.repositoryId ||
          candidate.repositoryFullName.toLowerCase() !== claim.repositoryFullName.toLowerCase()
        )
          throw new Error("Preview GitHub candidate is invalid");
        if ((candidate.branchRef ?? head.defaultBranch) !== claim.ref) continue;
        try {
          const accepted = z
            .strictObject({ sequence: z.number().int().positive().safe(), accepted: z.boolean() })
            .parse(
              await input.core.acceptGithubSource({
                inboxEventId: claim.inboxEventId,
                claimId: claim.claimId,
                organizationId: candidate.organizationId,
                projectId: candidate.projectId,
                sourceConnectionId: candidate.sourceConnectionId,
                sourceGeneration: candidate.sourceGeneration,
                expectedSequence: candidate.expectedSequence,
                branchRef: claim.ref,
                configGeneration: candidate.configGeneration,
                observedDefaultBranch: candidate.branchRef === null ? head.defaultBranch : null,
                observedHead: head.head,
              }),
            );
          if (accepted.accepted) {
            try {
              await input.notify(candidate);
            } catch {
              /* Durable outbox remains pending. */
            }
          }
        } catch (error) {
          if (
            errorCode(error) !== "preview_github_head_changed" &&
            errorCode(error) !== "precondition_changed"
          )
            throw error;
          retry = true;
          break;
        }
      }
      if (!retry) return;
    }
    throw new Error("Preview GitHub head changed repeatedly");
  };
}
const target = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  sourceConnectionId: z.string(),
  configGeneration: z.number().int(),
  branchRef: z.string(),
  installationId: z.string(),
  repositoryId: z.string(),
  grantActive: z.boolean(),
  repositoryRenamed: z.boolean(),
});
const reservation = z.object({
  pushDeploymentId: z.string(),
  outcome: z.enum(["reserved", "replay"]),
  operationId: z.string().nullable(),
  workflowAttached: z.boolean(),
});
const errorCode = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : error instanceof Error ? error.message : "";
};

/** The push ledger and inbox claims of the original consumer, over named Core commands. */
export function createD1GithubAutoDeployDatabase(input: {
  readonly github: D1GithubAutoDeployRuntime;
  readonly inbox: D1InboxRuntime;
  readonly drain: D1InboxClaimRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  /** The project's open billing epoch: a push that could not be planned is recorded as a failed operation of it. */
  readonly billingEpochOf: (organizationId: string, projectId: string) => Promise<string>;
  readonly log?: (event: string, fields: Record<string, string>) => void;
  readonly acceptPreview?: (claim: GithubPushClaim) => Promise<void>;
}): GithubAutoDeployDatabase {
  const organizations = new Map<string, string | null>();
  const lease = (seconds: number) =>
    new Date(input.clock.now().getTime() + seconds * 1000).toISOString();
  const scope = (value: Pick<GithubPushClaim, "claimId" | "inboxEventId">) => {
    const organizationId = organizations.get(value.claimId);
    if (organizationId === undefined) throw new Error("GitHub push claim is unknown");
    return {
      organizationId,
      provider: "github" as const,
      inboxEventId: value.inboxEventId,
      claimId: value.claimId,
    };
  };
  const database: GithubAutoDeployDatabase = {
    async claimOne() {
      const claimedAt = input.clock.now().toISOString();
      const raw = await input.drain.claimInboxEvent({
        shardId: 0,
        provider: "github",
        eventType: "push",
        claimId: input.ids.next(),
        claimedAt,
        leaseExpiresAt: lease(30),
      });
      if (raw === null) return null;
      const row = claimed.parse(raw),
        payload = row.payload,
        installationId = String(payload["installationId"]),
        repositoryId = String(payload["repositoryId"]),
        repositoryFullName = String(payload["repositoryFullName"]),
        ref = String(payload["ref"]),
        commit = payload["commitSha"],
        deleted = payload["deleted"];
      if (
        !numeric.test(installationId) ||
        !/^[1-9][0-9]{0,15}$/u.test(repositoryId) ||
        !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u.test(repositoryFullName) ||
        !ref.startsWith("refs/") ||
        typeof deleted !== "boolean" ||
        (commit !== null && !/^(?!0{40}$)[0-9a-f]{40}$/u.test(String(commit)))
      )
        throw new TypeError("Persisted GitHub push payload is invalid");
      organizations.set(row.claimId, row.organizationId);
      return {
        inboxEventId: row.inboxEventId,
        deliveryGuid: row.externalEventId,
        installationId,
        repositoryId,
        repositoryFullName,
        ref,
        commitSha: commit === null ? null : String(commit),
        deleted,
        claimId: row.claimId,
        claimedAt,
        attemptNumber: row.attemptNumber,
        maxAttempts: row.maxAttempts,
      };
    },
    async targetsFor(claim: GithubPushClaim) {
      if (claim.ref.startsWith("refs/heads/") && input.acceptPreview !== undefined) {
        if (!(await database.renew(claim))) throw new Error("GitHub push claim became stale");
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
          await Promise.race([
            input.acceptPreview(claim).catch(() => {
              input.log?.("github_preview_acceptance_deferred", {
                inboxEventId: claim.inboxEventId,
              });
            }),
            stale,
          ]);
          if (!(await database.renew(claim))) throw new Error("GitHub push claim became stale");
        } finally {
          if (timer !== undefined) clearInterval(timer);
        }
      }
      return z.array(target).parse(
        await input.github.readGithubAutoDeployTargets({
          installationId: claim.installationId,
          repositoryId: claim.repositoryId,
          repositoryFullName: claim.repositoryFullName,
        }),
      ) as readonly GithubTarget[];
    },
    async reserve(value: GithubPushClaim & GithubTarget): Promise<GithubReservation> {
      if (value.commitSha === null) throw new TypeError("Only non-deletion pushes may be reserved");
      let stored: z.output<typeof reservation>;
      try {
        stored = reservation.parse(
          await input.github.reserveGithubPushDeployment({
            inboxEventId: value.inboxEventId,
            deliveryGuid: value.deliveryGuid,
            installationId: value.installationId,
            repositoryId: value.repositoryId,
            ref: value.ref,
            commitSha: value.commitSha,
            claimedAt: value.claimedAt,
            organizationId: value.organizationId,
            projectId: value.projectId,
            sourceConnectionId: value.sourceConnectionId,
            configGeneration: value.configGeneration,
            branchRef: value.branchRef,
            pushDeploymentId: input.ids.next(),
          }),
        );
      } catch (error) {
        const code = errorCode(error);
        if (code === "GITHUB_AUTO_DEPLOY_DISABLED" || code === "GITHUB_AUTO_DEPLOY_GRANT_REVOKED")
          throw new GithubAutoDeployTargetDeniedError(code);
        throw error;
      }
      return {
        ...value,
        pushDeploymentId: stored.pushDeploymentId,
        outcome: stored.outcome,
        // A push whose operation does not exist yet carries the id a failed plan would be recorded under.
        operationId: stored.operationId ?? input.ids.next(),
        workflowAttached: stored.workflowAttached,
      };
    },
    async renew(claim) {
      return input.inbox.renewInboxLease({
        ...scope(claim),
        renewedAt: input.clock.now().toISOString(),
        leaseExpiresAt: lease(120),
      });
    },
    async deny(value) {
      // The denial has no reader and no table on the Core: it is an event, not a record.
      input.log?.("github_push_target_denied", {
        inboxEventId: value.inboxEventId,
        projectId: value.projectId,
        code: value.denialCode ?? "GITHUB_AUTO_DEPLOY_GRANT_REVOKED",
      });
      return "created" as const;
    },
    async failPlanning(value) {
      const failedAt = input.clock.now().toISOString();
      return z.enum(["failed", "superseded", "existing"]).parse(
        await input.github.failGithubPushPlanning({
          organizationId: value.organizationId,
          projectId: value.projectId,
          pushDeploymentId: value.pushDeploymentId,
          operationId: String(value.operationId),
          billingEpochId: await input.billingEpochOf(value.organizationId, value.projectId),
          auditEventId: input.ids.next(),
          queuedOperationEventId: input.ids.next(),
          startedOperationEventId: input.ids.next(),
          operationEventId: input.ids.next(),
          failedAt,
          errorCode: value.planningFailureCode,
          diagnostic: value.diagnostic,
        }),
      );
    },
    async acknowledge(claim) {
      if (!organizations.has(claim.claimId)) return false;
      const acknowledged = await input.inbox.acknowledgeInboxEvent({
        ...scope(claim),
        acknowledgedAt: input.clock.now().toISOString(),
      });
      if (acknowledged) organizations.delete(claim.claimId);
      return acknowledged;
    },
    async fail(claim) {
      const failedAt = input.clock.now().toISOString();
      const result = await input.inbox.failInboxEvent({
        ...scope(claim),
        failedAt,
        errorCode: claim.code,
        nextAvailableAt: new Date(Date.parse(failedAt) + 30_000).toISOString(),
      });
      organizations.delete(claim.claimId);
      if (result === "stale") throw new Error("GitHub push failure claim is stale");
      return result;
    },
  };
  return Object.freeze(database);
}

/** Plans and accepts the Dev deployment of a push through the product capability, as the system principal. */
export function createD1GithubAutoDeployments(input: {
  readonly surface: ProductSurfacePort;
  readonly github: D1GithubAutoDeployRuntime;
  readonly clock: Clock;
}): GithubAutoDeploymentPort {
  const principalId = "system:github-push";
  const credit = (code: string): GithubPlanningFailureCode | null =>
    code === "paid_plan_required"
      ? "PAID_PLAN_REQUIRED"
      : code === "project_budget_exceeded"
        ? "PROJECT_BUDGET_EXCEEDED"
        : code === "insufficient_organization_credits"
          ? "INSUFFICIENT_ORGANIZATION_CREDITS"
          : null;
  return {
    async requestDev(request) {
      const rejected = (code: GithubPlanningFailureCode, diagnostic: unknown = null) => ({
        status: "rejected" as const,
        operationId: request.operationId,
        code,
        diagnostic: diagnostic as never,
      });
      const context = {
        organizationId: parseUlid(request.organizationId),
        projectId: parseUlid(request.projectId),
        principalId,
        requestId: `github-push-${request.pushDeploymentId}`,
      };
      const refusal = (error: unknown) => {
        // A transient refusal (an unreleased provider cutover, a project operation or a data change still running) is a
        // platform condition: the push is released for retry instead of ending as rejected (D040). Any other refusal of
        // the Core, such as a deployment refused for an inactive project, is a real rejection of the push.
        if (
          error instanceof ProductSurfaceConflictError &&
          ["cutover_pending", "project_operation_in_progress", "data_change_in_progress"].includes(
            error.reason,
          )
        )
          throw error;
        if (error instanceof ProductSurfaceConflictError)
          return rejected(githubPlanningFailureCode(error.reason), error.diagnostic);
        if (error instanceof OrganizationCreditError) {
          const code = credit(error.code);
          if (code !== null) return rejected(code);
        }
        throw error;
      };
      let planId: ReturnType<typeof parseUlid>;
      try {
        const planned = await input.surface.planDeployment({
          ...context,
          commitSha: request.commitSha,
          environment: "dev",
          sourceConnectionId: parseUlid(request.sourceConnectionId),
        });
        const id = (planned.body as Record<string, unknown>)["id"];
        planId = parseUlid(String(id));
      } catch (error) {
        return refusal(error);
      }
      let operationId: string;
      try {
        // Acceptance is idempotent by delivery and project, so a retried push finds the operation it already created.
        const created = await input.surface.createDeployment({
          ...context,
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: new Uint8Array(
            createHash("sha256")
              .update(JSON.stringify({ commit_sha: request.commitSha }))
              .digest(),
          ),
          planId,
        });
        operationId = String((created.body as Record<string, unknown>)["id"]);
      } catch (error) {
        return refusal(error);
      }
      await input.github.attachGithubPushOperation({
        organizationId: request.organizationId,
        projectId: request.projectId,
        pushDeploymentId: request.pushDeploymentId,
        operationId,
        now: input.clock.now().toISOString(),
      });
      return { status: "attached" as const, operationId: parseUlid(operationId) };
    },
  };
}

/** One push per tick, claimed from the shared inbox; its ledger and the deployment it accepts live in the Core. */
export function createD1GithubPushConsumer(input: {
  readonly bindings: {
    readonly GITHUB_RUNTIME?: unknown;
    readonly CONTROL_RUNTIME?: unknown;
    readonly CONTROL_MAINTENANCE_RUNTIME?: unknown;
    readonly PRODUCT_API_RUNTIME?: D1ProductSurfaceRuntime;
    readonly PREVIEW_API_RUNTIME?: ProductApiPreviewRuntime & GithubPreviewCore;
    readonly PREVIEW_EXECUTION?: PreviewExecutionBinding;
    readonly SOURCE_INSPECTOR?: Partial<GithubPreviewSource>;
  };
  readonly surface: ProductSurfacePort;
  readonly clock: Clock;
  readonly ids: UlidFactory;
}) {
  const github = input.bindings.GITHUB_RUNTIME,
    control = input.bindings.CONTROL_RUNTIME,
    maintenance = input.bindings.CONTROL_MAINTENANCE_RUNTIME,
    product = input.bindings.PRODUCT_API_RUNTIME;
  if (
    !isD1GithubAutoDeployRuntime(github) ||
    !isD1InboxRuntime(control) ||
    !isD1InboxClaimRuntime(maintenance) ||
    product === undefined
  )
    throw new Error("GitHub auto-deploy is unavailable");
  const data = createD1ProductSurfaceDataPort(product);
  const preview = input.bindings.PREVIEW_API_RUNTIME;
  const source = input.bindings.SOURCE_INSPECTOR;
  const acceptPreview =
    preview && source && typeof source.resolvePreviewGithubHead === "function"
      ? createGithubPreviewAcceptor({
          core: preview,
          source: source as GithubPreviewSource,
          notify: (scope) => notifyPreviewSources(preview, input.bindings.PREVIEW_EXECUTION, scope),
        })
      : undefined;
  return createGithubAutoDeployConsumer({
    database: createD1GithubAutoDeployDatabase({
      github,
      inbox: control,
      drain: maintenance,
      clock: input.clock,
      ids: input.ids,
      ...(acceptPreview === undefined ? {} : { acceptPreview }),
      billingEpochOf: async (organizationId, projectId) => {
        const scope = await data.readScope({
          organizationId: parseUlid(organizationId),
          projectId: parseUlid(projectId),
        });
        if (!scope) throw new Error("Project scope is unavailable");
        return scope.billingEpochId;
      },
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    }),
    deployments: createD1GithubAutoDeployments({
      surface: input.surface,
      github,
      clock: input.clock,
    }),
  });
}
