import { requireControlRuntimeBinding } from "./d1-identity-port.js";
import type { CreditWarningPersistence } from "./credit-warning-recipients.js";

interface CreditWarningBinding {
  readCreditWarningScope(input: {
    organizationId: string;
    exhaustedAt: string;
  }): Promise<string | null>;
  isCreditWarningOwner(input: { organizationId: string; userId: string }): Promise<boolean>;
}

/** Fixed read-only WorkOS capability; no contact data, arbitrary authorization action or SQL reaches Core. */
export function createD1CreditWarningPersistence(runtime: unknown): CreditWarningPersistence {
  const binding = requireControlRuntimeBinding(runtime) as unknown as CreditWarningBinding;
  return {
    readScope: (organizationId, exhaustedAt) =>
      binding.readCreditWarningScope({ organizationId, exhaustedAt }),
    isOwner: (organizationId, userId) => binding.isCreditWarningOwner({ organizationId, userId }),
  };
}
