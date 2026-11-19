import type { DatabaseMigrationClient } from "@ohmyhost/platform";
import { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { productionPgcfDataConnection } from "./pgcf-data-operations.js";
import {
  createPgcfManagement,
  type PgcfManagementDependencies,
  type PgcfDatabaseAdminBinding,
} from "./pgcf-runtime.js";

/** The PGCF provider configuration a Worker holds; absent members fail the provider's construction. */
interface PgcfProviderBindings {
  readonly PGCF_API_URL?: string | undefined;
  readonly PGCF_APPS_PROJECT_ID?: string | undefined;
  readonly PGCF_APPS_API_KEY?: string | undefined;
}

export function createProductionPgcfProvider(bindings: PgcfProviderBindings): PgcfProjectProvider {
  if (!bindings.PGCF_API_URL || !bindings.PGCF_APPS_PROJECT_ID || !bindings.PGCF_APPS_API_KEY)
    throw new Error("PGCF project configuration is unavailable");
  return new PgcfProjectProvider({
    baseUrl: bindings.PGCF_API_URL,
    projectId: bindings.PGCF_APPS_PROJECT_ID,
    apiKey: bindings.PGCF_APPS_API_KEY,
  });
}
/** Provisioning and migration statements may run longer than product SQL. */
export function pgcfManagementConnect(): PgcfManagementDependencies["connect"] {
  return async (uri, target) => {
    const connection = await productionPgcfDataConnection(uri, target, {
      query_timeout: 35_000,
      statement_timeout: 35_000,
    });
    return {
      client: connection.client as unknown as DatabaseMigrationClient,
      close: connection.close,
    };
  };
}
type PgcfRuntimeBindings = PgcfProviderBindings & {
  readonly PROJECT_DATABASE_ADMIN_US: unknown;
  readonly PROJECT_DATABASE_ADMIN_EU: unknown;
};
export function createProductionPgcfRuntime(
  bindings: PgcfRuntimeBindings,
  authority: Pick<PgcfManagementDependencies, "persistence" | "sleep">,
  connectOverride?: PgcfManagementDependencies["connect"],
) {
  return createPgcfManagement({
    ...authority,
    provider: createProductionPgcfProvider(bindings),
    admin: (region) =>
      (region === "us"
        ? bindings.PROJECT_DATABASE_ADMIN_US
        : bindings.PROJECT_DATABASE_ADMIN_EU) as unknown as PgcfDatabaseAdminBinding,
    connect: connectOverride ?? pgcfManagementConnect(),
  });
}
