import { AI_KEY_NAME, BROWSER_KEY_NAME } from "@ohmyhost/platform/shared";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { bytesOf } from "../platform-support.js";
import {
  secretSnapshotQueries,
  secretSnapshotOf,
  type EnvironmentSecretMetadata,
  planPut,
  putEnvironmentSecretInput,
} from "../secrets/environment-secrets.js";
import {
  sealedInput,
  promotionMailInput,
  parse,
  integer,
  DeliveryInputError,
  DeliveryScopeError,
  type Row,
} from "./contracts.js";
import { ACTIVE_SCOPE, params } from "./facts.js";

const AUTHORIZE = `SELECT 1 FROM product_provider_mutation_claims claim
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id
 JOIN environments environment ON environment.organization_id=claim.organization_id AND environment.project_id=claim.project_id AND environment.environment_id=claim.environment_id
 WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.claim_id=?5
 AND operation.state IN ('queued','running') AND project.owner_state='active' AND project.lifecycle_state='active' AND project.lifecycle_version=claim.accepted_lifecycle_version`;
const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
const MAIL_READY = `SELECT 1 FROM (
 SELECT b.organization_id,b.project_id FROM project_mail_domain_bindings b JOIN workspace_mail_domains w ON w.domain_id=b.mail_domain_id AND w.organization_id=b.organization_id
 LEFT JOIN resend_mail_domains d ON d.domain_id=w.legacy_domain_id LEFT JOIN project_application_domain_identities i ON i.project_id=b.project_id AND i.organization_id=b.organization_id
 WHERE b.organization_id=?1 AND b.project_id=?2 AND b.state='active' AND b.sending=1 AND w.status='active' AND COALESCE(d.sending_status,w.sending_status)='ready'
 AND (b.legacy=1 OR(i.state='verified' AND i.expires_at>${DB_NOW} AND i.revision=b.application_identity_revision AND i.registrable_domain=w.registrable_domain))
 UNION ALL SELECT receiver.organization_id,receiver.project_id FROM resend_mail_domains receiver
 JOIN workspace_mail_domains w ON w.legacy_domain_id=receiver.domain_id AND w.organization_id=receiver.organization_id AND w.status='active'
 JOIN projects project ON project.organization_id=receiver.organization_id AND project.project_id=receiver.project_id AND project.owner_state='active' AND project.lifecycle_state='active'
 JOIN environments production ON production.organization_id=receiver.organization_id AND production.project_id=receiver.project_id AND production.environment_id=receiver.environment_id AND production.name='prod'
 WHERE receiver.organization_id=?1 AND receiver.project_id=?2 AND receiver.deleted_at IS NULL AND receiver.receiving=1 AND receiver.webhook_verified_at IS NOT NULL
 ) capability WHERE EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3) LIMIT 1`;
const SECRET = `SELECT * FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name=?4`;
const MS_CREATED = "(substr(secret.created_at,1,23)||'000Z')";

/** Reuse an existing environment key when a funded preview starts; never replace keys or reputation. */
export function previewMailMetadataStatements(
  db: D1Database,
  scope: { organizationId: string; projectId: string; environmentId: string },
): D1PreparedStatement[] {
  const values = [scope.organizationId, scope.projectId, scope.environmentId, "OHMYHOST_MAIL_KEY"];
  const eligible = `EXISTS(${MAIL_READY}) AND NOT EXISTS(
    SELECT 1 FROM mail_gateway_keys other WHERE other.key_sha256=secret.value_sha256
    AND (other.organization_id<>secret.organization_id OR other.project_id<>secret.project_id)
  )`;
  return [
    db
      .prepare(
        `INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at)
         SELECT secret.organization_id,secret.project_id,1,secret.value_sha256,${MS_CREATED}
         FROM (${SECRET}) secret WHERE ${eligible} ON CONFLICT(organization_id,project_id) DO NOTHING`,
      )
      .bind(...values),
    db
      .prepare(
        `INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at)
         SELECT secret.organization_id,secret.project_id,'active',${MS_CREATED},1,${MS_CREATED}
         FROM (${SECRET}) secret JOIN mail_gateway_keys key ON key.organization_id=secret.organization_id
         AND key.project_id=secret.project_id AND key.key_version=1 WHERE ${eligible}
         ON CONFLICT(organization_id,project_id) DO NOTHING`,
      )
      .bind(...values),
  ];
}

class PlatformKeyConflict extends Error {
  constructor(kind: "mail" | "storage") {
    super(
      kind === "mail"
        ? "Mail gateway key conflicts with durable state"
        : "Storage gateway request conflicts with durable state",
    );
    this.name = kind === "mail" ? "MailGatewayKeyConflictError" : "StorageGatewayConflictError";
  }
}
function digest(value: unknown): string {
  return Array.from(bytesOf(value), (v) => v.toString(16).padStart(2, "0")).join("");
}
type Kind = "database" | "auth" | "mail" | "storage" | "ai" | "browser";
export const installPlatformSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "database");
export const ensurePlatformSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "auth");
export const ensureMailSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "mail");
export const ensureStorageSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "storage");
export const ensureAiSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "ai");

export const ensureBrowserSecret = (context: CatalogContext, raw: unknown) =>
  storePlatform(context, raw, "browser");

async function storePlatform(context: CatalogContext, raw: unknown, kind: Kind) {
  const input = parse(sealedInput, raw),
    expected = {
      database: "DATABASE_URL",
      auth: "BETTER_AUTH_SECRET",
      mail: "OHMYHOST_MAIL_KEY",
      storage: "OHMYHOST_STORAGE_KEY",
      ai: AI_KEY_NAME,
      browser: BROWSER_KEY_NAME,
    }[kind];
  if (input.name !== expected) throw new DeliveryInputError();
  const { db } = await routeOrganization(context, input.organizationId),
    p = params(input),
    authority = [...p, input.operationId, input.claimId],
    secretParams = [...p, input.name];
  const put = parse(putEnvironmentSecretInput, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    name: input.name,
    ciphertext: input.ciphertext,
    nonce: input.nonce,
    valueSha256: input.valueSha256,
    keyVersion: input.keyVersion,
    writtenAt: input.writtenAt,
    claim: { operationId: input.operationId, claimId: input.claimId },
  });
  const read = async (reader: typeof db) => {
    const facts = await reader.batch([
      ...secretSnapshotQueries(put).map(([sql, ...values]) => reader.prepare(sql).bind(...values)),
      reader.prepare(AUTHORIZE).bind(...authority),
      reader
        .prepare(
          kind === "mail"
            ? MAIL_READY
            : kind === "storage"
              ? "SELECT 1 FROM project_r2_bucket_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3"
              : "SELECT 1 WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL",
        )
        .bind(...p),
      reader
        .prepare(
          kind === "storage"
            ? "SELECT key_version,lower(hex(key_sha256)) key_sha256,created_at FROM storage_gateway_keys WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 ORDER BY key_version DESC LIMIT 1"
            : "SELECT 1 WHERE ?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL",
        )
        .bind(...p),
      reader
        .prepare(
          kind === "mail"
            ? "SELECT version FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2 AND ?3 IS NOT NULL"
            : "SELECT 1 WHERE ?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL",
        )
        .bind(...p),
      reader
        .prepare(
          kind === "mail"
            ? "SELECT 1 FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id<>?3 AND name='OHMYHOST_MAIL_KEY' AND value_sha256=unhex(?4) LIMIT 1"
            : "SELECT 1 WHERE ?1 IS NULL AND ?2 IS NULL AND ?3 IS NULL AND ?4 IS NULL",
        )
        .bind(...p, digest(input.valueSha256)),
    ]);
    return {
      secret: secretSnapshotOf(
        facts.slice(0, 4).map((row) => row.results),
        true,
      ),
      authorized: (facts[4]?.results.length ?? 0) === 1,
      ready: (facts[5]?.results.length ?? 0) !== 0,
      key: facts[6]?.results[0] ?? null,
      reputation: facts[7]?.results[0] ?? null,
      duplicateMailKey: (facts[8]?.results.length ?? 0) !== 0,
    };
  };
  const command: Command<Awaited<ReturnType<typeof read>>, EnvironmentSecretMetadata> = {
    name: `runtimeSecrets.platform.${kind}`,
    input,
    read,
    decide: (s) => {
      if (!s.authorized || !s.secret.scopeActive || !s.secret.claimCurrent)
        return { reject: new DeliveryScopeError() };
      if (!s.ready)
        return { reject: new PlatformKeyConflict(kind === "mail" ? "mail" : "storage") };
      // Existing keys are immutable on ensure, even when historical generations were duplicated. A new
      // environment must never install a key already held by another environment of the project.
      if (kind === "mail" && s.secret.secret === null && s.duplicateMailKey)
        return { reject: new PlatformKeyConflict("mail") };
      if (s.secret.secret !== null && !Number.isSafeInteger(s.secret.secret.revision))
        return { reject: new DeliveryInputError() };
      if (kind === "storage" && s.key !== null) {
        const old = s.secret.secret,
          expectedHash = old === null ? digest(input.valueSha256) : digest(old.value_sha256),
          created = old?.updated_at ?? input.writtenAt;
        if (
          typeof s.key["key_version"] !== "number" ||
          s.key["key_version"] < 1 ||
          s.key["key_sha256"] !== expectedHash ||
          typeof s.key["created_at"] !== "string" ||
          s.key["created_at"].slice(0, 23) !== created.slice(0, 23)
        )
          return { reject: new PlatformKeyConflict("storage") };
      }
      const base = planPut(db, put, s.secret, kind === "database");
      if ("reject" in base) return base;
      // Original PG metadata refuses an unsafe returned revision and rolls the transaction back.
      if (!("replay" in base) && s.secret.secret?.revision === Number.MAX_SAFE_INTEGER)
        return { reject: new DeliveryInputError() };
      const statements = [
        guard(db, "precondition_changed", `NOT EXISTS(${AUTHORIZE})`, authority),
        guard(db, "precondition_changed", `NOT EXISTS(${ACTIVE_SCOPE})`, p),
      ];
      if ("replay" in base) {
        const old = s.secret.secret;
        if (old === null) throw new DeliveryInputError();
        statements.push(
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM (${SECRET}) WHERE CAST(revision AS TEXT)=?5 AND key_version=?6 AND lower(hex(value_sha256))=?7 AND created_at=?8 AND updated_at=?9)`,
            [
              ...secretParams,
              String(old.revision),
              old.key_version,
              digest(old.value_sha256),
              old.created_at,
              old.updated_at,
            ],
          ),
        );
      } else statements.push(...base.statements);
      const baseCount = "replay" in base ? 0 : base.statements.length;
      if (kind === "storage") {
        statements.push(
          db
            .prepare(
              `INSERT INTO storage_gateway_keys(organization_id,project_id,environment_id,key_version,key_sha256,created_at)
     SELECT secret.organization_id,secret.project_id,secret.environment_id,1,secret.value_sha256,${MS_CREATED} FROM (${SECRET}) secret JOIN project_r2_bucket_receipts bucket ON bucket.organization_id=secret.organization_id AND bucket.project_id=secret.project_id AND bucket.environment_id=secret.environment_id
     WHERE 1 ON CONFLICT DO NOTHING`,
            )
            .bind(...secretParams),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM storage_gateway_keys key JOIN (${SECRET}) secret ON key.organization_id=secret.organization_id AND key.project_id=secret.project_id AND key.environment_id=secret.environment_id WHERE key.key_version=(SELECT MAX(latest.key_version) FROM storage_gateway_keys latest WHERE latest.organization_id=key.organization_id AND latest.project_id=key.project_id AND latest.environment_id=key.environment_id) AND key.key_sha256=secret.value_sha256 AND substr(key.created_at,1,23)=substr(secret.updated_at,1,23))`,
            secretParams,
          ),
        );
      }
      if (kind === "mail") {
        statements.push(
          guard(db, "precondition_changed", `NOT EXISTS(${MAIL_READY})`, p),
          ...(s.secret.secret === null
            ? [
                guard(
                  db,
                  "precondition_changed",
                  "EXISTS(SELECT 1 FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id<>?3 AND name='OHMYHOST_MAIL_KEY' AND value_sha256=unhex(?4))",
                  [...p, digest(input.valueSha256)],
                ),
              ]
            : []),
          db
            .prepare(
              `INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at) SELECT secret.organization_id,secret.project_id,1,secret.value_sha256,${MS_CREATED} FROM (${SECRET}) secret WHERE 1 ON CONFLICT(organization_id,project_id) DO NOTHING`,
            )
            .bind(...secretParams),
          db
            .prepare(
              `INSERT INTO mail_reputation_states(organization_id,project_id,state,warmup_started_at,version,updated_at) SELECT secret.organization_id,secret.project_id,'active',${MS_CREATED},1,${MS_CREATED} FROM (${SECRET}) secret JOIN mail_gateway_keys key ON key.organization_id=secret.organization_id AND key.project_id=secret.project_id AND key.key_version=1 WHERE 1 ON CONFLICT(organization_id,project_id) DO NOTHING`,
            )
            .bind(...secretParams),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2 AND version>=1)",
            p.slice(0, 2),
          ),
        );
      }
      return {
        statements,
        result: (results) =>
          "replay" in base
            ? base.replay.metadata
            : base.result(results.slice(2, 2 + baseCount)).metadata,
      };
    },
    retryOn: ["precondition_changed", "row_version_conflict", "scope_inactive"],
    naturalKeyTables: [
      "environment_secrets",
      "storage_gateway_keys",
      "mail_gateway_keys",
      "mail_reputation_states",
    ],
    lookup: async (reader) => {
      const current = await read(reader);
      if (
        !current.authorized ||
        !current.ready ||
        !current.secret.scopeActive ||
        !current.secret.claimCurrent
      )
        return undefined;
      const result = planPut(db, put, current.secret, kind === "database");
      if (!("replay" in result)) return undefined;
      if (kind === "storage") {
        const key = current.key,
          secret = current.secret.secret;
        if (
          key === null ||
          secret === null ||
          typeof key["key_version"] !== "number" ||
          key["key_version"] < 1 ||
          key["key_sha256"] !== digest(secret.value_sha256) ||
          typeof key["created_at"] !== "string" ||
          key["created_at"].slice(0, 23) !== secret.updated_at.slice(0, 23)
        )
          return undefined;
      }
      if (
        kind === "mail" &&
        (current.reputation === null || BigInt(String(current.reputation["version"])) < 1n)
      )
        return undefined;
      return result.replay.metadata;
    },
  };
  return runCommand(db, command);
}
export async function readPromotionMailSource(context: CatalogContext, raw: unknown) {
  const input = parse(promotionMailInput, raw),
    { db } = await routeOrganization(context, input.organizationId);
  const rows = (
    await db
      .prepare(
        `SELECT secret.environment_id,secret.ciphertext,secret.nonce,secret.value_sha256,secret.key_version
 FROM product_provider_mutation_claims claim JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id AND intent.event_type=claim.event_type
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 JOIN environment_secrets secret ON secret.organization_id=intent.organization_id AND secret.project_id=intent.project_id AND secret.environment_id=intent.source_environment_id AND secret.name='OHMYHOST_MAIL_KEY'
 JOIN mail_gateway_keys key ON key.organization_id=secret.organization_id AND key.project_id=secret.project_id AND key.key_sha256=secret.value_sha256
 WHERE claim.claim_id=?5 AND claim.organization_id=?1 AND claim.project_id=?2 AND claim.environment_id=?3 AND claim.operation_id=?4 AND claim.event_type='DeploymentPromotionRequestedV1' AND operation.state IN ('queued','running')`,
      )
      .bind(...params(input), input.operationId, input.claimId)
      .all()
  ).results;
  const row: Row | undefined = rows[0];
  if (row === undefined) return null;
  const ciphertext = bytesOf(row["ciphertext"]),
    nonce = bytesOf(row["nonce"]),
    sha = bytesOf(row["value_sha256"]);
  if (
    rows.length !== 1 ||
    ciphertext.byteLength < 17 ||
    nonce.byteLength !== 12 ||
    sha.byteLength !== 32
  )
    throw new PlatformKeyConflict("mail");
  return {
    environmentId: String(row["environment_id"]),
    ciphertext,
    nonce,
    valueSha256: sha,
    keyVersion: integer(row["key_version"], 1),
  };
}
