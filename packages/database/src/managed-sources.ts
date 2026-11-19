import type { AuthorizationAction, AuthorizationRestriction } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

interface Scope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string;
}
export interface ManagedSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly executable: boolean;
}
export interface ManagedSourceBlob extends ManagedSourceFile {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly eTag: string;
}
export interface ManagedSourceDelegation {
  readonly grantId: string;
  readonly clientId: string;
  readonly consentHash: string;
  readonly action: AuthorizationAction;
  readonly authorizationRestriction?: AuthorizationRestriction;
}
export interface ProjectSourceBinding {
  readonly provider: "github" | "managed";
  readonly sourceConnectionId: string;
  readonly generation: number;
  readonly commitSha: string | null;
  readonly namespace: string;
  readonly repositoryName: string;
  readonly status: "ready" | "revoked";
  readonly linkedAt: string;
  readonly updatedAt: string;
}
export interface ManagedSourcePublication {
  readonly operationId: string;
  readonly sourceConnectionId: string;
  readonly mode: "initialize" | "commit" | "switch";
  readonly state: "staging" | "sealed" | "committed" | "failed";
  readonly expectedSourceConnectionId: string | null;
  readonly expectedSourceGeneration: number;
  readonly expectedManagedCommit: string | null;
  readonly manifestDigest: string | null;
  readonly commitSha: string | null;
  readonly treeSha: string | null;
  readonly namespace: string;
  readonly repositoryName: string;
  readonly message: string;
  readonly files: readonly ManagedSourceFile[];
  readonly blobs: readonly ManagedSourceBlob[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly errorCode: string | null;
  readonly delegation: ManagedSourceDelegation | null;
}
export interface BeginManagedSourcePublicationInput extends Scope {
  readonly environmentId: string;
  readonly operationId: string;
  readonly operationEventId: string;
  readonly auditEventId: string;
  readonly outboxEventId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
  readonly mode: ManagedSourcePublication["mode"];
  readonly sourceConnectionId: string;
  readonly expectedSourceConnectionId: string | null;
  readonly expectedSourceGeneration: number;
  readonly expectedManagedCommit: string | null;
  readonly namespace: string;
  readonly repositoryName: string;
  readonly message: string;
  readonly now: string;
  readonly expiresAt: string;
  readonly routeTemplate?: string;
  readonly delegation?: ManagedSourceDelegation;
}
export class ManagedSourceConflictError extends Error {
  constructor(
    readonly kind:
      | "scope"
      | "generation"
      | "commit"
      | "operation"
      | "manifest"
      | "candidate"
      | "expired"
      | "state"
      | "idempotency",
  ) {
    super(`Managed source ${kind} conflict`);
    this.name = "ManagedSourceConflictError";
  }
}

/** Deletion custody is the running exact project tombstone, not a client-supplied repository. */
export declare function readManagedSourceDeletionInventory(
  client: TransactionClient,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
  },
): Promise<{
  readonly repos: readonly {
    readonly sourceConnectionId: string;
    readonly namespace: string;
    readonly repositoryName: string;
  }[];
  readonly blobOperations: readonly {
    readonly operationId: string;
    readonly blobs: readonly ManagedSourceBlob[];
  }[];
}>;
