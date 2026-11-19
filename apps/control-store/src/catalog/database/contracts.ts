import { z } from "zod";

import { CommandConflictError } from "../../run-command.js";
import { instant, ulid } from "../platform-support.js";

/** The durable identity, scope or authority of a provider-database command no longer holds. Nothing was applied. */
export class DatabaseProviderConflictError extends CommandConflictError {
  constructor() {
    super("database_provider_conflict", "Database provider scope or durable identity conflicts");
    this.name = "DatabaseProviderConflictError";
  }
}

/** The data-change reauthorization fence no longer holds. Nothing was applied. */
export class ProjectDatabaseRegistrationConflictError extends CommandConflictError {
  constructor() {
    super(
      "project_database_registration_conflict",
      "Project database registration conflicts with durable state",
    );
    this.name = "ProjectDatabaseRegistrationConflictError";
  }
}

export const ORIGIN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u;
const providerProjectId = z.string().regex(/^prj_[a-z0-9]{20}$/u);
const databaseId = z.string().regex(/^[a-z][a-z0-9]{19}$/u);

export const scopeInput = {
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
};
export const claimInput = { ...scopeInput, operationId: ulid, claimId: ulid };

/** The registration of a PGCF database: exactly the fourteen keys the stored CHECK allows, and no secret. */
export const pgcfRegistration = z.strictObject({
  provider: z.literal("pgcf"),
  databaseId,
  operationId: ulid,
  organizationId: ulid,
  projectId: ulid,
  physicalEnvironmentId: ulid,
  registrationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  region: z.enum(["us", "eu"]),
  providerProjectId,
  originHost: z.string().regex(ORIGIN_HOST),
  originDatabase: databaseId,
  originUser: z.string().regex(/^ohmyho_rw_[0-9a-hjkmnp-tv-z]{26}$/u),
  authorizedEnvironmentIds: z.array(ulid).min(1).max(2),
  status: z.enum(["active", "revoked"]),
});
export type PgcfRegistration = z.output<typeof pgcfRegistration>;

/** Historical Neon registration: provenance only, never an active target and never a fallback. */
export interface NeonRegistration {
  readonly operationId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly registrationVersion: number;
  readonly region: "us" | "eu";
  readonly providerProjectId: string;
  readonly branchId: string;
  readonly originHost: string;
  readonly originDatabase: "neondb";
  readonly originUser: string;
  readonly authorizedEnvironmentIds: readonly string[];
  readonly status: "active" | "revoked";
}
export type AnyRegistration = PgcfRegistration | NeonRegistration;

export const runtimeRoleOf = (physicalEnvironmentId: string): string =>
  `ohmyho_rw_${physicalEnvironmentId.toLowerCase()}`;
export const regionOf = (regionId: string): "us" | "eu" => (regionId === "us-dev" ? "us" : "eu");

/** Sorted-key compact JSON: the one stored form, so text equality is the old jsonb equality. */
export function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, child]) => [key, sorted(child)]),
          )
        : item;
  return JSON.stringify(sorted(value));
}

/** Same keys and same values, independent of key order. */
export function sameRegistration(left: object, right: object): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function parseRegistration(text: string): AnyRegistration {
  return JSON.parse(text) as AnyRegistration;
}

export function isPgcf(value: AnyRegistration): value is PgcfRegistration {
  return "provider" in value && value.provider === "pgcf";
}

/** `inventory.cleanup_locator` of a PGCF database: `encoded/` plus the unpadded base64url of its id. */
export function cleanupLocatorOf(id: string): string {
  return `encoded/${btoa(id).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
}

export const deletionRequest = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  physicalEnvironmentId: ulid,
  providerProjectId: z.string().min(1).max(64),
  databaseId: z.string().min(1).max(64),
  registrationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type DeletionRequest = z.output<typeof deletionRequest>;

export const readRegistrationInput = z.strictObject(scopeInput);
export const reserveRegistrationInput = z.strictObject({
  ...claimInput,
  originHost: z.string().max(253),
});
export const putRegistrationInput = z.strictObject({
  claim: z.strictObject(claimInput),
  registration: pgcfRegistration,
  observedAt: instant,
});
export const reauthorizationInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  claimId: ulid,
  physicalEnvironmentId: ulid,
  authorizedEnvironmentIds: z.array(ulid).max(16),
});
export type ReauthorizationInput = z.output<typeof reauthorizationInput>;
export const putReauthorizationInput = z.strictObject({
  input: reauthorizationInput,
  registration: pgcfRegistration,
  observedAt: instant,
});
export const markServingInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  candidateReceiptId: ulid,
  wfpReceiptId: ulid,
  revisionId: ulid,
  activatedAt: instant,
});
export const recordRevocationInput = z.strictObject({
  request: deletionRequest,
  registration: pgcfRegistration,
  observedAt: instant,
});
export const retireTargetInput = z.strictObject({ request: deletionRequest, retiredAt: instant });
