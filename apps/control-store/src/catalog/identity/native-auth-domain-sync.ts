import { z } from "zod";
import { guard } from "../../guards.js";
import { fenceRaceGuard, routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "../provisioning/authority.js";
import { canonicalAuthorizationGuard } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput } from "./handoff-effect.js";
import { restrictionAllows } from "./operation-delegations.js";
import { activeGrantGuard } from "./mcp-sql.js";

const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  kind: z.enum(["paid_delete", "handle_change"]),
  identity: z.string().min(1).max(255),
  recoveryId: z.string().min(1).max(255).optional(),
});
const ack = scope.extend({
  environmentId: ulid,
  configurationRevision: z.number().int().positive(),
  revocationEpoch: z.number().int().positive(),
  ownerEnabled: z.boolean(),
  registryVersion: z.number().int().positive().nullable(),
  acknowledgement: z.enum(["applied", "unprovisioned"]),
});
type Row = Record<string, unknown>;
const unavailable = () => new Error("Native domain policy synchronization unavailable");
export function paidDomainAuthorityGuards(
  db: Awaited<ReturnType<typeof routeOrganization>>["db"],
  input: {
    organizationId: string;
    projectId: string;
    principalId: string;
    delegation?: z.output<typeof handoffAuthorityInput>;
  },
) {
  const result = [canonicalAuthorizationGuard(db, { ...input, action: "projects:write" })];
  if (input.principalId.startsWith("user:"))
    result.push(
      guard(
        db,
        "consent_changed",
        "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)",
        [input.principalId.slice(5)],
      ),
    );
  const d = input.delegation;
  if (d !== undefined) {
    const userId = input.principalId.startsWith("user:") ? input.principalId.slice(5) : "";
    if (
      !/^user_[A-Za-z0-9]+$/u.test(userId) ||
      d.action !== "projects:write" ||
      !restrictionAllows(d.authorizationRestriction, { ...input, action: "projects:write" })
    )
      return [...result, guard(db, "consent_changed", "1")];
    result.push(
      guard(
        db,
        "consent_changed",
        "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)",
        [userId],
      ),
      activeGrantGuard(
        db,
        {
          organizationId: input.organizationId,
          userId,
          clientId: d.clientId,
          consentHash: d.consentHash,
        },
        input.projectId,
        false,
        d.grantId,
      ),
    );
  }
  return result;
}

export async function handleDomainAuthorityGuards(
  db: Awaited<ReturnType<typeof routeOrganization>>["db"],
  input: { organizationId: string; projectId: string; operationId: string },
) {
  const values = [input.organizationId, input.projectId, input.operationId];
  const rows = await db
    .prepare(
      "SELECT actor_id FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1' AND actor_type='principal'",
    )
    .bind(...values)
    .all<{ actor_id: string }>();
  if (rows.results.length !== 1 || rows.results[0] === undefined) throw unavailable();
  const principalId = rows.results[0].actor_id;
  const proof = await readWorkflowDelegation(db, input);
  return [
    guard(
      db,
      "operation_conflict",
      "(SELECT count(*) FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1' AND actor_type='principal')<>1 OR NOT EXISTS(SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1' AND actor_type='principal' AND actor_id=?4)",
      [...values, principalId],
    ),
    canonicalAuthorizationGuard(db, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      principalId,
      action: "projects:write",
    }),
    ...(principalId.startsWith("user:")
      ? [
          guard(
            db,
            "consent_changed",
            "EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=?1)",
            [principalId.slice(5)],
          ),
        ]
      : []),
    ...workflowExecutionGuards(db, input, proof),
  ];
}

/** Checks the original still-authorized operation, including delegated workflow authority. */
export async function domainPolicyExecutionGuards(
  db: Awaited<ReturnType<typeof routeOrganization>>["db"],
  i: z.output<typeof scope>,
) {
  const values = [i.organizationId, i.projectId, i.kind, i.identity];
  const guards = [
    fenceRaceGuard(db, "operation_conflict", i.organizationId),
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM native_auth_domain_operations d JOIN projects p USING(organization_id,project_id) WHERE d.organization_id=?1 AND d.project_id=?2 AND d.kind=?3 AND d.identity=?4 AND d.state='pending' AND p.owner_state='active' AND p.lifecycle_state='active')`,
      values,
    ),
  ];
  if (i.recoveryId === undefined) {
    guards.push(
      guard(
        db,
        "operation_conflict",
        "EXISTS(SELECT 1 FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4 AND state='pending')",
        values,
      ),
    );
  } else {
    const recovery = await db
      .prepare(
        "SELECT principal_id,delegation,recovery_operation_id FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4 AND recovery_id=?5 AND state='pending'",
      )
      .bind(...values, i.recoveryId)
      .first<{
        principal_id: string;
        delegation: string | null;
        recovery_operation_id: string | null;
      }>();
    if (recovery === null) throw unavailable();
    guards.push(
      guard(
        db,
        "operation_conflict",
        "NOT EXISTS(SELECT 1 FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4 AND recovery_id=?5 AND state='pending' AND principal_id=?6 AND recovery_operation_id IS ?7)",
        [...values, i.recoveryId, recovery.principal_id, recovery.recovery_operation_id],
      ),
    );
    if (i.kind === "handle_change") {
      if (recovery.recovery_operation_id === null) throw unavailable();
      const captured = await readWorkflowDelegation(db, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        operationId: recovery.recovery_operation_id,
      });
      if (recovery.delegation !== (captured === null ? null : JSON.stringify(captured)))
        throw unavailable();
      guards.push(
        ...(await handleDomainAuthorityGuards(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          operationId: recovery.recovery_operation_id,
        })),
      );
      guards.push(
        guard(
          db,
          "operation_conflict",
          "NOT EXISTS(SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1' AND actor_type='principal' AND actor_id=?4)",
          [i.organizationId, i.projectId, recovery.recovery_operation_id, recovery.principal_id],
        ),
      );
      guards.push(
        guard(
          db,
          "operation_conflict",
          "NOT EXISTS(SELECT 1 FROM product_command_intents intent JOIN operations o USING(organization_id,project_id,operation_id) WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.operation_id=?3 AND intent.event_type='ProjectHandleChangeRequestedV1' AND o.state IN('queued','running'))",
          [i.organizationId, i.projectId, recovery.recovery_operation_id],
        ),
      );
    } else {
      const delegation =
        recovery.delegation === null
          ? undefined
          : handoffAuthorityInput.parse(JSON.parse(recovery.delegation));
      guards.push(
        ...paidDomainAuthorityGuards(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          principalId: recovery.principal_id,
          ...(delegation === undefined ? {} : { delegation }),
        }),
      );
    }
  }
  if (i.kind === "paid_delete") {
    guards.push(
      guard(
        db,
        "operation_conflict",
        `NOT EXISTS(SELECT 1 FROM paid_project_domains d JOIN native_auth_domain_operations pending ON pending.organization_id=d.organization_id AND pending.project_id=d.project_id AND pending.kind=?3 AND pending.identity=?4 WHERE d.organization_id=?1 AND d.project_id=?2 AND d.state='deleting' AND lower(hex(d.delete_idempotency_sha256))=?4 AND json_extract(pending.original_input,'$.hostname')=d.hostname AND json_extract(pending.original_input,'$.requestSha256')=lower(hex(d.delete_request_sha256)))`,
        values,
      ),
    );
    const parent = await db
      .prepare(
        "SELECT original_input FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4",
      )
      .bind(...values)
      .first<{ original_input: string }>();
    if (parent === null) throw unavailable();
    const original = z
      .strictObject({
        hostname: z.string(),
        requestSha256: z.string(),
        principalId: z.string(),
        delegation: handoffAuthorityInput.optional(),
      })
      .parse(JSON.parse(parent.original_input));
    if (i.recoveryId === undefined)
      guards.push(
        ...paidDomainAuthorityGuards(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          principalId: original.principalId,
          ...(original.delegation === undefined ? {} : { delegation: original.delegation }),
        }),
      );
  } else {
    guards.push(
      guard(
        db,
        "operation_conflict",
        `NOT EXISTS(SELECT 1 FROM product_provider_mutation_claims c JOIN operations o ON o.organization_id=c.organization_id AND o.project_id=c.project_id AND o.operation_id=c.operation_id JOIN projects p ON p.organization_id=c.organization_id AND p.project_id=c.project_id AND p.lifecycle_version=c.accepted_lifecycle_version AND p.active_billing_epoch_id=c.billing_epoch_id JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE c.organization_id=?1 AND c.project_id=?2 AND c.operation_id=?4 AND c.event_type='ProjectHandleChangeRequestedV1' AND o.state IN('queued','running'))`,
        values,
      ),
    );
    if (i.recoveryId === undefined)
      guards.push(...(await handleDomainAuthorityGuards(db, { ...i, operationId: i.identity })));
  }
  return guards;
}

const absent = `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?5)
 AND NOT EXISTS(SELECT 1 FROM native_auth_role_operations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?5)
 AND NOT EXISTS(SELECT 1 FROM native_auth_preparation_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?5)
 AND NOT EXISTS(SELECT 1 FROM native_auth_restore_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?5)
 AND NOT EXISTS(SELECT 1 FROM environments e JOIN deployment_revisions revision ON revision.organization_id=e.organization_id AND revision.project_id=e.project_id AND revision.deployment_id=e.active_deployment_id AND revision.revision_id=e.active_revision_id JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?5 AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native')`;

/** A realm without registration is absent only with explicit storage and Native-head proof. */
export async function readDomainPolicySync(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const values = [i.organizationId, i.projectId, i.kind, i.identity];
  await db.batch(await domainPolicyExecutionGuards(db, i));
  const rows = await db
    .prepare(
      `SELECT s.*,p.region FROM native_auth_domain_policy_syncs s JOIN projects p USING(organization_id,project_id) WHERE s.organization_id=?1 AND s.project_id=?2 AND s.kind=?3 AND s.identity=?4 AND s.state='pending' ORDER BY s.environment_id`,
    )
    .bind(...values)
    .all<Row>();
  for (const row of rows.results) {
    if (row["registry_version"] === null) {
      const proof = await db
        .prepare(`SELECT ${absent} AS absent`)
        .bind(...values, row["environment_id"])
        .first<{ absent: number }>();
      if (proof?.absent !== 1) throw unavailable();
    }
  }
  return rows.results.map((row) => ({
    environmentId: String(row["environment_id"]),
    region: row["region"],
    configurationRevision: Number(row["configuration_revision"]),
    revocationEpoch: Number(row["revocation_epoch"]),
    ownerEnabled: row["owner_enabled"] === 1,
    canonicalOrigin: null,
    registryVersion: row["registry_version"] === null ? null : Number(row["registry_version"]),
  }));
}

/** Record the exact private RPC acknowledgement under the same current-owner and head fences. */
export async function ackDomainPolicySync(context: CatalogContext, raw: unknown) {
  const i = ack.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const values = [
    i.organizationId,
    i.projectId,
    i.kind,
    i.identity,
    i.environmentId,
    i.configurationRevision,
    i.revocationEpoch,
    i.ownerEnabled ? 1 : 0,
    i.registryVersion,
  ];
  if ((i.registryVersion === null) !== (i.acknowledgement === "unprovisioned")) throw unavailable();
  const evidence = JSON.stringify({
    configurationRevision: i.configurationRevision,
    revocationEpoch: i.revocationEpoch,
    ownerEnabled: i.ownerEnabled,
    canonicalOrigin: null,
    registryVersion: i.registryVersion,
    outcome: i.acknowledgement,
  });
  const guards = await domainPolicyExecutionGuards(db, i);
  await db.batch(guards);
  const existing = await db
    .prepare(
      `SELECT state,acknowledgement FROM native_auth_domain_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4 AND environment_id=?5`,
    )
    .bind(...values.slice(0, 5))
    .first<Row>();
  if (existing?.["state"] === "acknowledged") {
    if (existing["acknowledgement"] !== evidence) throw unavailable();
    return "replayed" as const;
  }
  await db.batch([
    ...guards,
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs s JOIN native_auth_realms r USING(organization_id,project_id,environment_id) JOIN environments e USING(organization_id,project_id,environment_id) WHERE s.organization_id=?1 AND s.project_id=?2 AND s.kind=?3 AND s.identity=?4 AND s.environment_id=?5 AND s.state='pending' AND s.configuration_revision=?6 AND s.revocation_epoch=?7 AND s.owner_enabled=?8 AND s.registry_version IS ?9 AND r.configuration_revision=?6 AND r.revocation_epoch=?7 AND r.enabled=?8 AND r.canonical_origin IS NULL AND e.active_deployment_id IS s.head_deployment_id AND e.active_revision_id IS s.head_revision_id AND e.head_version=s.head_version)`,
      values,
    ),
    i.registryVersion === null
      ? guard(db, "operation_conflict", `NOT (${absent})`, values.slice(0, 5))
      : guard(
          db,
          "operation_conflict",
          `NOT EXISTS(SELECT 1 FROM native_auth_registrations WHERE organization_id=?1 AND project_id=?2 AND environment_id=?5 AND state='active' AND registry_version=?9)`,
          values,
        ),
    db
      .prepare(
        `UPDATE native_auth_domain_policy_syncs SET state='acknowledged',acknowledgement=?6 WHERE organization_id=?1 AND project_id=?2 AND kind=?3 AND identity=?4 AND environment_id=?5 AND state='pending'`,
      )
      .bind(...values.slice(0, 5), evidence),
    guard(db, "operation_conflict", "changes()<>1"),
  ]);
  return "acknowledged" as const;
}
