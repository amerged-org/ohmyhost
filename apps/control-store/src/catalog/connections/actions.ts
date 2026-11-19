import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { digestOf, IdempotencyConflictError, runCommand } from "../../run-command.js";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { integrationMutationGuards, mutationAuthority } from "./mutation-authority.js";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const id = z.string().min(1).max(256);
// Pin an origin-relative path, rejecting ambiguous encodings and path normalization.
const pathPrefix = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (path) =>
      path.startsWith("/") &&
      !path.startsWith("//") &&
      !/[?#\\\p{Cc}]/u.test(path) &&
      !/%(?:25|2f|2e|5c)/iu.test(path) &&
      !path.split("/").some((segment) => segment === "." || segment === ".."),
  );
const action = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("endpoint"),
    appName: id,
    appVersion: z.number().int().positive().safe(),
    endpointName: id,
  }),
  z.strictObject({
    kind: z.literal("scenario"),
    scenarioId: z.number().int().positive().safe(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    pathPrefix,
  }),
]);
const create = z.strictObject({
  organizationId: ulid,
  principalId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
  projectId: ulid,
  environmentId: ulid,
  importId: ulid,
  bindingId: ulid,
  capabilityDigest: digest,
  idempotencyKey: id,
  mutationAuthority,
  action,
});
const read = z.strictObject({ organizationId: ulid, bindingId: ulid, capabilityDigest: digest });
const admit = read.extend({
  executionId: id,
  inputDigest: digest,
  grantGeneration: z.number().int().positive(),
});
const finish = z.strictObject({
  organizationId: ulid,
  bindingId: ulid,
  executionId: id,
  state: z.enum(["completed", "uncertain", "denied"]),
});
const valid = `FROM make_action_bindings b JOIN workspace_connection_imports i ON i.import_id=b.import_id AND i.organization_id=b.organization_id AND i.principal_id=b.principal_id AND i.project_id=b.project_id AND i.environment_id=b.environment_id JOIN workspace_connection_grants g ON g.grant_id=i.grant_id JOIN workspace_connection_attempts a ON a.attempt_id=g.attempt_id JOIN workspace_connection_handoffs h ON h.handoff_hash=a.handoff_hash AND h.organization_id=b.organization_id AND h.principal_id=b.principal_id JOIN projects p ON p.organization_id=b.organization_id AND p.project_id=b.project_id AND p.owner_state='active' AND p.lifecycle_state='active' AND p.ownership_version=b.ownership_version AND p.active_billing_epoch_id=b.billing_epoch_id JOIN environments e ON e.organization_id=b.organization_id AND e.project_id=b.project_id AND e.environment_id=b.environment_id JOIN billing_epochs be ON be.organization_id=b.organization_id AND be.project_id=b.project_id AND be.billing_epoch_id=b.billing_epoch_id AND be.ended_at IS NULL WHERE b.organization_id=?1 AND b.binding_id=?2 AND b.capability_digest=?3 AND g.state='active' AND NOT EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(b.principal_id,6))`;

type Binding = {
  organizationId: string;
  principalId: string;
  projectId: string;
  environmentId: string;
  grantId: string;
  providerOrganizationId: number;
  teamId: number;
  connectionId: number;
  action: string;
};
async function lookup(db: import("../../d1-types.js").D1Database, i: z.output<typeof read>) {
  const row = await db
    .prepare(
      `SELECT b.organization_id AS organizationId,b.principal_id AS principalId,b.project_id AS projectId,b.environment_id AS environmentId,i.grant_id AS grantId,i.provider_organization_id AS providerOrganizationId,i.team_id AS teamId,i.connection_id AS connectionId,b.action AS action ${valid}`,
    )
    .bind(i.organizationId, i.bindingId, i.capabilityDigest)
    .first<Binding>();
  return row;
}
function ownerGuards(db: import("../../d1-types.js").D1Database, b: Binding) {
  const scope = {
    organizationId: b.organizationId,
    principalId: b.principalId,
    action: "integrations:manage" as const,
  };
  return [
    canonicalAuthorizationGuard(db, scope),
    canonicalAuthorizationGuard(db, {
      ...scope,
      projectId: b.projectId,
      environmentId: b.environmentId,
    }),
  ];
}
export async function createMakeActionBinding(context: CatalogContext, raw: unknown) {
  const i = create.parse(raw),
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
      `NOT EXISTS(SELECT 1 FROM workspace_connection_imports i JOIN workspace_connection_grants g ON g.grant_id=i.grant_id JOIN workspace_connection_attempts a ON a.attempt_id=g.attempt_id JOIN workspace_connection_handoffs h ON h.handoff_hash=a.handoff_hash JOIN projects p ON p.organization_id=i.organization_id AND p.project_id=i.project_id JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.environment_id=i.environment_id JOIN billing_epochs be ON be.organization_id=p.organization_id AND be.project_id=p.project_id AND be.billing_epoch_id=p.active_billing_epoch_id AND be.ended_at IS NULL WHERE i.import_id=?1 AND i.organization_id=?2 AND i.principal_id=?3 AND i.project_id=?4 AND i.environment_id=?5 AND h.organization_id=i.organization_id AND h.principal_id=i.principal_id AND g.state='active' AND p.owner_state='active' AND p.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(i.principal_id,6)))`,
      [i.importId, i.organizationId, i.principalId, i.projectId, i.environmentId],
    ),
  ];
  const commandId = await digestOf({
    namespace: "make-action-binding",
    organizationId: i.organizationId,
    principalId: i.principalId,
    idempotencyKey: i.idempotencyKey,
  });
  const authority =
    i.mutationAuthority.kind === "session"
      ? Object.fromEntries(
          Object.entries(i.mutationAuthority).filter(([k]) => k !== "tokenExpiresAt"),
        )
      : i.mutationAuthority;
  try {
    await db.batch(guards());
    const result = await runCommand(db, {
      name: "connections.createMakeActionBinding",
      input: { ...i, mutationAuthority: authority },
      commandId,
      read: async () => null,
      decide: () => ({
        statements: [
          ...guards(),
          db
            .prepare(
              `INSERT INTO make_action_bindings(binding_id,organization_id,principal_id,import_id,project_id,environment_id,capability_digest,action,ownership_version,billing_epoch_id,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,p.ownership_version,p.active_billing_epoch_id,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') FROM projects p WHERE p.organization_id=?2 AND p.project_id=?5 ON CONFLICT DO NOTHING`,
            )
            .bind(
              i.bindingId,
              i.organizationId,
              i.principalId,
              i.importId,
              i.projectId,
              i.environmentId,
              i.capabilityDigest,
              JSON.stringify(i.action),
            ),
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM make_action_bindings WHERE binding_id=?1 AND organization_id=?2 AND principal_id=?3 AND import_id=?4 AND project_id=?5 AND environment_id=?6 AND capability_digest=?7 AND action=?8)`,
            [
              i.bindingId,
              i.organizationId,
              i.principalId,
              i.importId,
              i.projectId,
              i.environmentId,
              i.capabilityDigest,
              JSON.stringify(i.action),
            ],
          ),
        ],
        result: () => ({ bindingId: i.bindingId }),
        logResult: { bindingId: i.bindingId },
      }),
      fromLog: (v) => z.strictObject({ bindingId: ulid }).parse(v),
    });
    await db.batch(guards());
    return result;
  } catch (e) {
    if (
      e instanceof IdempotencyConflictError ||
      (classifyFailure(e).kind === "guard" &&
        (classifyFailure(e) as { code: string }).code === "operation_conflict")
    )
      throw new Error("integration_idempotency_conflict");
    if (classifyFailure(e).kind === "guard") return null;
    throw e;
  }
}
export async function readMakeActionBinding(context: CatalogContext, raw: unknown) {
  const i = read.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    b = await lookup(db, i);
  if (!b) return null;
  try {
    await db.batch(ownerGuards(db, b));
  } catch (e) {
    if (classifyFailure(e).kind === "guard") return null;
    throw e;
  }
  return { ...b, action: action.parse(JSON.parse(b.action)) };
}
export async function admitMakeActionExecution(context: CatalogContext, raw: unknown) {
  const i = admit.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    b = await lookup(db, i);
  if (!b) return "denied" as const;
  try {
    const results = await db.batch([
      ...ownerGuards(db, b),
      db
        .prepare(
          `INSERT INTO make_action_executions(organization_id,binding_id,execution_id,input_digest,grant_generation,state) SELECT ?1,?2,?4,?5,?6,'running' WHERE EXISTS(SELECT 1 ${valid} AND g.generation=?6) ON CONFLICT DO NOTHING`,
        )
        .bind(
          i.organizationId,
          i.bindingId,
          i.capabilityDigest,
          i.executionId,
          i.inputDigest,
          i.grantGeneration,
        ),
    ]);
    if (results[2]?.meta.changes) return "admitted" as const;
  } catch (e) {
    if (classifyFailure(e).kind === "guard") return "denied" as const;
    throw e;
  }
  const row = await db
    .prepare(
      `SELECT input_digest AS inputDigest,grant_generation AS grantGeneration,state FROM make_action_executions WHERE organization_id=?1 AND binding_id=?2 AND execution_id=?3`,
    )
    .bind(i.organizationId, i.bindingId, i.executionId)
    .first<{
      inputDigest: string;
      grantGeneration: number;
      state: "running" | "completed" | "uncertain" | "denied";
    }>();
  if (!row) return "denied" as const;
  if (row.inputDigest !== i.inputDigest || row.grantGeneration !== i.grantGeneration)
    return "conflict" as const;
  return row.state;
}
export async function finishMakeActionExecution(context: CatalogContext, raw: unknown) {
  const i = finish.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  await db
    .prepare(
      `UPDATE make_action_executions SET state=?4 WHERE organization_id=?1 AND binding_id=?2 AND execution_id=?3 AND state='running'`,
    )
    .bind(i.organizationId, i.bindingId, i.executionId, i.state)
    .run();
}
