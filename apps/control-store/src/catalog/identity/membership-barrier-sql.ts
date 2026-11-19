/**
 * Existing membership (`m`) and mapped organization (`o`) must be synchronized
 * and free of terminal organization or user revocation, even before projection reconciliation.
 * A user revocation is global or scoped to this WorkOS organization, as in membership-state.ts.
 * Callers supply these fixed SQL aliases, never user-selected identifiers. This
 * predicate is shared by enumeration, canonical decisions and effect/proof guards.
 */
export const BARRIER_FREE_MEMBERSHIP_SQL = `
  NOT EXISTS (SELECT 1 FROM workos_membership_sync_barriers barrier
    WHERE barrier.organization_id=m.organization_id
      AND barrier.workos_user_id=m.workos_user_id AND barrier.reconciled_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM pending_membership_barriers pending
    WHERE pending.workos_organization_id=o.workos_organization_id
      AND pending.workos_user_id=m.workos_user_id)
  AND NOT EXISTS (SELECT 1 FROM revocations terminal
    WHERE terminal.kind='organization' AND terminal.resource_id=o.workos_organization_id)
  AND NOT EXISTS (SELECT 1 FROM revocations terminal
    WHERE terminal.kind='user' AND terminal.resource_id=m.workos_user_id
      AND (terminal.workos_organization_id IS NULL OR terminal.workos_organization_id=o.workos_organization_id))`;

/**
 * An active admin or owner membership of the principal in the active organization `organizationColumn` refers to, free of
 * barriers and terminal revocations. Dev access uses this one fragment for issue, scope, redemption and share state, so
 * a removed member loses every path at once. Callers pass fixed SQL column and bind expressions, never user input.
 */
export function activeAdministratorSql(
  organizationColumn: string,
  principalExpression: string,
): string {
  return `EXISTS(SELECT 1 FROM organizations o JOIN organization_memberships m ON m.organization_id=o.organization_id
      WHERE o.organization_id=${organizationColumn} AND o.state='active' AND ('user:'||m.workos_user_id)=${principalExpression}
        AND m.state='active' AND m.revoked_at IS NULL AND m.role IN('admin','owner') AND ${BARRIER_FREE_MEMBERSHIP_SQL})`;
}
