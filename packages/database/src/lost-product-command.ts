import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

/**
 * A rename whose outbox delivery is exhausted while nothing of it ever ran: its operation is still
 * queued, it holds no provider-mutation claim and moved no gateway, and a Workflow run, if one was
 * recorded, has no evidence. Its ETag is stale by now, so it is ended, never re-driven.
 */
export declare function findLostProductCommand(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
  },
): Promise<Readonly<
  | {
      state: "abandoned";
    }
  | {
      state: "lost";
      workflowId: string | null;
    }
> | null>;

/**
 * Ends that rename with the closed OPERATION_ABANDONED failure under the operation lock, which every
 * provider-mutation claim also takes, so a late Workflow can neither claim nor complete it. Delivery
 * attempts and audits stay; a repeat of the same reconciliation returns "existing".
 */
export declare function abandonLostProductCommand(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly workflowId: string | null;
    readonly reconciliationId: Ulid;
    readonly actorId: string;
    readonly abandonedAt: string;
    readonly ids: {
      next(): Ulid;
    };
  },
): Promise<"abandoned" | "existing" | "changed">;
