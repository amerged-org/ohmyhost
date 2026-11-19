import { nativeAuthLaunchAllowed, nativeAuthSocialAllowed } from "./native-auth-launch-policy.js";
import { z } from "zod";
import { guard } from "../../guards.js";
import { CommandConflictError, digestOf, runCommand, type Command } from "../../run-command.js";
import {
  newUlid,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { bytesOf, readSnapshot } from "../platform-support.js";
import { canonicalAuthorizationCondition } from "../projects/customer-projects-access.js";
import type { D1Database } from "../../d1-types.js";
import { handoffAuthorityInput, handoffEffectGuards } from "./handoff-effect.js";
import {
  isNativeAuthRedirectPath,
  NATIVE_AUTH_DEFAULT_REDIRECT_PATHS,
} from "@ohmyhost/contracts/native-auth";
import { canonicalOrigin } from "../gateway/contracts.js";

const MAX_GENERATION = 2_147_483_647;

const scope = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  principalId: z.string().min(1).max(256),
});
const config = z.strictObject({
  configurationRevision: z.number().int().positive().max(MAX_GENERATION),
  revocationEpoch: z.number().int().positive().max(MAX_GENERATION),
  enabled: z.boolean(),
  signupPolicy: z.enum(["open", "invite-only"]),
  appName: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !/[\p{Cc}]/u.test(value)),
  canonicalOrigin: z.string().nullable(),
  allowedRedirectPaths: z.array(z.string().refine(isNativeAuthRedirectPath)).min(1).max(32),
  resetPasswordPath: z.string().refine(isNativeAuthRedirectPath),
  invitationPath: z.string().refine(isNativeAuthRedirectPath),
});
const update = scope.extend({
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_GENERATION - 1),
  operationId: ulid,
  enabled: z.boolean(),
  signupPolicy: z.enum(["open", "invite-only"]),
  appName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/[\p{Cc}]/u.test(value)),
  canonicalOrigin: z.string().refine(canonicalOrigin).nullable().optional(),
  allowedRedirectPaths: z
    .array(z.string().refine(isNativeAuthRedirectPath))
    .min(1)
    .max(32)
    .optional(),
  resetPasswordPath: z.string().refine(isNativeAuthRedirectPath).optional(),
  invitationPath: z.string().refine(isNativeAuthRedirectPath).optional(),
  handoffDelegation: handoffAuthorityInput.optional(),
});
export type NativeAuthConfig = z.output<typeof config>;
export type NativeAuthConfigScope = z.output<typeof scope>;
export type UpdateNativeAuthConfigInput = z.output<typeof update>;

interface Snapshot {
  allowed: boolean;
  realm: NativeAuthConfig | null;
  receipt: { request_digest: string; response: string } | null;
  provider: {
    enabled: number;
    client_id: string;
    secret_present: number;
    last_success_at: string | null;
  } | null;
  origins: string;
  storedOrigin: string | null;
}

const realmSql = `SELECT configuration_revision,revocation_epoch,enabled,signup_policy,app_name,canonical_origin,allowed_redirect_paths,reset_password_path,invitation_path
 FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3`;
export const originsSql = `SELECT json_array(CASE WHEN d.deleted_at IS NULL AND d.handle=p.handle THEN 'https://'||CASE e.name WHEN 'dev' THEN d.development_domain WHEN 'prod' THEN d.production_domain END END,
 CASE WHEN e.name='prod' AND paid.state='active' AND paid.deleted_at IS NULL AND paid.gateway_script_name='ohmyho-gateway-production' AND paid.custom_hostname_receipt IS NOT NULL AND paid.worker_route_receipt IS NOT NULL THEN 'https://'||paid.hostname END) AS origins
 FROM environments e JOIN projects p ON p.organization_id=e.organization_id AND p.project_id=e.project_id
 LEFT JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id
 LEFT JOIN paid_project_domains paid ON paid.organization_id=p.organization_id AND paid.project_id=p.project_id
 WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3`;
const activeSql = `SELECT 1 FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id
 WHERE p.organization_id=?1 AND p.project_id=?2 AND e.environment_id=?3 AND p.owner_state='active' AND p.lifecycle_state='active'`;
const values = (i: NativeAuthConfigScope) => [i.organizationId, i.projectId, i.environmentId];
function audit(
  db: D1Database,
  i: NativeAuthConfigScope,
  eventId: string,
  event: string,
  payload: object,
) {
  return db
    .prepare(
      `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at)
    SELECT p.organization_id,?3,p.project_id,NULL,p.active_billing_epoch_id,?4,'principal',?5,?6,(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')
    FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2`,
    )
    .bind(i.organizationId, i.projectId, eventId, event, i.principalId, JSON.stringify(payload));
}
function realmOf(row: Record<string, unknown> | undefined): NativeAuthConfig | null {
  return row === undefined
    ? null
    : config.parse({
        configurationRevision: row["configuration_revision"],
        revocationEpoch: row["revocation_epoch"],
        enabled: row["enabled"] === 1,
        signupPolicy: row["signup_policy"],
        appName: row["app_name"],
        canonicalOrigin: row["canonical_origin"],
        allowedRedirectPaths: JSON.parse(String(row["allowed_redirect_paths"])),
        resetPasswordPath: row["reset_password_path"],
        invitationPath: row["invitation_path"],
      });
}
async function snapshot(
  db: D1Database,
  i: NativeAuthConfigScope,
  operationId?: string,
  provider?: "google" | "github",
): Promise<Snapshot> {
  const authority = canonicalAuthorizationCondition({
    ...i,
    action: operationId === undefined ? "auth:read" : "auth:manage",
  });
  const [allowed, active, realms, receipts, providers, origins] = await readSnapshot(db, [
    [`SELECT (${authority.sql}) AS allowed`, ...authority.params],
    [activeSql, ...values(i)],
    [realmSql, ...values(i)],
    [
      "SELECT request_digest,response FROM native_auth_config_requests WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4",
      ...values(i),
      operationId ?? "",
    ],
    [
      "SELECT enabled,client_id,(ciphertext IS NOT NULL) AS secret_present,last_success_at FROM native_auth_providers WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider=?4",
      ...values(i),
      provider ?? "",
    ],
    [originsSql, ...values(i)],
  ]);
  const originJson = String(origins?.[0]?.["origins"] ?? "[null,null]");
  const approved = JSON.parse(originJson) as (string | null)[];
  const realm = realmOf(realms?.[0]);
  return {
    allowed: allowed?.[0]?.["allowed"] === 1 && active?.length === 1,
    realm:
      realm === null
        ? null
        : {
            ...realm,
            canonicalOrigin: approved.includes(realm.canonicalOrigin)
              ? realm.canonicalOrigin
              : null,
          },
    storedOrigin: realm?.canonicalOrigin ?? null,
    origins: originJson,
    receipt: (receipts?.[0] as Snapshot["receipt"] | undefined) ?? null,
    provider: (providers?.[0] as Snapshot["provider"] | undefined) ?? null,
  };
}

/** Returns no configuration for a caller without current Owner authority. */
export async function readNativeAuthConfig(
  context: CatalogContext,
  raw: unknown,
): Promise<NativeAuthConfig | null> {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const state = await snapshot(db, i);
  return state.allowed ? state.realm : null;
}

/** Policy only: setting enabled never asserts source capability, sender, Paid or runtime readiness. */
export async function updateNativeAuthConfig(
  context: CatalogContext,
  raw: unknown,
): Promise<NativeAuthConfig> {
  const i = update.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const digest = await digestOf(i);
  const auditId = newUlid();
  const command: Command<Snapshot, NativeAuthConfig> = {
    name: "nativeAuth.updateConfig",
    input: i,
    retryOn: ["row_version_conflict", "precondition_changed"],
    naturalKeyTables: ["native_auth_realms", "native_auth_config_requests"],
    read: (reader) => snapshot(reader, i, i.operationId),
    decide(state) {
      if (i.enabled && !nativeAuthLaunchAllowed(context, i.organizationId, i.projectId))
        return { reject: new CommandConflictError("native_auth_launch_unavailable") };
      if (!state.allowed) return { reject: new CommandConflictError("native_auth_owner_required") };
      if (state.receipt !== null) {
        if (state.receipt.request_digest !== digest)
          return { reject: new CommandConflictError("native_auth_idempotency_conflict") };
        const response = config.parse(JSON.parse(state.receipt.response));
        const approved = JSON.parse(state.origins) as (string | null)[];
        return {
          replay: {
            ...response,
            canonicalOrigin: approved.includes(response.canonicalOrigin)
              ? response.canonicalOrigin
              : null,
          },
        };
      }
      if ((state.realm?.configurationRevision ?? 0) !== i.expectedRevision)
        return { reject: new CommandConflictError("native_auth_revision_conflict") };
      const approved = JSON.parse(state.origins) as (string | null)[];
      const selectedOrigin =
        i.canonicalOrigin === undefined
          ? state.realm === null
            ? (approved[0] ?? null)
            : state.storedOrigin
          : i.canonicalOrigin === null
            ? (approved[0] ?? null)
            : i.canonicalOrigin;
      if (
        i.canonicalOrigin !== undefined &&
        selectedOrigin !== null &&
        !approved.includes(selectedOrigin)
      )
        return { reject: new CommandConflictError("native_auth_origin_unapproved") };
      const paths = i.allowedRedirectPaths ??
        state.realm?.allowedRedirectPaths ?? [...NATIVE_AUTH_DEFAULT_REDIRECT_PATHS];
      const resetPath = i.resetPasswordPath ?? state.realm?.resetPasswordPath ?? "/reset-password";
      const invitationPath =
        i.invitationPath ?? state.realm?.invitationPath ?? "/accept-invitation";
      if (
        new Set(paths).size !== paths.length ||
        !paths.includes(resetPath) ||
        !paths.includes(invitationPath)
      )
        return { reject: new CommandConflictError("native_auth_paths_invalid") };
      const revoke =
        state.realm !== null &&
        ((state.realm.enabled && !i.enabled) || state.storedOrigin !== selectedOrigin);
      if (revoke && state.realm?.revocationEpoch === MAX_GENERATION)
        return { reject: new CommandConflictError("native_auth_epoch_exhausted") };
      const result: NativeAuthConfig = {
        configurationRevision: i.expectedRevision + 1,
        revocationEpoch: state.realm === null ? 1 : state.realm.revocationEpoch + (revoke ? 1 : 0),
        enabled: i.enabled,
        signupPolicy: i.signupPolicy,
        appName: i.appName,
        canonicalOrigin:
          selectedOrigin !== null && approved.includes(selectedOrigin) ? selectedOrigin : null,
        allowedRedirectPaths: paths,
        resetPasswordPath: resetPath,
        invitationPath,
      };
      const authority = canonicalAuthorizationCondition({ ...i, action: "auth:manage" });
      return {
        statements: [
          guard(db, "precondition_changed", `NOT (${authority.sql})`, authority.params),
          guard(db, "precondition_changed", `NOT EXISTS (${activeSql})`, values(i)),
          guard(db, "precondition_changed", `COALESCE((${originsSql}), '[null,null]') IS NOT ?4`, [
            ...values(i),
            state.origins,
          ]),
          ...(i.handoffDelegation === undefined
            ? []
            : handoffEffectGuards(db, {
                organizationId: i.organizationId,
                projectId: i.projectId,
                environmentId: i.environmentId,
                principalId: i.principalId,
                action: "auth:manage",
                authority: i.handoffDelegation,
              })),
          ...(state.realm === null
            ? [
                db
                  .prepare(
                    "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch,canonical_origin,allowed_redirect_paths,reset_password_path,invitation_path) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                  )
                  .bind(
                    ...values(i),
                    i.enabled ? 1 : 0,
                    i.signupPolicy,
                    i.appName,
                    result.configurationRevision,
                    result.revocationEpoch,
                    selectedOrigin,
                    JSON.stringify(paths),
                    resetPath,
                    invitationPath,
                  ),
              ]
            : [
                db
                  .prepare(
                    "UPDATE native_auth_realms SET enabled=?4,signup_policy=?5,app_name=?6,configuration_revision=?7,revocation_epoch=?8,canonical_origin=?11,allowed_redirect_paths=?12,reset_password_path=?13,invitation_path=?14 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND configuration_revision=?9 AND revocation_epoch=?10",
                  )
                  .bind(
                    ...values(i),
                    i.enabled ? 1 : 0,
                    i.signupPolicy,
                    i.appName,
                    result.configurationRevision,
                    result.revocationEpoch,
                    i.expectedRevision,
                    state.realm.revocationEpoch,
                    selectedOrigin,
                    JSON.stringify(paths),
                    resetPath,
                    invitationPath,
                  ),
                guard(db, "row_version_conflict", "changes()=0"),
              ]),
          ...(state.realm !== null && state.storedOrigin !== selectedOrigin
            ? [
                db
                  .prepare(
                    "UPDATE native_auth_providers SET last_success_at=NULL WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
                  )
                  .bind(...values(i)),
              ]
            : []),
          db
            .prepare(
              "INSERT INTO native_auth_config_requests(organization_id,project_id,environment_id,operation_id,request_digest,response) VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .bind(...values(i), i.operationId, digest, JSON.stringify(result)),
          audit(db, i, auditId, "NativeAuthConfigurationChanged", {
            environmentId: i.environmentId,
            enabled: result.enabled,
            configurationRevision: result.configurationRevision,
            revocationEpoch: result.revocationEpoch,
          }),
        ],
        result: () => result,
      };
    },
    async lookup(reader) {
      const state = await snapshot(reader, i, i.operationId);
      if (!state.allowed) throw new CommandConflictError("native_auth_owner_required");
      if (state.receipt === null) return undefined;
      if (state.receipt.request_digest !== digest)
        throw new CommandConflictError("native_auth_idempotency_conflict");
      const response = config.parse(JSON.parse(state.receipt.response));
      const approved = JSON.parse(state.origins) as (string | null)[];
      return {
        ...response,
        canonicalOrigin: approved.includes(response.canonicalOrigin)
          ? response.canonicalOrigin
          : null,
      };
    },
  };
  return runCommand(db, command);
}

const providerScope = scope.extend({ provider: z.enum(["google", "github"]) });
const envelope = z.strictObject({
  ciphertext: z.instanceof(Uint8Array).refine((v) => v.byteLength >= 17 && v.byteLength <= 65552),
  nonce: z.instanceof(Uint8Array).refine((v) => v.byteLength === 12),
  valueSha256: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
  keyVersion: z.number().int().positive(),
});
const providerUpdate = providerScope.extend({
  expectedRevision: z
    .number()
    .int()
    .positive()
    .max(MAX_GENERATION - 1),
  operationId: ulid,
  enabled: z.boolean(),
  clientId: z.string().max(1024).optional(),
  encryptedSecret: envelope.optional(),
  handoffDelegation: handoffAuthorityInput.optional(),
});
const providerResult = z.strictObject({
  provider: z.enum(["google", "github"]),
  enabled: z.boolean(),
  clientId: z.string(),
  secretPresent: z.boolean(),
  configurationRevision: z.number().int().positive().max(MAX_GENERATION),
  lastSuccessfulFlowAt: z.string().nullable(),
});
export type NativeAuthProvider = z.output<typeof providerResult>;
export type UpdateNativeAuthProviderInput = z.output<typeof providerUpdate>;

/** Public provider status deliberately excludes the encrypted envelope. */
export async function readNativeAuthProvider(
  context: CatalogContext,
  raw: unknown,
): Promise<NativeAuthProvider | null> {
  const i = providerScope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const state = await snapshot(db, i, undefined, i.provider);
  return state.allowed && state.realm !== null && state.provider !== null
    ? {
        provider: i.provider,
        enabled: state.provider.enabled === 1,
        clientId: state.provider.client_id,
        secretPresent: state.provider.secret_present === 1,
        configurationRevision: state.realm.configurationRevision,
        lastSuccessfulFlowAt:
          state.provider.last_success_at === null
            ? null
            : publicTimestamp(state.provider.last_success_at),
      }
    : null;
}

/** Write-only envelope custody; provider changes fence pending flows but retain existing sessions. */
export async function updateNativeAuthProvider(
  context: CatalogContext,
  raw: unknown,
): Promise<NativeAuthProvider> {
  const i = providerUpdate.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  // Encryption nonces and custody-key versions can change on a retry; only the submitted value is logical input.
  const digest = await digestOf({
    ...i,
    encryptedSecret:
      i.encryptedSecret === undefined
        ? null
        : {
            valueSha256: Array.from(i.encryptedSecret.valueSha256),
          },
  });
  const auditId = newUlid();
  const command: Command<Snapshot, NativeAuthProvider> = {
    name: "nativeAuth.updateProvider",
    input: i,
    retryOn: ["row_version_conflict", "precondition_changed"],
    naturalKeyTables: ["native_auth_providers", "native_auth_config_requests"],
    read: (reader) => snapshot(reader, i, i.operationId, i.provider),
    decide(state) {
      if (!state.allowed) return { reject: new CommandConflictError("native_auth_owner_required") };
      if (i.enabled && !nativeAuthSocialAllowed(context, i.organizationId, i.projectId))
        return { reject: new CommandConflictError("native_auth_provider_unavailable") };
      if (state.receipt !== null)
        return state.receipt.request_digest === digest
          ? { replay: providerResult.parse(JSON.parse(state.receipt.response)) }
          : { reject: new CommandConflictError("native_auth_idempotency_conflict") };
      if (state.realm?.configurationRevision !== i.expectedRevision)
        return { reject: new CommandConflictError("native_auth_revision_conflict") };
      const secretPresent = i.encryptedSecret !== undefined || state.provider?.secret_present === 1;
      const clientId = i.clientId ?? state.provider?.client_id ?? "";
      if (i.enabled && (!secretPresent || !clientId.trim()))
        return { reject: new CommandConflictError("native_auth_provider_incomplete") };
      const result: NativeAuthProvider = {
        provider: i.provider,
        enabled: i.enabled,
        clientId,
        secretPresent,
        configurationRevision: i.expectedRevision + 1,
        lastSuccessfulFlowAt: null,
      };
      const authority = canonicalAuthorizationCondition({ ...i, action: "auth:manage" });
      const secret = i.encryptedSecret;
      return {
        statements: [
          guard(db, "precondition_changed", `NOT (${authority.sql})`, authority.params),
          guard(db, "precondition_changed", `NOT EXISTS (${activeSql})`, values(i)),
          ...(i.handoffDelegation === undefined
            ? []
            : handoffEffectGuards(db, {
                organizationId: i.organizationId,
                projectId: i.projectId,
                environmentId: i.environmentId,
                principalId: i.principalId,
                action: "auth:manage",
                authority: i.handoffDelegation,
              })),
          db
            .prepare(
              "UPDATE native_auth_realms SET configuration_revision=configuration_revision+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND configuration_revision=?4",
            )
            .bind(...values(i), i.expectedRevision),
          guard(db, "row_version_conflict", "changes()=0"),
          db
            .prepare(
              `INSERT INTO native_auth_providers(organization_id,project_id,environment_id,provider,enabled,client_id,ciphertext,nonce,value_sha256,key_version)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(organization_id,project_id,environment_id,provider) DO UPDATE SET
          enabled=excluded.enabled,client_id=excluded.client_id,ciphertext=COALESCE(excluded.ciphertext,native_auth_providers.ciphertext),nonce=COALESCE(excluded.nonce,native_auth_providers.nonce),value_sha256=COALESCE(excluded.value_sha256,native_auth_providers.value_sha256),key_version=COALESCE(excluded.key_version,native_auth_providers.key_version),last_success_at=NULL`,
            )
            .bind(
              ...values(i),
              i.provider,
              i.enabled ? 1 : 0,
              clientId,
              secret?.ciphertext ?? null,
              secret?.nonce ?? null,
              secret?.valueSha256 ?? null,
              secret?.keyVersion ?? null,
            ),
          db
            .prepare(
              "INSERT INTO native_auth_config_requests(organization_id,project_id,environment_id,operation_id,request_digest,response) VALUES(?1,?2,?3,?4,?5,?6)",
            )
            .bind(...values(i), i.operationId, digest, JSON.stringify(result)),
          audit(db, i, auditId, "NativeAuthProviderChanged", {
            environmentId: i.environmentId,
            provider: i.provider,
            enabled: result.enabled,
            configurationRevision: result.configurationRevision,
            secretPresent: result.secretPresent,
          }),
        ],
        result: () => result,
      };
    },
    async lookup(reader) {
      const state = await snapshot(reader, i, i.operationId, i.provider);
      if (!state.allowed) throw new CommandConflictError("native_auth_owner_required");
      if (state.receipt === null) return undefined;
      if (state.receipt.request_digest !== digest)
        throw new CommandConflictError("native_auth_idempotency_conflict");
      return providerResult.parse(JSON.parse(state.receipt.response));
    },
  };
  return runCommand(db, command);
}

/** Private runtime-only read of one enabled provider at the initiating configuration revision. */
export async function readNativeAuthProviderEnvelope(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      environmentId: ulid,
      provider: z.enum(["google", "github"]),
      configurationRevision: z.number().int().positive().max(MAX_GENERATION),
    })
    .parse(raw);
  if (!nativeAuthSocialAllowed(context, i.organizationId, i.projectId)) return null;
  const { db } = await routeOrganization(context, i.organizationId);
  const row = await db
    .prepare(
      `SELECT v.client_id,v.ciphertext,v.nonce,v.value_sha256,v.key_version
    FROM native_auth_providers v JOIN native_auth_realms r USING(organization_id,project_id,environment_id)
    JOIN projects p USING(organization_id,project_id)
    JOIN billing_epochs b ON b.organization_id=p.organization_id AND b.project_id=p.project_id
      AND b.billing_epoch_id=p.active_billing_epoch_id AND b.ended_at IS NULL
    WHERE v.organization_id=?1 AND v.project_id=?2 AND v.environment_id=?3 AND v.provider=?4
      AND r.configuration_revision=?5 AND r.enabled=1 AND v.enabled=1 AND v.ciphertext IS NOT NULL
      AND p.owner_state='active' AND p.lifecycle_state='active'`,
    )
    .bind(...values({ ...i, principalId: "" }), i.provider, i.configurationRevision)
    .first();
  if (row === null) return null;
  return {
    clientId: String(row["client_id"]),
    ciphertext: bytesOf(row["ciphertext"]),
    nonce: bytesOf(row["nonce"]),
    valueSha256: bytesOf(row["value_sha256"]),
    keyVersion: Number(row["key_version"]),
  };
}
