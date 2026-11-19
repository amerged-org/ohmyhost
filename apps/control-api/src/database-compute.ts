import { assertDatabaseCompute } from "@ohmyhost/contracts/database-compute";
import type { DatabaseComputeSelection } from "@ohmyhost/contracts/database-sizes";
import type { ProductSurfaceContext } from "./contracts.js";
import type { ProductSurfaceMutationContext } from "./contracts.js";
import { ProjectComputeChangeError, readProjectComputeContext } from "@ohmyhost/database";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import { operationResult } from "./product-surface.js";
import { IdempotencyKeyReusedError } from "./contracts.js";
export interface DatabaseComputeBinding {
  readCompute(input: unknown): Promise<unknown>;
  changeCompute(input: unknown): Promise<unknown>;
  runComputeChange(input: unknown): Promise<unknown>;
}
type ComputeOperation = {
  projectId: string;
  operation: {
    operationId: string;
    state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    createdAt: string;
    updatedAt: string;
    failure?: { code: string } | null;
  };
};
type ComputeConfiguration = Awaited<ReturnType<typeof readProjectComputeContext>>;
export interface D1DatabaseComputeReadRuntime {
  readProjectDatabaseOperation(
    input: unknown,
  ): Promise<import("./d1-recovery-operation.js").D1RecoveryOperationRead>;
  readProjectComputeContext(input: unknown): Promise<ComputeConfiguration>;
}
export function createD1DatabaseComputePort(
  binding: DatabaseComputeBinding,
  runtime: D1DatabaseComputeReadRuntime,
) {
  return createComputePort(
    binding,
    async (organizationId, operationId) => {
      const value = await runtime.readProjectDatabaseOperation({ organizationId, operationId });
      if (value.outcome !== "ready") return null;
      return { projectId: value.operation.projectId, operation: value.operation };
    },
    (input) =>
      runtime.readProjectComputeContext({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        now: input.now,
      }),
  );
}
function createComputePort(
  binding: DatabaseComputeBinding,
  readOperation: (organizationId: string, operationId: string) => Promise<ComputeOperation | null>,
  readConfiguration: (
    input: ProductSurfaceContext & { environment: "dev" | "prod"; now: string },
  ) => Promise<ComputeConfiguration>,
) {
  const get = async (input: ProductSurfaceContext & { environment: "dev" | "prod" }) => {
    const value = await binding.readCompute({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
    });
    if (value === null) return null;
    assertDatabaseCompute(value);
    if (value.project_id !== input.projectId || value.environment !== input.environment)
      throw new TypeError("Database compute scope mismatch");
    return value;
  };
  return {
    async set(
      input: ProductSurfaceMutationContext &
        DatabaseComputeSelection & {
          environment: "dev" | "prod";
        },
    ) {
      const value = await binding.changeCompute({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environment: input.environment,
        ...(input.memoryMiB === undefined
          ? { profile: input.profile }
          : { memoryMiB: input.memoryMiB }),
        principalId: input.principalId,
        ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        canonicalRequestSha256: Buffer.from(input.canonicalRequestDigest).toString("hex"),
      });
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Invalid compute change result");
      const result = value as Record<string, unknown>,
        keys = Object.keys(result).sort().join(",");
      if (keys === "status" && result["status"] === "absent") return null;
      if (keys === "code,status" && result["status"] === "rejected") {
        const code = result["code"];
        if (code === "idempotency_key_reused") throw new IdempotencyKeyReusedError();
        if (
          code === "compute_performance_paid_required" ||
          code === "compute_paid_required" ||
          code === "compute_storage_shrink_requires_migration" ||
          code === "compute_performance_unavailable" ||
          code === "compute_change_pending" ||
          code === "compute_change_conflict" ||
          code === "compute_change_scope_unavailable"
        )
          throw new ProjectComputeChangeError(code);
      }
      if (
        keys !== "operationId,status" ||
        result["status"] !== "accepted" ||
        typeof result["operationId"] !== "string"
      )
        throw new TypeError("Invalid compute change result");
      const stored = await readOperation(input.organizationId, parseUlid(result["operationId"]));
      if (!stored || stored.projectId !== input.projectId)
        throw new TypeError("Compute operation scope mismatch");
      return operationResult(stored.operation);
    },
    get,
    async getContext(input: ProductSurfaceContext & { environment: "dev" | "prod"; now: string }) {
      const [configuration, observed] = await Promise.all([
        readConfiguration(input),
        get(input).catch(() => "unavailable" as const),
      ]);
      if (!configuration) return null;
      return { ...configuration, observed: observed ?? ("unavailable" as const) };
    },
  };
}

/** The same bounded actual compute runner, with the fixed Core delivery/claim queries and no SQL authority. */
export async function dispatchD1DatabaseComputeChanges(input: {
  runtime: {
    acknowledgeProductComputeOutbox(input: unknown): Promise<boolean>;
    readDueProductCompute(
      input: unknown,
    ): Promise<readonly { organizationId: string; projectId: string; operationId: string }[]>;
  };
  binding: DatabaseComputeBinding;
  clock: Clock;
  ids: UlidFactory;
}) {
  await input.runtime.acknowledgeProductComputeOutbox({
    now: input.clock.now().toISOString(),
    attemptId: input.ids.next(),
  });
  const jobs = await input.runtime.readDueProductCompute({ now: input.clock.now().toISOString() });
  let failed = 0;
  for (const job of jobs) {
    try {
      const result = await input.binding.runComputeChange(job);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).join(",") !== "status" ||
        !("status" in result) ||
        !["running", "succeeded", "failed", "cancelled"].includes(String(result.status))
      )
        throw new TypeError("Invalid compute execution result");
    } catch {
      failed++;
    }
  }
  return { observed: jobs.length, failed };
}
