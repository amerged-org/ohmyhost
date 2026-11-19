import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { CommandConflictError } from "../../run-command.js";
import type { PlatformContext } from "../platform-support.js";
import { instant } from "../platform-support.js";

export const DOMAIN_CLASSES = [
  "app_prod",
  "app_dev",
  "cf_mail",
  "paid_hostname",
  "project_mail",
  "resend_live",
  "workspace_live",
] as const;
export type DomainClass = (typeof DOMAIN_CLASSES)[number];

export interface DomainClaim {
  readonly class: DomainClass;
  readonly domain: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  /** Stable id of the claiming command; identical on every retry of that command. */
  readonly claimId: string;
  /** Stored-form timestamp of the claiming command. */
  readonly now: string;
}

function taken(claim: Pick<DomainClaim, "domain">): CommandConflictError {
  return new CommandConflictError("domain_taken", `${claim.domain} is claimed by another owner`);
}

const SAME_OWNER =
  "domain_directory.organization_id = excluded.organization_id AND domain_directory.project_id IS excluded.project_id";

/** The Directory row that holds a globally unique name, as the claiming command's snapshot read it. */
export interface DirectoryClaimRow {
  readonly class: DomainClass;
  readonly domain: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly state: "reserved" | "active";
  readonly claim_id: string | null;
}

/** An abort tombstone: the sweep closed the claim `claim_id` of this name, which can never commit again. */
export interface ClaimAbortRow {
  readonly class: DomainClass;
  readonly domain: string;
  readonly claim_id: string;
}

/**
 * Whether a claim may take the name, decided on the one snapshot the command read: a name held by another owner is
 * `domain_taken`; a claim the sweep closed (its own, or the one of the reservation an older command left on the
 * name) is `domain_reservation_expired`. The same owner may claim again. A reservation is never adopted by another
 * owner and never the source of truth.
 */
export function domainClaimRefusal(
  claim: DomainClaim,
  rows: readonly DirectoryClaimRow[],
  aborts: readonly ClaimAbortRow[],
): CommandConflictError | null {
  const closedFor = (claimId: string | null) =>
    claimId !== null &&
    aborts.some(
      (abort) =>
        abort.class === claim.class && abort.domain === claim.domain && abort.claim_id === claimId,
    );
  if (closedFor(claim.claimId)) return reservationClosed(claim);
  const holder = rows.find((row) => row.class === claim.class && row.domain === claim.domain);
  if (holder === undefined) return null;
  if (holder.organization_id !== claim.organizationId || holder.project_id !== claim.projectId) {
    return taken(claim);
  }
  if (holder.state === "reserved" && closedFor(holder.claim_id)) return reservationClosed(claim);
  return null;
}

/**
 * The Directory claim of a globally unique name as statements of the claiming command's OWN batch (core-model 5.5
 * collapsed into one transaction, as the original single PostgreSQL transaction was): the name is claimed and
 * confirmed at once, together with the rows that back it, or not at all. The same owner confirms an older
 * reservation of the name; the guards abort the batch when another owner holds the name, or when the sweep wrote an
 * abort tombstone for this claim id or the reservation it found (a delayed writer never commits afterwards); the
 * command re-reads and classifies again.
 */
export function claimDomainStatements(
  db: D1Database,
  claim: DomainClaim,
  holderClaimId: string | null,
): D1PreparedStatement[] {
  const tombstone = (claimId: string) =>
    guard(
      db,
      "claim_lost",
      "EXISTS (SELECT 1 FROM domain_claim_aborts WHERE class = ? AND domain = ? AND claim_id = ?)",
      [claim.class, claim.domain, claimId],
    );
  return [
    ...[...new Set([claim.claimId, holderClaimId])]
      .filter((claimId): claimId is string => claimId !== null)
      .map(tombstone),
    db
      .prepare(
        `INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at, state, claim_id, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL)
         ON CONFLICT (class, domain) DO UPDATE SET
           updated_at = CASE WHEN domain_directory.state = 'reserved' THEN excluded.updated_at ELSE domain_directory.updated_at END,
           state = 'active', expires_at = NULL
          WHERE ${SAME_OWNER}`,
      )
      .bind(
        claim.class,
        claim.domain,
        claim.organizationId,
        claim.projectId,
        claim.now,
        claim.claimId,
      ),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS (SELECT 1 FROM domain_directory WHERE class = ?1 AND domain = ?2 AND organization_id = ?3 AND project_id IS ?4 AND state = 'active')",
      [claim.class, claim.domain, claim.organizationId, claim.projectId],
    ),
  ];
}

/** Which shard table proves that a claim of each class has a live owner. */
const BACKING: Record<DomainClass, string> = {
  app_prod:
    "SELECT 1 FROM cloudflare_project_domains WHERE organization_id = ?1 AND production_domain = ?2",
  app_dev:
    "SELECT 1 FROM cloudflare_project_domains WHERE organization_id = ?1 AND development_domain = ?2",
  cf_mail:
    "SELECT 1 FROM cloudflare_project_domains WHERE organization_id = ?1 AND mail_domain = ?2",
  paid_hostname:
    "SELECT 1 FROM paid_project_domains WHERE organization_id = ?1 AND hostname = ?2 AND state NOT IN ('deleted', 'displaced')",
  project_mail: "SELECT 1 FROM project_mail_domains WHERE organization_id = ?1 AND domain = ?2",
  resend_live:
    "SELECT 1 FROM resend_mail_domains WHERE organization_id = ?1 AND domain = ?2 AND deleted_at IS NULL",
  workspace_live:
    "SELECT 1 FROM workspace_mail_domains WHERE organization_id = ?1 AND domain = ?2 AND status <> 'retired'",
};

export const settleDomainReservationsInput = z.strictObject({
  now: instant,
  limit: z.number().int().min(1).max(500).default(100),
});

const DUE_RESERVATION =
  "class = ?1 AND domain = ?2 AND organization_id = ?3 AND claim_id IS ?4 AND state = 'reserved'";

/** Raised to a command whose reservation the sweep closed: the same claim never commits again. */
export function reservationClosed(claim: Pick<DomainClaim, "domain">): CommandConflictError {
  return new CommandConflictError(
    "domain_reservation_expired",
    `The reservation of ${claim.domain} expired and was closed`,
  );
}

/**
 * Repair sweep of the saga. A reservation past its expiry is settled against the shard in ONE batch, as the
 * project creation resolver does: the batch writes the abort tombstone of its claim only when no backing row
 * exists, then reports whether one does. A backing row confirms the reservation (the command crashed after its
 * shard write). No backing row releases it; the tombstone now fences every shard write of that claim, so a
 * creator that was only delayed can never commit after the name was released and taken by another owner. The
 * directory and the shard are different databases: this is a fence, not an atomic transaction. Only `reserved`
 * rows are touched; a confirmed claim is released solely by the mirror order of its own command.
 */
export async function settleDomainReservations(
  context: PlatformContext,
  raw: unknown,
): Promise<{ readonly confirmed: number; readonly released: number }> {
  const input = settleDomainReservationsInput.parse(raw);
  const due = await context.directory
    .prepare(
      `SELECT class, domain, organization_id, project_id, claim_id FROM domain_directory
        WHERE state = 'reserved' AND expires_at < ? ORDER BY expires_at, class, domain LIMIT ?`,
    )
    .bind(input.now, input.limit)
    .all<{
      class: DomainClass;
      domain: string;
      organization_id: string;
      project_id: string | null;
      claim_id: string | null;
    }>();
  let confirmed = 0;
  let released = 0;
  for (const claim of due.results) {
    const shard = (await context.router.routeOrganization(claim.organization_id)).db;
    // One batch: tombstone only when nothing backs the claim, then read what backs it.
    const [, backing] = await shard.batch([
      shard
        .prepare(
          `INSERT OR IGNORE INTO domain_claim_aborts(class, domain, organization_id, claim_id, aborted_at)
           SELECT ?3, ?2, ?1, ?4, ?5 WHERE NOT EXISTS (${BACKING[claim.class]})`,
        )
        .bind(
          claim.organization_id,
          claim.domain,
          claim.class,
          claim.claim_id ?? `unclaimed:${claim.class}`,
          input.now,
        ),
      shard.prepare(BACKING[claim.class]).bind(claim.organization_id, claim.domain),
    ]);
    const backed = (backing?.results.length ?? 0) > 0;
    const changed = await context.directory
      .prepare(
        backed
          ? `UPDATE domain_directory SET state = 'active', expires_at = NULL, updated_at = ?5 WHERE ${DUE_RESERVATION}`
          : `DELETE FROM domain_directory WHERE ${DUE_RESERVATION}`,
      )
      .bind(
        claim.class,
        claim.domain,
        claim.organization_id,
        claim.claim_id,
        ...(backed ? [input.now] : []),
      )
      .run();
    if (changed.meta.changes === 1) {
      if (backed) confirmed += 1;
      else released += 1;
    }
  }
  return { confirmed, released };
}
