/** An unverified workspace reservation keeps its name for this long; then it is retired like any other sender. */
export const UNVERIFIED_WORKSPACE_MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expires the unverified workspace reservations due at `now`. Each one goes through the provider retirement, which frees
 * its name and releases its provider domain. A failed retirement stays due and is listed again by the next tick.
 */
export async function expireUnverifiedWorkspaceMailDomains(input: {
  readonly persistence: {
    listExpiredUnverifiedWorkspaces(
      cutoff: string,
      limit: number,
    ): Promise<readonly { organizationId: string; domainId: string; expectedRevision: number }[]>;
  };
  readonly now: () => Date;
  readonly retire: (scope: {
    organizationId: string;
    domainId: string;
    expectedRevision: number;
  }) => Promise<unknown>;
}) {
  const cutoff = new Date(input.now().getTime() - UNVERIFIED_WORKSPACE_MAIL_TTL_MS).toISOString();
  const due = await input.persistence.listExpiredUnverifiedWorkspaces(cutoff, 20);
  let retired = 0,
    failed = 0;
  for (const row of due) {
    try {
      await input.retire(row);
      retired++;
    } catch {
      failed++;
    }
  }
  return { attempted: due.length, retired, failed };
}
