import { z } from "zod";
import { guard } from "../../guards.js";
import type { Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  fenceRaceGuard,
  runMapped,
  conflict,
  type CatalogContext,
} from "../common.js";
import { assertOperationDelegationCurrent } from "../identity/operation-delegations.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
import { ProductWorkflowContextConflictError } from "./context.js";
export const providerAuthorizationInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  acceptedLifecycleVersion: z.number().int().min(1).max(2147483647),
});
const AUTHORIZED = `SELECT 1 FROM product_provider_mutation_claims claim
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id
 JOIN environments environment ON environment.organization_id=claim.organization_id AND environment.project_id=claim.project_id AND environment.environment_id=claim.environment_id
 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.accepted_lifecycle_version=?5
 AND operation.state IN('queued','running') AND project.owner_state='active' AND project.lifecycle_state='active' AND project.lifecycle_version=?5`;
/** Original five-field provider authorization, with accepted consent/source and current claim fenced in ONE batch. */
export async function authorizeProductProviderMutation(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = providerAuthorizationInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    values = [
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
      i.acceptedLifecycleVersion,
    ];
  await assertOperationDelegationCurrent(context, {
    organizationId: i.organizationId,
    operationId: i.operationId,
  });
  const changed = () => {
    const e = conflict(
      "operation_authorization_changed",
      "Queued operation authorization or source generation changed",
    );
    e.name = "OperationAuthorizationConflictError";
    return e;
  };
  const command: Command<
    { authorized: boolean; proof: Awaited<ReturnType<typeof readWorkflowDelegation>> },
    true
  > = {
    name: "provisioning.authorizeProviderMutation",
    input: i,
    retryOn: ["operation_conflict"],
    read: async (reader) => ({
      authorized:
        (await reader
          .prepare(AUTHORIZED)
          .bind(...values)
          .first()) !== null,
      proof: await readWorkflowDelegation(reader, i),
    }),
    decide: (s) =>
      s.authorized
        ? {
            statements: [
              fenceRaceGuard(db, "operation_conflict", i.organizationId),
              ...workflowExecutionGuards(db, i, s.proof),
              guard(db, "operation_conflict", `NOT EXISTS(${AUTHORIZED})`, values),
            ],
            result: () => true,
          }
        : {
            reject: new ProductWorkflowContextConflictError(
              "Product provider mutation is no longer authorized",
            ),
          },
    lookup: async (reader) => {
      // A previous successful check is never a permission after a lost reply and changed authority.
      await assertOperationDelegationCurrent(context, {
        organizationId: i.organizationId,
        operationId: i.operationId,
      });
      const proof = await readWorkflowDelegation(reader, i);
      await reader.batch([
        ...workflowExecutionGuards(reader, i, proof),
        guard(reader, "operation_conflict", `NOT EXISTS(${AUTHORIZED})`, values),
      ]);
      return true;
    },
  };
  await runMapped(db, command, {
    consent_changed: changed,
    source_head_conflict: changed,
    operation_conflict: () =>
      new ProductWorkflowContextConflictError("Product provider mutation is no longer authorized"),
  });
}
