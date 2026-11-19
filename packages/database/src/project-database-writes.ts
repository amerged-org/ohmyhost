import { type Ulid } from "@ohmyhost/platform";
import type {
  ProjectDatabaseWriteReceipt,
  DatabaseEnvironment,
} from "@ohmyhost/contracts/database-access";
import type { TransactionClient } from "./transaction.js";

export class ProjectDatabaseWriteError extends Error {
  constructor(readonly code: "scope" | "idempotency" | "pending" | "paid_plan_required") {
    super(code);
    this.name = "ProjectDatabaseWriteError";
  }
}
export interface DatabaseWriteIdentity {
  organizationId: Ulid;
  projectId: Ulid;
  environment: DatabaseEnvironment;
  principalId: string;
  idempotencyKey: string;
  canonicalRequestDigest: Uint8Array;
  requestId: string;
}
/** Receipt lookup precedes provider access and survives ordinary 24-hour idempotency cleanup. */
export declare function acceptProjectDatabaseWrite(
  client: TransactionClient,
  input: DatabaseWriteIdentity & {
    now: string;
    ids: {
      next(): Ulid;
    };
  },
): Promise<
  | {
      mode: "observe";
      receipt: ProjectDatabaseWriteReceipt;
      target?: never;
    }
  | {
      mode: "execute";
      receipt: ProjectDatabaseWriteReceipt;
      target:
        | {
            deadlineAt: string;
            dataEnvironmentId: string;
            providerProjectId: string;
            roleName: string;
            originHost: string | null;
            provider: "neon";
            defaultBranchId: string;
          }
        | {
            deadlineAt: string;
            dataEnvironmentId: string;
            providerProjectId: string;
            roleName: string;
            originHost: string;
            provider: "pgcf";
            databaseId: string;
          };
    }
>;
/** No terminal observation ever reopens the execution claim. */
export declare function finishProjectDatabaseWrite(
  client: TransactionClient,
  input: {
    organizationId: Ulid;
    operationId: Ulid;
    now: string;
    ids: {
      next(): Ulid;
    };
    command?: "INSERT" | "UPDATE" | "DELETE";
    affectedRows?: number;
    failureCode?: string;
  },
): Promise<ProjectDatabaseWriteReceipt>;
