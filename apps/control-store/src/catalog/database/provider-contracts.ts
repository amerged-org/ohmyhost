import { z } from "zod";

import { CommandConflictError } from "../../run-command.js";
import { instant, ulid } from "../platform-support.js";
import { claimInput, scopeInput } from "./contracts.js";

/**
 * The scope or the durable identity of the provider authority conflicts (the PostgreSQL
 * `DatabaseProviderConflictError`). `DatabaseProviderConflictError` of contracts.ts is the one typed error; it is
 * re-used so the Node callers keep matching one class.
 */
export {
  DatabaseProviderConflictError,
  type PgcfRegistration,
  runtimeRoleOf,
} from "./contracts.js";

export const providerProjectIdPattern = /^prj_[a-z0-9]{20}$/u;
export const databaseIdPattern = /^[a-z][a-z0-9]{19}$/u;
export const providerOperationIdPattern = /^op_[a-z0-9]{20}$/u;
export const stepPattern = /^[a-z][a-z0-9_.:-]{0,127}$/u;
export const sizeClassPattern = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;

export interface DatabaseProviderScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
}
export interface DatabaseProviderClaim extends DatabaseProviderScope {
  readonly operationId: string;
  readonly claimId: string;
}
interface TargetBase extends DatabaseProviderScope {
  readonly targetVersion: number;
  readonly providerProjectId: string;
  readonly regionId: string;
  readonly runtimeRole: string;
  readonly credentialReference: string;
  readonly activatedAt: string | null;
}
export type DatabaseProviderTarget =
  | (TargetBase & { readonly provider: "neon"; readonly branchId: string })
  | (TargetBase & {
      readonly provider: "pgcf";
      readonly databaseId: string;
      readonly sizeClassId: string;
    });
export type PgcfDatabaseProviderTarget = Extract<DatabaseProviderTarget, { provider: "pgcf" }>;

export type DatabaseProviderOperationState =
  | "reserved"
  | "dispatched"
  | "pending"
  | "succeeded"
  | "failed";

export interface DatabaseProviderOperation extends DatabaseProviderClaim {
  readonly step: string;
  readonly idempotencyKey: string;
  readonly providerProjectId: string;
  readonly requestBody: Readonly<Record<string, unknown>>;
  readonly providerOperationId: string | null;
  readonly databaseId: string | null;
  readonly state: DatabaseProviderOperationState;
}

/** The logical caller (organization, project, environment) whose physical data environment is wanted. */
export const resolveScopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
});
export const readTargetInput = z.strictObject(scopeInput);

/** `step` is optional: only the operation-scoped steps (create, role, delete) have a second authority. */
export const authorizeInput = z.strictObject({
  ...claimInput,
  step: z.string().regex(stepPattern).optional(),
});
export const stepClaimInput = z.strictObject({
  ...claimInput,
  step: z.string().regex(stepPattern),
});

export const reserveOperationInput = z.strictObject({
  ...claimInput,
  step: z.string().regex(stepPattern),
  providerProjectId: z.string().regex(providerProjectIdPattern),
  requestBody: z.record(z.string(), z.unknown()),
});

/** The operation as the reservation returned it: every field is compared to the stored identity. */
export const operationInput = z.strictObject({
  ...claimInput,
  step: z.string().regex(stepPattern),
  idempotencyKey: z.string().regex(/^omh-[a-f0-9]{64}$/u),
  providerProjectId: z.string().regex(providerProjectIdPattern),
  requestBody: z.record(z.string(), z.unknown()),
  providerOperationId: z.string().regex(providerOperationIdPattern).nullable(),
  databaseId: z.string().regex(databaseIdPattern).nullable(),
  state: z.enum(["reserved", "dispatched", "pending", "succeeded", "failed"]),
});

export const beginOperationInput = z.strictObject({ operation: operationInput, now: instant });
export const recordOperationInput = z.strictObject({
  operation: operationInput,
  observation: z.strictObject({
    databaseId: z.string().regex(databaseIdPattern),
    providerOperationId: z.string().regex(providerOperationIdPattern).nullable(),
    state: z.enum(["pending", "succeeded", "failed"]),
  }),
  now: instant,
});

const pgcfTargetInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
  targetVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  providerProjectId: z.string().regex(providerProjectIdPattern),
  databaseId: z.string().regex(databaseIdPattern),
  regionId: z.enum(["us-dev", "eu-dev"]),
  sizeClassId: z.string().regex(sizeClassPattern),
  runtimeRole: z.string(),
  credentialReference: z.string().min(1).max(256),
});
export const activateTargetInput = z.strictObject({
  claim: z.strictObject(claimInput),
  target: pgcfTargetInput,
  now: instant,
});
export const nextVersionInput = z.strictObject({ claim: z.strictObject(claimInput) });

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u);
export const retireLegacyInput = z.strictObject({
  ...scopeInput,
  expectedTargetVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  providerProjectId: z.string().min(1).max(60),
  branchId: z.string().min(1).max(60),
  manifestSha256: sha256Hex,
  inventorySha256: sha256Hex,
  retiredAt: instant,
  retiredBy: z.string().min(1).max(256),
});

export const migrationReceiptInput = z.strictObject({
  claim: z.strictObject(claimInput),
  providerProjectId: z.string().regex(providerProjectIdPattern),
  databaseId: z.string().regex(databaseIdPattern),
  bundleSha256: sha256Hex,
  appliedPaths: z.array(z.string().min(1).max(1024)).max(4096),
  replayedPaths: z.array(z.string().min(1).max(1024)).max(4096),
  completedAt: instant,
});

export class DatabaseProviderOperationUnknownError extends CommandConflictError {
  constructor() {
    super(
      "database_provider_operation_unknown",
      "The provider operation has no recorded identity; reserve it first",
    );
    this.name = "DatabaseProviderOperationUnknownError";
  }
}
