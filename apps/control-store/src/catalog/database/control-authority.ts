import { z } from "zod";
import type { CatalogContext } from "../common.js";
import { CoreConfigurationError, CORE_LAYOUT } from "../../core.js";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const configuration = z.object({
  CONTROL_CORE_DATABASE_ID: uuid,
  CONTROL_PLATFORM_ENVIRONMENT: z.enum(["development", "production"]),
});
export const controlAuthority = z.strictObject({
  provider: z.literal("d1"),
  databaseId: uuid,
  environment: z.enum(["development", "production"]),
  activationId: uuid,
  qualificationSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  runtimeSchemaSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ControlAuthority = z.output<typeof controlAuthority>;
/** Configured resource metadata plus the actual immutable bound-Core qualification. Provider binding/version proof stays in release evidence. */
export async function readControlAuthority(
  context: CatalogContext,
  bindings: unknown,
): Promise<ControlAuthority> {
  const configured = configuration.parse(bindings),
    db = (await context.router.routeShard(0)).db;
  const row = await db
    .prepare(
      `SELECT a.activation_id,lower(hex(a.qualification_sha256)) qualification_sha256,lower(hex(a.runtime_schema_sha256)) runtime_schema_sha256
 FROM core_layout layout JOIN core_authority_activation a ON a.singleton=layout.singleton
 WHERE layout.singleton=1 AND layout.layout=?1 AND layout.command_namespace_version=1 AND NOT EXISTS(SELECT 1 FROM core_historical_import WHERE closed_at IS NULL)`,
    )
    .bind(CORE_LAYOUT)
    .first<{
      activation_id: string;
      qualification_sha256: string;
      runtime_schema_sha256: string;
    }>();
  if (row === null)
    throw new CoreConfigurationError("CONTROL_CORE has no closed qualified authority");
  return controlAuthority.parse({
    provider: "d1",
    databaseId: configured.CONTROL_CORE_DATABASE_ID,
    environment: configured.CONTROL_PLATFORM_ENVIRONMENT,
    activationId: row.activation_id,
    qualificationSha256: row.qualification_sha256,
    runtimeSchemaSha256: row.runtime_schema_sha256,
  });
}
