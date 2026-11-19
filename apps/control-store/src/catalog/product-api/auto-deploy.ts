import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  auditStatement,
  conflict,
  instant,
  queuedOperationStatements,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { bytes, hex, integer, iso, text, type Row } from "../provisioning/context-values.js";
import {
  idempotencyRecordStatement,
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
const scope = z.strictObject({ organizationId: ulid, projectId: ulid });
const branch = z
  .string()
  .regex(/^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,1022}[A-Za-z0-9._-])?$/u)
  .refine((ref) => {
    const v = ref.slice("refs/heads/".length);
    return !(
      v.length < 1 ||
      v.length > 1024 ||
      v.startsWith("-") ||
      v.startsWith("/") ||
      v.endsWith("/") ||
      v.endsWith(".") ||
      v.includes("//") ||
      v.includes("..") ||
      v.includes("@{") ||
      [...v].some((c) => {
        const n = c.codePointAt(0) ?? 0;
        return n <= 0x20 || n === 0x7f || "\\~^:?*[]".includes(c);
      }) ||
      v.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"))
    );
  });
const configResponse = z.strictObject({
  sourceConnectionId: ulid,
  branchRef: branch,
  generation: z.number().int().positive(),
  enabled: z.boolean(),
  updatedAt: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  grantActive: z.boolean(),
});
function configOf(r: Row) {
  return {
    organizationId: parseUlid(text(r, "organization_id")),
    projectId: parseUlid(text(r, "project_id")),
    ...configResponse.parse({
      sourceConnectionId: r["source_connection_id"],
      branchRef: r["branch_ref"],
      generation: r["generation"],
      // A configuration whose connection the project no longer binds watches nothing, whatever it stored.
      enabled: r["enabled"] === 1 && r["bound"] === 1,
      updatedAt: iso(r["updated_at"]),
      grantActive: r["grant_active"] === 1,
    }),
  };
}
const CONFIG_SQL = `SELECT config.*,NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active,
 EXISTS(SELECT 1 FROM project_source_bindings binding WHERE binding.organization_id=config.organization_id AND binding.project_id=config.project_id AND binding.provider='github' AND binding.source_connection_id=config.source_connection_id) bound
 FROM github_auto_deploy_configs config JOIN repository_grants grant_record ON grant_record.organization_id=config.organization_id AND grant_record.project_id=config.project_id AND grant_record.source_connection_id=config.source_connection_id
 JOIN projects ownership ON ownership.organization_id=config.organization_id AND ownership.project_id=config.project_id
 WHERE config.organization_id=?1 AND config.project_id=?2 AND ownership.owner_state='active'`;
export async function readApiGithubAutoDeploy(context: CatalogContext, raw: unknown) {
  const i = scope.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    r = await db.prepare(CONFIG_SQL).bind(i.organizationId, i.projectId).first<Row>();
  return r === null ? null : configOf(r);
}
// The stored configuration's own connection, its grant and the project's billing epoch. A disable is answered for it when
// the project no longer binds GitHub: it watches nothing then, and switching it off must not be refused.
const STORED_SQL = `SELECT config.source_connection_id,ownership.active_billing_epoch_id billing_epoch_id,NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active
 FROM github_auto_deploy_configs config JOIN repository_grants grant_record ON grant_record.organization_id=config.organization_id AND grant_record.project_id=config.project_id AND grant_record.source_connection_id=config.source_connection_id
 JOIN projects ownership ON ownership.organization_id=config.organization_id AND ownership.project_id=config.project_id
 WHERE config.organization_id=?1 AND config.project_id=?2 AND ownership.owner_state='active'`;
/** The source auto-deploy follows is the project's current binding, so an older GitHub source row never answers for a switched project. */
const SOURCE_SQL = `SELECT grant_record.source_connection_id,grant_record.grant_id,ownership.active_billing_epoch_id billing_epoch_id,NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id) grant_active,
 EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=ownership.organization_id AND environment.project_id=ownership.project_id AND environment.name='dev') has_dev
 FROM project_source_bindings binding JOIN repository_grants grant_record ON grant_record.organization_id=binding.organization_id AND grant_record.project_id=binding.project_id AND grant_record.source_connection_id=binding.source_connection_id
 JOIN projects ownership ON ownership.organization_id=binding.organization_id AND ownership.project_id=binding.project_id
 WHERE binding.organization_id=?1 AND binding.project_id=?2 AND binding.provider='github' AND ownership.owner_state='active'
 AND EXISTS(SELECT 1 FROM project_sources source WHERE source.organization_id=binding.organization_id AND source.project_id=binding.project_id AND source.grant_id=grant_record.grant_id AND source.provider='github' AND source.state='ready')
 AND(?3=0 OR (ownership.lifecycle_state='active' AND NOT EXISTS(SELECT 1 FROM repository_grant_revocations revoked WHERE revoked.grant_id=grant_record.grant_id)))`;
const configure = scope.extend({
  principalId: z.string().min(1),
  requestId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(255),
  canonicalRequestDigest: z
    .unknown()
    .transform(bytes)
    .refine((v) => v.byteLength === 32),
  operationId: ulid,
  queuedEventId: ulid,
  succeededEventId: ulid,
  auditEventId: ulid,
  branchRef: branch,
  enabled: z.boolean(),
  configuredAt: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
});
/** Config, exact idempotency response, succeeded operation with both events and original audit are one atomic effect. */
export async function configureApiGithubAutoDeploy(context: CatalogContext, raw: unknown) {
  const i = configure.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    key = {
      ...i,
      httpMethod: "PUT",
      routeTemplate: "/v1/projects/{project_id}/source/auto-deploy",
    };
  type S = {
    record: ReturnType<typeof storedIdempotencyRecord>;
    dev: Row | undefined;
    source: Row | undefined;
    config: Row | undefined;
    stored: Row | undefined;
  };
  type Result = NonNullable<Awaited<ReturnType<typeof readApiGithubAutoDeploy>>>;
  const command: Command<S, Result> = {
    name: "productApi.configureGithubAutoDeploy",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["api_idempotency_records"],
    read: async (reader) => {
      const [receipt, dev, source, config, stored] = await reader.batch([
        readIdempotencyRecordStatement(reader, key),
        reader
          .prepare(
            `SELECT EXISTS(SELECT 1 FROM environments environment WHERE environment.organization_id=project.organization_id AND environment.project_id=project.project_id AND environment.name='dev') has_dev
          FROM projects project WHERE project.organization_id=?1 AND project.project_id=?2 AND project.owner_state='active' AND project.lifecycle_state='active'`,
          )
          .bind(i.organizationId, i.projectId),
        reader.prepare(SOURCE_SQL).bind(i.organizationId, i.projectId, Number(i.enabled)),
        reader
          .prepare(
            "SELECT * FROM github_auto_deploy_configs WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(i.organizationId, i.projectId),
        reader.prepare(STORED_SQL).bind(i.organizationId, i.projectId),
      ]);
      return {
        record: storedIdempotencyRecord(receipt?.results[0]),
        dev: dev?.results[0],
        source: source?.results[0],
        config: config?.results[0],
        stored: stored?.results[0],
      };
    },
    decide: ({ record, dev, source, config, stored }) => {
      if (record !== null) {
        if (record.digestHex !== hex(i.canonicalRequestDigest))
          return { reject: conflict("idempotency_key_reused") };
        const body = configResponse.safeParse(record.body);
        return body.success
          ? {
              replay: {
                organizationId: parseUlid(i.organizationId),
                projectId: parseUlid(i.projectId),
                ...body.data,
                sourceConnectionId: parseUlid(body.data.sourceConnectionId),
              },
            }
          : { reject: conflict("idempotency_key_reused") };
      }
      if (i.enabled && dev?.["has_dev"] === 0)
        return { reject: conflict("development_environment_missing") };
      // Enabling needs the bound GitHub source. A disable uses that source when it is bound, and otherwise switches off the
      // stored configuration, which then watches nothing.
      const watched = source ?? (i.enabled ? undefined : stored);
      if (watched === undefined) return { reject: new Error("auto_deploy_source_unavailable") };
      const sourceConnectionId = parseUlid(text(watched, "source_connection_id")),
        epoch = text(watched, "billing_epoch_id"),
        generation =
          config === undefined
            ? 1
            : integer(config["generation"], 1) +
              (config["source_connection_id"] === sourceConnectionId &&
              config["branch_ref"] === i.branchRef &&
              config["enabled"] === Number(i.enabled)
                ? 0
                : 1);
      const body = {
        sourceConnectionId,
        branchRef: i.branchRef,
        generation,
        enabled: i.enabled,
        updatedAt: iso(i.configuredAt),
        grantActive: watched["grant_active"] === 1,
      };
      const opScope = {
        organizationId: i.organizationId,
        projectId: i.projectId,
        operationId: i.operationId,
        billingEpochId: epoch,
      };
      // A bound source must still be the one read. Without one (a disable only), no GitHub source may have been bound since
      // the read, and the stored configuration must still watch the same connection, grant and billing epoch.
      const sourceGuard =
        source === undefined
          ? guard(
              db,
              "precondition_changed",
              `EXISTS(SELECT 1 FROM (${SOURCE_SQL}) current) OR NOT EXISTS(SELECT 1 FROM (${STORED_SQL}) current WHERE source_connection_id=?4 AND billing_epoch_id=?5 AND grant_active=?6)`,
              [
                i.organizationId,
                i.projectId,
                0,
                sourceConnectionId,
                epoch,
                watched["grant_active"],
              ],
            )
          : guard(
              db,
              "precondition_changed",
              `NOT EXISTS(SELECT 1 FROM (${SOURCE_SQL}) current WHERE source_connection_id=?4 AND grant_id=?5 AND billing_epoch_id=?6 AND grant_active=?7 AND has_dev=?8)`,
              [
                i.organizationId,
                i.projectId,
                Number(i.enabled),
                sourceConnectionId,
                source["grant_id"],
                epoch,
                source["grant_active"],
                source["has_dev"],
              ],
            );
      return {
        statements: [
          sourceGuard,
          guard(
            db,
            "precondition_changed",
            config === undefined
              ? "EXISTS(SELECT 1 FROM github_auto_deploy_configs WHERE organization_id=?1 AND project_id=?2)"
              : "NOT EXISTS(SELECT 1 FROM github_auto_deploy_configs WHERE organization_id=?1 AND project_id=?2 AND generation=?3 AND source_connection_id=?4 AND branch_ref=?5 AND enabled=?6 AND updated_at=?7)",
            config === undefined
              ? [i.organizationId, i.projectId]
              : [
                  i.organizationId,
                  i.projectId,
                  config["generation"],
                  config["source_connection_id"],
                  config["branch_ref"],
                  config["enabled"],
                  config["updated_at"],
                ],
          ),
          idempotencyRecordStatement(
            db,
            key,
            { digestHex: hex(i.canonicalRequestDigest), requestId: i.requestId },
            { operationId: i.operationId, httpStatus: 200, headers: {}, body },
            i.configuredAt,
          ),
          db
            .prepare(
              "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?7)ON CONFLICT(organization_id,project_id)DO UPDATE SET source_connection_id=excluded.source_connection_id,branch_ref=excluded.branch_ref,generation=excluded.generation,enabled=excluded.enabled,updated_at=excluded.updated_at",
            )
            .bind(
              i.organizationId,
              i.projectId,
              sourceConnectionId,
              i.branchRef,
              generation,
              Number(i.enabled),
              i.configuredAt,
            ),
          ...queuedOperationStatements(db, opScope, {
            eventId: i.queuedEventId,
            occurredAt: i.configuredAt,
          }),
          db
            .prepare(
              "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2",
            )
            .bind(i.organizationId, i.operationId),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,payload,occurred_at)VALUES(?1,?2,?3,?4,1,'OperationSucceeded','{}',?5)",
            )
            .bind(i.organizationId, i.succeededEventId, i.operationId, i.projectId, i.configuredAt),
          auditStatement(db, i.organizationId, {
            auditEventId: i.auditEventId,
            projectId: i.projectId,
            operationId: i.operationId,
            billingEpochId: epoch,
            eventType: "GithubAutoDeployConfiguredV1",
            actorType: "principal",
            actorId: i.principalId,
            payload: {},
            occurredAt: i.configuredAt,
          }),
        ],
        result: () => ({
          organizationId: parseUlid(i.organizationId),
          projectId: parseUlid(i.projectId),
          ...body,
        }),
      };
    },
  };
  return runCommand(db, command);
}
