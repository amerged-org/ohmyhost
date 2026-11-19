import {
  authorizationRestrictionInput,
  delegationActionInput,
} from "../identity/authorization-restriction.js";
import { restrictionAllows } from "../identity/operation-delegations.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";
import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { ulid } from "../common.js";

/** True when `value` holds a C0 control character or DEL (kept out of the regular expressions: no-control-regex). */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const cfDelegation = z.strictObject({
    grantId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
    grantRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    clientId: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => !/\s/u.test(value) && !hasControlCharacter(value)),
    consentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    action: delegationActionInput.optional(),
    authorizationRestriction: authorizationRestrictionInput.optional(),
  }),
  cfActor = z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !hasControlCharacter(value));
export const cfAuthorityInput = z.strictObject({
  organizationId: ulid,
  purpose: z.enum(["application_identity", "workspace_mail"]),
  resourceId: ulid,
  principalId: cfActor,
  delegation: cfDelegation.nullable(),
});
export type CfAuthority = z.output<typeof cfAuthorityInput>;
/** Exact original local grant collapse/beta policy and purpose-bound MCP identities, on the one shared primary. */
export function cfAuthorityCondition(input: CfAuthority): { sql: string; params: unknown[] } {
  const project = input.purpose === "application_identity";
  const action = project ? "projects:write" : "mail-domains:admin";
  const d = input.delegation;
  if (
    d !== null &&
    ((d.action !== undefined && d.action !== action) ||
      !restrictionAllows(d.authorizationRestriction, {
        action,
        organizationId: input.organizationId,
        ...(project ? { projectId: input.resourceId } : { mailDomainId: input.resourceId }),
      }))
  )
    return { sql: "0", params: [] };
  const canonical = canonicalAuthorizationCondition({
    organizationId: input.organizationId,
    principalId: input.principalId,
    action,
    ...(project ? { projectId: input.resourceId } : { mailDomainId: input.resourceId }),
  });
  if (canonical.params.length === 0) return { sql: "0", params: [] };
  const values: unknown[] = [...canonical.params, input.principalId.slice(5)];
  let sql = `(${canonical.sql}) AND NOT EXISTS(SELECT 1 FROM revocations terminal WHERE terminal.kind='user' AND terminal.resource_id=?7)`;
  if (d !== null) {
    values.push(d.grantId, d.grantRevision, d.clientId, d.consentHash);
    sql += ` AND EXISTS(SELECT 1 FROM mcp_client_grants g WHERE g.organization_id=?1 AND g.user_id=?7 AND g.grant_id=?8 AND g.revision=?9 AND g.client_id=?10 AND g.consent_hash=?11 AND g.revoked_at IS NULL
      AND ${project ? "g.project_id=?3 AND EXISTS(SELECT 1 FROM projects p WHERE p.organization_id=g.organization_id AND p.project_id=g.project_id AND p.owner_state='active' AND p.lifecycle_state='active' AND p.ownership_version=g.ownership_version AND p.active_billing_epoch_id=g.billing_epoch_id)" : "g.project_id IS NULL"}
      AND NOT EXISTS(SELECT 1 FROM mcp_client_revocations r WHERE r.organization_id=g.organization_id AND r.user_id=g.user_id AND r.client_id=g.client_id AND r.consent_hash=g.consent_hash)
      AND NOT EXISTS(SELECT 1 FROM mcp_connection_revocations r WHERE r.user_id=g.user_id AND r.client_id=g.client_id AND r.consent_hash=g.consent_hash))`;
  }
  return { sql, params: values };
}
export async function cfAuthorityHolds(db: D1Database, input: CfAuthority): Promise<boolean> {
  const condition = cfAuthorityCondition(input);
  return (
    (await db
      .prepare(`SELECT 1 WHERE ${condition.sql}`)
      .bind(...condition.params)
      .first()) !== null
  );
}
export function cfAuthorityGuard(db: D1Database, input: CfAuthority): D1PreparedStatement {
  const condition = cfAuthorityCondition(input);
  return guard(db, "precondition_changed", `NOT(${condition.sql})`, condition.params);
}
