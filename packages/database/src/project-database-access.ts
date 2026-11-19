import { type Ulid } from "@ohmyhost/platform";
import type {
  DatabaseAccessMode,
  DatabaseEnvironment,
  ProjectDatabaseAccess,
} from "@ohmyhost/contracts/database-access";
import type { TransactionClient } from "./transaction.js";

export class ProjectDatabaseAccessError extends Error {
  constructor(readonly code: "scope" | "limit" | "not_found" | "paid_plan_required") {
    super(code);
    this.name = "ProjectDatabaseAccessError";
  }
}
export type DatabaseAccessRevocationReason =
  | "principal"
  | "expired"
  | "budget"
  | "creation_failed"
  | "data_change";
export interface ProjectDatabaseAccessRecord {
  readonly provider: "pgcf";
  readonly accessId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly environment: DatabaseEnvironment;
  readonly dataEnvironmentId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly providerCreateOperationId: string | null;
  readonly providerDeleteOperationId: string | null;
  readonly roleName: string;
  readonly mode: DatabaseAccessMode;
  readonly label: string | null;
  readonly principalId: string;
  readonly originHost: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: DatabaseAccessRevocationReason | null;
  readonly roleDroppedAt: string | null;
  readonly state: "active" | "expired" | "revoked";
}
export interface IssuedProjectDatabaseAccess {
  readonly provider: "pgcf";
  readonly accessId: string;
  readonly roleName: string;
  readonly memberRole: string;
  readonly mode: DatabaseAccessMode;
  readonly environment: DatabaseEnvironment;
  readonly environmentId: string;
  readonly dataEnvironmentId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly originHost: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly label: string | null;
}

export declare function listProjectDatabaseAccess(
  client: TransactionClient,
  input: {
    organizationId: string;
    projectId: string;
    environment?: DatabaseEnvironment;
    now: string;
  },
): Promise<readonly ProjectDatabaseAccessRecord[]>;

/** Revocation is idempotent: only a newly dropped role changes an already revoked row. */
export declare function revokeProjectDatabaseAccess(
  client: TransactionClient,
  input: {
    organizationId: string;
    projectId: string;
    accessId: string;
    revokedAt: string;
    revokedBy: string;
    reason: DatabaseAccessRevocationReason;
    roleDropped: boolean;
    ids: {
      next(): Ulid;
    };
  },
): Promise<ProjectDatabaseAccessRecord | null>;

/** The one customer-visible projection; the URI, principal and provider target stay internal. */
export function publicProjectDatabaseAccess(
  record: ProjectDatabaseAccessRecord,
): ProjectDatabaseAccess {
  return Object.freeze({
    access_id: record.accessId,
    environment: record.environment,
    mode: record.mode,
    role_name: record.roleName,
    host: record.originHost,
    provider: "pgcf",
    transport: "wss",
    websocket_url: `wss://${record.originHost}/`,
    database: record.databaseId,
    label: record.label,
    state: record.state,
    issued_at: record.issuedAt,
    expires_at: record.expiresAt,
    revoked_at: record.revokedAt,
    revocation_reason: record.revocationReason,
  });
}
