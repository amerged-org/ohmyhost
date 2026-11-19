import type { D1Database } from "../../d1-types.js";

/**
 * Historical SES resource identities recorded at creation; no provider lookup, guessed locator or inferred absence.
 * Route 53 receipts are retired history and no longer name resources that deletion must prove absent.
 */
export const LEGACY_MAIL_RESOURCES_SQL = `
 SELECT 'ses-tenant' resource_kind,tenant.tenant_arn locator FROM ses_tenant_receipts tenant WHERE tenant.organization_id=?1 AND tenant.project_id=?2
 UNION ALL SELECT 'ses-configuration-set',resources.configuration_set_arn FROM ses_project_mail_resource_receipts resources WHERE resources.organization_id=?1 AND resources.project_id=?2
 UNION ALL SELECT 'ses-event-destination',resources.configuration_set_arn||'/event-destination/'||event.event_destination_name
 FROM ses_event_destination_receipts event JOIN ses_project_mail_resource_receipts resources ON resources.organization_id=event.organization_id AND resources.project_id=event.project_id WHERE event.organization_id=?1 AND event.project_id=?2`;
export const LEGACY_MAIL_ABSENCE_SQL = `SELECT DISTINCT legacy.resource_kind,legacy.locator,absence.observed_at FROM(${LEGACY_MAIL_RESOURCES_SQL}) legacy
 LEFT JOIN legacy_aws_mail_absence absence ON absence.organization_id=?1 AND absence.project_id=?2 AND absence.resource_kind=legacy.resource_kind AND absence.locator=legacy.locator
 ORDER BY legacy.resource_kind,legacy.locator`;
export interface LegacyMailResourceRow {
  resource_kind: string;
  locator: string | null;
  observed_at: string | null;
}
export function legacyMailResourcesStatement(
  db: D1Database,
  scope: { organizationId: string; projectId: string },
) {
  return db.prepare(LEGACY_MAIL_ABSENCE_SQL).bind(scope.organizationId, scope.projectId);
}
export function requireLegacyMailAbsence(rows: readonly LegacyMailResourceRow[]) {
  const absent = [];
  for (const row of rows) {
    if (row.observed_at === null || row.locator === null)
      throw new Error("legacy_aws_mail_absence_missing");
    absent.push({
      provider: "aws" as const,
      resourceKind: row.resource_kind,
      locator: row.locator,
      outcome: "not_found" as const,
    });
  }
  return absent;
}
