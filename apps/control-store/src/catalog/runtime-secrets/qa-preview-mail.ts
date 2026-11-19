import { bytesOf } from "../platform-support.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { authorizeDevAccessSession } from "../dev-access/access.js";
import { readRuntimeDecision } from "../credit/index.js";
import { authorizeMailGatewayKey, readSender } from "../mail/auth.js";
import { storedTimestamp } from "../../timestamps.js";
import type { D1Database } from "../../d1-types.js";
import { QA_PREVIEW_MAIL_SCOPE } from "./qa-preview-mail-scope.js";

const NAME = "OHMYHOST_MAIL_KEY";
const unavailable = () => new Error("qa_mail_key_unavailable");
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function readStored(db: D1Database) {
  const scope = QA_PREVIEW_MAIL_SCOPE;
  const results = (
    await db
      .prepare(
        `SELECT secret.ciphertext,secret.nonce,secret.value_sha256,secret.key_version,secret.revision,
    e.dev_access_epoch,p.handle,d.development_domain FROM environment_secrets secret
    JOIN projects p ON p.organization_id=secret.organization_id AND p.project_id=secret.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
    JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active'
    JOIN environments e ON e.organization_id=secret.organization_id AND e.project_id=secret.project_id AND e.environment_id=secret.environment_id AND e.name='dev'
    JOIN cloudflare_project_domains d ON d.organization_id=p.organization_id AND d.project_id=p.project_id AND d.handle=p.handle AND d.deleted_at IS NULL AND d.zone_name='omh.st'
    WHERE secret.organization_id=?1 AND secret.project_id=?2 AND secret.environment_id=?3 AND secret.name='OHMYHOST_MAIL_KEY'`,
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId)
      .all<Record<string, unknown>>()
  ).results;
  if (results.length !== 1 || !results[0]) throw unavailable();
  const row = results[0],
    ciphertext = bytesOf(row["ciphertext"]),
    nonce = bytesOf(row["nonce"]),
    valueSha256 = bytesOf(row["value_sha256"]);
  if (
    ciphertext.byteLength < 17 ||
    ciphertext.byteLength > 5136 ||
    nonce.byteLength !== 12 ||
    valueSha256.byteLength !== 32 ||
    !positive(row["key_version"]) ||
    !positive(row["revision"]) ||
    !positive(row["dev_access_epoch"]) ||
    typeof row["handle"] !== "string" ||
    typeof row["development_domain"] !== "string" ||
    row["development_domain"] !== `dev-${row["handle"]}.dev.check.omh.st`
  )
    throw unavailable();
  return {
    ciphertext,
    nonce,
    valueSha256,
    keyVersion: row["key_version"],
    revision: row["revision"],
    devAccessEpoch: row["dev_access_epoch"],
    handle: row["handle"],
    origin: `https://${row["development_domain"]}`,
  };
}
function fingerprint(row: Awaited<ReturnType<typeof readStored>>) {
  return JSON.stringify([
    hex(row.ciphertext),
    hex(row.nonce),
    hex(row.valueSha256),
    row.keyVersion,
    row.revision,
    row.devAccessEpoch,
    row.handle,
    row.origin,
  ]);
}
async function live(
  context: CatalogContext,
  db: D1Database,
  row: Awaited<ReturnType<typeof readStored>>,
) {
  const scope = QA_PREVIEW_MAIL_SCOPE;
  const dev = await authorizeDevAccessSession(context, {
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    handle: row.handle,
    origin: row.origin,
    principalId: scope.principalId,
    devAccessEpoch: row.devAccessEpoch,
  });
  if (!dev) throw unavailable();
  const now = new Date().toISOString();
  const credit = await readRuntimeDecision(db, {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    now,
  });
  if (!credit.allowed || !credit.paidAllowed || credit.reason !== null) throw unavailable();
  const authority = await authorizeMailGatewayKey(context, {
    projectId: scope.projectId,
    keySha256: hex(row.valueSha256),
  });
  if (
    !authority ||
    authority.organizationId !== scope.organizationId ||
    authority.projectId !== scope.projectId ||
    authority.environmentId !== scope.environmentId
  )
    throw unavailable();
  const sender = await readSender(db, {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    now: storedTimestamp(now),
  });
  if (sender.domain !== authority.domain) throw unavailable();
  return { senderDomain: sender.domain, senderRevision: sender.bindingRevision };
}

/** Only one fixed ciphertext envelope reaches the custody Worker; no caller chooses scope or name. */
export async function readQaPreviewMailEnvelope(context: CatalogContext, raw: unknown) {
  if (raw !== undefined) throw unavailable();
  try {
    const scope = QA_PREVIEW_MAIL_SCOPE;
    const { db } = await routeOrganization(context, scope.organizationId);
    const before = await readStored(db);
    const first = await live(context, db, before);
    const after = await readStored(db);
    const last = await live(context, db, after);
    const final = await readStored(db);
    if (
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(after) !== fingerprint(final) ||
      JSON.stringify(first) !== JSON.stringify(last)
    )
      throw unavailable();
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      name: NAME,
      ciphertext: after.ciphertext,
      nonce: after.nonce,
      valueSha256: after.valueSha256,
      keyVersion: after.keyVersion,
      revision: after.revision,
      devAccessEpoch: after.devAccessEpoch,
      ...last,
    };
  } catch {
    throw unavailable();
  }
}
