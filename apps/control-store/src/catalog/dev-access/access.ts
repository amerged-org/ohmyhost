import { z } from "zod";
import { guard } from "../../guards.js";
import { activeAdministratorSql } from "../identity/membership-barrier-sql.js";
import { runCommand, type Plan } from "../../run-command.js";
import {
  conflict,
  instant,
  publicTimestamp,
  routeOrganization,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";

/** The ticket lifetime of the original: one hour, exactly. */
export const DEV_ACCESS_TICKET_MILLISECONDS = 3_600_000;
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u;
const principal = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const handle = z.string().max(59).regex(HANDLE);
const origin = (value: string, handleValue: string) =>
  [
    `https://dev-${handleValue}.dev.check.omh.st`,
    `https://dev-${handleValue}.check.omh.st`,
  ].includes(value);
const scoped = <Extra extends z.ZodRawShape>(extra: Extra) =>
  z
    .strictObject({ projectId: ulid, environmentId: ulid, handle, origin: z.string(), ...extra })
    .refine(
      (value) => origin((value as { origin: string }).origin, (value as { handle: string }).handle),
      "Dev access scope is invalid",
    );

/**
 * The dev environment of an active project whose owner can still administer it: an active organization, an active
 * admin or owner membership of the principal and an unrevoked owner grant (organization-wide or for exactly this
 * ownership and billing epoch). ?1 organization, ?2 project, ?3 principal.
 */
const AUTHORITY = `FROM projects p
  JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='dev'
  JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.deleted_at IS NULL
  WHERE p.organization_id=?1 AND p.project_id=?2 AND d.handle=p.handle AND d.zone_name='omh.st'
    AND p.owner_state='active' AND p.lifecycle_state='active'
    AND ${activeAdministratorSql("p.organization_id", "?3")}
    AND EXISTS(SELECT 1 FROM local_authorization_grants g
      WHERE g.organization_id=p.organization_id AND g.principal_kind='user' AND g.principal_id=?3
        AND g.role='owner' AND g.revoked_at IS NULL
        AND ((g.project_id IS NULL AND g.environment_id IS NULL AND g.ownership_version IS NULL AND g.billing_epoch_id IS NULL)
          OR (g.project_id=p.project_id AND g.environment_id IS e.environment_id
            AND g.ownership_version=p.ownership_version AND g.billing_epoch_id=p.active_billing_epoch_id)))`;
const SCOPE = `SELECT e.environment_id,p.handle,d.development_domain,e.dev_access_epoch ${AUTHORITY}`;
const FINGERPRINT = `SELECT json_object('e',x.environment_id,'h',x.handle,'d',x.development_domain,'v',x.dev_access_epoch) FROM(${SCOPE}) x`;

interface ScopeRow {
  environment_id: string;
  handle: string;
  development_domain: string;
  dev_access_epoch: number;
}
export type RedeemResult = {
  readonly kind: "share" | "ticket";
  readonly scope: DevAccessScope;
  readonly subjectId: string;
};
export interface DevAccessScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly handle: string;
  readonly origin: string;
  readonly devAccessEpoch: number;
}
const scopeOf = (
  organizationId: string,
  projectId: string,
  row: ScopeRow,
  epoch: number = row.dev_access_epoch,
): DevAccessScope => ({
  organizationId,
  projectId,
  environmentId: row.environment_id,
  handle: row.handle,
  origin: `https://${row.development_domain}`,
  devAccessEpoch: epoch,
});

const issueInput = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    principalId: principal,
    ticketId: ulid,
    tokenSha256: sha256Hex,
    issuedAt: instant,
    expiresAt: instant,
  })
  .refine(
    (value) =>
      Date.parse(value.expiresAt) - Date.parse(value.issuedAt) === DEV_ACCESS_TICKET_MILLISECONDS,
    "Dev access ticket lifetime is invalid",
  );
interface TicketRow {
  environment_id: string;
  handle: string;
  public_origin: string;
  dev_access_epoch: number;
  issued_to_principal_id: string;
  token_sha256: string;
  issued_at: string;
  expires_at: string;
}
const ticketResult = (
  organizationId: string,
  projectId: string,
  ticketId: string,
  row: TicketRow,
) => ({
  ...scopeOf(
    organizationId,
    projectId,
    {
      environment_id: row.environment_id,
      handle: row.handle,
      development_domain: row.public_origin.slice("https://".length),
      dev_access_epoch: row.dev_access_epoch,
    },
    row.dev_access_epoch,
  ),
  ticketId,
  principalId: row.issued_to_principal_id,
  issuedAt: publicTimestamp(row.issued_at),
  expiresAt: publicTimestamp(row.expires_at),
});
const TICKET = `SELECT environment_id,handle,public_origin,dev_access_epoch,issued_to_principal_id,lower(hex(token_sha256)) token_sha256,issued_at,expires_at FROM dev_access_tickets WHERE organization_id=?1 AND ticket_id=?2`;

/**
 * Issues one ticket for the dev environment: bumps the environment's epoch (every earlier session of the environment
 * ends), revokes the principal's open tickets and stores the new digest. Null when the principal cannot administer it.
 */
export async function issueDevAccessTicket(context: CatalogContext, raw: unknown) {
  const input = issueInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    params = [input.organizationId, input.projectId, input.principalId];
  return runCommand(db, {
    name: "devAccess.issueTicket",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["dev_access_tickets"],
    read: async (reader) => ({
      scope: await reader
        .prepare(SCOPE)
        .bind(...params)
        .first<ScopeRow>(),
      fingerprint: await reader
        .prepare(FINGERPRINT)
        .bind(...params)
        .first<Record<string, string>>(),
      stored: await reader
        .prepare(TICKET)
        .bind(input.organizationId, input.ticketId)
        .first<TicketRow>(),
    }),
    decide: ({ scope, fingerprint, stored }) => {
      if (stored !== null) {
        if (
          stored.token_sha256 !== input.tokenSha256 ||
          stored.issued_to_principal_id !== input.principalId
        )
          throw conflict("dev_access_ticket_conflict");
        return {
          replay: ticketResult(input.organizationId, input.projectId, input.ticketId, stored),
        };
      }
      if (scope === null || fingerprint === null) return { replay: null };
      const text = Object.values(fingerprint)[0] as string,
        epoch = scope.dev_access_epoch + 1;
      return {
        statements: [
          guard(db, "precondition_changed", `(${FINGERPRINT}) IS NOT ?4`, [...params, text]),
          db
            .prepare(
              "UPDATE environments SET dev_access_epoch=dev_access_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND name='dev'",
            )
            .bind(input.organizationId, input.projectId),
          db
            .prepare(
              "UPDATE dev_access_tickets SET revoked_at=?4 WHERE organization_id=?1 AND project_id=?2 AND issued_to_principal_id=?3 AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .bind(...params, input.issuedAt),
          db
            .prepare(
              "INSERT INTO dev_access_tickets(ticket_id,organization_id,project_id,environment_id,environment_name,handle,public_origin,dev_access_epoch,issued_to_principal_id,token_sha256,issued_at,expires_at) VALUES(?1,?2,?3,?4,'dev',?5,?6,?7,?8,unhex(?9),?10,?11)",
            )
            .bind(
              input.ticketId,
              input.organizationId,
              input.projectId,
              scope.environment_id,
              scope.handle,
              `https://${scope.development_domain}`,
              epoch,
              input.principalId,
              input.tokenSha256,
              input.issuedAt,
              input.expiresAt,
            ),
        ],
        result: () => ({
          ...scopeOf(input.organizationId, input.projectId, scope, epoch),
          ticketId: input.ticketId,
          principalId: input.principalId,
          issuedAt: publicTimestamp(input.issuedAt),
          expiresAt: publicTimestamp(input.expiresAt),
        }),
      };
    },
    lookup: async (reader) => {
      const stored = await reader
        .prepare(TICKET)
        .bind(input.organizationId, input.ticketId)
        .first<TicketRow>();
      return stored === null ||
        stored.token_sha256 !== input.tokenSha256 ||
        stored.issued_to_principal_id !== input.principalId
        ? undefined
        : ticketResult(input.organizationId, input.projectId, input.ticketId, stored);
    },
  });
}

const redeemInput = scoped({
  shareTokenSha256: sha256Hex,
  ticketTokenSha256: sha256Hex,
  consumedAt: instant,
});
/** The open ticket of a dev scope that is still redeemable today; ?1 project ?2 environment ?3 handle ?4 origin ?5 digest ?6 now. */
const OPEN_TICKET = `FROM dev_access_tickets t
  JOIN projects p ON p.organization_id=t.organization_id AND p.project_id=t.project_id AND p.owner_state='active'
  JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='dev'
  JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.deleted_at IS NULL
  WHERE t.project_id=?1 AND t.environment_id=?2 AND t.handle=?3 AND t.public_origin=?4 AND t.token_sha256=unhex(?5)
    AND t.environment_name='dev' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>?6
    AND p.handle=t.handle AND d.handle=t.handle AND d.zone_name='omh.st' AND t.public_origin='https://'||d.development_domain
    AND p.lifecycle_state='active' AND e.environment_id=t.environment_id AND t.dev_access_epoch=e.dev_access_epoch
    AND ${activeAdministratorSql("t.organization_id", "t.issued_to_principal_id")}
    AND EXISTS(SELECT 1 FROM local_authorization_grants g
      WHERE g.organization_id=t.organization_id AND g.principal_kind='user' AND g.principal_id=t.issued_to_principal_id
        AND g.role='owner' AND g.revoked_at IS NULL
        AND ((g.project_id IS NULL AND g.environment_id IS NULL AND g.ownership_version IS NULL AND g.billing_epoch_id IS NULL)
          OR (g.project_id=t.project_id AND g.environment_id IS t.environment_id
            AND g.ownership_version=p.ownership_version AND g.billing_epoch_id=p.active_billing_epoch_id)))`;
const SHARE = `SELECT p.organization_id,l.generation FROM dev_share_links l
  JOIN projects p ON p.project_id=l.project_id AND p.organization_id=l.organization_id AND p.owner_state='active'
  JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='dev'
  JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.deleted_at IS NULL
  WHERE l.project_id=?1 AND l.environment_id=?2 AND l.token_sha256=unhex(?5) AND l.revoked_at IS NULL
    AND p.dev_access_mode='protected' AND p.lifecycle_state='active' AND p.handle=?3 AND d.handle=?3
    AND d.zone_name='omh.st' AND ?4='https://'||d.development_domain AND e.environment_id=l.environment_id`;

/**
 * Redeems what the Dev origin presented: a share link (never consumed, valid while it is the current generation) or else
 * a single-use ticket, consumed here. Null when neither is valid. Both digests are of the one presented token.
 */
export async function redeemDevAccess(context: CatalogContext, raw: unknown) {
  const input = redeemInput.parse(raw),
    { db: shard } = await context.router.routeShard(0),
    owner = await shard
      .prepare("SELECT organization_id FROM projects WHERE project_id=?1 AND owner_state='active'")
      .bind(input.projectId)
      .first<{ organization_id: string }>();
  if (owner === null) return null;
  const { db } = await routeOrganization(context, owner.organization_id),
    shared = [
      input.projectId,
      input.environmentId,
      input.handle,
      input.origin,
      input.shareTokenSha256,
    ],
    open = [
      input.projectId,
      input.environmentId,
      input.handle,
      input.origin,
      input.ticketTokenSha256,
      input.consumedAt,
    ],
    ticketRow = `SELECT t.ticket_id,t.organization_id,t.dev_access_epoch,t.issued_to_principal_id ${OPEN_TICKET}`;
  return runCommand(db, {
    name: "devAccess.redeem",
    input,
    retryOn: ["precondition_changed"],
    read: async (reader) => ({
      share: await reader
        .prepare(SHARE)
        .bind(...shared)
        .first<{ organization_id: string; generation: number }>(),
      ticket: await reader
        .prepare(ticketRow)
        .bind(...open)
        .first<{
          ticket_id: string;
          organization_id: string;
          dev_access_epoch: number;
          issued_to_principal_id: string;
        }>(),
    }),
    decide: ({ share, ticket }): Plan<RedeemResult | null> => {
      const scope = (organizationId: string, devAccessEpoch: number): DevAccessScope => ({
        organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        handle: input.handle,
        origin: input.origin,
        devAccessEpoch,
      });
      if (share !== null)
        return {
          replay: {
            kind: "share" as const,
            scope: scope(share.organization_id, share.generation),
            subjectId: `share:${input.projectId}`,
          },
        };
      if (ticket === null) return { replay: null };
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS(SELECT 1 ${OPEN_TICKET})`, open),
          db
            .prepare(
              "UPDATE dev_access_tickets SET consumed_at=?3 WHERE organization_id=?1 AND ticket_id=?2 AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .bind(ticket.organization_id, ticket.ticket_id, input.consumedAt),
        ],
        result: () => ({
          kind: "ticket" as const,
          scope: scope(ticket.organization_id, ticket.dev_access_epoch),
          subjectId: ticket.issued_to_principal_id,
        }),
      };
    },
  });
}

const pageInput = scoped({
  shareSession: z.boolean(),
  epoch: z.number().int().min(1).nullable(),
});
const PAGE_AUTHORIZATION_SQL = `SELECT EXISTS(SELECT 1 FROM projects p
          JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='dev'
          JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.deleted_at IS NULL
          WHERE p.project_id=?1 AND p.owner_state='active' AND e.environment_id=?2 AND p.handle=?3 AND p.lifecycle_state='active'
            AND d.handle=?3 AND d.zone_name='omh.st' AND ?4='https://'||d.development_domain
            AND (p.dev_access_mode='public' OR (p.dev_access_mode='protected' AND ?5=1
              AND EXISTS(SELECT 1 FROM dev_share_links l WHERE l.project_id=p.project_id AND l.organization_id=p.organization_id
                AND l.environment_id=e.environment_id AND l.revoked_at IS NULL AND l.generation=?6)))) authorized`;
/** Whether the public Dev page may be served now: public mode, or protected with a share session of the live generation. */
export async function authorizeDevPage(context: CatalogContext, raw: unknown) {
  const input = pageInput.parse(raw),
    { db: shard } = await context.router.routeShard(0),
    row = await shard
      .prepare(PAGE_AUTHORIZATION_SQL)
      .bind(
        input.projectId,
        input.environmentId,
        input.handle,
        input.origin,
        input.shareSession ? 1 : 0,
        input.epoch,
      )
      .first<{ authorized: number }>();
  return row?.authorized === 1;
}

const sessionInput = scoped({ devAccessEpoch: z.number().int().min(1), principalId: principal });
/** Whether a signed-in principal's session still reaches the dev environment (same epoch, same administrator rights). */
export async function authorizeDevAccessSession(context: CatalogContext, raw: unknown) {
  const input = sessionInput.parse(raw),
    { db: shard } = await context.router.routeShard(0),
    owner = await shard
      .prepare("SELECT organization_id FROM projects WHERE project_id=?1 AND owner_state='active'")
      .bind(input.projectId)
      .first<{ organization_id: string }>();
  if (owner === null) return false;
  const { db } = await routeOrganization(context, owner.organization_id),
    row = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 ${AUTHORITY} AND e.environment_id=?4 AND p.handle=?5 AND ?6='https://'||d.development_domain AND e.dev_access_epoch=?7) authorized`,
      )
      .bind(
        owner.organization_id,
        input.projectId,
        input.principalId,
        input.environmentId,
        input.handle,
        input.origin,
        input.devAccessEpoch,
      )
      .first<{ authorized: number }>();
  return row?.authorized === 1;
}

/** One fenced snapshot of the existing public/share OR verified-user predicates. */
export async function authorizeDevCombined(context: CatalogContext, raw: unknown) {
  const input = scoped({
    organizationHint: ulid.optional(),
    shareSession: z.boolean(),
    epoch: z.number().int().min(1).nullable(),
    principalId: principal.nullable(),
    devAccessEpoch: z.number().int().min(1).nullable(),
  })
    .refine(
      (v) =>
        (v.principalId === null) === (v.devAccessEpoch === null) &&
        !(v.shareSession && v.principalId !== null),
    )
    .parse(raw);
  const ownerSql =
    "SELECT organization_id FROM projects WHERE project_id=?1 AND owner_state='active'";
  let hint = input.organizationHint;
  if (hint === undefined) {
    const { db: shard } = await context.router.routeShard(0);
    const owners = (
      await shard.prepare(ownerSql).bind(input.projectId).all<{ organization_id: string }>()
    ).results;
    if (owners.length === 0) return false;
    if (owners.length !== 1 || !owners[0]) throw new Error("dev_access_unavailable");
    hint = ulid.parse(owners[0].organization_id);
  }
  const { db } = await routeOrganization(context, hint);
  const results = await db.batch([
    db.prepare(ownerSql).bind(input.projectId),
    db
      .prepare(PAGE_AUTHORIZATION_SQL)
      .bind(
        input.projectId,
        input.environmentId,
        input.handle,
        input.origin,
        input.shareSession ? 1 : 0,
        input.epoch,
      ),
    db
      .prepare(
        `SELECT EXISTS(SELECT 1 ${AUTHORITY} AND e.environment_id=?4 AND p.handle=?5 AND ?6='https://'||d.development_domain AND e.dev_access_epoch=?7) authorized`,
      )
      .bind(
        hint,
        input.projectId,
        input.principalId,
        input.environmentId,
        input.handle,
        input.origin,
        input.devAccessEpoch,
      ),
  ]);
  if (results.length !== 3 || results.some((r) => !r.success))
    throw new Error("dev_access_unavailable");
  const [owners, page, session] = results;
  if (!owners || !page || !session || owners.results.length > 1)
    throw new Error("dev_access_unavailable");
  if (owners.results.length === 0) return false;
  if (owners.results[0]?.["organization_id"] !== hint) throw new Error("dev_access_unavailable");
  if (
    page.results.length !== 1 ||
    session.results.length !== 1 ||
    ![0, 1].includes(page.results[0]?.["authorized"] as number) ||
    ![0, 1].includes(session.results[0]?.["authorized"] as number)
  )
    throw new Error("dev_access_unavailable");
  return page.results[0]?.["authorized"] === 1 || session.results[0]?.["authorized"] === 1;
}

const probeInput = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    deploymentId: ulid,
    handle,
    origin: z.string(),
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\/(?!\/)[^?#]*$/u)
      .refine((value) => !value.split("/").some((segment) => segment === "." || segment === "..")),
    method: z.enum(["GET", "HEAD"]),
  })
  .refine((value) => origin(value.origin, value.handle), "Dev runtime probe scope is invalid");

/**
 * Whether the platform may probe this dev origin's health path now: a running dev deployment of an open operation that
 * holds the project's provider-mutation claim, with an uncleaned candidate and exactly the planned health-check path.
 */
export async function authorizeDevRuntimeProbe(context: CatalogContext, raw: unknown) {
  const input = probeInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM product_command_intents intent
          JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
          JOIN projects project ON project.organization_id=intent.organization_id AND project.project_id=intent.project_id AND project.owner_state='active'
          JOIN environments environment ON environment.organization_id=intent.organization_id AND environment.project_id=intent.project_id
            AND environment.environment_id=intent.environment_id AND environment.name='dev'
          JOIN deployments deployment ON deployment.organization_id=intent.organization_id AND deployment.project_id=intent.project_id AND deployment.deployment_id=intent.deployment_id
          LEFT JOIN deployment_revisions rollback_revision ON intent.event_type='DeploymentRollbackRequestedV1'
            AND rollback_revision.organization_id=intent.organization_id AND rollback_revision.project_id=intent.project_id
            AND rollback_revision.deployment_id=intent.target_deployment_id AND rollback_revision.revision_id=intent.target_revision_id
            AND rollback_revision.artifact_id=intent.target_artifact_id
          LEFT JOIN wfp_publish_receipts rollback_published ON intent.event_type='DeploymentRollbackRequestedV1'
            AND rollback_published.organization_id=rollback_revision.organization_id AND rollback_published.project_id=rollback_revision.project_id
            AND rollback_published.wfp_receipt_id=rollback_revision.wfp_receipt_id
          JOIN deployment_plans plan ON plan.organization_id=intent.organization_id AND plan.project_id=intent.project_id
            AND plan.plan_id=CASE intent.event_type WHEN 'DeploymentRequestedV1' THEN intent.plan_id WHEN 'DeploymentRollbackRequestedV1' THEN rollback_revision.plan_id END
          JOIN product_provider_mutation_claims claim ON claim.organization_id=intent.organization_id AND claim.project_id=intent.project_id
            AND claim.environment_id=intent.environment_id AND claim.operation_id=intent.operation_id AND claim.event_type=intent.event_type
          JOIN wfp_candidate_receipts candidate ON candidate.organization_id=intent.organization_id AND candidate.project_id=intent.project_id
            AND candidate.environment_id=intent.environment_id
            AND ((intent.event_type='DeploymentRollbackRequestedV1' AND candidate.candidate_receipt_id=rollback_published.candidate_receipt_id)
              OR (intent.event_type='DeploymentRequestedV1' AND candidate.operation_id=intent.operation_id AND candidate.product_deployment_id=intent.deployment_id))
          LEFT JOIN wfp_candidate_cleanup_receipts cleanup ON cleanup.candidate_receipt_id=candidate.candidate_receipt_id
          JOIN cloudflare_project_domains domain ON domain.organization_id=intent.organization_id AND domain.project_id=intent.project_id AND domain.deleted_at IS NULL
          WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?4
            AND ?5=CASE intent.event_type WHEN 'DeploymentRollbackRequestedV1' THEN intent.target_deployment_id ELSE intent.deployment_id END
            AND intent.event_type IN('DeploymentRequestedV1','DeploymentRollbackRequestedV1')
            AND operation.state IN('queued','running') AND project.lifecycle_state='active'
            AND deployment.status IN('running','reconciliation_required')
            AND json_extract(plan.framework_plan,'$.runtimePolicy.healthCheckPath')=?6
            AND project.handle=?7 AND domain.handle=?7 AND domain.zone_name='omh.st'
            AND ?8='https://'||domain.development_domain AND cleanup.candidate_receipt_id IS NULL) authorized`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.operationId,
        input.deploymentId,
        input.path,
        input.handle,
        input.origin,
      )
      .first<{ authorized: number }>();
  return row?.authorized === 1;
}
