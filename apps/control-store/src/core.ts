import type { D1Database } from "./d1-types.js";

/** The one authority binding of the production Control store. */
export const CORE_BINDING = "CONTROL_CORE" as const;
/** The layout record `core_layout` must carry: the schema of `migrations/core`. */
export const CORE_LAYOUT = "shared-core-v1" as const;

/**
 * Bindings of the previous organization-sharded authority. They are not an alternative: a store that finds one next to
 * `CONTROL_CORE` refuses to start, so two authorities for the same money, authentication and operations can never be
 * reachable from one Worker.
 */
const LEGACY_AUTHORITY_BINDING = /^(?:CONTROL_GLOBAL|CONTROL_SHARD_\d{4})$/u;

/** The Worker is not configured with exactly one shared-core authority. Raised before anything is read or written. */
export class CoreConfigurationError extends Error {
  readonly code = "core_configuration";
}

function isD1Database(value: unknown): value is D1Database {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["prepare"] === "function" && typeof candidate["batch"] === "function";
}

/**
 * The authority database of the store: exactly one `CONTROL_CORE` D1 binding and no legacy Directory or organization
 * shard binding. A missing or ambiguous configuration fails closed; there is no fallback to another database and no
 * PostgreSQL path. Messages name bindings only, never identifiers or credentials.
 */
export function resolveCoreDatabase(bindings: Readonly<Record<string, unknown>>): D1Database {
  const legacy = Object.keys(bindings)
    .filter((name) => LEGACY_AUTHORITY_BINDING.test(name))
    .sort();
  if (legacy.length > 0) {
    throw new CoreConfigurationError(
      `ambiguous authority: ${CORE_BINDING} must be the only authority binding, found ${legacy.join(", ")}`,
    );
  }
  const core = bindings[CORE_BINDING];
  if (!isD1Database(core)) {
    throw new CoreConfigurationError(
      `${CORE_BINDING} is not bound to this Worker as a D1 database`,
    );
  }
  return core;
}

interface LayoutRow {
  readonly layout: string;
  readonly command_namespace_version: number;
}

/**
 * Proves that the bound database is the shared-core-v1 schema before the first command uses it: a database without the
 * layout record (an old Directory or tenant shard, or an unmigrated database) is refused. Only a missing table or row
 * means "wrong layout"; any other failure (a lost connection) is rethrown so the caller retries instead of misreporting.
 * Production authority additionally requires an immutable operator qualification/activation receipt. A fresh or
 * loading target is never a runtime authority. This positive may be cached: the SQL guards permanently prevent a
 * historical import from opening after ANY activation and prevent activation while an import is open.
 */
export async function verifyCoreLayout(core: D1Database): Promise<void> {
  let row: LayoutRow | null;
  try {
    row = await core
      .prepare("SELECT layout, command_namespace_version FROM core_layout WHERE singleton = 1")
      .first<LayoutRow>();
  } catch (error) {
    if (/no such table/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new CoreConfigurationError(`${CORE_BINDING} does not carry the ${CORE_LAYOUT} schema`);
    }
    throw error;
  }
  if (row?.layout !== CORE_LAYOUT || row.command_namespace_version !== 1) {
    throw new CoreConfigurationError(`${CORE_BINDING} does not carry the ${CORE_LAYOUT} schema`);
  }
  let activation: { readonly singleton: number } | null;
  try {
    activation = await core
      .prepare("SELECT singleton FROM core_authority_activation WHERE singleton = 1")
      .first<{ readonly singleton: number }>();
  } catch (error) {
    if (/no such table/iu.test(error instanceof Error ? error.message : String(error))) {
      throw new CoreConfigurationError(`${CORE_BINDING} has no qualified immutable activation`);
    }
    throw error;
  }
  if (activation?.singleton !== 1)
    throw new CoreConfigurationError(`${CORE_BINDING} has no qualified immutable activation`);
}
