import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface ProjectDeletionInventoryRecord {
  readonly resourceRecordId: Ulid;
  readonly provider: string;
  readonly resourceKind: string;
  readonly externalRefHash: Uint8Array;
  readonly cleanupLocator: string;
  readonly cleanupOutcome?: "removed" | "not_found";
}

export class ProjectDomainDeletionRequiredError extends Error {
  readonly code = "project_domain_delete_required";
  constructor() {
    super("Remove the project's live custom domain connection before planning project deletion");
    this.name = "ProjectDomainDeletionRequiredError";
  }
}

/** A failed deletion continues with a fresh operation; the old execution stays terminal. */
export declare function readProjectDeletionAdmission(
  client: TransactionClient,
  input: {
    organizationId: Ulid;
    projectId: Ulid;
    acceptingOperationId?: Ulid;
  },
): Promise<{
  environmentId: Ulid;
  billingEpochId: Ulid;
  expectedProjectVersion: number;
  lifecycleState: "active" | "deleting";
  previousOperationId: Ulid | null;
} | null>;

/**
 * The project a rename would move, locked for the accept. A project that is being deleted or that
 * already has work in flight is not renameable: its address is about to change for other reasons.
 */
export declare function readProjectRenameAdmission(
  client: TransactionClient,
  input: Readonly<{
    organizationId: Ulid;
    projectId: Ulid;
    handle: string;
  }>,
): Promise<Readonly<{
  environmentId: Ulid;
  billingEpochId: Ulid;
  lifecycleVersion: number;
  handle: string;
  /** True while a queued or running operation may still move this project's gateways. */
  busy: boolean;
  /** A frozen Native rename may be reconciled by a fresh Owner request. */
  nativeRecoveryPending?: boolean;
  nativePreparationPending?: boolean;
  /** True when another project already answers on the requested address. */
  taken: boolean;
}> | null>;
