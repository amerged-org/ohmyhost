import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import type { Command } from "../../run-command.js";
import { runMapped } from "../common.js";
import { shardOfOrganization, type PlatformContext } from "../platform-support.js";
import { DatabaseProviderConflictError } from "./contracts.js";

/**
 * Every guard code a database command can raise means "a fact the decision read no longer holds": the snapshot is
 * stale and nothing was applied. A stale snapshot is read and decided again (`retryOn`); only a settled decision
 * is reported, as the typed conflict.
 */
export function conflictsAs(make: () => Error): Readonly<Record<string, () => Error>> {
  return {
    claim_lost: make,
    scope_inactive: make,
    organization_inactive: make,
    precondition_changed: make,
  };
}
export const DATABASE_CONFLICTS = conflictsAs(() => new DatabaseProviderConflictError());

/** An unknown outcome of a command without a command id is resolved by deciding again: a committed twin is a replay. */
export function lookupByReplay<Snapshot, Result>(
  command: Pick<Command<Snapshot, Result>, "read" | "decide">,
): (db: D1Database) => Promise<Result | undefined> {
  return async (db) => {
    const plan = command.decide(await command.read(db));
    return "replay" in plan ? plan.replay : undefined;
  };
}

/** Runs one command on the shard of the organization it names, translating guard aborts into typed conflicts. */
export async function runOnOrganization<Snapshot, Result>(
  context: PlatformContext,
  organizationId: string,
  build: (db: D1Database) => Command<Snapshot, Result>,
  conflicts: Readonly<Record<string, () => Error>> = DATABASE_CONFLICTS,
): Promise<Result> {
  const db = await shardOfOrganization(context, organizationId);
  const command = build(db);
  return runMapped(db, { ...command, lookup: lookupByReplay(command) }, conflicts);
}

/** A read on the shard of the organization it names: one snapshot batch, no write. */
export async function readOnOrganization<Result>(
  context: PlatformContext,
  organizationId: string,
  run: (db: D1Database) => Promise<Result>,
): Promise<Result> {
  return run(await shardOfOrganization(context, organizationId));
}

/** The batch aborts with `precondition_changed` when `violation` holds: the decision's snapshot is stale. */
export function stale(
  db: D1Database,
  violation: string,
  params: readonly unknown[],
): D1PreparedStatement {
  return guard(db, "precondition_changed", violation, params);
}
