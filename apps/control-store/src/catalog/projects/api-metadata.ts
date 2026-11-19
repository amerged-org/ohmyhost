import { z } from "zod";
import { normalizeProjectNotes } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import {
  conflict,
  instant,
  publicTimestamp,
  routeOrganization,
  sha256Hex,
  ulid,
  type CatalogContext,
} from "../common.js";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid });
const mutation = scope.extend({
  principalId: z.string().min(1).max(256),
  idempotencyKey: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value === value.trim() && !/\p{Cc}/u.test(value)),
  canonicalRequestDigest: sha256Hex,
  now: instant,
  eventId: ulid,
});
const OWNED = `SELECT p.active_billing_epoch_id epoch FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`;
const values = (input: z.output<typeof scope>) => [input.organizationId, input.projectId];
const noteSql = `SELECT notes.version,notes.markdown,notes.updated_at FROM projects p LEFT JOIN project_agent_notes notes ON notes.project_id=p.project_id WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state IN('active','deleting')`;
export async function readProjectNotes(context: CatalogContext, raw: unknown) {
  const input = scope.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(noteSql)
      .bind(...values(input))
      .first<{ version: number | null; markdown: string | null; updated_at: string | null }>();
  return row === null
    ? null
    : {
        version: row.version ?? 0,
        markdown: row.markdown ?? "",
        updatedAt: row.updated_at === null ? null : publicTimestamp(row.updated_at),
      };
}
const noteFingerprint = `json_object('epoch',(SELECT epoch FROM(${OWNED})),'note',(SELECT json_object('version',version,'markdown',markdown,'updated_at',updated_at) FROM project_agent_notes WHERE project_id=?2),'receipt',(SELECT json_object('digest',lower(hex(request_sha256)),'version',version,'updated_at',updated_at) FROM project_agent_note_requests WHERE organization_id=?1 AND project_id=?2 AND actor_id=?3 AND idempotency_key=?4))`;
interface NoteSnapshot {
  epoch: string | null;
  note: { version: number; markdown: string; updated_at: string } | null;
  receipt: { digest: string; version: number; updated_at: string } | null;
}
export async function writeProjectNotes(context: CatalogContext, raw: unknown) {
  const input = mutation
      .extend({
        expectedVersion: z.number().int().min(0).max(2147483646),
        markdown: z.string().refine((value) => normalizeProjectNotes(value) === value),
      })
      .parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    params = [...values(input), input.principalId, input.idempotencyKey];
  return runCommand(db, {
    name: "api.writeProjectNotes",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_agent_notes", "project_agent_note_requests"],
    read: async (reader) => {
      const row = await reader
        .prepare(`SELECT ${noteFingerprint} value`)
        .bind(...params)
        .first<{ value: string }>();
      if (!row) throw new Error("Project notes snapshot unavailable");
      return { text: row.value, data: JSON.parse(row.value) as NoteSnapshot };
    },
    decide: ({ text, data }) => {
      if (data.epoch === null) throw conflict("project_notes_scope");
      if (data.receipt !== null) {
        if (data.receipt.digest !== input.canonicalRequestDigest)
          throw conflict("project_notes_idempotency");
        return {
          replay: {
            version: data.receipt.version,
            updatedAt: publicTimestamp(data.receipt.updated_at),
          },
        };
      }
      if ((data.note?.version ?? 0) !== input.expectedVersion)
        throw conflict("project_notes_version");
      const version = input.expectedVersion + 1;
      return {
        statements: [
          guard(db, "precondition_changed", `(${noteFingerprint}) IS NOT ?5`, [...params, text]),
          db
            .prepare(
              "INSERT INTO project_agent_notes(project_id,version,markdown,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,markdown=excluded.markdown,updated_at=excluded.updated_at",
            )
            .bind(input.projectId, version, input.markdown, input.now),
          db
            .prepare(
              "INSERT INTO project_agent_note_requests(organization_id,project_id,actor_id,idempotency_key,request_sha256,version,updated_at) VALUES(?1,?2,?3,?4,unhex(?5),?6,?7)",
            )
            .bind(...params, input.canonicalRequestDigest, version, input.now),
          db
            .prepare(
              "INSERT INTO audit_events(audit_event_id,organization_id,project_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,'ProjectNotesUpdated',?4,?5,?6,?7,?8)",
            )
            .bind(
              input.eventId,
              input.organizationId,
              input.projectId,
              input.principalId.startsWith("user:") ? "user" : "service",
              input.principalId,
              generatedJsonb({ version }),
              input.now,
              data.epoch,
            ),
        ],
        result: () => ({ version, updatedAt: publicTimestamp(input.now) }),
      };
    },
  });
}
export async function readProjectStorageJurisdiction(
  context: CatalogContext,
  raw: unknown,
): Promise<"us" | "eu" | null> {
  const input = scope.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    rows = (
      await db
        .prepare(
          `SELECT p.region,(SELECT json_group_array(jurisdiction) FROM(SELECT jurisdiction FROM project_r2_bucket_receipts WHERE organization_id=?1 AND project_id=?2 UNION SELECT jurisdiction FROM project_r2_bucket_reservations WHERE organization_id=?1 AND project_id=?2)) jurisdictions FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active'`,
        )
        .bind(...values(input))
        .all<{ region: string; jurisdictions: string }>()
    ).results,
    row = rows[0];
  if (!row) return null;
  const regions = JSON.parse(row.jurisdictions) as string[];
  if (regions.length > 1) throw conflict("project_r2_bucket_conflict");
  const result = regions[0] ?? row.region;
  if (result !== "us" && result !== "eu") throw conflict("project_r2_bucket_conflict");
  return result;
}
const FLAG = `SELECT flag.enabled_at FROM projects p LEFT JOIN project_powered_by_flag_periods flag ON flag.project_id=p.project_id AND flag.organization_id=p.organization_id AND flag.disabled_at IS NULL WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active' AND p.lifecycle_state='active'`;
export async function readPoweredByFlag(context: CatalogContext, raw: unknown) {
  const input = scope.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(FLAG)
      .bind(...values(input))
      .first<{ enabled_at: string | null }>();
  return row === null
    ? null
    : {
        enabled: row.enabled_at !== null,
        enabledAt: row.enabled_at === null ? null : publicTimestamp(row.enabled_at),
      };
}
const flagFingerprint = `json_object('epoch',(SELECT epoch FROM(${OWNED})),'open',(SELECT json_object('period',period_id,'organization',organization_id,'enabled_at',enabled_at) FROM project_powered_by_flag_periods WHERE project_id=?2 AND disabled_at IS NULL),'receipt',(SELECT json_object('digest',lower(hex(request_sha256)),'enabled',enabled,'enabled_at',enabled_at) FROM project_powered_by_flag_requests WHERE organization_id=?1 AND project_id=?2 AND actor_id=?3 AND idempotency_key=?4),'dependent',EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state IN('awaiting_deployment','pending','active') AND deleted_at IS NULL),'paidUntil',(SELECT paid_until FROM credit_account WHERE organization_id=?1))`;
interface FlagSnapshot {
  epoch: string | null;
  open: { period: string; organization: string; enabled_at: string } | null;
  receipt: { digest: string; enabled: number; enabled_at: string | null } | null;
  dependent: number;
  /** Until when the organization is Paid; Paid features and the flag-free domain need it to be in the future. */
  paidUntil: string | null;
}
export async function setPoweredByFlag(context: CatalogContext, raw: unknown) {
  const input = mutation.extend({ enabled: z.boolean(), periodId: ulid }).parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    params = [...values(input), input.principalId, input.idempotencyKey];
  return runCommand(db, {
    name: "api.setPoweredByFlag",
    input,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_powered_by_flag_periods", "project_powered_by_flag_requests"],
    read: async (reader) => {
      const row = await reader
        .prepare(`SELECT ${flagFingerprint} value`)
        .bind(...params)
        .first<{ value: string }>();
      if (!row) throw new Error("Flag snapshot unavailable");
      return { text: row.value, data: JSON.parse(row.value) as FlagSnapshot };
    },
    decide: ({ text, data }) => {
      if (data.epoch === null) return { replay: null };
      if (data.receipt !== null) {
        if (data.receipt.digest !== input.canonicalRequestDigest)
          throw conflict("powered_by_flag_idempotency");
        return {
          replay: {
            enabled: data.receipt.enabled === 1,
            enabledAt:
              data.receipt.enabled_at === null ? null : publicTimestamp(data.receipt.enabled_at),
          },
        };
      }
      const ownOpen = data.open?.organization === input.organizationId,
        changed = input.enabled ? !ownOpen : ownOpen;
      // A paid domain without the flag needs Paid coverage that runs past this instant.
      if (
        !input.enabled &&
        ownOpen &&
        data.dependent === 1 &&
        (data.paidUntil === null || data.paidUntil <= input.now)
      )
        throw conflict("powered_by_flag_required");
      const result = input.enabled
        ? {
            enabled: true,
            enabledAt: publicTimestamp(
              ownOpen && data.open !== null ? data.open.enabled_at : input.now,
            ),
          }
        : { enabled: false, enabledAt: null };
      const writes = [
        guard(db, "precondition_changed", `(${flagFingerprint}) IS NOT ?5`, [...params, text]),
      ];
      if (data.open !== null && (!input.enabled || !ownOpen))
        writes.push(
          db
            .prepare("UPDATE project_powered_by_flag_periods SET disabled_at=?2 WHERE period_id=?1")
            .bind(data.open.period, input.now),
        );
      if (input.enabled && !ownOpen)
        writes.push(
          db
            .prepare(
              "INSERT INTO project_powered_by_flag_periods(period_id,organization_id,project_id,enabled_at) VALUES(?1,?2,?3,?4)",
            )
            .bind(input.periodId, input.organizationId, input.projectId, input.now),
        );
      if (changed)
        writes.push(
          db
            .prepare(
              "INSERT INTO audit_events(audit_event_id,organization_id,project_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,'ProjectPoweredByFlagSetV1',?4,?5,?6,?7,?8)",
            )
            .bind(
              input.eventId,
              input.organizationId,
              input.projectId,
              input.principalId.startsWith("user:") ? "user" : "service",
              input.principalId,
              generatedJsonb({ enabled: input.enabled }),
              input.now,
              data.epoch,
            ),
        );
      writes.push(
        db
          .prepare(
            "INSERT INTO project_powered_by_flag_requests(organization_id,project_id,actor_id,idempotency_key,request_sha256,enabled,enabled_at,recorded_at) VALUES(?1,?2,?3,?4,unhex(?5),?6,?7,?8)",
          )
          .bind(
            ...params,
            input.canonicalRequestDigest,
            input.enabled ? 1 : 0,
            input.enabled
              ? ownOpen && data.open !== null
                ? data.open.enabled_at
                : input.now
              : null,
            input.now,
          ),
      );
      return { statements: writes, result: () => result };
    },
  });
}
