import { nativeAuthLaunchAllowed, nativeAuthSocialAllowed } from "./native-auth-launch-policy.js";
import { z } from "zod";
import {
  isNativeAuthRedirectPath,
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { addMilliseconds, ulid, type CatalogContext } from "../common.js";
import { readRuntimeDecision } from "../credit/index.js";
import { runtimeDecisionStatements, runtimeDecisionFromResults } from "../credit/decision.js";
import { CREDIT_GRACE_MS, type AccountRow } from "../credit/account.js";
import {
  nativeRegistrationFromRow,
  nativeRegistrationStatement,
} from "./native-auth-registration.js";
import { readSnapshot } from "../platform-support.js";
import { originsSql } from "./native-auth-config.js";
import type { D1Database } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";

const scope = z.strictObject({
  projectId: ulid,
  environmentId: ulid,
  deploymentId: ulid.optional(),
});
const rowSchema = z.strictObject({
  enabled: z.number().int().min(0).max(1),
  configuration_revision: z.number().int().positive().max(2_147_483_647),
  revocation_epoch: z.number().int().positive().max(2_147_483_647),
  canonical_origin: z.string().nullable(),
  app_name: z.string().min(1).max(128),
  allowed_redirect_paths: z.string(),
  reset_password_path: z.string().refine(isNativeAuthRedirectPath),
  signup_policy: z.enum(["open", "invite-only"]),
  invitation_path: z.string().refine(isNativeAuthRedirectPath),
  source_capable: z.number().int().min(0).max(1),
  head_version: z.number().int().nonnegative(),
  active_deployment_id: ulid.nullable(),
  region: z.enum(["us", "eu"]),
  storage_ready: z.number().int().min(0).max(1),
});
const currentSql = `SELECT r.enabled,r.configuration_revision,r.revocation_epoch,r.canonical_origin,r.app_name,r.signup_policy,
 r.allowed_redirect_paths,r.reset_password_path,r.invitation_path,e.head_version,e.active_deployment_id,p.region,
 EXISTS(SELECT 1 FROM deployment_revisions revision JOIN deployment_plans plan
   ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
   WHERE revision.organization_id=e.organization_id AND revision.project_id=e.project_id
     AND revision.deployment_id=e.active_deployment_id AND revision.revision_id=e.active_revision_id
     AND json_extract(plan.framework_plan,'$.auth.provider')='omh-native') AS source_capable,
 EXISTS(SELECT 1 FROM native_auth_registrations reg
   JOIN native_auth_database_targets target ON target.organization_id=reg.organization_id AND target.project_id=reg.project_id AND target.target_version=reg.target_version
     AND target.provider_project_id=reg.provider_project_id AND target.database_id=reg.database_id AND target.region_id=reg.region_id AND target.ended_at IS NULL
   JOIN native_auth_preparation_receipts proof ON proof.organization_id=reg.organization_id AND proof.project_id=reg.project_id AND proof.environment_id=reg.environment_id
     AND proof.operation_id=reg.operation_id AND proof.claim_id=reg.claim_id AND proof.provider_project_id=reg.provider_project_id AND proof.database_id=reg.database_id
     AND proof.target_version=reg.target_version AND proof.schema_name=reg.schema_name AND proof.runtime_role=reg.role_name
   WHERE reg.organization_id=r.organization_id AND reg.project_id=r.project_id AND reg.environment_id=r.environment_id AND reg.state='active'
     AND proof.migrator_role='omh_am_'||lower(reg.environment_id) AND proof.backup_role='omh_ab_'||lower(reg.project_id)
     AND proof.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND proof.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}'
     AND (NOT EXISTS(SELECT 1 FROM native_auth_restores restore WHERE restore.organization_id=reg.organization_id AND restore.project_id=reg.project_id)
       OR EXISTS(SELECT 1 FROM native_auth_restores restore JOIN native_auth_restore_realms restored
           ON restored.organization_id=restore.organization_id AND restored.project_id=restore.project_id AND restored.restore_id=restore.restore_id AND restored.environment_id=reg.environment_id
         JOIN native_auth_restore_verifications verified ON verified.organization_id=restored.organization_id AND verified.project_id=restored.project_id AND verified.restore_id=restored.restore_id AND verified.environment_id=restored.environment_id
         WHERE restore.organization_id=reg.organization_id AND restore.project_id=reg.project_id AND restore.database_id=reg.database_id AND restore.state='complete'
           AND restore.restore_generation=(SELECT max(latest.restore_generation) FROM native_auth_restores latest WHERE latest.organization_id=restore.organization_id AND latest.project_id=restore.project_id)
           AND verified.target_version=reg.target_version AND verified.registry_version=reg.registry_version AND verified.schema_name=reg.schema_name AND verified.runtime_role=reg.role_name
           AND verified.migrator_role='omh_am_'||lower(reg.environment_id) AND verified.backup_role='omh_ab_'||lower(reg.project_id)
           AND verified.migration_version=${NATIVE_AUTH_SCHEMA_MIGRATION_VERSION} AND verified.migration_digest='${NATIVE_AUTH_SCHEMA_MIGRATION_SHA256}'))) AS storage_ready
 FROM native_auth_realms r JOIN projects p USING(organization_id,project_id)
 JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
 JOIN environments e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.environment_id=r.environment_id
 JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
 WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active'`;

async function snapshot(
  db: D1Database,
  organizationId: string,
  projectId: string,
  environmentId: string,
) {
  const values = [organizationId, projectId, environmentId];
  const [rows, origins] = await readSnapshot(db, [
    [currentSql, ...values],
    [originsSql, ...values],
  ]);
  return parseSnapshot(rows, origins);
}

function parseSnapshot(
  rows: Record<string, unknown>[] | undefined,
  origins: Record<string, unknown>[] | undefined,
) {
  if (rows?.length !== 1 || origins?.length !== 1) return null;
  const row = rowSchema.parse(rows[0]),
    approved = JSON.parse(String(origins[0]?.["origins"])) as (string | null)[];
  const paths = z
    .array(z.string().refine(isNativeAuthRedirectPath))
    .min(1)
    .max(32)
    .parse(JSON.parse(row.allowed_redirect_paths));
  if (!paths.includes(row.reset_password_path) || !paths.includes(row.invitation_path)) return null;
  const origin =
    row.canonical_origin !== null && approved.includes(row.canonical_origin)
      ? row.canonical_origin
      : null;
  return { row, paths, origin, fingerprint: JSON.stringify([row, approved]) };
}

async function resolve(context: CatalogContext, i: z.output<typeof scope>) {
  const db = context.directory;
  const owners = (
    await db
      .prepare(
        `SELECT p.organization_id FROM projects p JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
    JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id
    WHERE p.project_id=?1 AND e.environment_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`,
      )
      .bind(i.projectId, i.environmentId)
      .all<{ organization_id: string }>()
  ).results;
  if (owners.length !== 1 || owners[0] === undefined) throw new Error("auth_unavailable");
  const organizationId = owners[0].organization_id;
  await context.router.routeOrganization(organizationId);
  const before = await snapshot(db, organizationId, i.projectId, i.environmentId);
  if (before === null) throw new Error("auth_unavailable");
  const billing = await readRuntimeDecision(db, {
    organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    now: new Date().toISOString(),
  });
  const after = await snapshot(db, organizationId, i.projectId, i.environmentId);
  if (after === null || before.fingerprint !== after.fingerprint)
    throw new Error("auth_unavailable");
  return buildAuthority(i, organizationId, after, billing);
}

function buildAuthority(
  i: z.output<typeof scope>,
  organizationId: string,
  after: NonNullable<ReturnType<typeof parseSnapshot>>,
  billing: Awaited<ReturnType<typeof readRuntimeDecision>>,
) {
  const row = after.row;
  if (i.deploymentId !== undefined && i.deploymentId !== row.active_deployment_id)
    throw new Error("auth_unavailable");
  return {
    organizationId,
    region: row.region,
    deploymentId: row.active_deployment_id,
    realm: {
      projectId: i.projectId,
      environmentId: i.environmentId,
      canonicalOrigin: after.origin,
      realmGeneration: row.revocation_epoch,
      configurationRevision: row.configuration_revision,
    },
    revocationEpoch: row.revocation_epoch,
    enabled: row.enabled === 1 && after.origin !== null,
    ownerEnabled: row.enabled === 1,
    sourceCapable: row.source_capable === 1,
    paidAllowed: billing.paidAllowed,
    runtimeAllowed: billing.allowed && row.storage_ready === 1,
    storageReady: row.storage_ready === 1,
    applicationName: row.app_name,
    signupPolicy: row.signup_policy,
    allowedRedirectPaths: after.paths,
    resetPasswordPath: row.reset_password_path,
    invitationPath: row.invitation_path,
  };
}

/** Session authority requires an approved current origin. */
export async function resolveNativeAuthAuthority(context: CatalogContext, raw: unknown) {
  const result = await resolve(context, scope.parse(raw));
  if (result.realm.canonicalOrigin === null) throw new Error("auth_unavailable");
  const allowed = nativeAuthLaunchAllowed(context, result.organizationId, result.realm.projectId);
  return {
    ...result,
    enabled: result.enabled && allowed,
    sourceCapable: result.sourceCapable && allowed,
    runtimeAllowed: result.runtimeAllowed && allowed,
    realm: { ...result.realm, canonicalOrigin: result.realm.canonicalOrigin },
  };
}

// Worker Date and performance clocks share a time domain; this margin is only a
// conservative millisecond-representation fence, not a cross-host skew claim.
const SNAPSHOT_MARGIN_US = 1000n;
function exactUtcMicroseconds(value: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value))
    throw new Error("auth_unavailable");
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    new Date(milliseconds).toISOString() !== `${value.slice(0, 23)}Z`
  )
    throw new Error("auth_unavailable");
  return BigInt(milliseconds) * 1000n + BigInt(value.slice(23, 26));
}
function snapshotClock(): number {
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 1) throw new Error("auth_unavailable");
  return now;
}
function assertStableTime(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  account: AccountRow | undefined,
): void {
  if (t0 > t1 || t1 > t2 || t2 > t3) throw new Error("auth_unavailable");
  const low = BigInt(t0) * 1000n - SNAPSHOT_MARGIN_US;
  const high = BigInt(t3) * 1000n + SNAPSHOT_MARGIN_US;
  const d = new Date(t0);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  if (!Number.isSafeInteger(nextMonth)) throw new Error("auth_unavailable");
  const month = BigInt(nextMonth) * 1000n;
  const thisMonth = BigInt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)) * 1000n;
  const boundaries: string[] = [];
  if (account) {
    boundaries.push(account.monthly_ends_at);
    if (account.paid_until !== null) boundaries.push(account.paid_until);
    if (account.exhausted_at !== null) {
      exactUtcMicroseconds(account.exhausted_at);
      boundaries.push(addMilliseconds(account.exhausted_at, CREDIT_GRACE_MS));
    }
  }
  if (
    (month >= low && month <= high) ||
    (thisMonth >= low && thisMonth <= high) ||
    boundaries.some((value) => {
      const bound = exactUtcMicroseconds(value);
      return bound >= low && bound <= high;
    })
  )
    throw new Error("auth_unavailable");
}

/** Fresh, deployment-bound authority and registration from one routed, fenced transaction. */
export async function resolveNativeAuthAtomicSnapshot(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ deploymentId: ulid, organizationHint: ulid.optional() }).parse(raw);
  const ownerSql = `SELECT p.organization_id FROM projects p JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
    JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id
    WHERE p.project_id=?1 AND e.environment_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`;
  const t0 = snapshotClock();
  let organizationId = i.organizationHint;
  if (organizationId === undefined) {
    const owners = (
      await context.directory
        .prepare(ownerSql)
        .bind(i.projectId, i.environmentId)
        .all<{ organization_id: string }>()
    ).results;
    if (owners.length !== 1 || !owners[0]) throw new Error("auth_unavailable");
    organizationId = ulid.parse(owners[0].organization_id);
  }
  const t1 = snapshotClock();
  const { db } = await context.router.routeOrganization(organizationId);
  const t2 = snapshotClock();
  const values = [organizationId, i.projectId, i.environmentId];
  const creditInput = {
    organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    now: new Date(t0).toISOString(),
  };
  const results = await db.batch([
    db.prepare(ownerSql).bind(i.projectId, i.environmentId),
    db.prepare(currentSql).bind(...values),
    db.prepare(originsSql).bind(...values),
    ...runtimeDecisionStatements(db, creditInput),
    db.prepare(currentSql).bind(...values),
    db.prepare(originsSql).bind(...values),
    nativeRegistrationStatement(db, i.projectId, i.environmentId),
    nativeRegistrationStatement(db, i.projectId, i.environmentId),
  ]);
  const t3 = snapshotClock();
  if (results.length !== 10 || results.some((r) => !r.success)) throw new Error("auth_unavailable");
  const [
    owner,
    first,
    firstOrigins,
    creditScope,
    creditAccount,
    creditProject,
    second,
    secondOrigins,
    registration,
    registrationAfter,
  ] = results;
  if (
    !owner ||
    !first ||
    !firstOrigins ||
    !creditScope ||
    !creditAccount ||
    !creditProject ||
    !second ||
    !secondOrigins ||
    !registration ||
    !registrationAfter ||
    owner.results.length !== 1 ||
    owner.results[0]?.["organization_id"] !== organizationId
  )
    throw new Error("auth_unavailable");
  const before = parseSnapshot(first.results, firstOrigins.results);
  const after = parseSnapshot(second.results, secondOrigins.results);
  if (
    !before ||
    !after ||
    before.fingerprint !== after.fingerprint ||
    registration.results.length !== 1 ||
    registrationAfter.results.length !== 1 ||
    JSON.stringify(registration.results[0]) !== JSON.stringify(registrationAfter.results[0]) ||
    !registration.results[0]
  )
    throw new Error("auth_unavailable");
  const receipt = nativeRegistrationFromRow(registration.results[0]);
  if (
    receipt.organizationId !== organizationId ||
    receipt.projectId !== i.projectId ||
    receipt.environmentId !== i.environmentId ||
    after.row.active_deployment_id !== i.deploymentId
  )
    throw new Error("auth_unavailable");
  const creditResults = [creditScope, creditAccount, creditProject];
  if (
    creditAccount.results.length > 1 ||
    creditProject.results.length > 1 ||
    creditScope.results.length !== 1
  )
    throw new Error("auth_unavailable");
  assertStableTime(t0, t1, t2, t3, creditAccount.results[0] as unknown as AccountRow | undefined);
  const start = runtimeDecisionFromResults(creditInput, creditResults);
  const end = runtimeDecisionFromResults(
    { ...creditInput, now: new Date(t3).toISOString() },
    creditResults,
  );
  if (
    start.allowed !== end.allowed ||
    start.paidAllowed !== end.paidAllowed ||
    start.reason !== end.reason ||
    start.customDomainAllowed !== end.customDomainAllowed
  )
    throw new Error("auth_unavailable");
  const result = buildAuthority(i, organizationId, after, end);
  if (result.realm.canonicalOrigin === null) throw new Error("auth_unavailable");
  const allowed = nativeAuthLaunchAllowed(context, organizationId, i.projectId);
  return {
    authority: {
      ...result,
      enabled: result.enabled && allowed,
      sourceCapable: result.sourceCapable && allowed,
      runtimeAllowed: result.runtimeAllowed && allowed,
      realm: { ...result.realm, canonicalOrigin: result.realm.canonicalOrigin },
    },
    registration: receipt,
  };
}

/** Trusted control can still fence the private database after an origin loses approval. */
export async function resolveNativeAuthAdminAuthority(context: CatalogContext, raw: unknown) {
  const i = scope.extend({ organizationId: ulid }).parse(raw);
  const result = await resolve(context, {
    projectId: i.projectId,
    environmentId: i.environmentId,
    ...(i.deploymentId === undefined ? {} : { deploymentId: i.deploymentId }),
  });
  if (result.organizationId !== i.organizationId) throw new Error("auth_unavailable");
  return result;
}

/** Private provider-policy read also resolves disabled providers, without exposing their credentials. */
export async function resolveNativeAuthProviderPolicy(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      environmentId: ulid,
      provider: z.enum(["google", "github"]),
    })
    .parse(raw);
  const realmScope = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
  };
  const current = await resolveNativeAuthAdminAuthority(context, realmScope);
  const { db } = await context.router.routeOrganization(i.organizationId);
  const row = await db
    .prepare(
      "SELECT enabled FROM native_auth_providers WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider=?4",
    )
    .bind(i.organizationId, i.projectId, i.environmentId, i.provider)
    .first<{ enabled: number }>();
  const after = await resolveNativeAuthAdminAuthority(context, realmScope);
  if (JSON.stringify(current) !== JSON.stringify(after)) throw new Error("auth_unavailable");
  if (row === null) return null;
  return {
    ...realmScope,
    provider: i.provider,
    enabled: row.enabled === 1 && nativeAuthSocialAllowed(context, i.organizationId, i.projectId),
    configurationRevision: after.realm.configurationRevision,
    revocationEpoch: after.revocationEpoch,
    realmEnabled: after.ownerEnabled,
    canonicalOrigin: after.realm.canonicalOrigin,
    sourceCapable: after.sourceCapable,
  };
}

/** Owner and optional delegated grant are rechecked for the exact user-management action. */
export async function authorizeNativeAuthOwnerOperation(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const i = scope
    .extend({
      organizationId: ulid,
      principalId: z.string().min(1).max(256),
      requestId: z.string().min(1).max(256),
      intent: z.enum(["users-list", "user-read", "user-mutate"]),
      delegation: handoffAuthorityInput.optional(),
      idempotencyKey: z.string().min(1).max(255).optional(),
      canonicalRequestDigest: z.instanceof(Uint8Array).optional(),
    })
    .strip()
    .parse(raw);
  const { db } = await context.router.routeOrganization(i.organizationId);
  const action = i.intent === "user-mutate" ? "auth:manage" : "auth:read";
  const authority = canonicalAuthorizationCondition({
    organizationId: i.organizationId,
    projectId: i.projectId,
    environmentId: i.environmentId,
    principalId: i.principalId,
    action,
  });
  try {
    await db.batch([
      guard(db, "consent_changed", `NOT (${authority.sql})`, authority.params),
      guard(
        db,
        "scope_inactive",
        "NOT EXISTS(SELECT 1 FROM projects p JOIN environments e USING(organization_id,project_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND e.environment_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active')",
        [i.organizationId, i.projectId, i.environmentId],
      ),
      ...(i.delegation === undefined
        ? []
        : handoffEffectGuards(db, {
            organizationId: i.organizationId,
            projectId: i.projectId,
            environmentId: i.environmentId,
            principalId: i.principalId,
            action,
            authority: i.delegation,
          })),
    ]);
    return true;
  } catch (error) {
    if (classifyFailure(error).kind === "guard") return false;
    throw error;
  }
}
