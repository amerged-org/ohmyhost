import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import type { CatalogContext } from "../common.js";
import { clock, parse, scope } from "./contracts.js";

const attemptInput = scope.extend({ now: clock });

/**
 * Stamps one pending scope as tried now, whatever the attempt does next, so the sweeper's next batch starts with the
 * scopes it has not tried for longest. An idempotent stamp: a lost reply is answered by stamping again.
 */
export async function recordDeliveryAttempt(context: CatalogContext, raw: unknown): Promise<void> {
  const input = parse(attemptInput, raw),
    db = context.directory,
    name = "runtimeSecrets.recordPendingAttempt";
  await runCommand(db, {
    name,
    input,
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE runtime_secret_delivery_states SET last_attempted_at=?4 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
          )
          .bind(input.organizationId, input.projectId, input.environmentId, input.now),
      ],
      result: () => undefined,
    }),
    lookup: async () => {
      throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
    },
  });
}
