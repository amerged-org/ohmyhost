import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { handoffAuthorityInput, handoffEffectGuards } from "../identity/handoff-effect.js";
import {
  originatingCredential,
  originatingCredentialGuards,
  sameOriginatingCredential,
} from "./origin-credential.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";
import { routeOrganization, sha256Hex, ulid, type CatalogContext } from "../common.js";
const principal = z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u);
const registration = z.string().regex(/^[a-z0-9-]{1,64}$/u);
const create = z
  .strictObject({
    handoffHash: sha256Hex,
    organizationId: ulid,
    projectId: ulid.optional(),
    environmentId: ulid.optional(),
    principalId: principal,
    registration,
    credentialId: z.string().min(1).max(2048),
    idempotencyKeyHash: sha256Hex,
    requestDigest: sha256Hex,
    originatingCredential: originatingCredential.optional(),
    originatingDelegation: handoffAuthorityInput.optional(),
  })
  .refine(
    (i) =>
      (i.originatingCredential === undefined) !== (i.originatingDelegation === undefined) &&
      (i.projectId === undefined) === (i.environmentId === undefined),
  );
type Input = z.output<typeof create>;
type Row = {
  handoff_hash: string;
  organization_id: string;
  project_id: string | null;
  environment_id: string | null;
  principal_id: string;
  registration: string;
  credential_id: string;
  idempotency_key_hash: string;
  request_digest: string;
  originating_credential: string | null;
  originating_delegation: string | null;
  ownership_version: number | null;
  billing_epoch_id: string | null;
  expires_at: string;
  consumed_at: string | null;
};
const now = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
const expiry = "(strftime('%Y-%m-%dT%H:%M:%f','now','+10 minutes')||'000Z')";
function authorization(
  i: Pick<Input, "organizationId" | "projectId" | "environmentId" | "principalId">,
) {
  const a = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    principalId: i.principalId,
    action: "integrations:manage",
  });
  return {
    sql: a.sql.replaceAll("?3", "NULL").replaceAll("?4", "NULL"),
    params: [
      i.organizationId,
      i.principalId,
      i.projectId ?? null,
      i.environmentId ?? null,
      null,
      "integrations:manage",
    ],
  };
}
const currentProject = `EXISTS(SELECT 1 FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.environment_id=?4 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL WHERE p.organization_id=?1 AND p.project_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active'`;
const userCurrent =
  "NOT EXISTS(SELECT 1 FROM revocations WHERE kind='user' AND resource_id=substr(?2,6))";
function originGuards(
  db: D1Database,
  i: Pick<Input, "organizationId" | "principalId" | "credentialId">,
  c: unknown,
  d: unknown,
) {
  if (d != null) {
    const proof = handoffAuthorityInput.parse(d);
    if (proof.clientId !== i.credentialId) return [guard(db, "consent_changed", "1")];
    return handoffEffectGuards(db, {
      organizationId: i.organizationId,
      principalId: i.principalId,
      action: "integrations:manage",
      authority: proof,
    });
  }
  return originatingCredentialGuards(db, i, c);
}
function identity(row: Row) {
  return {
    organizationId: row.organization_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
    principalId: row.principal_id,
    credentialId: row.credential_id,
  };
}
function parsedOrigin(row: Row) {
  return {
    credential:
      row.originating_credential === null
        ? undefined
        : originatingCredential.parse(JSON.parse(row.originating_credential)),
    delegation:
      row.originating_delegation === null
        ? undefined
        : handoffAuthorityInput.parse(JSON.parse(row.originating_delegation)),
  };
}
function response(row: Row) {
  const origin = parsedOrigin(row);
  return {
    userId: row.principal_id.slice(5),
    organizationId: row.organization_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
    registration: row.registration,
    expiresAt: row.expires_at,
    ...(origin.credential ? { originatingCredential: origin.credential } : {}),
    ...(origin.delegation ? { originatingDelegation: origin.delegation } : {}),
  };
}
async function byHash(context: CatalogContext, hash: string): Promise<Row | null> {
  const db = (await context.router.routeShard(0)).db;
  return db
    .prepare(
      "SELECT * FROM integration_portal_handoffs WHERE handoff_hash=?1 UNION ALL SELECT * FROM workspace_integration_portal_handoffs WHERE handoff_hash=?1",
    )
    .bind(hash)
    .first<Row>();
}
export async function createIntegrationPortalHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "replay" | "conflict"> {
  const i = create.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    a = authorization(i),
    workspace = i.projectId === undefined,
    table = workspace ? "workspace_integration_portal_handoffs" : "integration_portal_handoffs",
    projectGuard = workspace ? "1" : `${currentProject})`;
  const c = i.originatingCredential ? JSON.stringify(i.originatingCredential) : null,
    d = i.originatingDelegation ? JSON.stringify(i.originatingDelegation) : null;
  const results = await db.batch([
    ...originGuards(db, i, i.originatingCredential, i.originatingDelegation),
    guard(db, "consent_changed", `NOT (${a.sql} AND ${userCurrent} AND ${projectGuard})`, a.params),
    db
      .prepare(
        `INSERT INTO ${table}(handoff_hash,organization_id,project_id,environment_id,principal_id,registration,credential_id,idempotency_key_hash,request_digest,originating_credential,originating_delegation,ownership_version,billing_epoch_id,created_at,expires_at) SELECT ?7,?1,?3,?4,?2,?8,?9,?10,?11,?12,?13,${workspace ? "NULL,NULL" : "p.ownership_version,p.active_billing_epoch_id"},${now},${expiry} ${workspace ? "" : "FROM projects p WHERE p.organization_id=?1 AND p.project_id=?3 AND"} ${workspace ? "WHERE" : ""} ${a.sql} AND ${userCurrent} AND ${projectGuard} ON CONFLICT DO NOTHING`,
      )
      .bind(
        ...a.params,
        i.handoffHash,
        i.registration,
        i.credentialId,
        i.idempotencyKeyHash,
        i.requestDigest,
        c,
        d,
      ),
  ]);
  if (results.at(-1)?.meta.changes === 1) return "created";
  const replay = await db.batch([
    ...originGuards(db, i, i.originatingCredential, i.originatingDelegation),
    db
      .prepare(
        `SELECT * FROM ${table} WHERE organization_id=?1 AND principal_id=?2 AND credential_id=?7 AND idempotency_key_hash=?8 AND ${a.sql} AND ${userCurrent} AND ${workspace ? "1" : `${currentProject} AND p.ownership_version=${table}.ownership_version AND p.active_billing_epoch_id=${table}.billing_epoch_id)`}`,
      )
      .bind(...a.params, i.credentialId, i.idempotencyKeyHash),
  ]);
  const row = replay.at(-1)?.results[0] as Row | undefined;
  return row &&
    row.handoff_hash === i.handoffHash &&
    row.request_digest === i.requestDigest &&
    row.project_id === (i.projectId ?? null) &&
    row.environment_id === (i.environmentId ?? null) &&
    row.registration === i.registration &&
    sameOriginatingCredential(parsedOrigin(row).credential, i.originatingCredential) &&
    row.originating_delegation === d
    ? "replay"
    : "conflict";
}
const lookup = z.strictObject({ handoffHash: sha256Hex, principalId: principal });
async function get(context: CatalogContext, raw: unknown, mode: "read" | "consume" | "status") {
  const input =
      mode === "status"
        ? lookup.extend({ credentialId: z.string().min(1).max(2048) }).parse(raw)
        : lookup.parse(raw),
    row = await byHash(context, input.handoffHash);
  if (
    !row ||
    row.principal_id !== input.principalId ||
    ("credentialId" in input && input.credentialId !== row.credential_id)
  )
    return null;
  const i = identity(row),
    origin = parsedOrigin(row),
    { db } = await routeOrganization(context, i.organizationId),
    a = authorization(i),
    table =
      row.project_id === null
        ? "workspace_integration_portal_handoffs"
        : "integration_portal_handoffs";
  const predicate = `handoff_hash=?7 AND principal_id=?2 AND ${a.sql} AND ${userCurrent} AND ${row.project_id === null ? "1" : `${currentProject} AND p.ownership_version=${table}.ownership_version AND p.active_billing_epoch_id=${table}.billing_epoch_id)`}`;
  const statement =
    mode === "consume"
      ? db
          .prepare(
            `UPDATE ${table} SET consumed_at=${now} WHERE ${predicate} AND consumed_at IS NULL AND expires_at>${now} RETURNING *`,
          )
          .bind(...a.params, input.handoffHash)
      : db
          .prepare(
            `SELECT *, (expires_at<=${now}) AS is_expired FROM ${table} WHERE ${predicate} ${mode === "read" ? `AND consumed_at IS NULL AND expires_at>${now}` : ""}`,
          )
          .bind(...a.params, input.handoffHash);
  const results = await db.batch([
    ...originGuards(db, i, origin.credential, origin.delegation),
    statement,
  ]);
  const found = results.at(-1)?.results[0] as (Row & { is_expired?: number }) | undefined;
  if (!found) return null;
  return mode === "status"
    ? {
        ...response(found),
        state:
          found.consumed_at !== null ? "consumed" : found.is_expired === 1 ? "expired" : "pending",
      }
    : response(found);
}
export const readIntegrationPortalHandoff = (context: CatalogContext, raw: unknown) =>
  get(context, raw, "read");
export const consumeIntegrationPortalHandoff = (context: CatalogContext, raw: unknown) =>
  get(context, raw, "consume");
export const readIntegrationPortalStatus = (context: CatalogContext, raw: unknown) =>
  get(context, raw, "status");
