import type { BindCommand } from "../platform-commands.js";
import {
  releasePgcfDatabaseClaim,
  readPgcfDatabaseClaim,
  settlePgcfDatabaseClaims,
} from "./pgcf-claims.js";
import {
  activateNewPgcfDatabaseTarget,
  authorizeDatabaseProviderClaim,
  beginDatabaseProviderOperation,
  nextPgcfDatabaseTargetVersion,
  readDatabaseProviderOperation,
  readDatabaseProviderTarget,
  recordDatabaseProviderOperation,
  recordPgcfDatabaseMigrationReceipt,
  reserveDatabaseProviderOperation,
  resolveDatabaseProviderScope,
  retireAbsentLegacyDatabaseTarget,
} from "./provider-targets.js";

/**
 * The typed provider-target commands. A closed interface: nothing here accepts SQL, a provider call or a secret.
 *
 * `runtime` is the authority of the control Worker and the provider-management Node port: every command re-proves its
 * accepted claim inside its own batch. `operator` is the owner-only surface (the original reachable only through the
 * table owner role): bind it ONLY for the operator entry, never into the runtime or public surface. `maintenance`
 * is the global claim sweep and belongs to the scheduler.
 */
export function createDatabaseProviderCommands(bind: BindCommand) {
  return Object.freeze({
    runtime: Object.freeze({
      resolveScope: bind(resolveDatabaseProviderScope),
      readTarget: bind(readDatabaseProviderTarget),
      authorizeClaim: bind(authorizeDatabaseProviderClaim),
      reserveOperation: bind(reserveDatabaseProviderOperation),
      readOperation: bind(readDatabaseProviderOperation),
      beginOperation: bind(beginDatabaseProviderOperation),
      recordOperation: bind(recordDatabaseProviderOperation),
      nextTargetVersion: bind(nextPgcfDatabaseTargetVersion),
      activateNewTarget: bind(activateNewPgcfDatabaseTarget),
      recordMigrationReceipt: bind(recordPgcfDatabaseMigrationReceipt),
    }),
    operator: Object.freeze({
      retireAbsentLegacyTarget: bind(retireAbsentLegacyDatabaseTarget),
      releaseDatabaseClaim: bind(releasePgcfDatabaseClaim),
      readDatabaseClaim: bind(readPgcfDatabaseClaim),
    }),
    maintenance: Object.freeze({
      settleDatabaseClaims: bind(settlePgcfDatabaseClaims),
    }),
  });
}

export type DatabaseProviderCommands = ReturnType<typeof createDatabaseProviderCommands>;
