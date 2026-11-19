import type { TransactionClient } from "./transaction.js";

export declare class SharedGatewayConflictError extends Error {
  readonly code = "shared_gateway_conflict";
  constructor();
}

/**
 * A candidate cleanup books the route its environment keeps: none, another candidate's active
 * route, or, when the latest route still points at the cleaned candidate because its compensation
 * never ran, that route returned under the cleanup claim to its recorded predecessor or closed, on
 * behalf of the operation that activated it (Sebmer Dev revision 1, 2026-09-27).
 */
export declare function settleSharedGatewayCandidateCleanup(
  client: TransactionClient,
  input: Readonly<{
    organizationId: string;
    projectId: string;
    candidateReceiptId: string;
    claimId: string;
  }>,
): Promise<
  Readonly<{
    compensatedTargetScriptName: string | null;
    sharedGatewayRevision: number | null;
  }>
>;
