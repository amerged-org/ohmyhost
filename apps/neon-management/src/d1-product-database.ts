import type { D1PgcfEntitlementRuntime } from "./d1-pgcf-entitlements.js";
import { readD1PgcfConfiguration, type D1PgcfConfiguration } from "./d1-bindings.js";
import { parseUlid, type Clock, type EntropySource, type UlidFactory } from "@ohmyhost/platform";
import {
  assertProjectDatabaseWriteReceipt,
  parseProjectDatabaseAccessRequest,
} from "@ohmyhost/contracts/database-access";
import {
  ProjectComputeChangeError,
  DeploymentPersistenceConflictError,
  ProjectDatabaseWriteError,
  OrganizationCreditError,
  publicProjectDatabaseAccess,
  ProjectDatabaseAccessError,
  type ProjectDatabaseAccessRecord,
  type IssuedProjectDatabaseAccess,
} from "@ohmyhost/database";
import {
  issuePgcfDatabaseAccess,
  revokePgcfDatabaseAccess,
  ReadOnlyProofError,
  type DatabaseAccessConnection,
  type PgcfAccessProvider,
} from "./pgcf-access.js";
import type { PgcfPostgresTarget } from "@ohmyhost/database";
import type { WebhookLifecycleRuntime } from "./pgcf-webhook-subscriptions.js";

interface ProductDatabaseBinding extends D1PgcfEntitlementRuntime, WebhookLifecycleRuntime {
  expireProductDatabaseWrites(input: unknown): Promise<number>;
  readProductDiagnosticTarget(
    input: unknown,
  ): Promise<import("@ohmyhost/database").ProjectDatabaseSqlTarget | null>;
  readDueProductCompute(
    input: unknown,
  ): Promise<readonly { organizationId: string; projectId: string; operationId: string }[]>;
  acknowledgeProductComputeOutbox(input: unknown): Promise<boolean>;
  replayProductCompute(input: unknown): Promise<string | null>;
  readProductComputeScope(input: unknown): Promise<
    Awaited<ReturnType<import("./pgcf-compute.js").PgcfComputePersistence["readScope"]>> & {
      dataMode: "shared" | "isolated";
    }
  >;
  acceptProductCompute(
    input: unknown,
  ): ReturnType<import("./pgcf-compute.js").PgcfComputePersistence["accept"]>;
  claimProductCompute(
    input: unknown,
  ): ReturnType<import("./pgcf-compute.js").PgcfComputePersistence["claim"]>;
  completeProductCompute(input: unknown): Promise<void>;
  recordProductCompute(input: unknown): Promise<void>;
  releaseProductComputeUse(input: unknown): Promise<boolean>;

  issueProductDatabaseAccess(
    input: unknown,
  ): Promise<
    | { status: "accepted"; access: IssuedProjectDatabaseAccess }
    | { status: "rejected"; code: string }
  >;
  readProductDatabaseAccess(input: unknown): Promise<ProjectDatabaseAccessRecord | null>;
  readProductDatabaseAccessForIssuance(input: unknown): Promise<ProjectDatabaseAccessRecord | null>;
  revokeProductDatabaseAccess(input: unknown): Promise<ProjectDatabaseAccessRecord | null>;
  recordProductDatabaseAccessOperation(input: unknown): Promise<ProjectDatabaseAccessRecord | null>;
  readProductDatabaseAccessSweep(input: unknown): Promise<{
    expired: readonly ProjectDatabaseAccessRecord[];
    undropped: readonly ProjectDatabaseAccessRecord[];
    active: readonly ProjectDatabaseAccessRecord[];
  }>;
  markProductDatabaseAccessSweepAttempts(input: unknown): Promise<number>;
  readProductAccessCreditAdmission(input: unknown): Promise<{ allowed: boolean }>;
  readDataChangeProductAccess(input: unknown): Promise<readonly string[]>;
  acceptProductDatabaseWrite(input: unknown): Promise<unknown>;
  finishProductDatabaseWrite(input: unknown): Promise<unknown>;
}
type AccessRevocation = {
  readonly revokedAt: string;
  readonly revokedBy: string;
  readonly reason: "principal" | "expired" | "budget" | "creation_failed" | "data_change";
  readonly roleDropped: boolean;
  readonly auditEventId: string;
};
function request(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new TypeError("Invalid database product request");
  return raw as Record<string, unknown>;
}
/** PGCF-only actual caller. Core owns no password/connection/SQL; provider role options and native login proof use the original helper. */
export function createD1ProjectDatabaseAccessManager(input: {
  runtime: ProductDatabaseBinding;
  provider: PgcfAccessProvider;
  connect: (uri: string, target: PgcfPostgresTarget) => Promise<DatabaseAccessConnection>;
  clock: Clock;
  ids: UlidFactory;
  entropy: EntropySource;
}) {
  const runtime = input.runtime,
    at = () => input.clock.now().toISOString();
  const read = (scope: { organizationId: string; projectId: string; accessId: string }) =>
    runtime.readProductDatabaseAccess({ ...scope, now: at() });
  /** Records a provider operation of one access; a failed deletion arrives together with the access's revocation. */
  const operationRecorder =
    (
      scope: { organizationId: string; projectId: string; accessId: string },
      revocation?: AccessRevocation,
    ) =>
    (kind: "create" | "delete", operationId: string, previousOperationId?: string) =>
      runtime
        .recordProductDatabaseAccessOperation({
          ...scope,
          kind,
          operationId,
          previousOperationId,
          revocation,
        })
        .then(() => undefined);
  const revoke = async (
    record: ProjectDatabaseAccessRecord,
    reason: "principal" | "expired" | "budget" | "creation_failed" | "data_change",
    revokedBy: string,
    now: string,
    waitForCompletion = true,
  ) => {
    if (record.revokedAt !== null && record.roleDroppedAt !== null) return record;
    const scope = {
      organizationId: record.organizationId,
      projectId: record.projectId,
      accessId: record.accessId,
    };
    const revocation = {
      revokedAt: now,
      revokedBy,
      reason,
      roleDropped: false,
      auditEventId: input.ids.next(),
    };
    const dropped = await revokePgcfDatabaseAccess({
      provider: input.provider,
      connect: input.connect,
      access: record,
      waitForCompletion,
      recordOperation: operationRecorder(scope, revocation),
    });
    if (!dropped.dropped) throw new Error("PGCF role revocation is not complete");
    const result = await runtime.revokeProductDatabaseAccess({
      ...scope,
      ...revocation,
      roleDropped: true,
    });
    if (!result) throw new ProjectDatabaseAccessError("scope");
    return result;
  };
  return {
    async issue(raw: unknown) {
      const value = request(raw, [
        "organizationId",
        "projectId",
        "principalId",
        "requestId",
        "environment",
        "mode",
        "ttlSeconds",
        "label",
      ]);
      const scope = {
        organizationId: parseUlid(String(value["organizationId"])),
        projectId: parseUlid(String(value["projectId"])),
      };
      const wanted = parseProjectDatabaseAccessRequest({
        environment: value["environment"],
        mode: value["mode"],
        ttl_seconds: value["ttlSeconds"],
        label: value["label"],
      });
      if (
        wanted.label !== (value["label"] ?? null) ||
        typeof value["requestId"] !== "string" ||
        value["requestId"].length === 0
      )
        throw new TypeError("Invalid database access request");
      const bytes = new Uint8Array(8);
      input.entropy.fill(bytes);
      const roleSuffix = Array.from(bytes, (b) => (b % 36).toString(36)).join("");
      bytes.fill(0);
      const accessId = input.ids.next(),
        auditEventId = input.ids.next();
      const result = await runtime.issueProductDatabaseAccess({
        ...scope,
        environment: wanted.environment,
        mode: wanted.mode,
        ttlSeconds: wanted.ttl_seconds,
        label: wanted.label,
        principalId: String(value["principalId"]),
        now: at(),
        roleSuffix,
        accessId,
        auditEventId,
      });
      if (result.status === "rejected") return result;
      const accepted = result.access;
      const accessScope = { ...scope, accessId: accepted.accessId };
      try {
        return await issuePgcfDatabaseAccess({
          provider: input.provider,
          connect: input.connect,
          accepted,
          projectId: scope.projectId,
          recordOperation: operationRecorder(accessScope),
          assertScope: async () => {
            const current = await runtime.readProductDatabaseAccessForIssuance({
              ...scope,
              accessId: accepted.accessId,
              now: at(),
            });
            if (
              !current ||
              current.dataEnvironmentId !== accepted.dataEnvironmentId ||
              current.providerProjectId !== accepted.providerProjectId ||
              current.databaseId !== accepted.databaseId ||
              current.roleName !== accepted.roleName
            )
              throw new ProjectDatabaseAccessError("scope");
          },
        });
      } catch (error) {
        // Fixed codes only, never a message: an operator tells a refused read proof (`proof` names the failed checks)
        // from an outage (`proof` null) without any value reaching the log. `grants` is what the owner grants did before
        // a refused proof: `busy` means a migration held the lock and a retry can fix it, `current` or `ensured` that the
        // grants are in place and the PGCF baseline is what is missing.
        console.log(
          JSON.stringify({
            event: "database_access_issue_failed",
            mode: accepted.mode,
            proof: error instanceof ReadOnlyProofError ? error.failed : null,
            grants: error instanceof ReadOnlyProofError ? error.grants : null,
          }),
        );
        // A failed deletion recorded here arrives with this revocation, so the access never stays active with a delete id.
        const revocation = {
          revokedAt: at(),
          revokedBy: "platform",
          reason: "creation_failed" as const,
          roleDropped: false,
          auditEventId: input.ids.next(),
        };
        let roleDropped = false;
        try {
          roleDropped = (
            await revokePgcfDatabaseAccess({
              provider: input.provider,
              connect: input.connect,
              access: accepted,
              recordOperation: operationRecorder(accessScope, revocation),
            })
          ).dropped;
        } catch {
          // The sweep retries a role that is not confirmed dropped.
        }
        try {
          await runtime.revokeProductDatabaseAccess({
            ...scope,
            ...revocation,
            accessId: accepted.accessId,
            roleDropped,
          });
        } catch {
          // An access whose revocation is lost expires with its lifetime and is swept.
        }
        return { status: "rejected" as const, code: "unavailable" as const };
      }
    },
    async revoke(raw: unknown) {
      const value = request(raw, ["organizationId", "projectId", "principalId", "accessId"]);
      const scope = {
        organizationId: parseUlid(String(value["organizationId"])),
        projectId: parseUlid(String(value["projectId"])),
        accessId: parseUlid(String(value["accessId"])),
      };
      const current = await read(scope);
      if (!current) return { status: "rejected" as const, code: "not_found" as const };
      return publicProjectDatabaseAccess(
        await revoke(current, "principal", String(value["principalId"]), at()),
      );
    },
    async revokeDataChangeAccess(raw: unknown) {
      const value = request(raw, [
        "organizationId",
        "projectId",
        "environmentId",
        "operationId",
        "claimId",
        "losingEnvironmentId",
      ]);
      const scope = {
        organizationId: parseUlid(String(value["organizationId"])),
        projectId: parseUlid(String(value["projectId"])),
      };
      const accessIds = await runtime.readDataChangeProductAccess({
        ...scope,
        environmentId: parseUlid(String(value["environmentId"])),
        operationId: parseUlid(String(value["operationId"])),
        claimId: parseUlid(String(value["claimId"])),
        losingEnvironmentId: parseUlid(String(value["losingEnvironmentId"])),
      });
      let revoked = 0;
      for (const accessId of accessIds) {
        const current = await read({ ...scope, accessId });
        if (!current) throw new ProjectDatabaseAccessError("scope");
        await revoke(current, "data_change", "data-change:" + String(value["operationId"]), at());
        revoked++;
      }
      return { status: "completed" as const, revoked };
    },
    async sweep(now: Date) {
      const time = now.toISOString(),
        counts = { expired: 0, budget: 0, dropped: 0, failed: 0 },
        deadline = performance.now() + 45000;
      const pending = await runtime.readProductDatabaseAccessSweep({ now: time, limit: 50 });
      // The rows the pass tried: those whose attempt failed and those the budget check kept. They are stamped after the
      // pass, so the next pass lists every row not yet tried first and a kept row cannot hold its tenant's share forever;
      // a row the budget below never reached is not stamped and keeps its place.
      const tried: string[] = [];
      for (const [kind, records] of [
        ["expired", pending.expired],
        ["dropped", pending.undropped],
        ["budget", pending.active],
      ] as const) {
        for (const record of records) {
          if (performance.now() >= deadline) break;
          try {
            if (
              kind === "budget" &&
              (
                await runtime.readProductAccessCreditAdmission({
                  organizationId: record.organizationId,
                  projectId: record.projectId,
                  environmentId: record.environmentId,
                  now: time,
                })
              ).allowed
            ) {
              tried.push(record.accessId);
              continue;
            }
            await revoke(
              record,
              kind === "expired"
                ? "expired"
                : kind === "budget"
                  ? "budget"
                  : (record.revocationReason ?? "creation_failed"),
              kind === "dropped" ? (record.revokedBy ?? "platform") : "platform",
              time,
              false,
            );
            counts[kind]++;
          } catch {
            counts.failed++;
            tried.push(record.accessId);
          }
        }
      }
      if (tried.length > 0)
        await runtime.markProductDatabaseAccessSweepAttempts({ now: time, accessIds: tried });
      return counts;
    },
  };
}

/** Strip factories and customer SQL at the RPC boundary; one stable generated fact identity per Core attempt. */
export function createD1ProjectDatabaseWritePersistence(
  runtime: ProductDatabaseBinding,
): import("./database-write.js").ProjectDatabaseWritePersistence {
  return {
    async accept(input) {
      const operationId = input.ids.next(),
        queuedEventId = input.ids.next(),
        startedEventId = input.ids.next(),
        startedAuditEventId = input.ids.next(),
        writeAuditEventId = input.ids.next();
      const value = await runtime.acceptProductDatabaseWrite({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        principalId: input.principalId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        canonicalRequestDigest: Buffer.from(input.canonicalRequestDigest).toString("hex"),
        now: input.now,
        operationId,
        queuedEventId,
        startedEventId,
        startedAuditEventId,
        writeAuditEventId,
        operationEventId: input.ids.next(),
        auditEventId: input.ids.next(),
        completionAuditEventId: input.ids.next(),
      });
      if (!value || typeof value !== "object" || !("status" in value))
        throw new TypeError("Invalid database write admission");
      if (value.status === "rejected" && "code" in value) {
        if (
          value.code === "scope" ||
          value.code === "idempotency" ||
          value.code === "pending" ||
          value.code === "paid_plan_required"
        )
          throw new ProjectDatabaseWriteError(value.code);
        if (
          value.code === "insufficient_organization_credits" ||
          value.code === "project_budget_exceeded" ||
          value.code === "organization_credit_scope_missing"
        )
          throw new OrganizationCreditError(value.code);
        throw new Error("Database write admission unavailable");
      }
      if (
        value.status !== "accepted" ||
        !("result" in value) ||
        typeof value.result !== "object" ||
        value.result === null ||
        !("mode" in value.result) ||
        !("receipt" in value.result)
      )
        throw new TypeError("Invalid database write admission");
      const result = value.result;
      assertProjectDatabaseWriteReceipt(result.receipt);
      if (result.mode === "observe") return { mode: "observe", receipt: result.receipt };
      if (
        result.mode !== "execute" ||
        !("target" in result) ||
        typeof result.target !== "object" ||
        result.target === null
      )
        throw new TypeError("Invalid database write target");
      const target = result.target as Record<string, unknown>;
      if (
        Object.keys(target).sort().join(",") !==
          "dataEnvironmentId,databaseId,deadlineAt,originHost,provider,providerProjectId,roleName" ||
        target["provider"] !== "pgcf" ||
        typeof target["databaseId"] !== "string" ||
        !/^[a-z][a-z0-9]{19}$/u.test(target["databaseId"]) ||
        typeof target["providerProjectId"] !== "string" ||
        !/^prj_[a-z0-9]{20}$/u.test(target["providerProjectId"]) ||
        typeof target["dataEnvironmentId"] !== "string" ||
        typeof target["originHost"] !== "string" ||
        typeof target["roleName"] !== "string" ||
        typeof target["deadlineAt"] !== "string"
      )
        throw new TypeError("Invalid database write target");
      const physical = parseUlid(target["dataEnvironmentId"]);
      if (
        target["roleName"] !== `ohmyho_rw_${physical.toLowerCase()}` ||
        new Date(target["deadlineAt"]).toISOString() !== target["deadlineAt"]
      )
        throw new TypeError("Invalid database write target");
      return {
        mode: "execute",
        receipt: result.receipt,
        target: {
          provider: "pgcf",
          databaseId: target["databaseId"],
          providerProjectId: target["providerProjectId"],
          dataEnvironmentId: physical,
          originHost: target["originHost"],
          roleName: target["roleName"],
          deadlineAt: target["deadlineAt"],
        },
      };
    },
    async finish(input) {
      const value = await runtime.finishProductDatabaseWrite({
        organizationId: input.organizationId,
        projectId: input.projectId,
        operationId: input.operationId,
        now: input.now,
        operationEventId: input.ids.next(),
        auditEventId: input.ids.next(),
        completionAuditEventId: input.ids.next(),
        ...(input.failureCode === undefined
          ? { command: input.command, affectedRows: input.affectedRows }
          : { failureCode: input.failureCode }),
      });
      assertProjectDatabaseWriteReceipt(value);
      return value;
    },
  };
}

export interface D1ProductDatabaseBindings extends D1PgcfConfiguration {
  readonly DATABASE_PRODUCT_RUNTIME: ProductDatabaseBinding;
}
export function readD1ProductDatabaseBindings(raw: unknown): D1ProductDatabaseBindings {
  const configuration = readD1PgcfConfiguration(raw),
    binding = configuration["DATABASE_PRODUCT_RUNTIME"];
  const methods = [
    "expireProductDatabaseWrites",
    "readProductEntitlementTargets",
    "claimProductEntitlement",
    "beginProductEntitlement",
    "recordProductEntitlement",
    "recordProductEntitlementCheckFailure",
    "readProductDiagnosticTarget",
    "replayProductCompute",
    "readProductComputeScope",
    "acceptProductCompute",
    "claimProductCompute",
    "completeProductCompute",
    "recordProductCompute",
    "releaseProductComputeUse",
    "readDueProductCompute",
    "acknowledgeProductComputeOutbox",
    "issueProductDatabaseAccess",
    "readProductDatabaseAccess",
    "readProductDatabaseAccessForIssuance",
    "revokeProductDatabaseAccess",
    "recordProductDatabaseAccessOperation",
    "readProductDatabaseAccessSweep",
    "markProductDatabaseAccessSweepAttempts",
    "readProductAccessCreditAdmission",
    "readDataChangeProductAccess",
    "acceptProductDatabaseWrite",
    "finishProductDatabaseWrite",
  ];
  if (
    typeof binding !== "object" ||
    binding === null ||
    methods.some((method) => typeof Reflect.get(binding, method) !== "function")
  )
    throw new Error("D1 product database binding is unavailable");
  return configuration as unknown as D1ProductDatabaseBindings;
}

/** Compute transports preserve the existing provider loop and its single compound observation/completion transaction. */
export function createD1PgcfComputePersistence(
  runtime: ProductDatabaseBinding,
  management: import("./d1-pgcf-management.js").DatabaseManagementBinding,
  clock: Clock,
): import("./pgcf-compute.js").PgcfComputePersistence {
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "idempotency_key_reused")
        throw new DeploymentPersistenceConflictError(
          "Compute request conflicts with idempotency key",
        );
      if (
        code === "compute_change_scope_unavailable" ||
        code === "compute_paid_required" ||
        code === "compute_storage_shrink_requires_migration" ||
        code === "compute_change_pending" ||
        code === "compute_change_conflict"
      )
        throw new ProjectComputeChangeError(code);
      throw error;
    }
  };
  return {
    replay: (input) =>
      call(() =>
        runtime.replayProductCompute({
          organizationId: input.organizationId,
          projectId: input.projectId,
          principalId: input.principalId,
          idempotencyKey: input.idempotencyKey,
          canonicalRequestDigest: Buffer.from(input.canonicalRequestDigest).toString("hex"),
        }),
      ),
    readScope: (input) => call(() => runtime.readProductComputeScope(input)),
    accept: (input) =>
      call(() =>
        runtime.acceptProductCompute({
          ...input,
          canonicalRequestDigest: Buffer.from(input.canonicalRequestDigest).toString("hex"),
          eventType: "ProjectDatabaseComputeChangeRequestedV1",
        }),
      ),
    claim: (input) => call(() => runtime.claimProductCompute(input)),
    complete: (input) => call(() => runtime.completeProductCompute(input)),
    reserve: (input) => management.reserveOperation(input),
    begin: (operation) => management.beginOperation({ operation, now: clock.now().toISOString() }),
    release: (input) => runtime.releaseProductComputeUse(input),
    record: (operation, observation, completion) =>
      call(() =>
        runtime.recordProductCompute({
          record: { operation, observation, now: clock.now().toISOString() },
          ...(completion === undefined ? {} : { completion }),
        }),
      ),
  };
}
