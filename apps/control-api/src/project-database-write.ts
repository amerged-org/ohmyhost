import { Buffer } from "node:buffer";
import {
  assertProjectDatabaseWriteReceipt,
  type ProjectDatabaseWriteRequest,
} from "@ohmyhost/contracts/database-access";
import { ProjectDatabaseWriteError, OrganizationCreditError } from "@ohmyhost/database";
import {
  IdempotencyKeyReusedError,
  type ProductSurfaceResult,
  type ProductSurfaceMutationContext,
} from "./contracts.js";
export interface ProjectDatabaseWriteBinding {
  writeProject(input: unknown): Promise<unknown>;
}
export function createProjectDatabaseWritePort(binding: ProjectDatabaseWriteBinding) {
  return async (
    input: ProductSurfaceMutationContext & ProjectDatabaseWriteRequest,
  ): Promise<ProductSurfaceResult | null> => {
    const value = await binding.writeProject({
      organizationId: input.organizationId,
      projectId: input.projectId,
      principalId: input.principalId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      canonicalRequestSha256: Buffer.from(input.canonicalRequestDigest).toString("hex"),
      environment: input.environment,
      statement: input.statement,
      parameters: input.parameters,
    });
    if (
      value &&
      typeof value === "object" &&
      "status" in value &&
      value.status === "rejected" &&
      "code" in value
    ) {
      if (value.code === "scope") return null;
      if (value.code === "idempotency") throw new IdempotencyKeyReusedError();
      if (value.code === "pending") throw new ProjectDatabaseWriteError("pending");
      if (value.code === "paid_plan_required")
        throw new ProjectDatabaseWriteError("paid_plan_required");
      if (
        value.code === "insufficient_organization_credits" ||
        value.code === "project_budget_exceeded"
      )
        throw new OrganizationCreditError(value.code);
    }
    assertProjectDatabaseWriteReceipt(value);
    if (value.environment !== input.environment)
      throw new TypeError("Database write environment mismatch");
    return {
      status: value.state === "running" ? 202 : 200,
      location: `/v1/operations/${value.operation_id}`,
      body: { ...value },
    };
  };
}
