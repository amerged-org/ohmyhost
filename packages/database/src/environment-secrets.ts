import { type Ulid } from "@ohmyhost/platform";

import type { TransactionClient } from "./transaction.js";

export interface EnvironmentSecretScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
}

export interface EnvironmentSecretMetadata {
  readonly name: string;
  readonly revision: number;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export declare function listEnvironmentSecrets(
  client: TransactionClient,
  scope: EnvironmentSecretScope,
): Promise<readonly EnvironmentSecretMetadata[]>;

export declare function deleteEnvironmentSecret(
  client: TransactionClient,
  input: EnvironmentSecretScope &
    Readonly<{
      name: string;
    }>,
): Promise<"absent" | "deleted">;
