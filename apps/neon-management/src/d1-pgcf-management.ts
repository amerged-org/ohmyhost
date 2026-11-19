import type { DatabaseProviderClaim, DatabaseProviderScope } from "@ohmyhost/database";
import type { PgcfManagementPersistence } from "./pgcf-persistence.js";
import type { PgcfDatabaseAdminBinding } from "./pgcf-runtime.js";
import { readD1PgcfConfiguration, type D1PgcfConfiguration } from "./d1-bindings.js";

export interface DatabaseManagementBinding {
  resolveClaim(input: unknown): ReturnType<PgcfManagementPersistence["resolveClaim"]>;
  authorizeClaim(input: unknown): Promise<void>;
  readTarget(input: unknown): ReturnType<PgcfManagementPersistence["readTarget"]>;
  nextTargetVersion(input: unknown): Promise<number>;
  reserveOperation(input: unknown): ReturnType<PgcfManagementPersistence["reserveOperation"]>;
  readOperation(input: unknown): ReturnType<PgcfManagementPersistence["readOperation"]>;
  beginOperation(input: unknown): ReturnType<PgcfManagementPersistence["beginOperation"]>;
  recordOperation(input: unknown): Promise<void>;
  activateNewTarget(input: unknown): Promise<void>;
  recordMigrationReceipt(input: unknown): Promise<void>;
  readRuntimeBinding(input: unknown): ReturnType<PgcfManagementPersistence["readRuntimeBinding"]>;
  reservePgcfDatabaseRegistration(
    input: unknown,
  ): ReturnType<PgcfManagementPersistence["reserveRegistration"]>;
  putPgcfDatabaseRegistration(input: unknown): Promise<void>;
  reservePgcfDatabaseReauthorization(
    input: unknown,
  ): ReturnType<PgcfManagementPersistence["reserveReauthorization"]>;
  putPgcfDatabaseReauthorization(input: unknown): Promise<void>;
  readPgcfDatabaseDeletion(input: unknown): ReturnType<PgcfManagementPersistence["readDeletion"]>;
  recordPgcfDeletionRevocation(input: unknown): Promise<void>;
  retirePgcfDatabaseTarget(input: unknown): Promise<void>;
}
export interface D1PgcfManagementBindings extends D1PgcfConfiguration {
  readonly DATABASE_MANAGEMENT_RUNTIME: DatabaseManagementBinding;
  readonly PROJECT_DATABASE_ADMIN_US: PgcfDatabaseAdminBinding;
  readonly PROJECT_DATABASE_ADMIN_EU: PgcfDatabaseAdminBinding;
}
const methods = [
  "resolveClaim",
  "readTarget",
  "authorizeClaim",
  "nextTargetVersion",
  "reserveOperation",
  "readOperation",
  "beginOperation",
  "recordOperation",
  "activateNewTarget",
  "recordMigrationReceipt",
  "readRuntimeBinding",
  "reservePgcfDatabaseRegistration",
  "putPgcfDatabaseRegistration",
  "reservePgcfDatabaseReauthorization",
  "putPgcfDatabaseReauthorization",
  "readPgcfDatabaseDeletion",
  "recordPgcfDeletionRevocation",
  "retirePgcfDatabaseTarget",
];
export function readD1PgcfManagementBindings(raw: unknown): D1PgcfManagementBindings {
  const value = readD1PgcfConfiguration(raw),
    binding = value["DATABASE_MANAGEMENT_RUNTIME"];
  if (
    typeof binding !== "object" ||
    binding === null ||
    methods.some((method) => typeof Reflect.get(binding, method) !== "function")
  )
    throw new Error("D1 database management binding is unavailable");
  for (const name of ["PROJECT_DATABASE_ADMIN_US", "PROJECT_DATABASE_ADMIN_EU"]) {
    const admin = value[name];
    if (
      typeof admin !== "object" ||
      admin === null ||
      ["register", "inspect", "revoke", "rebind"].some(
        (method) => typeof Reflect.get(admin, method) !== "function",
      )
    )
      throw new Error("Database registry binding is unavailable");
  }
  return value as unknown as D1PgcfManagementBindings;
}
const scopeOf = (scope: DatabaseProviderScope) => ({
  organizationId: scope.organizationId,
  projectId: scope.projectId,
  physicalEnvironmentId: scope.physicalEnvironmentId,
});
const claimOf = (claim: DatabaseProviderClaim) => ({
  ...scopeOf(claim),
  operationId: claim.operationId,
  claimId: claim.claimId,
});
/** Closed DTO calls on the binding itself: no SQL callbacks, no credential or caller-prepriced measurement. */
export function createD1PgcfPersistence(
  binding: DatabaseManagementBinding,
): PgcfManagementPersistence {
  return {
    resolveClaim: (input) => binding.resolveClaim(input),
    readTarget: (scope) => binding.readTarget(scopeOf(scope)),
    authorizeClaim: (claim) =>
      binding.authorizeClaim({
        ...claimOf(claim),
        ...(claim.step === undefined ? {} : { step: claim.step }),
      }),
    nextTargetVersion: (claim) => binding.nextTargetVersion(claimOf(claim)),
    reserveOperation: (input) =>
      binding.reserveOperation({
        ...claimOf(input),
        step: input.step,
        providerProjectId: input.providerProjectId,
        requestBody: input.requestBody,
      }),
    beginOperation: (operation, now) => binding.beginOperation({ operation, now }),
    recordOperation: (operation, observation, now) =>
      binding.recordOperation({ operation, observation, now }),
    readOperation: (input) => binding.readOperation({ ...claimOf(input), step: input.step }),
    activateNewTarget: (claim, target, now) => {
      const { provider, activatedAt, ...stored } = target;
      void provider;
      void activatedAt;
      return binding.activateNewTarget({ claim: claimOf(claim), target: stored, now });
    },
    recordMigrationReceipt: (input) =>
      binding.recordMigrationReceipt({ ...input, claim: claimOf(input.claim) }),
    reserveRegistration: (claim, host) =>
      binding.reservePgcfDatabaseRegistration({ ...claimOf(claim), originHost: host }),
    putRegistration: (claim, registration) =>
      binding.putPgcfDatabaseRegistration({
        claim: claimOf(claim),
        registration,
        observedAt: new Date().toISOString(),
      }),
    readRuntimeBinding: (scope) => binding.readRuntimeBinding(scope),
    reserveReauthorization: (input) => binding.reservePgcfDatabaseReauthorization(input),
    putReauthorization: (input, registration) =>
      binding.putPgcfDatabaseReauthorization({
        input,
        registration,
        observedAt: new Date().toISOString(),
      }),
    readDeletion: (input) => binding.readPgcfDatabaseDeletion(input),
    recordDeletionRevocation: (request, registration, observedAt) =>
      binding.recordPgcfDeletionRevocation({ request, registration, observedAt }),
    retireTarget: (request, retiredAt) => binding.retirePgcfDatabaseTarget({ request, retiredAt }),
  };
}
