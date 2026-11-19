import { type Ulid } from "@ohmyhost/platform";

import { type ConsumeActionConfirmationInput } from "./deployment-persistence.js";
import { type OperationDelegation } from "./operation-delegations.js";

export interface AcceptApiOperationInput {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly operationId: Ulid;
  readonly operationEventId: Ulid;
  readonly auditEventId: Ulid;
  readonly outboxEventId: Ulid;
  readonly principalId: string;
  readonly actorType?: "principal" | "service";
  readonly requestId: string;
  /** The rename route `PUT /v1/projects/{project_id}/handle` is accepted like the others. */
  readonly httpMethod: "POST" | "PUT" | "DELETE";
  readonly routeTemplate: string;
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly availableAt?: string;
  readonly delegation?: OperationDelegation;
  readonly confirmation?: ConsumeActionConfirmationInput;
}
