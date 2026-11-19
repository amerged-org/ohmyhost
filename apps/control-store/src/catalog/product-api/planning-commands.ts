import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  addMilliseconds,
  conflict,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { bytes, hex, iso, text, type Row } from "../provisioning/context-values.js";
import { OrganizationCreditError } from "../billing/errors.js";
import { paidDenial, readAccount, type AccountView } from "../credit/index.js";
const digest = z
  .unknown()
  .transform(bytes)
  .refine((v) => v.byteLength === 32, "Digest must contain32bytes");
const exactTime = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
  .pipe(instant);
const cleanText = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v);
const confirmation = z
  .strictObject({
    confirmationId: ulid,
    organizationId: ulid,
    projectId: ulid,
    issuedToPrincipalId: cleanText.max(255),
    action: z.enum(["rollback", "promote", "delete", "data_change"]),
    targetDeploymentId: ulid.optional(),
    subjectEtag: cleanText.max(255),
    tokenDigest: digest,
    issuedAt: exactTime,
  })
  .refine(
    (i) =>
      (i.action === "rollback" || i.action === "promote") === (i.targetDeploymentId !== undefined),
  );
/** Original confirmation identity and source generation are inserted together; replay compares every immutable field. */
export async function issueApiActionConfirmation(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = confirmation.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    expires = addMilliseconds(i.issuedAt, 600000);
  type S = { generation: number | null; existing: Row | undefined };
  return runCommand<S, "created" | "existing">(db, {
    name: "productApi.issueActionConfirmation",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["action_confirmations"],
    read: async (reader) => {
      const [source, existing] = await reader.batch([
        reader
          .prepare(
            "SELECT COALESCE((SELECT generation FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2),0) generation",
          )
          .bind(i.organizationId, i.projectId),
        reader
          .prepare("SELECT * FROM action_confirmations WHERE confirmation_id=?1")
          .bind(i.confirmationId),
      ]);
      return {
        generation:
          i.action === "rollback" || i.action === "promote"
            ? Number(source?.results[0]?.["generation"] ?? 0)
            : null,
        existing: existing?.results[0],
      };
    },
    decide: ({ generation, existing }) => {
      if (existing !== undefined) {
        const equal =
          existing["organization_id"] === i.organizationId &&
          existing["project_id"] === i.projectId &&
          existing["issued_to_principal_id"] === i.issuedToPrincipalId &&
          existing["action"] === i.action &&
          existing["target_deployment_id"] === (i.targetDeploymentId ?? null) &&
          existing["subject_etag"] === i.subjectEtag &&
          hex(existing["token_sha256"]) === hex(i.tokenDigest) &&
          iso(existing["created_at"]) === iso(i.issuedAt) &&
          iso(existing["expires_at"]) === iso(expires) &&
          existing["source_generation"] === generation;
        return equal
          ? { replay: "existing" as const }
          : {
              reject: conflict("deployment_persistence_conflict"),
            };
      }
      return {
        statements: [
          ...(generation === null
            ? []
            : [
                guard(
                  db,
                  "precondition_changed",
                  "COALESCE((SELECT generation FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2),0)<>?3",
                  [i.organizationId, i.projectId, generation],
                ),
              ]),
          apiActionConfirmationStatement(db, i, generation),
        ],
        result: () => "created" as const,
      };
    },
  });
}
const usable = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  principalId: cleanText,
  action: z.enum(["delete", "rollback", "promote"]),
  targetDeploymentId: ulid.optional(),
  subjectEtag: cleanText,
  tokenDigest: digest,
  now: exactTime,
});
/** Same original preflight check; the accepting command independently consumes the exact confirmation atomically. */
export async function requireApiUsableConfirmation(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const i = usable.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const r = await db
    .prepare(
      "SELECT expires_at FROM action_confirmations WHERE organization_id=?1 AND project_id=?2 AND issued_to_principal_id=?3 AND action=?4 AND target_deployment_id IS ?5 AND subject_etag=?6 AND token_sha256=?7 AND consumed_at IS NULL",
    )
    .bind(
      i.organizationId,
      i.projectId,
      i.principalId,
      i.action,
      i.targetDeploymentId ?? null,
      i.subjectEtag,
      i.tokenDigest,
    )
    .first<Row>();
  if (r === null) throw new Error("confirmation_invalid");
  if (String(r["expires_at"]) <= i.now) throw new Error("confirmation_expired");
}
const plan = z.strictObject({
  planId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  sourceConnectionId: ulid,
  sourceGeneration: z.number().int().positive().optional(),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  sourceDigest: digest,
  buildPlanDigest: digest,
  planDigest: digest,
  runtime: cleanText,
  frameworkPlan: z.unknown().transform(parseNewProductionFrameworkPlan),
  impacts: z.array(z.string()).readonly(),
  risks: z.array(z.string()).readonly(),
  costEstimate: z.record(z.string(), z.unknown()),
  createdAt: exactTime,
});
const DB_NOW = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
const MAIL_CONFIGURED = `(EXISTS(SELECT 1 FROM project_mail_domain_bindings mail JOIN workspace_mail_domains sender ON sender.domain_id=mail.mail_domain_id AND sender.organization_id=mail.organization_id
 LEFT JOIN project_application_domain_identities identity ON identity.project_id=mail.project_id AND identity.organization_id=mail.organization_id
 WHERE mail.organization_id=?1 AND mail.project_id=?2 AND mail.sending=1 AND mail.state='active' AND sender.status='active'
 AND(mail.legacy=1 OR(identity.state='verified' AND identity.expires_at>${DB_NOW} AND identity.revision=mail.application_identity_revision AND identity.registrable_domain=sender.registrable_domain))
 AND EXISTS(SELECT 1 FROM environments e WHERE e.environment_id=mail.environment_id AND e.project_id=mail.project_id AND e.name='prod'))
 OR EXISTS(SELECT 1 FROM resend_mail_domains receiver JOIN workspace_mail_domains sender ON sender.legacy_domain_id=receiver.domain_id AND sender.organization_id=receiver.organization_id AND sender.status='active'
 JOIN projects receiver_project ON receiver_project.project_id=receiver.project_id AND receiver_project.organization_id=receiver.organization_id AND receiver_project.lifecycle_state='active'
 JOIN environments e ON e.organization_id=receiver.organization_id AND e.project_id=receiver.project_id AND e.environment_id=receiver.environment_id AND e.name='prod'
 WHERE receiver.organization_id=?1 AND receiver.project_id=?2 AND receiver.deleted_at IS NULL AND receiver.receiving=1 AND receiver.webhook_verified_at IS NOT NULL))`;
const PLAN_AUTHORITY = `SELECT project.owner_state,binding.generation source_generation,${MAIL_CONFIGURED} mail_configured
 FROM projects project JOIN repository_grants grant_record ON grant_record.organization_id=project.organization_id AND grant_record.project_id=project.project_id AND grant_record.source_connection_id=?3
 LEFT JOIN project_source_bindings binding ON binding.organization_id=project.organization_id AND binding.project_id=project.project_id AND binding.source_connection_id=?3
 WHERE project.organization_id=?1 AND project.project_id=?2 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)`;
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Immutable plan writer: source generation, active grant, optional Mail/Paid access and exact replay share one batch. */
export async function createApiDeploymentPlan(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = plan.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    expires = addMilliseconds(i.createdAt, 86400000);
  type S = { authority: Row | undefined; existing: Row | undefined; account: AccountView | null };
  const command: Command<S, "created" | "existing"> = {
    name: "productApi.createDeploymentPlan",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["deployment_plans"],
    read: async (reader) => {
      const [a, e] = await reader.batch([
        reader.prepare(PLAN_AUTHORITY).bind(i.organizationId, i.projectId, i.sourceConnectionId),
        reader.prepare("SELECT * FROM deployment_plans WHERE plan_id=?1").bind(i.planId),
      ]);
      return {
        authority: a?.results[0],
        existing: e?.results[0],
        account: i.frameworkPlan.mail.enabled
          ? await readAccount(reader, i.organizationId, i.createdAt)
          : null,
      };
    },
    decide: ({ authority: a, existing: e, account }) => {
      if (a?.["owner_state"] !== "active")
        return {
          reject: conflict("deployment_persistence_conflict"),
        };
      const generation = a["source_generation"];
      if (
        typeof generation !== "number" ||
        (i.sourceGeneration !== undefined && i.sourceGeneration !== generation)
      )
        return {
          reject: conflict("deployment_persistence_conflict"),
        };
      if (i.frameworkPlan.mail.enabled) {
        if (a["mail_configured"] !== 1) return { reject: conflict("mail_domain_required") };
        if (account === null) throw new Error("Mail plan credit account is absent");
        const denied = paidDenial(account);
        if (denied !== null) return { reject: new OrganizationCreditError(denied) };
      }
      if (e !== undefined) {
        const equal =
          e["organization_id"] === i.organizationId &&
          e["project_id"] === i.projectId &&
          e["environment_id"] === i.environmentId &&
          e["source_connection_id"] === i.sourceConnectionId &&
          e["commit_sha"] === i.commitSha &&
          hex(e["source_sha256"]) === hex(i.sourceDigest) &&
          hex(e["build_plan_sha256"]) === hex(i.buildPlanDigest) &&
          hex(e["plan_sha256"]) === hex(i.planDigest) &&
          e["runtime"] === i.runtime &&
          canonicalJson(JSON.parse(text(e, "framework_plan"))) === canonicalJson(i.frameworkPlan) &&
          JSON.stringify(JSON.parse(text(e, "impacts"))) === JSON.stringify(i.impacts) &&
          JSON.stringify(JSON.parse(text(e, "risks"))) === JSON.stringify(i.risks) &&
          JSON.stringify(JSON.parse(text(e, "cost_estimate"))) === JSON.stringify(i.costEstimate) &&
          iso(e["created_at"]) === iso(i.createdAt) &&
          iso(e["expires_at"]) === iso(expires) &&
          e["source_generation"] === generation;
        return equal
          ? { replay: "existing" as const }
          : {
              reject: conflict("deployment_persistence_conflict"),
            };
      }
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM (${PLAN_AUTHORITY}) admitted WHERE owner_state='active' AND source_generation=?4 ${i.frameworkPlan.mail.enabled ? "AND mail_configured=1" : ""})`,
            [i.organizationId, i.projectId, i.sourceConnectionId, generation],
          ),
          db
            .prepare(
              "INSERT INTO deployment_plans(plan_id,organization_id,project_id,source_connection_id,commit_sha,source_sha256,build_plan_sha256,plan_sha256,runtime,framework_plan,impacts,risks,cost_estimate,created_at,expires_at,environment_id,source_generation)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            )
            .bind(
              i.planId,
              i.organizationId,
              i.projectId,
              i.sourceConnectionId,
              i.commitSha,
              i.sourceDigest,
              i.buildPlanDigest,
              i.planDigest,
              i.runtime,
              JSON.stringify(i.frameworkPlan),
              JSON.stringify(i.impacts),
              JSON.stringify(i.risks),
              JSON.stringify(i.costEstimate),
              i.createdAt,
              expires,
              i.environmentId,
              generation,
            ),
        ],
        result: () => "created" as const,
      };
    },
  };
  return runCommand(db, command);
}

export const apiActionConfirmationInput = confirmation;
/** Shared original confirmation INSERT for a larger single-batch plan compound. */
export function apiActionConfirmationStatement(
  db: D1Database,
  i: z.output<typeof confirmation>,
  generation: number | null,
) {
  return db
    .prepare(
      "INSERT INTO action_confirmations(confirmation_id,organization_id,project_id,issued_to_principal_id,action,target_deployment_id,subject_etag,token_sha256,created_at,expires_at,source_generation)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
    )
    .bind(
      i.confirmationId,
      i.organizationId,
      i.projectId,
      i.issuedToPrincipalId,
      i.action,
      i.targetDeploymentId ?? null,
      i.subjectEtag,
      i.tokenDigest,
      i.issuedAt,
      addMilliseconds(i.issuedAt, 600000),
      generation,
    );
}
