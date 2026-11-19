import { z } from "zod";
import { runCommand } from "../../run-command.js";
import { guard } from "../../guards.js";
import { auditStatement, hexBytes, newUlid, routeOrganization, ulid } from "../common.js";
import { MANAGED_BINDING } from "../product-api/managed-source-common.js";
import { acceptedPreviewSourceStatements } from "./source.js";
import { resumeSuspendedPreview } from "./cleanup.js";
import { previewNativeDrainGuard } from "./native-auth.js";
import {
  customerGuards,
  customerRecord,
  customerScope,
  envelope,
  fail,
  nowOf,
  rowById,
  rowByScope,
  runtimeFence,
  runtimeRecord,
  scopeGuard,
  scopeRow,
  ROW,
  type PreviewRow,
} from "./common.js";
import type { CatalogContext } from "../common.js";

const read = customerScope;
const ensureInput = customerScope.extend({
  environmentId: ulid,
  previewId: ulid,
  capability: envelope,
});
const rotateInput = customerScope.extend({
  previewId: ulid,
  expectedRowVersion: z.number().int().positive().safe(),
  expectedTokenGeneration: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(256),
  capability: envelope,
});
const destroyInput = customerScope.extend({
  previewId: ulid,
  expectedRowVersion: z.number().int().positive().safe(),
  requestId: z.string().min(1).max(256),
});

function audit(
  db: Parameters<typeof auditStatement>[0],
  row: PreviewRow,
  eventType: string,
  actorId: string,
  now: string,
) {
  return auditStatement(db, String(row["organization_id"]), {
    auditEventId: newUlid(),
    projectId: String(row["project_id"]),
    operationId: null,
    billingEpochId: String(row["billing_epoch_id"]),
    eventType,
    actorType: "user",
    actorId,
    payload: {
      previewId: row["preview_id"],
      environmentId: row["environment_id"],
      tokenGeneration: row["token_generation"],
      runtimeGeneration: row["runtime_generation"],
    },
    occurredAt: now,
  });
}
function matchesScope(row: PreviewRow, scope: PreviewRow): boolean {
  return (
    row["environment_id"] === scope["environment_id"] &&
    row["data_environment_id"] === scope["data_environment_id"] &&
    row["assignment_version"] === scope["assignment_version"] &&
    row["billing_epoch_id"] === scope["billing_epoch_id"] &&
    row["ownership_version"] === scope["ownership_version"] &&
    row["lifecycle_version"] === scope["lifecycle_version"]
  );
}

/** Authorized preflight supplies the exact environment ID used in the cipher's AAD. */
export async function preparePreview(context: CatalogContext, raw: unknown) {
  const i = read.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId);
  const scope = await scopeRow(db, i, now),
    guards = await customerGuards(db, i, String(scope["environment_id"]), "projects:write");
  const results = await db.batch([
    ...guards,
    scopeGuard(db, i, scope, now),
    db
      .prepare(
        `${ROW} WHERE v.organization_id=?1 AND v.project_id=?2 AND v.environment_id=?3 AND v.retirement<>'retired'`,
      )
      .bind(i.organizationId, i.projectId, scope["environment_id"]),
  ]);
  const row = (results.at(-1)?.results[0] as PreviewRow | undefined) ?? null;
  if (row && !matchesScope(row, scope)) fail("scope_changed");
  if (row?.["retirement"] === "suspended") {
    await resumeSuspendedPreview(context, {
      previewId: String(row["preview_id"]),
      expectedRowVersion: Number(row["row_version"]),
      ...(i.now ? { now: i.now } : {}),
      ...(i.clock ? { clock: i.clock } : {}),
    });
    return preparePreview(context, raw);
  }
  return {
    environmentId: String(scope["environment_id"]),
    preview: row ? customerRecord(row) : null,
  };
}
export async function getPreview(context: CatalogContext, raw: unknown) {
  return (await preparePreview(context, raw)).preview;
}

/** A losing concurrent ensure discards its candidate and reads the winner after reauthorization. */
export async function ensurePreview(context: CatalogContext, raw: unknown) {
  const i = ensureInput.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId);
  if (i.capability.tokenGeneration !== 1) fail("generation");
  return runCommand(db, {
    name: "projectPreview.ensure",
    input: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environment: i.environment,
      principalId: i.principalId,
    },
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["project_previews", "project_preview_source_events"],
    read: async (reader) => {
      const scope = await scopeRow(reader, i, now);
      const guards = await customerGuards(
        reader,
        i,
        String(scope["environment_id"]),
        "projects:write",
      );
      if (scope["environment_id"] !== i.environmentId) fail("scope_changed");
      return {
        scope,
        guards,
        row: await rowByScope(reader, i, i.environmentId),
        binding: await reader
          .prepare(MANAGED_BINDING)
          .bind(i.organizationId, i.projectId)
          .first<PreviewRow>(),
      };
    },
    decide: ({ scope, guards, row, binding }) => {
      if (row) {
        if (!matchesScope(row, scope)) fail("scope_changed");
        return { replay: customerRecord(row) };
      }
      const seed =
        binding?.["grant_active"] === 1 && typeof binding["commit_sha"] === "string"
          ? acceptedPreviewSourceStatements(db, {
              organizationId: i.organizationId,
              projectId: i.projectId,
              eventId: `seed:${String(binding["source_connection_id"])}:${String(binding["generation"])}:${String(binding["commit_sha"])}`,
              sourceConnectionId: String(binding["source_connection_id"]),
              sourceGeneration: Number(binding["generation"]),
              commitSha: String(binding["commit_sha"]),
              now,
            })
          : [];
      return {
        statements: [
          ...guards,
          scopeGuard(db, i, scope, now),
          guard(
            db,
            "precondition_changed",
            binding === null
              ? `EXISTS(SELECT 1 FROM (${MANAGED_BINDING}))`
              : `NOT EXISTS(SELECT 1 FROM (${MANAGED_BINDING}) selected WHERE selected.source_connection_id=?3 AND selected.generation=?4 AND selected.commit_sha IS ?5 AND selected.grant_active=?6)`,
            binding === null
              ? [i.organizationId, i.projectId]
              : [
                  i.organizationId,
                  i.projectId,
                  binding["source_connection_id"],
                  binding["generation"],
                  binding["commit_sha"],
                  binding["grant_active"],
                ],
          ),
          ...seed,
          db
            .prepare(
              `INSERT INTO project_previews
    (preview_id,organization_id,project_id,environment_id,environment_name,data_environment_id,assignment_version,billing_epoch_id,ownership_version,lifecycle_version,token_lookup_sha256,token_ciphertext,token_nonce,token_key_version,token_generation,runtime_generation,auth_generation,row_version,state,retirement,target_connection_id,target_generation,target_sequence,target_commit,last_activity_at,created_at,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,1,1,1,'cold','none',
      (SELECT source_connection_id FROM project_preview_source_heads WHERE organization_id=?2 AND project_id=?3 AND source_connection_id=?16 AND source_generation=?17 AND ?18=1),
      (SELECT source_generation FROM project_preview_source_heads WHERE organization_id=?2 AND project_id=?3 AND source_connection_id=?16 AND source_generation=?17 AND ?18=1),
      (SELECT sequence FROM project_preview_source_heads WHERE organization_id=?2 AND project_id=?3 AND source_connection_id=?16 AND source_generation=?17 AND ?18=1),
      (SELECT commit_sha FROM project_preview_source_heads WHERE organization_id=?2 AND project_id=?3 AND source_connection_id=?16 AND source_generation=?17 AND ?18=1),?15,?15,?15)`,
            )
            .bind(
              i.previewId,
              i.organizationId,
              i.projectId,
              i.environmentId,
              i.environment,
              scope["data_environment_id"],
              scope["assignment_version"],
              scope["billing_epoch_id"],
              scope["ownership_version"],
              scope["lifecycle_version"],
              Array.from(hexBytes(i.capability.lookupSha256)),
              i.capability.ciphertext,
              i.capability.nonce,
              i.capability.keyVersion,
              now,
              binding?.["source_connection_id"] ?? null,
              binding?.["generation"] ?? null,
              binding?.["grant_active"] ?? 0,
            ),
          db
            .prepare(
              "INSERT INTO project_preview_source_pending(preview_id,sequence,updated_at) SELECT preview_id,target_sequence,?2 FROM project_previews WHERE preview_id=?1 AND target_sequence IS NOT NULL",
            )
            .bind(i.previewId, now),
          audit(
            db,
            { ...scope, preview_id: i.previewId, token_generation: 1, runtime_generation: 1 },
            "ProjectPreviewCreated",
            i.principalId,
            now,
          ),
        ],
        result: () => ({
          preview: {
            previewId: i.previewId,
            organizationId: i.organizationId,
            projectId: i.projectId,
            environment: i.environment,
            environmentId: i.environmentId,
            dataEnvironmentId: String(scope["data_environment_id"]),
            assignmentVersion: Number(scope["assignment_version"]),
            billingEpochId: String(scope["billing_epoch_id"]),
            ownershipVersion: Number(scope["ownership_version"]),
            lifecycleVersion: Number(scope["lifecycle_version"]),
            region: scope["region"] as "eu" | "us",
            rowVersion: 1,
            runtimeGeneration: 1,
            tokenGeneration: 1,
            authGeneration: 1,
            state: "cold" as const,
            targetSource: null,
            appliedSource: null,
            lastActivityAt: now,
            paidUntil: scope["paid_until"] === null ? null : String(scope["paid_until"]),
            retirement: "none" as const,
          },
          capability: i.capability,
        }),
      };
    },
    lookup: async (reader) => {
      const scope = await scopeRow(reader, i, now);
      await customerGuards(reader, i, String(scope["environment_id"]), "projects:write");
      const row = await rowByScope(reader, i, i.environmentId);
      if (row && !matchesScope(row, scope)) fail("scope_changed");
      return row ? customerRecord(row) : undefined;
    },
  }).then(async () => {
    const current = await preparePreview(context, {
      organizationId: i.organizationId,
      projectId: i.projectId,
      environment: i.environment,
      principalId: i.principalId,
      ...(i.delegation ? { delegation: i.delegation } : {}),
      ...(i.now ? { now: i.now } : {}),
      ...(i.clock ? { clock: i.clock } : {}),
    });
    if (!current.preview) fail("scope_unavailable");
    return current.preview;
  });
}

export async function rotatePreview(context: CatalogContext, raw: unknown) {
  const i = rotateInput.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId);
  await runCommand(db, {
    name: "projectPreview.rotate",
    input: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      previewId: i.previewId,
      requestId: i.requestId,
      expectedTokenGeneration: i.expectedTokenGeneration,
    },
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["project_preview_receipts", "project_previews"],
    read: async (reader) => {
      const scope = await scopeRow(reader, i, now),
        guards = await customerGuards(reader, i, String(scope["environment_id"]), "projects:write"),
        row = await rowById(reader, i.previewId),
        receipt = await reader
          .prepare(
            "SELECT kind,generation FROM project_preview_receipts WHERE preview_id=?1 AND request_id=?2",
          )
          .bind(i.previewId, i.requestId)
          .first<PreviewRow>();
      return { scope, guards, row, receipt };
    },
    decide: ({ scope, guards, row, receipt }) => {
      if (
        !row ||
        row["organization_id"] !== i.organizationId ||
        row["project_id"] !== i.projectId ||
        !matchesScope(row, scope)
      )
        fail("scope_unavailable");
      if (receipt) {
        if (
          receipt["kind"] !== "rotate" ||
          ![i.expectedTokenGeneration, i.expectedTokenGeneration + 1].includes(
            Number(receipt["generation"]),
          ) ||
          Number(row["token_generation"]) !== Number(receipt["generation"])
        )
          fail("request_superseded");
        return { replay: true };
      }
      if (i.capability.tokenGeneration !== i.expectedTokenGeneration + 1) fail("generation");
      if (
        row["retirement"] !== "none" ||
        Number(row["row_version"]) !== i.expectedRowVersion ||
        Number(row["token_generation"]) !== i.expectedTokenGeneration
      )
        fail("version_conflict");
      return {
        statements: [
          ...guards,
          scopeGuard(db, i, scope, now),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND row_version=?2 AND token_generation=?3 AND retirement='none')",
            [i.previewId, i.expectedRowVersion, i.expectedTokenGeneration],
          ),
          db
            .prepare(
              "UPDATE project_previews SET token_lookup_sha256=?2,token_ciphertext=?3,token_nonce=?4,token_key_version=?5,token_generation=?6,row_version=row_version+1,retirement='rotating',retirement_request_id=?7,updated_at=?8 WHERE preview_id=?1 AND row_version=?9 AND token_generation=?10 AND retirement='none'",
            )
            .bind(
              i.previewId,
              Array.from(hexBytes(i.capability.lookupSha256)),
              i.capability.ciphertext,
              i.capability.nonce,
              i.capability.keyVersion,
              i.capability.tokenGeneration,
              i.requestId,
              now,
              i.expectedRowVersion,
              i.expectedTokenGeneration,
            ),
          db
            .prepare(
              "INSERT INTO project_preview_receipts(preview_id,request_id,kind,generation) VALUES(?1,?2,'rotate',?3)",
            )
            .bind(i.previewId, i.requestId, i.capability.tokenGeneration),
          audit(db, row, "ProjectPreviewTokenRotated", i.principalId, now),
        ],
        result: () => true,
      };
    },
    lookup: async (reader) => {
      const receipt = await reader
        .prepare(
          "SELECT generation FROM project_preview_receipts WHERE preview_id=?1 AND request_id=?2 AND kind='rotate'",
        )
        .bind(i.previewId, i.requestId)
        .first<{ generation: number }>();
      return receipt &&
        [i.expectedTokenGeneration, i.expectedTokenGeneration + 1].includes(receipt.generation)
        ? true
        : undefined;
    },
  });
  const result = await preparePreview(context, {
    organizationId: i.organizationId,
    projectId: i.projectId,
    environment: i.environment,
    principalId: i.principalId,
    ...(i.delegation ? { delegation: i.delegation } : {}),
    ...(i.now ? { now: i.now } : {}),
    ...(i.clock ? { clock: i.clock } : {}),
  });
  if (
    !result.preview ||
    result.preview.preview.previewId !== i.previewId ||
    ![i.expectedTokenGeneration, i.expectedTokenGeneration + 1].includes(
      result.preview.preview.tokenGeneration,
    )
  )
    fail("request_superseded");
  return result.preview;
}

export async function destroyPreview(context: CatalogContext, raw: unknown) {
  const i = destroyInput.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId);
  await runCommand(db, {
    name: "projectPreview.destroy",
    input: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      previewId: i.previewId,
      requestId: i.requestId,
    },
    retryOn: ["precondition_changed", "consent_changed"],
    naturalKeyTables: ["project_preview_receipts"],
    read: async (reader) => {
      const scope = await scopeRow(reader, i, now, true),
        guards = await customerGuards(reader, i, String(scope["environment_id"]), "projects:write"),
        row = await rowById(reader, i.previewId),
        receipt = await reader
          .prepare(
            "SELECT kind,generation FROM project_preview_receipts WHERE preview_id=?1 AND request_id=?2",
          )
          .bind(i.previewId, i.requestId)
          .first<PreviewRow>();
      return { scope, guards, row, receipt };
    },
    decide: ({ scope, guards, row, receipt }) => {
      if (
        !row ||
        row["organization_id"] !== i.organizationId ||
        row["project_id"] !== i.projectId ||
        !matchesScope(row, scope)
      )
        fail("scope_unavailable");
      if (receipt) {
        if (
          receipt["kind"] !== "destroy" ||
          Number(receipt["generation"]) !== Number(row["runtime_generation"])
        )
          fail("request_superseded");
        return { replay: true };
      }
      if (row["retirement"] !== "none" || Number(row["row_version"]) !== i.expectedRowVersion)
        fail("version_conflict");
      const generation = Number(row["runtime_generation"]) + 1;
      return {
        statements: [
          ...guards,
          scopeGuard(db, i, scope, now, true),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND row_version=?2 AND retirement='none')",
            [i.previewId, i.expectedRowVersion],
          ),
          db
            .prepare(
              "UPDATE project_previews SET runtime_generation=?2,row_version=row_version+1,retirement='destroying',retirement_request_id=?3,updated_at=?4 WHERE preview_id=?1 AND row_version=?5 AND retirement='none'",
            )
            .bind(i.previewId, generation, i.requestId, now, i.expectedRowVersion),
          db
            .prepare(
              "INSERT INTO project_preview_receipts(preview_id,request_id,kind,generation) VALUES(?1,?2,'destroy',?3)",
            )
            .bind(i.previewId, i.requestId, generation),
          audit(db, row, "ProjectPreviewDestroyRequested", i.principalId, now),
        ],
        result: () => true,
      };
    },
    lookup: async (reader) => {
      const receipt = await reader
        .prepare(
          "SELECT generation FROM project_preview_receipts WHERE preview_id=?1 AND request_id=?2 AND kind='destroy'",
        )
        .bind(i.previewId, i.requestId)
        .first();
      return receipt ? true : undefined;
    },
  });
  const row = await rowById(db, i.previewId);
  if (!row) fail("scope_unavailable");
  return runtimeRecord(row);
}

/** Trusted API calls these only after the runtime has closed streams or confirmed exact backup deletion. */
export async function confirmPreviewRotation(context: CatalogContext, raw: unknown) {
  return confirm(context, raw, "rotating");
}
export async function confirmPreviewDestroy(context: CatalogContext, raw: unknown) {
  return confirm(context, raw, "destroying");
}
async function confirm(context: CatalogContext, raw: unknown, kind: "rotating" | "destroying") {
  const i = runtimeFence.parse(raw),
    now = nowOf(i),
    db = context.directory,
    row = await rowById(db, i.previewId);
  if (
    row &&
    kind === "rotating" &&
    row["retirement"] === "none" &&
    Number(row["runtime_generation"]) === i.runtimeGeneration + 1 &&
    Number(row["token_generation"]) === i.tokenGeneration
  ) {
    const completed = await db
      .prepare(
        "SELECT 1 FROM project_preview_receipts WHERE preview_id=?1 AND kind='rotate' AND generation=?2",
      )
      .bind(i.previewId, i.tokenGeneration)
      .first();
    if (completed) return;
  }
  if (
    !row ||
    Number(row["runtime_generation"]) !== i.runtimeGeneration ||
    Number(row["token_generation"]) !== i.tokenGeneration
  )
    fail("version_conflict");
  await routeOrganization(context, String(row["organization_id"]));
  if (row["retirement"] !== kind && row["retirement"] !== "none") fail("version_conflict");
  if (row["retirement"] === kind) {
    await db.batch([
      previewNativeDrainGuard(db, i.previewId, i.runtimeGeneration, i.tokenGeneration),
      guard(
        db,
        "precondition_changed",
        "NOT EXISTS(SELECT 1 FROM project_previews WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement=?4)",
        [i.previewId, i.runtimeGeneration, i.tokenGeneration, kind],
      ),
      guard(
        db,
        "precondition_changed",
        "EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND state='reserved')",
        [i.previewId],
      ),
      ...(kind === "destroying"
        ? [
            guard(
              db,
              "precondition_changed",
              "EXISTS(SELECT 1 FROM project_preview_backup_cleanup WHERE preview_id=?1)",
              [i.previewId],
            ),
          ]
        : []),
      db
        .prepare(
          kind === "rotating"
            ? "UPDATE project_previews SET retirement='none',retirement_request_id=NULL,row_version=row_version+1,runtime_generation=runtime_generation+1,auth_generation=auth_generation+1,state=CASE WHEN backup_handle IS NULL THEN 'cold' ELSE 'sleeping' END,updated_at=?4 WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement='rotating'"
            : "UPDATE project_previews SET retirement='none',retirement_request_id=NULL,row_version=row_version+1,state='cold',auth_generation=auth_generation+1,applied_connection_id=NULL,applied_generation=NULL,applied_sequence=NULL,applied_commit=NULL,backup_handle=NULL,backup_expires_at=NULL,backup_connection_id=NULL,backup_generation=NULL,backup_sequence=NULL,backup_commit=NULL,updated_at=?4 WHERE preview_id=?1 AND runtime_generation=?2 AND token_generation=?3 AND retirement='destroying'",
        )
        .bind(i.previewId, i.runtimeGeneration, i.tokenGeneration, now),
      db
        .prepare(
          `UPDATE project_previews SET
        target_connection_id=(SELECT h.source_connection_id FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
        target_generation=(SELECT h.source_generation FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
        target_sequence=(SELECT h.sequence FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
        target_commit=(SELECT h.commit_sha FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id),
        row_version=row_version+1 WHERE preview_id=?1 AND COALESCE(target_sequence,0)<(SELECT h.sequence FROM project_preview_source_heads h WHERE h.organization_id=project_previews.organization_id AND h.project_id=project_previews.project_id)`,
        )
        .bind(i.previewId),
      db
        .prepare(
          `INSERT INTO project_preview_source_pending(preview_id,sequence,updated_at)
        SELECT preview_id,target_sequence,?2 FROM project_previews WHERE preview_id=?1 AND target_sequence IS NOT NULL
        ON CONFLICT(preview_id) DO UPDATE SET sequence=excluded.sequence,updated_at=excluded.updated_at WHERE excluded.sequence>project_preview_source_pending.sequence`,
        )
        .bind(i.previewId, now),
    ]);
  }
  const result = await rowById(db, i.previewId);
  if (!result || result["retirement"] !== "none") fail("version_conflict");
  return;
}
