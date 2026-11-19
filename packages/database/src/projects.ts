import { type Ulid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export declare function readProjectDataEnvironment(
  database: TransactionClient,
  scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
  },
): Promise<Ulid | null>;
