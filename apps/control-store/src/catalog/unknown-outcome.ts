import { StoreOutcomeUnknownError } from "../run-command.js";

/** `lookup` of a command without a natural identity to read back: a lost reply stays explicitly unknown. */
export function unknownOutcome(name: string): () => Promise<never> {
  return async () => {
    throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
  };
}
