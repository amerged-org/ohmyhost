import type { MailManagementJobPersistence } from "./d1-job-persistence.js";

/** A bounded continuation of persisted resources, including custody whose creator is gone. */
export async function reconcileWorkspaceMailDomains(input: {
  persistence: MailManagementJobPersistence;
  now: () => Date;
  ensure(scope: { organizationId: string; domainId: string }): Promise<unknown>;
  sync(scope: { organizationId: string; domainId: string }): Promise<unknown>;
  revalidateApplicationDomainIdentity(scope: {
    organizationId: string;
    projectId: string;
    expectedRevision: number;
  }): Promise<unknown>;
}) {
  const persistence = input.persistence,
    now = input.now().toISOString(),
    due = await persistence.claimDueIdentityRevalidation(now);
  const revalidation = { attempted: due.length, renewed: 0, failed: 0 };
  for (const row of due) {
    try {
      const result = await input.revalidateApplicationDomainIdentity({
        organizationId: row.organization_id,
        projectId: row.project_id,
        expectedRevision: Number(row.revision),
      });
      if (
        typeof result !== "object" ||
        result === null ||
        !("status" in result) ||
        !["revalidated", "not_due", "needs_attention", "stale"].includes(String(result.status))
      )
        throw new Error("mail_identity_revalidation_unverified");
      if (result.status === "revalidated") revalidation.renewed++;
      else if (result.status === "needs_attention") revalidation.failed++;
    } catch {
      revalidation.failed++;
    }
  }
  await persistence.suspendExpiredBindings(now);
  const rows = await persistence.listPendingWorkspaces(now);
  let reconciled = 0,
    failed = 0;
  for (const row of rows) {
    if (!(await persistence.claimWorkspace(row.organization_id, row.domain_id, now))) continue;
    try {
      const scope = { organizationId: row.organization_id, domainId: row.domain_id };
      if (row.provisioning) await input.ensure(scope);
      else await input.sync(scope);
      reconciled++;
    } catch {
      failed++;
    }
  }
  return { reconciled, failed, revalidation };
}
