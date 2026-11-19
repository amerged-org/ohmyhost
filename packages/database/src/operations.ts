import { type OperationFailureDiagnostic } from "@ohmyhost/contracts/operation-failure";
import { type Operation } from "@ohmyhost/platform";

/**
 * An operation as stored. The platform history keeps a failure's code and message; the typed
 * refusal an auto-deploy planning rejection stores with them is returned beside the operation.
 */
export type StoredOperation = Operation & {
  readonly failureDiagnostic?: OperationFailureDiagnostic;
};
