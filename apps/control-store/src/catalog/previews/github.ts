import { z } from "zod";
import type { CatalogContext } from "../common.js";
import { instant, routeOrganization, ulid } from "../common.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import {
  customerScope,
  customerGuards,
  scopeGuard,
  scopeRow,
  fail,
  nowOf,
  type PreviewRow,
} from "./common.js";
import { acceptedPreviewSourceStatements } from "./source.js";

const claim = z.strictObject({
  inboxEventId: ulid,
  claimId: ulid,
  now: instant.optional(),
  clock: z.literal("execution").optional(),
});
const branch = z.string().startsWith("refs/heads/").min(12).max(1035);
const accept = claim.extend({
  organizationId: ulid,
  projectId: ulid,
  sourceConnectionId: ulid,
  sourceGeneration: z.number().int().positive().safe(),
  expectedSequence: z.number().int().nonnegative().safe(),
  branchRef: branch,
  configGeneration: z.number().int().positive().safe().nullable(),
  observedDefaultBranch: branch.nullable(),
  observedHead: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
});
const EVENT = `SELECT payload FROM webhook_inbox WHERE inbox_event_id=?1 AND claim_id=?2 AND provider='github' AND event_type='push' AND state='processing' AND lease_expires_at>?3`;
const CANDIDATES = `SELECT p.organization_id,p.project_id,g.source_connection_id,COALESCE(b.generation,s.revision) source_generation,
 cfg.branch_ref,cfg.generation config_generation,g.github_installation_id,g.external_repository_id,g.repository_owner,g.repository_name,
 COALESCE(h.sequence,0) expected_sequence
 FROM repository_grants g JOIN projects p ON p.organization_id=g.organization_id AND p.project_id=g.project_id AND p.owner_state='active' AND p.lifecycle_state='active' AND p.active_billing_epoch_id=g.billing_epoch_id
 JOIN organizations o ON o.organization_id=p.organization_id AND o.state='active' AND o.beta_admitted_at IS NOT NULL
 JOIN billing_epochs ep ON ep.organization_id=p.organization_id AND ep.project_id=p.project_id AND ep.billing_epoch_id=p.active_billing_epoch_id AND ep.ended_at IS NULL
 LEFT JOIN project_source_bindings b ON b.organization_id=p.organization_id AND b.project_id=p.project_id AND b.source_connection_id=g.source_connection_id AND b.provider='github'
 LEFT JOIN project_sources s ON s.organization_id=p.organization_id AND s.project_id=p.project_id AND s.grant_id=g.grant_id AND s.provider='github' AND s.state='ready' AND NOT EXISTS(SELECT 1 FROM project_source_bindings selected WHERE selected.organization_id=p.organization_id AND selected.project_id=p.project_id)
 LEFT JOIN github_auto_deploy_configs cfg ON cfg.organization_id=p.organization_id AND cfg.project_id=p.project_id AND cfg.source_connection_id=g.source_connection_id
 LEFT JOIN project_preview_source_heads h ON h.organization_id=p.organization_id AND h.project_id=p.project_id
 WHERE g.provider='github' AND (b.source_connection_id IS NOT NULL OR s.source_id IS NOT NULL)
 AND g.github_installation_id=?1 AND g.external_repository_id=?2 AND lower(g.repository_owner)=lower(?3) AND lower(g.repository_name)=lower(?4)
 AND EXISTS(SELECT 1 FROM project_previews preview WHERE preview.organization_id=p.organization_id AND preview.project_id=p.project_id AND preview.retirement='none')
 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations r WHERE r.grant_id=g.grant_id)`;
function payload(row: PreviewRow | null) {
  if (!row) fail("github_claim_unavailable");
  const v = JSON.parse(String(row["payload"])) as Record<string, unknown>,
    full = String(v["repositoryFullName"]),
    parts = full.split("/");
  if (
    !/^[1-9][0-9]{0,19}$/u.test(String(v["installationId"])) ||
    !/^[1-9][0-9]{0,15}$/u.test(String(v["repositoryId"])) ||
    parts.length !== 2 ||
    !/^[A-Za-z0-9-]{1,39}$/u.test(parts[0] ?? "") ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(parts[1] ?? "") ||
    !branch.safeParse(v["ref"]).success ||
    v["deleted"] !== false ||
    !/^(?!0{40}$)[0-9a-f]{40}$/u.test(String(v["commitSha"]))
  )
    fail("github_push_invalid");
  return {
    rawPayload: String(row["payload"]),
    installationId: String(v["installationId"]),
    repositoryId: String(v["repositoryId"]),
    owner: parts[0] as string,
    name: parts[1] as string,
    branchRef: String(v["ref"]),
    commitSha: String(v["commitSha"]),
  };
}
function candidate(row: PreviewRow) {
  return {
    organizationId: String(row["organization_id"]),
    projectId: String(row["project_id"]),
    sourceConnectionId: String(row["source_connection_id"]),
    sourceGeneration: Number(row["source_generation"]),
    expectedSequence: Number(row["expected_sequence"]),
    branchRef: row["branch_ref"] === null ? null : String(row["branch_ref"]),
    configGeneration: row["config_generation"] === null ? null : Number(row["config_generation"]),
    installationId: String(row["github_installation_id"]),
    repositoryId: String(row["external_repository_id"]),
    repositoryFullName: `${String(row["repository_owner"])}/${String(row["repository_name"])}`,
  };
}

/** Only existing live previews need the optional provider-head fast path for a verified push. */
export async function readGithubPreviewCandidates(context: CatalogContext, raw: unknown) {
  const i = claim.parse(raw),
    now = nowOf(i),
    db = context.directory,
    event = payload(
      await db.prepare(EVENT).bind(i.inboxEventId, i.claimId, now).first<PreviewRow>(),
    );
  const rows = (
    await db
      .prepare(CANDIDATES)
      .bind(event.installationId, event.repositoryId, event.owner, event.name)
      .all<PreviewRow>()
  ).results;
  return rows.map(candidate).filter((r) => r.branchRef === null || r.branchRef === event.branchRef);
}
/** The trusted fetcher confirmed this exact branch head; CAS prevents an older observation overtaking a newer one. */
export async function acceptGithubPreviewSource(context: CatalogContext, raw: unknown) {
  const i = accept.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "projectPreview.acceptGithubSource",
    input: i,
    retryOn: [],
    naturalKeyTables: ["project_preview_source_events"],
    read: async (reader) => {
      const event = payload(
        await reader.prepare(EVENT).bind(i.inboxEventId, i.claimId, now).first<PreviewRow>(),
      );
      const rows = (
        await reader
          .prepare(`${CANDIDATES} AND p.organization_id=?5 AND p.project_id=?6`)
          .bind(
            event.installationId,
            event.repositoryId,
            event.owner,
            event.name,
            i.organizationId,
            i.projectId,
          )
          .all<PreviewRow>()
      ).results;
      const old = await reader
        .prepare(
          "SELECT sequence,source_connection_id,source_generation,commit_sha FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2 AND event_id=?3",
        )
        .bind(i.organizationId, i.projectId, `github:${i.inboxEventId}`)
        .first<PreviewRow>();
      return { event, row: rows[0], old };
    },
    decide: ({ event, row, old }) => {
      if (!row) fail("github_target_changed");
      const selected = candidate(row);
      if (
        selected.sourceConnectionId !== i.sourceConnectionId ||
        selected.sourceGeneration !== i.sourceGeneration ||
        selected.configGeneration !== i.configGeneration ||
        event.branchRef !== i.branchRef ||
        event.commitSha !== i.observedHead ||
        (selected.branchRef === null
          ? i.observedDefaultBranch !== i.branchRef
          : selected.branchRef !== i.branchRef)
      )
        fail("github_target_changed");
      if (old) {
        if (
          old["source_connection_id"] !== i.sourceConnectionId ||
          Number(old["source_generation"]) !== i.sourceGeneration ||
          old["commit_sha"] !== i.observedHead
        )
          fail("github_replay_conflict");
        return { replay: { sequence: Number(old["sequence"]), accepted: false } };
      }
      if (selected.expectedSequence !== i.expectedSequence) fail("github_head_changed");
      const matches = `SELECT 1 FROM (${CANDIDATES}) c WHERE c.organization_id=?5 AND c.project_id=?6 AND c.source_connection_id=?7 AND c.source_generation=?8 AND c.expected_sequence=?9 AND c.config_generation IS ?10 AND c.branch_ref IS ?11`;
      return {
        statements: [
          guard(db, "precondition_changed", `NOT EXISTS(${EVENT} AND payload=?4)`, [
            i.inboxEventId,
            i.claimId,
            now,
            event.rawPayload,
          ]),
          guard(db, "precondition_changed", `NOT EXISTS(${matches})`, [
            event.installationId,
            event.repositoryId,
            event.owner,
            event.name,
            i.organizationId,
            i.projectId,
            i.sourceConnectionId,
            i.sourceGeneration,
            i.expectedSequence,
            i.configGeneration,
            selected.branchRef,
          ]),
          db
            .prepare(
              "UPDATE project_source_bindings SET commit_sha=?4,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND source_connection_id=?3 AND generation=?6 AND provider='github'",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.sourceConnectionId,
              i.observedHead,
              now,
              i.sourceGeneration,
            ),
          ...acceptedPreviewSourceStatements(db, {
            organizationId: i.organizationId,
            projectId: i.projectId,
            eventId: `github:${i.inboxEventId}`,
            sourceConnectionId: i.sourceConnectionId,
            sourceGeneration: i.sourceGeneration,
            commitSha: i.observedHead,
            now,
          }),
        ],
        result: () => ({ sequence: i.expectedSequence + 1, accepted: true }),
      };
    },
    lookup: async (reader) => {
      const r = await reader
        .prepare(
          "SELECT sequence,source_connection_id,source_generation,commit_sha FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2 AND event_id=?3",
        )
        .bind(i.organizationId, i.projectId, `github:${i.inboxEventId}`)
        .first<PreviewRow>();
      return r &&
        r["source_connection_id"] === i.sourceConnectionId &&
        Number(r["source_generation"]) === i.sourceGeneration &&
        r["commit_sha"] === i.observedHead
        ? { sequence: Number(r["sequence"]), accepted: false }
        : undefined;
    },
  });
}

const initialInput = customerScope.extend({
  sourceConnectionId: ulid,
  sourceGeneration: z.number().int().positive().safe(),
  expectedSequence: z.number().int().nonnegative().safe(),
  branchRef: branch,
  configGeneration: z.number().int().positive().safe().nullable(),
  observedDefaultBranch: branch.nullable(),
  observedHead: z.string().regex(/^(?!0{40}$)[0-9a-f]{40}$/u),
});
const SELECT_PROJECT =
  CANDIDATES.slice(0, CANDIDATES.indexOf(" WHERE g.provider='github'")) +
  ` WHERE g.provider='github' AND (b.source_connection_id IS NOT NULL OR s.source_id IS NOT NULL) AND p.organization_id=?1 AND p.project_id=?2 AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations r WHERE r.grant_id=g.grant_id)`;
/** For an existing GitHub project with no observed source head, request one trusted branch observation. */
export async function readInitialGithubPreviewCandidate(context: CatalogContext, raw: unknown) {
  const i = customerScope.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId),
    scope = await scopeRow(db, i, now),
    guards = await customerGuards(db, i, String(scope["environment_id"]), "projects:write");
  const results = await db.batch([
    ...guards,
    scopeGuard(db, i, scope, now),
    db.prepare(SELECT_PROJECT).bind(i.organizationId, i.projectId),
  ]);
  const row = results.at(-1)?.results[0] as PreviewRow | undefined;
  return row ? candidate(row) : null;
}
/** Initializes only a missing/currently different source head, under customer and exact-head CAS guards. */
export async function acceptInitialGithubPreviewSource(context: CatalogContext, raw: unknown) {
  const i = initialInput.parse(raw),
    now = nowOf(i),
    { db } = await routeOrganization(context, i.organizationId),
    eventId = `github-initial:${i.sourceConnectionId}:${i.sourceGeneration}:${i.expectedSequence}:${i.observedHead}`;
  return runCommand(db, {
    name: "projectPreview.acceptInitialGithubSource",
    input: {
      organizationId: i.organizationId,
      projectId: i.projectId,
      sourceConnectionId: i.sourceConnectionId,
      sourceGeneration: i.sourceGeneration,
      expectedSequence: i.expectedSequence,
      branchRef: i.branchRef,
      observedHead: i.observedHead,
    },
    retryOn: [],
    naturalKeyTables: ["project_preview_source_events"],
    read: async (reader) => {
      const scope = await scopeRow(reader, i, now),
        guards = await customerGuards(reader, i, String(scope["environment_id"]), "projects:write"),
        row = await reader
          .prepare(SELECT_PROJECT)
          .bind(i.organizationId, i.projectId)
          .first<PreviewRow>(),
        head = await reader
          .prepare(
            "SELECT * FROM project_preview_source_heads WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(i.organizationId, i.projectId)
          .first<PreviewRow>();
      return { scope, guards, row, head };
    },
    decide: ({ scope, guards, row, head }) => {
      if (!row) fail("github_target_changed");
      const selected = candidate(row);
      if (
        selected.sourceConnectionId !== i.sourceConnectionId ||
        selected.sourceGeneration !== i.sourceGeneration ||
        selected.configGeneration !== i.configGeneration ||
        (selected.branchRef === null
          ? i.observedDefaultBranch !== i.branchRef
          : selected.branchRef !== i.branchRef)
      )
        fail("github_target_changed");
      if (
        head &&
        head["source_connection_id"] === i.sourceConnectionId &&
        Number(head["source_generation"]) === i.sourceGeneration
      ) {
        if (head["commit_sha"] === i.observedHead)
          return { replay: { sequence: Number(head["sequence"]), accepted: false } };
      }
      if (selected.expectedSequence !== i.expectedSequence) fail("github_head_changed");
      const selectedSql = `SELECT 1 FROM (${SELECT_PROJECT}) c WHERE c.source_connection_id=?3 AND c.source_generation=?4 AND c.expected_sequence=?5 AND c.config_generation IS ?6 AND c.branch_ref IS ?7`;
      return {
        statements: [
          ...guards,
          scopeGuard(db, i, scope, now),
          guard(db, "precondition_changed", `NOT EXISTS(${selectedSql})`, [
            i.organizationId,
            i.projectId,
            i.sourceConnectionId,
            i.sourceGeneration,
            i.expectedSequence,
            i.configGeneration,
            selected.branchRef,
          ]),
          db
            .prepare(
              "UPDATE project_source_bindings SET commit_sha=?4,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND source_connection_id=?3 AND generation=?6 AND provider='github'",
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.sourceConnectionId,
              i.observedHead,
              now,
              i.sourceGeneration,
            ),
          ...acceptedPreviewSourceStatements(db, {
            organizationId: i.organizationId,
            projectId: i.projectId,
            eventId,
            sourceConnectionId: i.sourceConnectionId,
            sourceGeneration: i.sourceGeneration,
            commitSha: i.observedHead,
            now,
          }),
        ],
        result: () => ({ sequence: i.expectedSequence + 1, accepted: true }),
      };
    },
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          "SELECT sequence FROM project_preview_source_events WHERE organization_id=?1 AND project_id=?2 AND event_id=?3",
        )
        .bind(i.organizationId, i.projectId, eventId)
        .first<{ sequence: number }>();
      return row ? { sequence: row.sequence, accepted: false } : undefined;
    },
  });
}
