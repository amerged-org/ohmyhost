import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyFailure, guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { bytesOf } from "../platform-support.js";
import {
  instant,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import {
  nativeDomainPreparationGuard,
  snapshotNativeDomainPolicies,
} from "../identity/native-auth-domain-snapshot.js";
import {
  domainPolicyExecutionGuards,
  paidDomainAuthorityGuards,
} from "../identity/native-auth-domain-sync.js";
import { handoffAuthorityInput } from "../identity/handoff-effect.js";
import { shiftStored } from "../../timestamps.js";
const scope = { organizationId: ulid, projectId: ulid };
/** An unproven reservation holds its name against other unproven claims for this long, then frees it. */
const UNPROVEN_RESERVATION_MS = 7 * 24 * 60 * 60 * 1000;
/** A project holds at most this many pending challenges; a further hostname gets none until one is pruned or verified. */
const PENDING_PROOF_CAP = 10;
const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);
const digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u)
  .transform((value) => Uint8Array.from(Buffer.from(value.slice(7), "hex")));
const gateway = z.string().nullable();
const apply = z.strictObject({
  ...scope,
  hostname,
  gatewayScriptName: gateway,
  principalId: z.string().min(1).max(256),
  idempotencyKeySha256: digest,
  requestSha256: digest,
  now: instant,
  auditEventId: ulid,
});
type Row = Record<string, unknown>;
const same = (left: unknown, right: Uint8Array) =>
  left !== null && Buffer.from(bytesOf(left)).equals(Buffer.from(right));
function named(name: string, message = name) {
  const error = new Error(message);
  error.name = name;
  return error;
}
function record(row: Row | null) {
  if (!row) return null;
  return {
    organizationId: row["organization_id"],
    projectId: row["project_id"],
    hostname: row["hostname"],
    gatewayScriptName: row["gateway_script_name"],
    state: row["state"],
    customHostnameReceipt:
      row["custom_hostname_receipt"] === null
        ? null
        : JSON.parse(String(row["custom_hostname_receipt"])),
    workerRouteReceipt:
      row["worker_route_receipt"] === null ? null : JSON.parse(String(row["worker_route_receipt"])),
    hostnameProven: row["hostname_proven_at"] !== null,
  };
}
const read = (db: CatalogContext["directory"], i: { organizationId: string; projectId: string }) =>
  db
    .prepare("SELECT * FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2")
    .bind(i.organizationId, i.projectId)
    .first<Row>();

/** Original current active Prod deployment/routing receipt, not a mere project-region label. */
export async function readPaidDomainTarget(context: CatalogContext, raw: unknown) {
  const i = z.strictObject(scope).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = (
    await db
      .prepare(
        `SELECT CASE WHEN d.production_domain=p.handle||'.check.omh.st' THEN 'ohmyho-gateway-production' WHEN d.production_domain IN(p.handle||'.dev.check.omh.st',p.handle||'.poc.aixyte.com') THEN 'ohmyho-gateway-poc-private-fullstack' END gateway_script_name
 FROM projects p JOIN environments e ON e.organization_id=p.organization_id AND e.project_id=p.project_id AND e.name='prod' AND e.active_deployment_id IS NOT NULL
 JOIN cloudflare_project_domains d USING(organization_id,project_id)
 JOIN deployments deployment ON deployment.organization_id=e.organization_id AND deployment.project_id=e.project_id AND deployment.deployment_id=e.active_deployment_id AND deployment.active_revision_id=e.active_revision_id AND deployment.status='succeeded'
 JOIN deployment_revisions revision ON revision.organization_id=deployment.organization_id AND revision.project_id=deployment.project_id AND revision.deployment_id=deployment.deployment_id AND revision.revision_id=deployment.active_revision_id
 JOIN effective_wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id AND receipt.shared_gateway_revision IS NOT NULL AND receipt.deployment_url='https://'||d.production_domain
 JOIN shared_gateway_route_revisions route ON route.organization_id=e.organization_id AND route.project_id=e.project_id AND route.environment_id=e.environment_id AND route.revision=receipt.shared_gateway_revision AND route.active=1 AND route.candidate_receipt_id=receipt.candidate_receipt_id AND route.handle=p.handle AND route.public_origin=receipt.deployment_url
 WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND d.deleted_at IS NULL AND d.zone_name='omh.st'`,
      )
      .bind(i.organizationId, i.projectId)
      .all()
  ).results;
  if (rows.length === 1) return { gatewayScriptName: rows[0]?.["gateway_script_name"] };
  const undeployed = await db
    .prepare(
      "SELECT 1 FROM projects p JOIN environments e USING(organization_id,project_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active' AND e.name='prod' AND e.active_deployment_id IS NULL",
    )
    .bind(i.organizationId, i.projectId)
    .first();
  return undeployed ? "production_deployment_required" : null;
}
export async function readPaidDomainRecord(context: CatalogContext, raw: unknown) {
  const i = z.strictObject(scope).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  return record(await read(db, i));
}

export async function claimPaidDomainApply(context: CatalogContext, raw: unknown) {
  const i = apply.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    key = Buffer.from(i.idempotencyKeySha256).toString("hex");
  return runCommand(db, {
    name: "cloudflare.paid.claimApply",
    input: i,
    naturalKeyTables: ["paid_project_domains"],
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      // The project's own verified Paid proof for exactly this hostname is the ownership proof; its mail identity is not.
      const proof = await reader
        .prepare(
          "SELECT 1 FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND state='verified' AND expires_at>?4",
        )
        .bind(i.organizationId, i.projectId, i.hostname, i.now)
        .first();
      const proven = proof !== null;
      return {
        previous: await read(reader, i),
        proven,
        // A proven claim is refused only by a proven hold; an unproven claim also by a reservation younger than seven days.
        hostnameHeld: await reader
          .prepare(
            "SELECT 1 FROM paid_project_domains WHERE hostname=?1 AND state NOT IN('deleted','displaced') AND NOT(organization_id=?2 AND project_id=?3) AND (hostname_proven_at IS NOT NULL OR (?4=0 AND created_at>?5))",
          )
          .bind(
            i.hostname,
            i.organizationId,
            i.projectId,
            proven ? 1 : 0,
            shiftStored(i.now, -UNPROVEN_RESERVATION_MS),
          )
          .first(),
        retired: await reader
          .prepare(
            "SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND event_type='PaidDomainConnectionRetired' AND json_extract(payload,'$.applyIdempotencySha256')=?3 LIMIT 1",
          )
          .bind(i.organizationId, i.projectId, key)
          .first(),
      };
    },
    decide: (s) => {
      const old = s.previous;
      if (s.hostnameHeld)
        return {
          reject: named(
            "PaidDomainHostnameTakenError",
            "Paid domain hostname is held by another project",
          ),
        };
      if (s.retired)
        return {
          reject: named(
            "PaidDomainKeyConflictError",
            "Paid domain command conflicts with a retired connection",
          ),
        };
      if (
        i.gatewayScriptName === null &&
        old &&
        !["deleted", "displaced"].includes(String(old["state"])) &&
        old["gateway_script_name"] !== null
      )
        return { reject: named("PaidDomainProductionDeploymentRequiredError") };
      const retarget =
        !!old &&
        old["state"] === "active" &&
        old["hostname"] === i.hostname &&
        old["gateway_script_name"] === `g-p-${i.projectId.toLowerCase()}-prod` &&
        i.gatewayScriptName === "ohmyho-gateway-production" &&
        !same(old["apply_idempotency_sha256"], i.idempotencyKeySha256);
      // A displaced connection starts again as a fresh one; a deleted one does so under a new key.
      const freshConnection =
        old?.["state"] === "displaced" ||
        (old?.["state"] === "deleted" &&
          !same(old["apply_idempotency_sha256"], i.idempotencyKeySha256));
      // A connection that waited for its proof is completed by the same owner's later apply, under any key.
      const proofUpgrade =
        !!old &&
        s.proven &&
        old["hostname"] === i.hostname &&
        old["hostname_proven_at"] === null &&
        ["awaiting_deployment", "pending", "displaced"].includes(String(old["state"]));
      // The same member's live connection of this hostname, asked again under a fresh key, is the same request: it is
      // answered with that connection, which keeps its original key. Nothing is written and no provider object is made.
      if (
        old &&
        !retarget &&
        !freshConnection &&
        !proofUpgrade &&
        old["hostname"] === i.hostname &&
        old["configured_by_principal_id"] === i.principalId &&
        ["awaiting_deployment", "pending", "active"].includes(String(old["state"])) &&
        !same(old["apply_idempotency_sha256"], i.idempotencyKeySha256)
      )
        return { replay: { ...record(old), gatewayRetarget: false, sameConnection: true } };
      if (
        old &&
        !retarget &&
        !freshConnection &&
        (["deleted", "deleting"].includes(String(old["state"])) ||
          old["hostname"] !== i.hostname ||
          old["configured_by_principal_id"] !== i.principalId ||
          (!proofUpgrade &&
            (!same(old["apply_idempotency_sha256"], i.idempotencyKeySha256) ||
              !same(old["apply_request_sha256"], i.requestSha256))))
      ) {
        // A key that already belongs to this connection, with another request, is a reused key.
        if (same(old["apply_idempotency_sha256"], i.idempotencyKeySha256))
          return {
            reject: named(
              "PaidDomainKeyConflictError",
              "Paid domain apply conflicts with durable state",
            ),
          };
        // A fresh key meets the connection being deleted, or another hostname's or member's live connection.
        return {
          reject:
            old["state"] === "deleting"
              ? named("PaidDomainDeletingError", "Paid domain connection is being deleted")
              : named(
                  "PaidDomainAlreadyConfiguredError",
                  "Project already holds another Paid domain connection",
                ),
        };
      }
      const audit =
        old &&
        ((old["state"] === "deleted" &&
          !same(old["apply_idempotency_sha256"], i.idempotencyKeySha256)) ||
          retarget);
      const payload = old
        ? JSON.stringify(
            retarget
              ? {
                  hostname: old["hostname"],
                  previousGatewayScriptName: old["gateway_script_name"],
                  gatewayScriptName: i.gatewayScriptName,
                  applyIdempotencySha256: Buffer.from(
                    bytesOf(old["apply_idempotency_sha256"]),
                  ).toString("hex"),
                  retargetIdempotencySha256: key,
                }
              : {
                  hostname: old["hostname"],
                  applyIdempotencySha256: Buffer.from(
                    bytesOf(old["apply_idempotency_sha256"]),
                  ).toString("hex"),
                  ...(old["delete_idempotency_sha256"] === null
                    ? {}
                    : {
                        deleteIdempotencySha256: Buffer.from(
                          bytesOf(old["delete_idempotency_sha256"]),
                        ).toString("hex"),
                      }),
                },
          )
        : "{}";
      return {
        statements: [
          // A proven claim displaces the unproven connections of other projects for this hostname, in the same batch as
          // its own write and only when that write stores the proof.
          db
            .prepare(
              "UPDATE paid_project_domains SET state='displaced',updated_at=?4 WHERE hostname=?1 AND state IN('awaiting_deployment','pending') AND hostname_proven_at IS NULL AND NOT(organization_id=?2 AND project_id=?3) AND EXISTS(SELECT 1 FROM paid_hostname_proofs proof WHERE proof.organization_id=?2 AND proof.project_id=?3 AND proof.hostname=?1 AND proof.state='verified' AND proof.expires_at>?4)",
            )
            .bind(i.hostname, i.organizationId, i.projectId, i.now),
          guard(
            db,
            "precondition_changed",
            old
              ? `NOT EXISTS(SELECT 1 FROM paid_project_domains WHERE ${Object.keys(old)
                  .map((column, index) => `"${column}" IS ?${index + 1}`)
                  .join(" AND ")})`
              : "EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2)",
            old ? Object.values(old) : [i.organizationId, i.projectId],
          ),
          ...(audit
            ? [
                db
                  .prepare(
                    "INSERT INTO audit_events(organization_id,audit_event_id,project_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at) SELECT organization_id,?3,project_id,active_billing_epoch_id,?4,'principal',?5,?6,?7 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active'",
                  )
                  .bind(
                    i.organizationId,
                    i.projectId,
                    i.auditEventId,
                    retarget ? "PaidDomainGatewayRetargetRequested" : "PaidDomainConnectionRetired",
                    i.principalId,
                    payload,
                    i.now,
                  ),
              ]
            : []),
          db
            .prepare(
              `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at,hostname_proven_at)
 SELECT organization_id,project_id,?3,?4,CASE WHEN ?4 IS NULL THEN 'awaiting_deployment' ELSE 'pending' END,?5,?6,?7,?8,?8,CASE WHEN ?4 IS NULL THEN NULL ELSE ?8 END,CASE WHEN EXISTS(SELECT 1 FROM paid_hostname_proofs proof WHERE proof.organization_id=?1 AND proof.project_id=?2 AND proof.hostname=?3 AND proof.state='verified' AND proof.expires_at>?8) THEN ?8 END FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active'
 ON CONFLICT(organization_id,project_id) DO UPDATE SET hostname_proven_at=CASE WHEN paid_project_domains.state='deleted' THEN excluded.hostname_proven_at ELSE coalesce(paid_project_domains.hostname_proven_at,excluded.hostname_proven_at) END,hostname=excluded.hostname,gateway_script_name=excluded.gateway_script_name,state=CASE WHEN paid_project_domains.state IN('deleted','awaiting_deployment') OR paid_project_domains.hostname_proven_at IS NULL THEN excluded.state ELSE 'active' END,configured_by_principal_id=excluded.configured_by_principal_id,apply_idempotency_sha256=excluded.apply_idempotency_sha256,apply_request_sha256=excluded.apply_request_sha256,custom_hostname_receipt=CASE paid_project_domains.state WHEN 'deleted' THEN NULL ELSE paid_project_domains.custom_hostname_receipt END,worker_route_receipt=CASE paid_project_domains.state WHEN 'deleted' THEN NULL ELSE paid_project_domains.worker_route_receipt END,delete_idempotency_sha256=NULL,delete_request_sha256=NULL,deleted_at=NULL,created_at=CASE WHEN paid_project_domains.state IN('deleted','displaced') THEN excluded.created_at ELSE paid_project_domains.created_at END,provisioning_started_at=CASE WHEN paid_project_domains.state IN('deleted','awaiting_deployment') OR paid_project_domains.hostname_proven_at IS NULL THEN excluded.provisioning_started_at ELSE paid_project_domains.provisioning_started_at END,updated_at=excluded.updated_at
 WHERE(paid_project_domains.state='awaiting_deployment' AND excluded.gateway_script_name IS NOT NULL AND paid_project_domains.apply_idempotency_sha256=excluded.apply_idempotency_sha256 AND paid_project_domains.apply_request_sha256=excluded.apply_request_sha256 AND paid_project_domains.configured_by_principal_id=excluded.configured_by_principal_id AND paid_project_domains.hostname=excluded.hostname) OR paid_project_domains.state='displaced' OR(paid_project_domains.apply_idempotency_sha256<>excluded.apply_idempotency_sha256 AND(paid_project_domains.state='deleted' OR(paid_project_domains.state='active' AND paid_project_domains.hostname=excluded.hostname AND paid_project_domains.gateway_script_name='g-p-'||lower(paid_project_domains.project_id)||'-prod' AND excluded.gateway_script_name='ohmyho-gateway-production'))) OR(paid_project_domains.hostname_proven_at IS NULL AND excluded.hostname_proven_at IS NOT NULL AND paid_project_domains.hostname=excluded.hostname AND paid_project_domains.state IN('awaiting_deployment','pending','displaced') AND paid_project_domains.configured_by_principal_id=excluded.configured_by_principal_id)`,
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.hostname,
              i.gatewayScriptName,
              i.principalId,
              i.idempotencyKeySha256,
              i.requestSha256,
              i.now,
            ),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND gateway_script_name IS ?4 AND configured_by_principal_id=?5 AND apply_idempotency_sha256=?6 AND apply_request_sha256=?7 AND state NOT IN('deleted','deleting'))",
            [
              i.organizationId,
              i.projectId,
              i.hostname,
              i.gatewayScriptName,
              i.principalId,
              i.idempotencyKeySha256,
              i.requestSha256,
            ],
          ),
          db
            .prepare(
              "SELECT d.*,EXISTS(SELECT 1 FROM audit_events a WHERE a.organization_id=d.organization_id AND a.project_id=d.project_id AND a.event_type='PaidDomainGatewayRetargetRequested' AND json_extract(a.payload,'$.hostname')=d.hostname AND json_extract(a.payload,'$.retargetIdempotencySha256')=lower(hex(d.apply_idempotency_sha256))) gateway_retarget FROM paid_project_domains d WHERE d.organization_id=?1 AND d.project_id=?2",
            )
            .bind(i.organizationId, i.projectId),
        ],
        result: (results) => {
          const row = results.at(-1)?.results[0];
          if (!row) throw named("PaidDomainKeyConflictError");
          return {
            ...record(row),
            gatewayRetarget: row["gateway_retarget"] === 1,
            sameConnection: false,
          };
        },
      };
    },
    lookup: async (reader) => {
      const row = await read(reader, i);
      if (!row) return undefined;
      // Another key's row is not this command's committed twin: the claim is decided again and names its own conflict.
      if (!same(row["apply_idempotency_sha256"], i.idempotencyKeySha256)) return undefined;
      if (
        row["hostname"] !== i.hostname ||
        row["gateway_script_name"] !== i.gatewayScriptName ||
        row["configured_by_principal_id"] !== i.principalId ||
        !same(row["apply_request_sha256"], i.requestSha256) ||
        ["deleted", "deleting"].includes(String(row["state"]))
      )
        throw named("PaidDomainKeyConflictError");
      const audit = await reader
        .prepare(
          "SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND event_type='PaidDomainGatewayRetargetRequested' AND json_extract(payload,'$.hostname')=?3 AND json_extract(payload,'$.retargetIdempotencySha256')=?4 LIMIT 1",
        )
        .bind(i.organizationId, i.projectId, i.hostname, key)
        .first();
      return { ...record(row), gatewayRetarget: audit !== null, sameConnection: false };
    },
  });
}

export async function putPaidDomainActive(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        ...scope,
        hostname,
        gatewayScriptName: z.string(),
        idempotencyKeySha256: digest,
        requestSha256: digest,
        customHostnameReceipt: z.unknown(),
        workerRouteReceipt: z.unknown(),
        now: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const results = await db.batch([
    db
      .prepare(
        "UPDATE paid_project_domains SET state='active',custom_hostname_receipt=?7,worker_route_receipt=?8,updated_at=?9 WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND state IN('pending','active') AND apply_idempotency_sha256=?4 AND apply_request_sha256=?5 AND gateway_script_name=?6 AND configured_by_principal_id IS NOT NULL RETURNING *",
      )
      .bind(
        i.organizationId,
        i.projectId,
        i.hostname,
        i.idempotencyKeySha256,
        i.requestSha256,
        i.gatewayScriptName,
        JSON.stringify(i.customHostnameReceipt),
        JSON.stringify(i.workerRouteReceipt),
        i.now,
      ),
    guard(db, "precondition_changed", "changes()<>1"),
  ]);
  return record(results[0]?.results[0] ?? null);
}
export async function claimPaidDomainDelete(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        ...scope,
        hostname,
        principalId: z.string().min(1).max(256),
        delegation: handoffAuthorityInput.optional(),
        idempotencyKeySha256: digest,
        requestSha256: digest,
        now: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    key = Buffer.from(i.idempotencyKeySha256).toString("hex");
  const originalInput = JSON.stringify({
    hostname: i.hostname,
    requestSha256: Buffer.from(i.requestSha256).toString("hex"),
    principalId: i.principalId,
    ...(i.delegation === undefined ? {} : { delegation: i.delegation }),
  });
  const rows = await db
    .batch([
      ...paidDomainAuthorityGuards(db, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        principalId: i.principalId,
        ...(i.delegation === undefined ? {} : { delegation: i.delegation }),
      }),
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND event_type='PaidDomainConnectionRetired' AND json_extract(payload,'$.deleteIdempotencySha256')=?3)",
        [i.organizationId, i.projectId, key],
      ),
      nativeDomainPreparationGuard(db, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        originPredicate:
          "realm.canonical_origin='https://'||?3 AND EXISTS(SELECT 1 FROM paid_project_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?3 AND d.state='active')",
        originValues: [i.hostname],
      }),
      ...snapshotNativeDomainPolicies(db, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        kind: "paid_delete",
        identity: key,
        originalInput,
        // A deleted connection opens no policy operation: its own delete already settled the one it made.
        parentPredicate:
          "EXISTS(SELECT 1 FROM paid_project_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?6 AND d.state IN('awaiting_deployment','pending','active','deleting'))",
        originPredicate:
          "realm.canonical_origin='https://'||?5 AND EXISTS(SELECT 1 FROM paid_project_domains d WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?5 AND d.state='active')",
        originValues: [i.hostname],
      }),
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state<>'deleted') AND NOT EXISTS(SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=?3 AND original_input=?4)",
        [i.organizationId, i.projectId, key, originalInput],
      ),
      db
        .prepare(
          "UPDATE paid_project_domains SET state='deleting',delete_idempotency_sha256=?4,delete_request_sha256=?5,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND state IN('awaiting_deployment','pending','active','displaced')",
        )
        .bind(
          i.organizationId,
          i.projectId,
          i.hostname,
          i.idempotencyKeySha256,
          i.requestSha256,
          i.now,
        ),
      // The hostname's ownership proof ends with its connection: a later connection of it needs a new proof. A deleted
      // connection has ended already, so a repeated delete leaves a proof that was declared since untouched.
      db
        .prepare(
          "DELETE FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND NOT EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state='deleted')",
        )
        .bind(i.organizationId, i.projectId, i.hostname),
      // A live connection must be this hostname's and this key's. A deleted one answers a fresh key as deleted; only the
      // same key with another request, or another hostname, is a reused key.
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND((state<>'deleted' AND(hostname<>?3 OR delete_idempotency_sha256 IS NOT ?4 OR delete_request_sha256 IS NOT ?5)) OR(state='deleted' AND delete_idempotency_sha256 IS ?4 AND(hostname<>?3 OR delete_request_sha256 IS NOT ?5))))",
        [i.organizationId, i.projectId, i.hostname, i.idempotencyKeySha256, i.requestSha256],
      ),
      db
        .prepare("SELECT * FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2")
        .bind(i.organizationId, i.projectId),
    ])
    .catch(async (error: unknown) => {
      const failure = classifyFailure(error);
      if (failure.kind === "guard" && failure.code === "precondition_changed")
        throw await paidDeleteConflict(db, i);
      throw error;
    });
  return record(rows.at(-1)?.results[0] ?? null);
}

/**
 * The conflict a refused delete names: a key that already retired this connection, the deletion of another key, or a
 * live connection of another hostname. Only the same key with a changed request stays a reused key. The batch has already
 * passed its authority guards when a precondition fails, so this read names the state it refused.
 */
async function paidDeleteConflict(
  db: CatalogContext["directory"],
  i: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly hostname: string;
    readonly idempotencyKeySha256: Uint8Array;
  },
) {
  const retired = await db
    .prepare(
      "SELECT 1 FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND event_type='PaidDomainConnectionRetired' AND json_extract(payload,'$.deleteIdempotencySha256')=?3 LIMIT 1",
    )
    .bind(i.organizationId, i.projectId, Buffer.from(i.idempotencyKeySha256).toString("hex"))
    .first();
  const row = retired === null ? await read(db, i) : null;
  if (row !== null && !same(row["delete_idempotency_sha256"], i.idempotencyKeySha256)) {
    if (row["state"] === "deleting")
      return named("PaidDomainDeletingError", "Paid domain connection is being deleted");
    if (row["state"] !== "deleted" && row["hostname"] !== i.hostname)
      return named(
        "PaidDomainAlreadyConfiguredError",
        "Project already holds another Paid domain connection",
      );
  }
  return named("PaidDomainKeyConflictError", "Paid domain delete conflicts with durable state");
}
export async function markPaidDomainDeleted(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ ...scope, hostname, idempotencyKeySha256: digest.optional(), now: instant })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const parent = await db
    .prepare(
      `SELECT pending.identity FROM paid_project_domains d JOIN native_auth_domain_operations pending ON pending.organization_id=d.organization_id AND pending.project_id=d.project_id AND pending.kind='paid_delete' AND pending.identity=lower(hex(d.delete_idempotency_sha256)) AND pending.state='pending' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?3`,
    )
    .bind(i.organizationId, i.projectId, i.hostname)
    .first<{ identity: string }>();
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "EXISTS(SELECT 1 FROM paid_project_domains d JOIN native_auth_domain_operations pending ON pending.organization_id=d.organization_id AND pending.project_id=d.project_id AND pending.kind='paid_delete' AND pending.identity=lower(hex(d.delete_idempotency_sha256)) WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?3 AND ( ?4 IS NULL OR d.delete_idempotency_sha256 IS NOT ?4))",
      [i.organizationId, i.projectId, i.hostname, i.idempotencyKeySha256 ?? null],
    ),
    ...(parent === null
      ? [
          guard(
            db,
            "precondition_changed",
            `EXISTS(SELECT 1 FROM paid_project_domains d JOIN native_auth_domain_operations pending ON pending.organization_id=d.organization_id AND pending.project_id=d.project_id AND pending.kind='paid_delete' AND pending.identity=lower(hex(d.delete_idempotency_sha256)) AND pending.state='pending' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?3)`,
            [i.organizationId, i.projectId, i.hostname],
          ),
        ]
      : await domainPolicyExecutionGuards(db, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          kind: "paid_delete",
          identity: parent.identity,
        })),
    guard(
      db,
      "precondition_changed",
      `EXISTS(SELECT 1 FROM paid_project_domains d JOIN native_auth_domain_policy_syncs s ON s.organization_id=d.organization_id AND s.project_id=d.project_id AND s.kind='paid_delete' AND s.identity=lower(hex(d.delete_idempotency_sha256)) WHERE d.organization_id=?1 AND d.project_id=?2 AND d.hostname=?3 AND s.state='pending')`,
      [i.organizationId, i.projectId, i.hostname],
    ),
    db
      .prepare(
        "UPDATE paid_project_domains SET state='deleted',updated_at=CASE WHEN state='deleted' THEN updated_at ELSE ?4 END,deleted_at=coalesce(deleted_at,?4) WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND state IN('deleting','deleted')",
      )
      .bind(i.organizationId, i.projectId, i.hostname, i.now),
    guard(db, "precondition_changed", "changes()<>1"),
    db
      .prepare(
        `UPDATE native_auth_domain_operations SET state='completed' WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete' AND identity=(SELECT lower(hex(delete_idempotency_sha256)) FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND hostname=?3) AND state='pending'`,
      )
      .bind(i.organizationId, i.projectId, i.hostname),
  ]);
}
export async function claimPaidProjectDeletion(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ ...scope, operationId: ulid, now: instant }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    key = Uint8Array.from(
      createHash("sha256")
        .update(`ohmyhost.paid-domain-project-deletion/v1:${i.operationId}`)
        .digest(),
    );
  const rows = await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM product_command_intents intent JOIN projects p USING(organization_id,project_id) JOIN operations o ON o.organization_id=intent.organization_id AND o.project_id=intent.project_id AND o.operation_id=intent.operation_id WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.operation_id=?3 AND intent.event_type='ProjectDeletionRequestedV1' AND p.lifecycle_state='deleting' AND p.owner_state='active' AND o.state IN('queued','running'))",
      [i.organizationId, i.projectId, i.operationId],
    ),
    db
      .prepare(
        "UPDATE paid_project_domains SET state='deleting',delete_idempotency_sha256=?3,delete_request_sha256=?3,updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND state IN('awaiting_deployment','pending','active','displaced')",
      )
      .bind(i.organizationId, i.projectId, key, i.now),
    db
      .prepare(
        "SELECT * FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state<>'deleted'",
      )
      .bind(i.organizationId, i.projectId),
    // The project's ownership proofs end with it: a later connection of any of its hostnames needs a new proof.
    db
      .prepare("DELETE FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2")
      .bind(i.organizationId, i.projectId),
  ]);
  return record(rows[2]?.results[0] ?? null);
}

/** A Paid hostname's ownership proof as the Worker reads it; `null` when there is none. */
function proofRecord(row: Row | null | undefined) {
  if (!row) return null;
  return {
    organizationId: row["organization_id"],
    projectId: row["project_id"],
    hostname: row["hostname"],
    state: row["state"],
    challengeName: row["challenge_name"],
    challengeValue: row["challenge_value"],
    declaredAt: publicTimestamp(String(row["declared_at"])),
    verifiedAt: row["verified_at"] === null ? null : publicTimestamp(String(row["verified_at"])),
    expiresAt: row["expires_at"] === null ? null : publicTimestamp(String(row["expires_at"])),
  };
}

const proofChallenge = z.string().regex(/^omh-domain-v1=[A-Za-z0-9_-]{43}$/u);

/**
 * The proof of a hostname, or, for `hostname: null`, the project's latest pending challenge declared within the
 * seven-day hold. A Paid status shows that challenge while the project has no connection of its own.
 */
export async function readPaidDomainProof(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ ...scope, hostname: hostname.nullable(), now: instant }).parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const row =
    i.hostname === null
      ? await db
          .prepare(
            "SELECT * FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND state='pending' AND declared_at>?3 ORDER BY declared_at DESC LIMIT 1",
          )
          .bind(i.organizationId, i.projectId, shiftStored(i.now, -UNPROVEN_RESERVATION_MS))
          .first<Row>()
      : await db
          .prepare(
            "SELECT * FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3",
          )
          .bind(i.organizationId, i.projectId, i.hostname)
          .first<Row>();
  return proofRecord(row);
}

/** Issues the challenge of a hostname once; a repeat returns the challenge already issued. Nothing for an inactive project. */
export async function ensurePaidDomainProof(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ ...scope, hostname, challengeValue: proofChallenge, now: instant })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    // Pending challenges older than the hold, of hostnames that are not the connection's, make room first.
    db
      .prepare(
        "DELETE FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND state='pending' AND declared_at<=?3 AND hostname IS NOT (SELECT hostname FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2)",
      )
      .bind(i.organizationId, i.projectId, shiftStored(i.now, -UNPROVEN_RESERVATION_MS)),
    db
      .prepare(
        "INSERT INTO paid_hostname_proofs(organization_id,project_id,hostname,state,challenge_name,challenge_value,declared_at) SELECT organization_id,project_id,?3,'pending','_omh-project.'||?3,?4,?5 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active' AND(SELECT count(*) FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND state='pending')<?6 ON CONFLICT(organization_id,project_id,hostname) DO NOTHING",
      )
      .bind(i.organizationId, i.projectId, i.hostname, i.challengeValue, i.now, PENDING_PROOF_CAP),
    db
      .prepare(
        "SELECT * FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3",
      )
      .bind(i.organizationId, i.projectId, i.hostname),
  ]);
  return proofRecord(rows[2]?.results[0] as Row | undefined);
}

/**
 * Verifies a hostname's challenge, exactly as observed: a pending challenge, or a verified one whose window has ended,
 * takes the same value again. Returns the proof only when this call verified it.
 */
export async function verifyPaidDomainProof(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({
        ...scope,
        hostname,
        challengeValue: proofChallenge,
        now: instant,
        expiresAt: instant,
      })
      .parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const rows = await db.batch([
    db
      .prepare(
        "UPDATE paid_hostname_proofs SET state='verified',verified_at=?4,expires_at=?5 WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND challenge_value=?6 AND(state='pending' OR(state='verified' AND expires_at<=?4))",
      )
      .bind(i.organizationId, i.projectId, i.hostname, i.now, i.expiresAt, i.challengeValue),
    db
      .prepare(
        "SELECT * FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3 AND verified_at=?4 AND expires_at=?5",
      )
      .bind(i.organizationId, i.projectId, i.hostname, i.now, i.expiresAt),
  ]);
  return proofRecord(rows[1]?.results[0] as Row | undefined);
}
