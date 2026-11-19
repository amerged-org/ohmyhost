import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export class LegacyAwsMailAbsenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LegacyAwsMailAbsenceError";
  }
}

/**
 * Cleanup evidence for project deletion: every historical resource must have an observed absence,
 * otherwise deletion stays pending instead of asking the retired provider or assuming absence.
 */
export declare function requireLegacyAwsMailAbsence(
  client: TransactionClient,
  input: Readonly<{
    organizationId: Ulid;
    projectId: Ulid;
  }>,
): Promise<
  readonly Readonly<{
    provider: "aws";
    resourceKind: "ses-tenant" | "ses-configuration-set" | "ses-event-destination";
    locator: string;
    outcome: "not_found";
  }>[]
>;
