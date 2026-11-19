import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import type { Operation } from "@ohmyhost/platform";
import type { ProductSurfaceResult } from "./contracts.js";

export function operationResult(operation: {
  readonly operationId: string;
  readonly state: Operation["state"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: { readonly code: string } | null;
  readonly failureDiagnostic?: unknown;
}): ProductSurfaceResult {
  return {
    status: 202,
    location: `/v1/operations/${operation.operationId}`,
    body: {
      id: operation.operationId,
      state: operation.state,
      created_at: operation.createdAt,
      updated_at: operation.updatedAt,
      ...(operation.state === "failed"
        ? {
            error: publicOperationFailure(
              operation.failure?.code ?? "operation_failed",
              operation.failureDiagnostic,
            ),
          }
        : {}),
    },
  };
}
