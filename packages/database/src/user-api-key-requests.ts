import type { TransactionClient } from "./transaction.js";

interface UserKeyRequestScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly now: string;
}

/** Only metadata is retained; an uncertain provider result leaves the original request observable. */
export declare function finishUserApiKeyCreation(
  client: TransactionClient,
  input: UserKeyRequestScope & {
    readonly requestId: string;
    readonly auditEventId: string;
    readonly outcome:
      | {
          readonly kind: "created";
          readonly keyId: string;
        }
      | {
          readonly kind: "rejected";
          readonly code: "KEY_PERMISSIONS_UNAVAILABLE";
        };
  },
): Promise<void>;

export declare function readUserApiKeyNames(
  client: TransactionClient,
  input: {
    organizationId: string;
    userId: string;
    keyIds: readonly string[];
  },
): Promise<ReadonlyMap<string, string>>;
