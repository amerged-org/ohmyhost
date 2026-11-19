import { z } from "zod";
import type { D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  instant,
  addMilliseconds,
  fenceRaceGuard,
  HANDLE_QUARANTINE_MILLISECONDS,
  type CatalogContext,
} from "../common.js";
import { planGatewayCompensation } from "../gateway/mutations.js";
import {
  RUN,
  terminalIdentity,
  terminalMatches,
  workflowTerminalStatements,
} from "./workflow-terminal-plan.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import {
  nativeDomainPreparationGuard,
  snapshotNativeDomainPolicies,
} from "../identity/native-auth-domain-snapshot.js";
import { handleDomainAuthorityGuards } from "../identity/native-auth-domain-sync.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
// Exact existing project-handle-words-v1 customer-chosen grammar/policy; accepted intent remains authoritative.
const prohibited = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "cloudflare",
  "dev",
  "mail",
  "ohmyho",
  "ohmyhost",
  "prod",
  "root",
  "support",
  "system",
  "www",
]);
const handle = z
  .string()
  .min(3)
  .max(59)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u)
  .refine((v) => v.split("-").every((w) => !prohibited.has(w)));
const input = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    operationId: ulid,
    requestedHandle: handle,
    moved: z.array(z.strictObject({ environmentId: ulid, publicOrigin: z.string() })),
    workflowId: z.string().min(1).max(255),
    outboxEventId: ulid,
    startedOperationEventId: ulid,
    operationEventId: ulid,
    auditEventId: ulid,
    completedAt: instant,
    reconciliationAttemptId: ulid.optional(),
    replayAttemptId: ulid.optional(),
  })
  .refine((i) => new Set(i.moved.map((m) => m.environmentId)).size === i.moved.length);
type Row = Record<string, unknown>;
const fail = (m: string) => new ProductWorkflowContextConflictError(m);
const ACTIVE = `SELECT route.revision,published.wfp_receipt_id,environment.head_version FROM environments environment JOIN deployment_revisions head ON head.organization_id=environment.organization_id AND head.project_id=environment.project_id AND head.deployment_id=environment.active_deployment_id AND head.revision_id=environment.active_revision_id JOIN wfp_publish_receipts published ON published.organization_id=head.organization_id AND published.project_id=head.project_id AND published.wfp_receipt_id=head.wfp_receipt_id AND published.environment_id=environment.environment_id JOIN shared_gateway_route_revisions route ON route.organization_id=environment.organization_id AND route.project_id=environment.project_id AND route.environment_id=environment.environment_id AND route.candidate_receipt_id=published.candidate_receipt_id AND route.active=1 AND route.operation_id=?4 AND route.handle=?5 AND route.public_origin=?6 WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3 AND NOT EXISTS(SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id=route.organization_id AND newer.project_id=route.project_id AND newer.environment_id=route.environment_id AND newer.revision>route.revision)`;
/** Claimed address, every compensation/address receipt and original terminal evidence share ONE commit. */
export async function finalizeProductHandleChange(
  context: CatalogContext,
  raw: unknown,
): Promise<"applied" | "duplicate" | "pending" | { status: "conflict"; reason: "taken" }> {
  let i = input.parse(raw);
  const { db } = await routeOrganization(context, i.organizationId);
  const saved = await db
    .prepare(
      "SELECT original_input FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3",
    )
    .bind(i.organizationId, i.projectId, i.operationId)
    .first<{ original_input: string }>();
  if (saved !== null) {
    const original = input.parse(JSON.parse(saved.original_input));
    if (
      original.organizationId !== i.organizationId ||
      original.projectId !== i.projectId ||
      original.environmentId !== i.environmentId ||
      original.operationId !== i.operationId ||
      original.requestedHandle !== i.requestedHandle ||
      original.workflowId !== i.workflowId ||
      original.outboxEventId !== i.outboxEventId ||
      JSON.stringify(original.moved) !== JSON.stringify(i.moved)
    )
      throw fail("Rename pending identity changed");
    i = original;
  }
  const terminal = { requestedHandle: i.requestedHandle, environments: i.moved.length };
  const read = async (reader: typeof db) => {
    const rows = await reader.batch([
        reader
          .prepare("SELECT * FROM projects WHERE organization_id=?1 AND project_id=?2")
          .bind(i.organizationId, i.projectId),
        reader
          .prepare(
            "SELECT 1 WHERE EXISTS(SELECT 1 FROM projects WHERE owner_state<>'transferred' AND handle=?1 AND project_id<>?2) OR EXISTS(SELECT 1 FROM project_directory WHERE handle=?1 AND project_id<>?2) OR EXISTS(SELECT 1 FROM project_handle_releases WHERE handle=?1 AND organization_id<>?3 AND quarantined_until>?4)",
          )
          .bind(i.requestedHandle, i.projectId, i.organizationId, i.completedAt),
        reader
          .prepare(
            "SELECT environment_id FROM environments WHERE organization_id=?1 AND project_id=?2 AND active_deployment_id IS NOT NULL",
          )
          .bind(i.organizationId, i.projectId),
        reader
          .prepare(
            "SELECT requested_handle FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type='ProjectHandleChangeRequestedV1'",
          )
          .bind(i.organizationId, i.projectId, i.environmentId, i.operationId),
        reader.prepare(RUN).bind(...terminalIdentity(i, i, "ProjectHandleChangeRequestedV1")),
        reader
          .prepare(
            "SELECT claim.claim_id,project.handle FROM product_provider_mutation_claims claim JOIN projects project ON project.project_id=claim.project_id AND project.owner_state<>'transferred' WHERE claim.organization_id=?1 AND claim.project_id=?2 AND claim.operation_id=?3 AND claim.event_type='ProjectHandleChangeRequestedV1' AND project.lifecycle_state='active'",
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        reader
          .prepare(
            `SELECT 1 FROM native_auth_realms realm JOIN cloudflare_project_domains d USING(organization_id,project_id) WHERE realm.organization_id=?1 AND realm.project_id=?2 AND d.deleted_at IS NULL AND d.zone_name='omh.st' AND d.handle<>?3 AND realm.canonical_origin IN ('https://'||d.production_domain,'https://'||d.development_domain) LIMIT 1`,
          )
          .bind(i.organizationId, i.projectId, i.requestedHandle),
        reader
          .prepare(
            "SELECT 1 FROM native_auth_domain_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending' LIMIT 1",
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        reader
          .prepare(
            "SELECT class,domain FROM domain_directory WHERE organization_id=?1 AND project_id=?2 AND class IN('app_prod','app_dev') AND state='active'",
          )
          .bind(i.organizationId, i.projectId),
      ]),
      project = rows[0]?.results[0] ?? null,
      canStore =
        project?.["owner_state"] === "active" &&
        project["lifecycle_state"] === "active" &&
        (rows[1]?.results.length ?? 0) === 0,
      claim = rows[5]?.results[0] ?? null,
      storedHandle = canStore
        ? i.requestedHandle
        : claim
          ? handle.parse(claim["handle"])
          : i.requestedHandle,
      moves = [] as {
        environmentId: string;
        publicOrigin: string;
        statements: D1PreparedStatement[];
      }[];
    if (!canStore && i.moved.length > 0 && !claim)
      throw fail("Rename compensation claim is unavailable");
    for (const move of i.moved) {
      if (canStore) {
        moves.push({ ...move, statements: [] });
        continue;
      }
      const latest = await reader
        .prepare(
          "SELECT revision,action,handle,public_origin FROM shared_gateway_route_revisions WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 ORDER BY revision DESC LIMIT 1",
        )
        .bind(i.organizationId, i.projectId, move.environmentId, i.operationId)
        .first<Row>();
      if (
        !latest ||
        (latest["action"] !== "activate" && latest["action"] !== "compensate") ||
        (latest["action"] === "activate" &&
          (latest["handle"] !== i.requestedHandle ||
            latest["public_origin"] !== move.publicOrigin)) ||
        (latest["action"] === "compensate" && latest["handle"] !== storedHandle)
      )
        throw fail("Rename compensation target changed");
      if (latest["action"] === "compensate")
        moves.push({
          environmentId: move.environmentId,
          publicOrigin: String(latest["public_origin"]),
          statements: [],
        });
      else {
        const p = await planGatewayCompensation(
          context,
          {
            organizationId: i.organizationId,
            projectId: i.projectId,
            environmentId: move.environmentId,
            operationId: i.operationId,
            claimId: claim?.["claim_id"],
            expectedRevision: Number(latest["revision"]),
          },
          db,
        );
        moves.push({
          environmentId: move.environmentId,
          publicOrigin: p.publicOrigin,
          statements: p.statements,
        });
      }
    }
    return {
      project,
      canStore,
      storedHandle,
      moves,
      active: rows[2]?.results ?? [],
      intent: rows[3]?.results[0] ?? null,
      run: rows[4]?.results[0] ?? null,
      affected: (rows[6]?.results.length ?? 0) > 0,
      pendingPolicy: (rows[7]?.results.length ?? 0) > 0,
      directoryDomains: rows[8]?.results ?? [],
      proof: await readWorkflowDelegation(reader, i),
      nativeOwnerGuards:
        (rows[6]?.results.length ?? 0) > 0 || saved !== null
          ? await handleDomainAuthorityGuards(reader, i)
          : [],
    };
  };
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    "applied" | "duplicate" | "pending" | { status: "conflict"; reason: "taken" }
  > = {
    name: "provisioning.finalizeHandleChange",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: [
      "shared_gateway_address_receipts",
      "shared_gateway_route_revisions",
      "operation_events",
      "audit_events",
    ],
    read,
    decide: (s) => {
      if (s.intent?.["requested_handle"] !== i.requestedHandle || !s.run)
        return { reject: fail("Project handle intent changed") };
      if (
        s.active.length !== i.moved.length ||
        s.active.some((e) => !i.moved.some((m) => m.environmentId === e["environment_id"]))
      )
        return { reject: fail("Gateway address moves are incomplete") };
      const available =
          "SELECT 1 FROM projects WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM projects taken WHERE taken.owner_state<>'transferred' AND taken.handle=?3 AND taken.project_id<>?2) AND NOT EXISTS(SELECT 1 FROM project_directory claimed WHERE claimed.handle=?3 AND claimed.project_id<>?2) AND NOT EXISTS(SELECT 1 FROM project_handle_releases released WHERE released.handle=?3 AND released.organization_id<>?1 AND released.quarantined_until>?4)",
        params = [i.organizationId, i.projectId, i.requestedHandle],
        availableParams = [...params, i.completedAt];
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        ...workflowExecutionGuards(db, i, s.proof),
        ...s.nativeOwnerGuards,
        ...(saved === null
          ? [
              guard(
                db,
                "precondition_changed",
                "EXISTS(SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3)",
                [i.organizationId, i.projectId, i.operationId],
              ),
            ]
          : []),
        guard(
          db,
          "precondition_changed",
          `${s.affected ? "NOT " : ""}EXISTS(SELECT 1 FROM native_auth_realms realm JOIN cloudflare_project_domains d USING(organization_id,project_id) WHERE realm.organization_id=?1 AND realm.project_id=?2 AND d.deleted_at IS NULL AND d.zone_name='omh.st' AND d.handle<>?3 AND realm.canonical_origin IN ('https://'||d.production_domain,'https://'||d.development_domain))`,
          [i.organizationId, i.projectId, i.requestedHandle],
        ),
        guard(
          db,
          "precondition_changed",
          `${s.canStore ? "NOT " : ""}EXISTS(${available})`,
          availableParams,
        ),
        guard(
          db,
          "precondition_changed",
          "(SELECT count(*) FROM environments WHERE organization_id=?1 AND project_id=?2 AND active_deployment_id IS NOT NULL)<>?3",
          [i.organizationId, i.projectId, i.moved.length],
        ),
      ];
      if (saved !== null && s.pendingPolicy) return { statements, result: () => "pending" };
      for (const move of i.moved)
        statements.push(
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND active_deployment_id IS NOT NULL)",
            [i.organizationId, i.projectId, move.environmentId],
          ),
        );
      const previousHandle = String(s.project?.["handle"] ?? i.requestedHandle);
      const renamed = previousHandle !== i.requestedHandle;
      if (s.canStore)
        statements.push(
          ...(renamed
            ? [
                // The Directory claims move with the rename, so the new names are unique and the old ones are released.
                // Both the projects handle and the Directory handle are released: a legacy project's Directory
                // handle can differ from projects.handle, so the release reads the Directory rows themselves.
                db
                  .prepare(
                    "INSERT INTO project_handle_releases(handle,organization_id,project_id,released_at,quarantined_until) SELECT handle,organization_id,project_id,?4,?5 FROM project_directory WHERE organization_id=?1 AND project_id=?2 AND handle<>?3 ON CONFLICT(handle) DO UPDATE SET organization_id=excluded.organization_id,project_id=excluded.project_id,released_at=excluded.released_at,quarantined_until=excluded.quarantined_until",
                  )
                  .bind(
                    i.organizationId,
                    i.projectId,
                    i.requestedHandle,
                    i.completedAt,
                    addMilliseconds(i.completedAt, HANDLE_QUARANTINE_MILLISECONDS),
                  ),
                db
                  .prepare(
                    "INSERT INTO project_handle_releases(handle,organization_id,project_id,released_at,quarantined_until) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(handle) DO UPDATE SET organization_id=excluded.organization_id,project_id=excluded.project_id,released_at=excluded.released_at,quarantined_until=excluded.quarantined_until",
                  )
                  .bind(
                    previousHandle,
                    i.organizationId,
                    i.projectId,
                    i.completedAt,
                    addMilliseconds(i.completedAt, HANDLE_QUARANTINE_MILLISECONDS),
                  ),
                db
                  .prepare(
                    "UPDATE project_directory SET handle=?3 WHERE organization_id=?1 AND project_id=?2 AND state='active'",
                  )
                  .bind(i.organizationId, i.projectId, i.requestedHandle),
                guard(db, "precondition_changed", "changes()<>1"),
                ...s.directoryDomains.flatMap((row) => {
                  const domainClass = String(row["class"]);
                  const prefix = domainClass === "app_dev" ? "dev-" : "";
                  const oldDomain = String(row["domain"]);
                  // A legacy domain row can carry a handle other than projects.handle: its own label is the one that moves.
                  const staleHandle = oldDomain.slice(prefix.length).split(".")[0] ?? "";
                  if (staleHandle === "" || !oldDomain.startsWith(`${prefix}${staleHandle}.`))
                    throw fail("Project domain directory changed");
                  const newDomain = `${prefix}${i.requestedHandle}${oldDomain.slice(prefix.length + staleHandle.length)}`;
                  return [
                    ...(staleHandle === i.requestedHandle
                      ? []
                      : [
                          db
                            .prepare(
                              "INSERT INTO project_handle_releases(handle,organization_id,project_id,released_at,quarantined_until) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(handle) DO UPDATE SET organization_id=excluded.organization_id,project_id=excluded.project_id,released_at=excluded.released_at,quarantined_until=excluded.quarantined_until",
                            )
                            .bind(
                              staleHandle,
                              i.organizationId,
                              i.projectId,
                              i.completedAt,
                              addMilliseconds(i.completedAt, HANDLE_QUARANTINE_MILLISECONDS),
                            ),
                        ]),
                    guard(
                      db,
                      "precondition_changed",
                      "EXISTS(SELECT 1 FROM domain_directory WHERE class=?1 AND domain=?2 AND NOT(organization_id=?3 AND project_id=?4))",
                      [domainClass, newDomain, i.organizationId, i.projectId],
                    ),
                    db
                      .prepare(
                        "UPDATE domain_directory SET domain=?4 WHERE class=?1 AND domain=?2 AND organization_id=?3 AND project_id=?5 AND state='active'",
                      )
                      .bind(domainClass, oldDomain, i.organizationId, newDomain, i.projectId),
                    guard(db, "precondition_changed", "changes()<>1"),
                  ];
                }),
              ]
            : []),
          ...(s.affected && saved === null
            ? [
                nativeDomainPreparationGuard(db, {
                  organizationId: i.organizationId,
                  projectId: i.projectId,
                  originPredicate:
                    "realm.canonical_origin IN (SELECT 'https://'||production_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?3 UNION SELECT 'https://'||development_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?3)",
                  originValues: [i.requestedHandle],
                }),
              ]
            : []),
          ...(s.affected && saved === null
            ? snapshotNativeDomainPolicies(db, {
                organizationId: i.organizationId,
                projectId: i.projectId,
                kind: "handle_change",
                identity: i.operationId,
                originalInput: JSON.stringify(i),
                parentPredicate: "?6 IS NOT NULL",
                originPredicate:
                  "realm.canonical_origin IN (SELECT 'https://'||production_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?5 UNION SELECT 'https://'||development_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>?5)",
                originValues: [i.requestedHandle],
              })
            : []),
          db
            .prepare(
              "UPDATE projects SET handle=?3,handle_version='customer-chosen-v1',handle_attempt=0 WHERE organization_id=?1 AND project_id=?2 AND owner_state='active' AND lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM projects taken WHERE taken.owner_state<>'transferred' AND taken.handle=?3 AND taken.project_id<>?2)",
            )
            .bind(...params),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(
              "UPDATE cloudflare_project_domains SET handle=?3,production_domain=?3||substr(production_domain,length(handle)+1),development_domain='dev-'||?3||substr(production_domain,length(handle)+1) WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st'",
            )
            .bind(...params),
        );
      for (const move of s.moves) {
        statements.push(
          ...move.statements,
          guard(db, "precondition_changed", `(SELECT count(*) FROM(${ACTIVE}))<>1`, [
            i.organizationId,
            i.projectId,
            move.environmentId,
            i.operationId,
            s.storedHandle,
            move.publicOrigin,
          ]),
          db
            .prepare(
              `INSERT INTO shared_gateway_address_receipts(organization_id,project_id,environment_id,operation_id,wfp_receipt_id,shared_gateway_revision,head_version,handle,public_origin) SELECT ?1,?2,?3,?4,target.wfp_receipt_id,target.revision,target.head_version,?5,?6 FROM(${ACTIVE}) target WHERE 1 ON CONFLICT DO NOTHING`,
            )
            .bind(
              i.organizationId,
              i.projectId,
              move.environmentId,
              i.operationId,
              s.storedHandle,
              move.publicOrigin,
            ),
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM shared_gateway_address_receipts receipt JOIN(${ACTIVE}) target ON receipt.wfp_receipt_id=target.wfp_receipt_id AND receipt.shared_gateway_revision=target.revision AND receipt.head_version=target.head_version WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.environment_id=?3 AND receipt.operation_id=?4 AND receipt.handle=?5 AND receipt.public_origin=?6)`,
            [
              i.organizationId,
              i.projectId,
              move.environmentId,
              i.operationId,
              s.storedHandle,
              move.publicOrigin,
            ],
          ),
        );
      }
      if (!s.canStore)
        return { statements, result: () => ({ status: "conflict", reason: "taken" }) };
      if (s.affected && saved === null) return { statements, result: () => "pending" };
      if (terminalMatches(s.run, terminal)) return { statements, result: () => "duplicate" };
      if (s.run["state"] !== "queued")
        return { reject: fail("Product Workflow completion state changed") };
      statements.push(
        ...(saved === null
          ? []
          : [
              guard(
                db,
                "operation_conflict",
                "EXISTS(SELECT 1 FROM native_auth_domain_recoveries WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending')",
                [i.organizationId, i.projectId, i.operationId],
              ),
              guard(
                db,
                "operation_conflict",
                "EXISTS(SELECT 1 FROM native_auth_domain_policy_syncs WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending')",
                [i.organizationId, i.projectId, i.operationId],
              ),
            ]),
        db
          .prepare(
            "UPDATE operations SET state='succeeded',updated_at=?4,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')",
          )
          .bind(i.organizationId, i.projectId, i.operationId, i.completedAt),
        guard(db, "operation_conflict", "changes()<>1"),
        // The rename's provider claim ends with the operation; a surviving claim would block every later project write.
        db
          .prepare(
            "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1'",
          )
          .bind(i.organizationId, i.projectId, i.operationId),
        ...workflowTerminalStatements(
          db,
          i,
          i,
          "ProjectHandleChangeRequestedV1",
          s.run,
          terminal,
          i.completedAt,
          null,
        ),
        ...(saved === null
          ? []
          : [
              db
                .prepare(
                  "UPDATE native_auth_domain_operations SET state='completed' WHERE organization_id=?1 AND project_id=?2 AND kind='handle_change' AND identity=?3 AND state='pending'",
                )
                .bind(i.organizationId, i.projectId, i.operationId),
              guard(db, "operation_conflict", "changes()<>1"),
            ]),
      );
      return { statements, result: () => "applied" };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      return s.canStore && terminalMatches(s.run, terminal) ? "duplicate" : undefined;
    },
  };
  return runCommand(db, command);
}
