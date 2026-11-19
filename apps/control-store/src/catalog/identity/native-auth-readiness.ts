import { z } from "zod";
import { routeOrganization, ulid, type CatalogContext } from "../common.js";
import { readRuntimeDecision } from "../credit/index.js";
import {
  MailReputationSuspended,
  MailScopeError,
  readSender,
  senderOf,
  SENDER_SQL,
} from "../mail/auth.js";
import { authorizeNativeAuthOwner } from "./native-auth-owner.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  resolveNativeAuthAuthority,
  resolveNativeAuthAdminAuthority,
} from "./native-auth-authority.js";
import { readNativeAuthConfig } from "./native-auth-config.js";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid });
const ownerScope = scope.extend({ principalId: z.string().min(1).max(256) });

/** Sender details and credential envelopes stay in Mail; Native only receives the approved domain and scope. */
export async function authorizeNativeMail(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  try {
    const authority = await resolveNativeAuthAuthority(context, {
      projectId: i.projectId,
      environmentId: i.environmentId,
    });
    if (
      authority.organizationId !== i.organizationId ||
      !authority.enabled ||
      !authority.sourceCapable ||
      !authority.paidAllowed ||
      !authority.runtimeAllowed
    )
      return null;
    const row = await db
      .prepare(
        `SELECT * FROM (${SENDER_SQL}) sender WHERE EXISTS(
      SELECT 1 FROM native_auth_realms r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.environment_id=?3 AND r.enabled=1)`,
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.environmentId,
        storedTimestamp(new Date().toISOString()),
      )
      .first();
    if (row === null) return null;
    const sender = senderOf(row);
    const current = await resolveNativeAuthAuthority(context, {
      projectId: i.projectId,
      environmentId: i.environmentId,
    });
    if (JSON.stringify(current) !== JSON.stringify(authority)) return null;
    return {
      ...i,
      domain: sender.domain,
      canonicalOrigin: current.realm.canonicalOrigin,
      applicationName: current.applicationName,
      allowedRedirectPaths: current.allowedRedirectPaths,
      resetPasswordPath: current.resetPasswordPath,
      invitationPath: current.invitationPath,
    };
  } catch (error) {
    if (
      error instanceof MailScopeError ||
      error instanceof MailReputationSuspended ||
      (error instanceof Error && error.message === "auth_unavailable")
    )
      return null;
    throw error;
  }
}

/** Owner-only snapshot of the current independent prerequisites; it does not activate the realm. */
export async function readNativeAuthReadiness(context: CatalogContext, raw: unknown) {
  const i = ownerScope.parse(raw);
  if (!(await authorizeNativeAuthOwner(context, i))) return null;
  const { db } = await routeOrganization(context, i.organizationId),
    now = storedTimestamp(new Date().toISOString());
  const billing = await readRuntimeDecision(db, { ...i, now });
  const config = await readNativeAuthConfig(context, i);
  let storage = false;
  try {
    storage = (
      await resolveNativeAuthAdminAuthority(context, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        environmentId: i.environmentId,
      })
    ).storageReady;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "auth_unavailable") throw error;
  }
  let sender = false;
  try {
    await readSender(db, { ...i, now });
    sender = true;
  } catch (error) {
    if (!(error instanceof MailScopeError) && !(error instanceof MailReputationSuspended))
      throw error;
  }
  if (!(await authorizeNativeAuthOwner(context, i))) return null;
  return {
    paid: billing.paidAllowed && billing.allowed,
    sender,
    origin: config?.canonicalOrigin != null,
    storage,
  };
}
