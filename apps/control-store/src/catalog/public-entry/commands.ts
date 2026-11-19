import type { CatalogContext } from "../common.js";
import {
  recordPublicContact,
  recordPublicFeatureVote,
  readPublicFeatureVotes,
  readPublicStats,
  purgePublicEntries,
} from "./entry.js";
import { submitCustomerFeedback, readCustomerFeedbackStatus } from "./feedback.js";
import { applyFeedbackOperatorUpdate, readFeedbackOperatorPreview } from "./feedback-operator.js";
export type BindPublicEntryCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input: unknown) => Promise<Result>;
/** Public intake and authenticated feedback keep separate named private capabilities. */
export function createPublicEntryCommands(bind: BindPublicEntryCommand) {
  return Object.freeze({
    entry: Object.freeze({
      recordPublicContact: bind(recordPublicContact),
      recordPublicFeatureVote: bind(recordPublicFeatureVote),
      readPublicFeatureVotes: bind(readPublicFeatureVotes),
      readPublicStats: bind(readPublicStats),
    }),
    retention: Object.freeze({ purgePublicEntries: bind(purgePublicEntries) }),
    feedback: Object.freeze({
      submitCustomerFeedback: bind(submitCustomerFeedback),
      readCustomerFeedbackStatus: bind(readCustomerFeedbackStatus),
    }),
    feedbackOperator: Object.freeze({
      preview: bind(readFeedbackOperatorPreview),
      apply: bind(applyFeedbackOperatorUpdate),
    }),
  });
}
