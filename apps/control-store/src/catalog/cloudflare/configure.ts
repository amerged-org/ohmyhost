import { z } from "zod";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import {
  instant,
  publicTimestamp,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";
import {
  projectDomainClaims,
  projectDomainNameReads,
  projectDomainsClaimPlan,
  type ClaimInput,
} from "../domains-mail/cloudflare-project-domains.js";
import { Buffer } from "node:buffer";
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .transform((value) => Uint8Array.from(Buffer.from(value.slice(7), "hex")));
const inputSchema = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  queuedEventId: ulid,
  startedEventId: ulid,
  succeededEventId: ulid,
  auditEventId: ulid,
  outboxEventId: ulid,
  platform: z.enum(["development", "production"]),
  principalId: z.string().min(1).max(256),
  idempotencyKeySha256: digest,
  requestSha256: digest,
  projectHandle: z.string(),
  configuredAt: instant,
  occurredAt: instant,
});
type Row = Record<string, unknown>;
/** The original domains row, successful operation/history, audit and acknowledged outbox are ONE effect. */
export async function configureGeneralCloudflareDomains(context: CatalogContext, raw: unknown) {
  const i = inputSchema.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  if (
    new Set([
      i.operationId,
      i.queuedEventId,
      i.startedEventId,
      i.succeededEventId,
      i.auditEventId,
      i.outboxEventId,
    ]).size !== 6
  )
    throw new TypeError("Domain configuration operation identity is invalid");
  const claim: ClaimInput = {
    organizationId: i.organizationId,
    projectId: i.projectId,
    proposedOperationId: i.operationId,
    platform: i.platform,
    principalId: i.principalId,
    idempotencyKeySha256: i.idempotencyKeySha256,
    requestSha256: i.requestSha256,
    configuredAt: i.configuredAt,
  };
  const existing = (reader: D1Database) =>
    reader
      .prepare(
        "SELECT d.*,p.handle current_handle,p.active_billing_epoch_id FROM cloudflare_project_domains d JOIN projects p USING(organization_id,project_id) WHERE d.organization_id=?1 AND d.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')",
      )
      .bind(i.organizationId, i.projectId)
      .first<Row>();
  const operationId = await runCommand(db, {
    name: "cloudflare.configureDomains",
    input: i,
    naturalKeyTables: ["cloudflare_project_domains", "operations", "domain_directory"],
    retryOn: ["precondition_changed", "scope_inactive", "claim_lost"],
    read: async (reader) => {
      const row = await existing(reader),
        project = await reader
          .prepare(
            "SELECT handle,active_billing_epoch_id FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active'",
          )
          .bind(i.organizationId, i.projectId)
          .first<{ handle: string; active_billing_epoch_id: string }>();
      const names = projectDomainClaims(claim, project?.handle ?? i.projectHandle, i.operationId);
      const [directory, aborts] = await reader.batch(projectDomainNameReads(reader, names));
      return {
        row,
        project,
        directory: rowsOf<{
          class: "app_prod" | "app_dev";
          domain: string;
          organization_id: string;
          project_id: string;
          state: "reserved" | "active";
          claim_id: string | null;
        }>(directory),
        aborts: rowsOf<{ class: "app_prod" | "app_dev"; domain: string; claim_id: string }>(aborts),
      };
    },
    decide: (s) => {
      // The names derive from the handle alone, so the domains a project already holds answer any later request for it.
      if (s.row) {
        if (s.row["handle"] !== i.projectHandle)
          return {
            reject: Object.assign(new Error("CloudflareProjectDomainConflictError"), {
              name: "CloudflareProjectDomainConflictError",
            }),
          };
        return { replay: String(s.row["operation_id"]) };
      }
      if (!s.project || s.project.handle !== i.projectHandle)
        return { reject: new Error("Cloudflare domain configuration is unavailable") };
      const plan = projectDomainsClaimPlan(db, claim, s.project.handle, s);
      if ("reject" in plan) return plan;
      const epoch = s.project.active_billing_epoch_id;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND active_billing_epoch_id=?3 AND owner_state='active' AND lifecycle_state='active')",
            [i.organizationId, i.projectId, epoch],
          ),
          db
            .prepare(
              "INSERT INTO operations(organization_id,operation_id,project_id,billing_epoch_id,state,created_at,updated_at) VALUES(?1,?2,?3,?4,'succeeded',?5,?5)",
            )
            .bind(i.organizationId, i.operationId, i.projectId, epoch, i.occurredAt),
          ...plan.statements,
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?5,?6,0,'OperationQueued',NULL,'{}',?7),(?1,?3,?5,?6,1,'OperationStarted',?8,'{}',?7),(?1,?4,?5,?6,2,'OperationSucceeded',?9,'{}',?7)",
            )
            .bind(
              i.organizationId,
              i.queuedEventId,
              i.startedEventId,
              i.succeededEventId,
              i.operationId,
              i.projectId,
              i.occurredAt,
              `domain-config:${i.operationId}:start`,
              `domain-config:${i.operationId}:complete`,
            ),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?1,?2,?3,?4,?5,'ProjectDomainsConfigured','principal',?6,'{}',?7)",
            )
            .bind(
              i.organizationId,
              i.auditEventId,
              i.projectId,
              i.operationId,
              epoch,
              i.principalId,
              i.occurredAt,
            ),
          db
            .prepare(
              "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,attempt_count,max_attempts,acknowledged_at) VALUES(?1,?2,?3,?4,?5,'ProjectDomainsConfiguredV1','{}',?6,?6,?6,0,1,?6)",
            )
            .bind(
              i.organizationId,
              i.outboxEventId,
              i.projectId,
              i.operationId,
              epoch,
              i.occurredAt,
            ),
        ],
        result: () => i.operationId,
      };
    },
    lookup: async (reader) => {
      const row = await existing(reader);
      if (!row) return undefined;
      if (row["handle"] !== i.projectHandle)
        throw Object.assign(new Error("CloudflareProjectDomainConflictError"), {
          name: "CloudflareProjectDomainConflictError",
        });
      return String(row["operation_id"]);
    },
  });
  const operation = await db
    .prepare(
      "SELECT project_id,state,failure,created_at,updated_at FROM operations WHERE organization_id=?1 AND operation_id=?2",
    )
    .bind(i.organizationId, operationId)
    .first<Row>();
  if (!operation || operation["project_id"] !== i.projectId)
    throw new Error("Cloudflare domain configuration operation is unavailable");
  const failure =
    operation["failure"] === null
      ? null
      : (JSON.parse(String(operation["failure"])) as { code: string; message: string });
  return {
    status: 202 as const,
    location: `/v1/operations/${operationId}`,
    body: {
      id: operationId,
      state: operation["state"],
      created_at: publicTimestamp(String(operation["created_at"])),
      updated_at: publicTimestamp(String(operation["updated_at"])),
      ...(failure ? { error: failure } : {}),
    },
  };
}
