import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { parse, failInput, releaseInput, DeliveryLeaseError, type Row } from "./contracts.js";
import { STATE_DOCUMENT, CLEAR_LEASE, params, parseState } from "./facts.js";

export async function failDelivery(context: CatalogContext, raw: unknown): Promise<"failed"> {
  const input = parse(failInput, raw);
  await clearLease(context, input, input.failedAt, input.code);
  return "failed";
}
export async function releaseDelivery(context: CatalogContext, raw: unknown): Promise<"released"> {
  const input = parse(releaseInput, raw);
  await clearLease(context, input, input.releasedAt);
  return "released";
}
async function clearLease(
  context: CatalogContext,
  input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    leaseId: string;
    generation: number;
    releaseSequence: number;
  },
  at: string,
  code?: string,
): Promise<void> {
  const { db } = await routeOrganization(context, input.organizationId),
    p = params(input);
  const read = async (reader: typeof db): Promise<Row | null> => {
    const row = await reader
      .prepare(STATE_DOCUMENT)
      .bind(...p)
      .first<{ value: string }>();
    return parseState(row?.value ?? null);
  };
  const current = (state: Row | null) =>
    state !== null &&
    state["active_lease_id"] === input.leaseId &&
    state["claimed_generation"] === String(input.generation) &&
    state["claimed_release_sequence"] === String(input.releaseSequence) &&
    typeof state["lease_expires_at"] === "string" &&
    state["lease_expires_at"] >= at;
  const command: Command<Row | null, void> = {
    name: code === undefined ? "runtimeSecrets.release" : "runtimeSecrets.fail",
    input: { ...input, at, code },
    read,
    decide: (state) => {
      if (!current(state)) return { reject: new DeliveryLeaseError() };
      const values = [
        ...p,
        input.leaseId,
        String(input.generation),
        String(input.releaseSequence),
        at,
        ...(code === undefined ? [] : [code]),
      ];
      return {
        statements: [
          db
            .prepare(
              `UPDATE runtime_secret_delivery_states SET ${CLEAR_LEASE},updated_at=?7${code === undefined ? "" : ",last_failure_code=?8,last_failed_at=?7"}
   WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND active_lease_id=?4 AND claimed_generation=CAST(?5 AS INTEGER) AND claimed_release_sequence=CAST(?6 AS INTEGER) AND lease_expires_at>=?7`,
            )
            .bind(...values),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        result: () => undefined,
      };
    },
    retryOn: ["precondition_changed"],
  };
  // No fabricated replay from cleared state: original repeated fail/release is a stale-lease error, even after a lost reply.
  await runCommand(db, command);
}
