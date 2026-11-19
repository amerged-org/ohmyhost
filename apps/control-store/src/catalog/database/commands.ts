import type { BindCommand } from "../platform-commands.js";
import {
  readPgcfDatabaseDeletion,
  recordPgcfDeletionRevocation,
  retirePgcfDatabaseTarget,
} from "./deletion.js";
import {
  putPgcfDatabaseReauthorization,
  putPgcfDatabaseRegistration,
  readPgcfDatabaseRegistration,
  reservePgcfDatabaseReauthorization,
  reservePgcfDatabaseRegistration,
} from "./registration.js";
import { markDatabaseProviderTargetServing } from "./serving.js";

/**
 * The typed PGCF registration and deletion metadata commands. A closed interface: nothing here accepts SQL, a
 * provider call or a secret. The integrator binds it with the store's fence (`createPlatformCommands`).
 */
export function createDatabaseRegistrationCommands(bind: BindCommand) {
  return Object.freeze({
    readPgcfDatabaseRegistration: bind(readPgcfDatabaseRegistration),
    reservePgcfDatabaseRegistration: bind(reservePgcfDatabaseRegistration),
    putPgcfDatabaseRegistration: bind(putPgcfDatabaseRegistration),
    reservePgcfDatabaseReauthorization: bind(reservePgcfDatabaseReauthorization),
    putPgcfDatabaseReauthorization: bind(putPgcfDatabaseReauthorization),
    markDatabaseProviderTargetServing: bind(markDatabaseProviderTargetServing),
    readPgcfDatabaseDeletion: bind(readPgcfDatabaseDeletion),
    recordPgcfDeletionRevocation: bind(recordPgcfDeletionRevocation),
    retirePgcfDatabaseTarget: bind(retirePgcfDatabaseTarget),
  });
}

export type DatabaseRegistrationCommands = ReturnType<typeof createDatabaseRegistrationCommands>;
