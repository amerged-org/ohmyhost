import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { digestOf, IdempotencyConflictError, runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { integrationMutationGuards, mutationAuthority } from "./mutation-authority.js";

const selector = z.number().int().positive().safe();
const input = z.strictObject({
  organizationId: ulid,
  principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
  grantId: ulid,
  projectId: ulid,
  environmentId: ulid,
  providerOrganizationId: selector,
  teamId: selector,
  connectionId: selector,
  idempotencyKey: z.string().min(1).max(256),
  mutationAuthority,
});

export async function createConnectionImport(context: CatalogContext, raw: unknown) {
  const i = input.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const guards = () => [
    canonicalAuthorizationGuard(db, {
      organizationId: i.organizationId,
      principalId: i.principalId,
      action: "integrations:manage",
    }),
    canonicalAuthorizationGuard(db, {
      organizationId: i.organizationId,
      principalId: i.principalId,
      projectId: i.projectId,
      environmentId: i.environmentId,
      action: "integrations:manage",
    }),
    ...integrationMutationGuards(db, i),
    guard(
      db,
      "consent_changed",
      "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(?1,6))",
      [i.principalId],
    ),
    guard(
      db,
      "consent_changed",
      "NOT EXISTS(SELECT 1 FROM workspace_connection_grants g JOIN workspace_connection_attempts a USING(attempt_id) JOIN workspace_connection_handoffs h USING(handoff_hash) WHERE g.grant_id=?1 AND g.state='active' AND h.organization_id=?2 AND h.principal_id=?3)",
      [i.grantId, i.organizationId, i.principalId],
    ),
    guard(
      db,
      "consent_changed",
      "NOT EXISTS(SELECT 1 FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.environment_id=?3 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active')",
      [i.organizationId, i.projectId, i.environmentId],
    ),
  ];
  const commandId = await digestOf({
    namespace: "connection-import",
    organizationId: i.organizationId,
    principalId: i.principalId,
    idempotencyKey: i.idempotencyKey,
  });
  const commandAuthority =
    i.mutationAuthority.kind === "session"
      ? Object.fromEntries(
          Object.entries(i.mutationAuthority).filter(([key]) => key !== "tokenExpiresAt"),
        )
      : i.mutationAuthority;
  const identity = await digestOf({
    organizationId: i.organizationId,
    principalId: i.principalId,
    grantId: i.grantId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    providerOrganizationId: i.providerOrganizationId,
    teamId: i.teamId,
    connectionId: i.connectionId,
  });
  let value = BigInt(`0x${identity.slice(0, 32)}`);
  let importId = "";
  for (let index = 0; index < 26; index += 1) {
    importId = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".charAt(Number(value & 31n)) + importId;
    value >>= 5n;
  }
  try {
    await db.batch(guards());
    const result = await runCommand(db, {
      name: "connections.createImport",
      input: { ...i, mutationAuthority: commandAuthority },
      commandId,
      read: async () => null,
      decide: () => ({
        statements: [
          ...guards(),
          db
            .prepare(
              "INSERT INTO workspace_connection_imports(import_id,organization_id,principal_id,grant_id,project_id,environment_id,provider_organization_id,team_id,connection_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')) ON CONFLICT DO NOTHING",
            )
            .bind(
              importId,
              i.organizationId,
              i.principalId,
              i.grantId,
              i.projectId,
              i.environmentId,
              i.providerOrganizationId,
              i.teamId,
              i.connectionId,
            ),
          guard(
            db,
            "operation_conflict",
            "NOT EXISTS(SELECT 1 FROM workspace_connection_imports WHERE import_id=?1 AND organization_id=?2 AND principal_id=?3 AND grant_id=?4 AND project_id=?5 AND environment_id=?6 AND provider_organization_id=?7 AND team_id=?8 AND connection_id=?9)",
            [
              importId,
              i.organizationId,
              i.principalId,
              i.grantId,
              i.projectId,
              i.environmentId,
              i.providerOrganizationId,
              i.teamId,
              i.connectionId,
            ],
          ),
        ],
        result: () => ({ importId }),
        logResult: { importId },
      }),
      fromLog: (value) => z.strictObject({ importId: ulid }).parse(value),
    });
    await db.batch(guards());
    return result;
  } catch (error) {
    if (error instanceof IdempotencyConflictError)
      throw new Error("integration_idempotency_conflict");
    if (classifyFailure(error).kind === "guard") return null;
    throw error;
  }
}
