import { generatedJsonb } from "../../jsonb-generated.js";
import {
  readApiProjectDataChangeState,
  readApiDataChangeRenewalPlan,
  apiDataChangeRenewalStatements,
  type ApiDataChangeRenewalPlan,
} from "./data-changes.js";
import { quoteBuildCost, parseNewProductionFrameworkPlan } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  fenceRaceGuard,
  publicTimestamp,
  ringDoorbell,
  type CatalogContext,
} from "../common.js";
import { acceptStatements } from "../operations/accept-api-operation.js";
import {
  readIdempotencyRecordStatement,
  storedIdempotencyRecord,
} from "../operations/idempotency.js";
import { authorizeOrganizationAction } from "../projects/customer-projects-access.js";
import { activeGrantSelect, isUserRevoked } from "../identity/mcp-sql.js";
import {
  assertOperationDelegationCurrent,
  operationAction,
  restrictionAllows,
} from "../identity/operation-delegations.js";
import { OrganizationCreditError } from "../billing/errors.js";
import {
  buildAdmissionDenial,
  readAccount,
  readProjectBudget,
  reserve,
  stopBudgetGuard,
  type AccountView,
  type ProjectBudget,
} from "../credit/index.js";
import { currentDataEnvironment } from "../database/authority.js";
import { readDeletionInventoryPlan } from "../provisioning/lifecycle-inventory.js";
import { readDataChangeInventoryPlan } from "../provisioning/project-data-change.js";
import { DB_NOW, FENCE_HELD_SQL } from "../recovery/shared.js";
import {
  API_DEPLOYMENT_PLAN_SQL,
  API_DELETION_ADMISSION_SQL,
  apiDeletionAdmissionOf,
} from "./planning-reads.js";
import { readApiRollbackSnapshot, apiRollbackTargetOf } from "./rollback-target.js";
import { acceptedOperationOf, type AcceptedApiProductOperation } from "./accepted-operation.js";
import { parseApiProductAcceptance } from "./accept-product-input.js";
import {
  productAcceptanceStatements,
  promotionAcceptParameters,
  PROMOTION_ACCEPT_SQL,
  UNFINISHED_DATA_SQL,
  UNFINISHED_COMPUTE_SQL,
  type AcceptanceEffects,
} from "./accept-product-effects.js";

type Row = Record<string, unknown>;
/** The organization's database count and whether this deployment's environment already holds one. */
interface DatabaseCapacity {
  readonly enabled: boolean;
  readonly active: number;
  readonly environmentHasDatabase: boolean;
}
const fail = (code = "deployment_persistence_conflict") => new Error(code);
const DELEGATED = [
  "DeploymentRequestedV1",
  "DeploymentPromotionRequestedV1",
  "DeploymentRollbackRequestedV1",
];
const CUTOVER = [...DELEGATED, "ProjectDataChangeRequestedV1", "ProjectDeletionRequestedV1"];
/**
 * Another operation of the project is queued or running, or holds its provider-mutation claim. A deletion accepted while one
 * is open never completes: completion aborts on any open operation (CORE-29). Parameters: ?1 organization, ?2 project, ?3 operation.
 */
const OTHER_OPEN_OPERATION_SQL = `EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3 AND state IN('queued','running'))
  OR EXISTS(SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND operation_id<>?3)`;
const CUTOVER_PENDING = `EXISTS(SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.organization_id=?1 AND a.project_id=?2 AND NOT EXISTS(SELECT 1 FROM database_provider_cutover_releases r WHERE r.organization_id=a.organization_id AND r.operation_id=a.operation_id))`;
const SCOPE = `SELECT p.lifecycle_state,p.lifecycle_version,p.active_billing_epoch_id,e.name environment_name FROM projects p JOIN environments e USING(organization_id,project_id) WHERE p.organization_id=?1 AND p.project_id=?2 AND e.environment_id=?3 AND p.owner_state='active' AND(p.lifecycle_state='active' OR(p.lifecycle_state='deleting' AND ?4=1))`;
const CONFIRMATION = `SELECT source_generation FROM action_confirmations WHERE organization_id=?1 AND project_id=?2 AND issued_to_principal_id=?3 AND action=?4 AND target_deployment_id IS ?5 AND subject_etag=?6 AND token_sha256=?7 AND consumed_at IS NULL AND created_at<=?8 AND expires_at>?8 AND(action NOT IN('promote','rollback') OR source_generation=COALESCE((SELECT generation FROM project_source_bindings b WHERE b.organization_id=action_confirmations.organization_id AND b.project_id=action_confirmations.project_id),0))`;
/** Databases one organization may hold: a database-enabled deployment that would create the eleventh is refused. */
const DATABASE_LIMIT = 10;
/** The organization's live databases: active heads of PGCF targets. A retired head, a deleted database, is not counted. */
const ACTIVE_DATABASES_SQL = `SELECT count(*) FROM database_provider_target_heads h JOIN database_provider_target_revisions r USING(organization_id,project_id,physical_environment_id,target_version) WHERE h.organization_id=?1 AND h.state='active' AND r.provider='pgcf'`;
/** Parameters: ?1 organization, ?2 project, ?3 logical environment. */
const ENVIRONMENT_HAS_DATABASE_SQL = `EXISTS(SELECT 1 FROM database_provider_target_heads h WHERE h.organization_id=?1 AND h.project_id=?2 AND h.state='active' AND h.physical_environment_id=${currentDataEnvironment("?1", "?2", "?3")})`;
const OPERATION_SQL = "SELECT * FROM operations WHERE organization_id=?1 AND operation_id=?2";
const EVENTS_SQL =
  "SELECT * FROM operation_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY revision";
const INTENT_SQL =
  "SELECT event_type FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4";
const emptyEffects = (): AcceptanceEffects => ({
  confirmedSourceGeneration: null,
  plan: null,
  rollback: null,
  deletion: null,
  dataChange: null,
  previousOperationId: null,
  previousAbsences: [],
});

/** Whole original acceptance: idempotency/confirmation/spine, seven fixed intents, inventory and financial admission commit together. */
export async function acceptApiProductOperation(
  context: CatalogContext,
  raw: unknown,
): Promise<AcceptedApiProductOperation> {
  const p = parseApiProductAcceptance(raw),
    i = p.input,
    b = p.base,
    { db, shardId } = await routeOrganization(context, i.organizationId);
  const scoped = [i.organizationId, i.projectId],
    delegated = i.delegation !== undefined,
    userId = i.principalId.startsWith("user:") ? i.principalId.slice(5) : "";
  if (
    i.delegation !== undefined &&
    (operationAction(i.eventType) !== i.delegation.action ||
      !restrictionAllows(i.delegation.authorizationRestriction, {
        action: i.delegation.action,
        organizationId: i.organizationId,
        projectId: i.projectId,
      }) ||
      (await authorizeOrganizationAction(context, {
        organizationId: i.organizationId,
        principalId: i.principalId,
        projectId: i.projectId,
        action: i.delegation.action,
      })) !== "allow")
  )
    throw fail("operation_authorization_changed");
  if (i.delegation !== undefined && (await isUserRevoked(context.directory, userId)))
    throw fail("operation_authorization_changed");
  const readOperation = async (reader: D1Database, operationId: string) => {
    const r = await reader.batch([
      reader.prepare(OPERATION_SQL).bind(i.organizationId, operationId),
      reader.prepare(EVENTS_SQL).bind(i.organizationId, operationId),
      reader.prepare(INTENT_SQL).bind(i.organizationId, i.projectId, i.environmentId, operationId),
    ]);
    if (r[2]?.results[0]?.["event_type"] !== i.eventType) throw fail();
    return acceptedOperationOf(r[0]?.results[0], r[1]?.results ?? []);
  };
  const read = async (reader: D1Database) => {
    const results = await reader.batch([
      readIdempotencyRecordStatement(reader, b),
      reader
        .prepare(SCOPE)
        .bind(
          ...scoped,
          i.environmentId,
          i.eventType === "ProjectDeletionRequestedV1" && i.httpMethod === "DELETE" ? 1 : 0,
        ),
      reader
        .prepare(
          "SELECT 1 FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2 AND provider='managed'",
        )
        .bind(...scoped),
      reader
        .prepare(
          `SELECT ${CUTOVER_PENDING} pending,EXISTS(SELECT 1 FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2 AND state NOT IN('deleted','displaced')) live_domain,EXISTS(SELECT 1 FROM projects other WHERE other.owner_state<>'transferred' AND other.handle=?3 AND other.project_id<>?2) taken`,
        )
        .bind(...scoped, i.eventType === "ProjectHandleChangeRequestedV1" ? i.requestedHandle : ""),
      i.delegation === undefined
        ? reader.prepare("SELECT 1 WHERE 0")
        : activeGrantSelect(
            reader,
            {
              organizationId: i.organizationId,
              userId,
              clientId: i.delegation.clientId,
              consentHash: i.delegation.consentHash,
            },
            i.projectId,
            false,
          ),
      b.confirmation === undefined
        ? reader.prepare("SELECT 1 WHERE 0")
        : reader
            .prepare(CONFIRMATION)
            .bind(
              ...scoped,
              b.confirmation.issuedToPrincipalId,
              b.confirmation.action,
              b.confirmation.targetDeploymentId ?? null,
              b.confirmation.subjectEtag,
              i.eventType === "ProjectHandleChangeRequestedV1"
                ? null
                : "confirmation" in i
                  ? i.confirmation.tokenDigest
                  : null,
              b.confirmation.consumedAt,
            ),
    ]);
    const record = storedIdempotencyRecord(results[0]?.results[0]),
      scope = results[1]?.results[0] ?? null,
      managed = Boolean(results[2]?.results.length),
      status = results[3]?.results[0],
      grant = results[4]?.results[0] ?? null,
      confirmationUsable = Boolean(results[5]?.results.length);
    if (i.eventType === "SourceLinkRequestedV1" && managed) throw fail(); // Native precedes idempotency even on replay.
    if (record !== null) {
      if (record.digestHex !== b.canonicalRequestDigest || record.operationId === null)
        throw fail("idempotency_key_reused");
      return {
        record,
        scope,
        status,
        grant,
        confirmationUsable,
        replay: await readOperation(reader, record.operationId),
        effects: emptyEffects(),
        financial: null,
        promotion: false,
        busyData: false,
        busyCompute: false,
        held: false,
        openOperation: false,
        renewal: null as ApiDataChangeRenewalPlan | null,
        deletionAdmission: null as ReturnType<typeof apiDeletionAdmissionOf>,
        domainPending: false,
        databaseCapacity: null as DatabaseCapacity | null,
      };
    }
    const confirmedGeneration = results[5]?.results[0]?.["source_generation"];
    let effects: AcceptanceEffects = {
      ...emptyEffects(),
      // Only the persisted usable confirmation supplies an artifact action's queued source fence.
      confirmedSourceGeneration:
        (i.eventType === "DeploymentRollbackRequestedV1" ||
          i.eventType === "DeploymentPromotionRequestedV1") &&
        typeof confirmedGeneration === "number" &&
        Number.isSafeInteger(confirmedGeneration) &&
        confirmedGeneration >= 0
          ? confirmedGeneration
          : null,
    };
    let financial: null | {
      amountMicros: number;
      requirePaid: boolean;
      account: AccountView;
      budget: ProjectBudget | null;
    } = null;
    let renewal: ApiDataChangeRenewalPlan | null = null;
    let databaseCapacity: DatabaseCapacity | null = null;
    let promotion = false,
      busyData = false,
      busyCompute = false,
      held = false,
      openOperation = false,
      domainPending = false,
      deletionAdmission: ReturnType<typeof apiDeletionAdmissionOf> = null;
    if (i.eventType === "DeploymentRequestedV1") {
      const plan = await reader
        .prepare(
          `SELECT * FROM(${API_DEPLOYMENT_PLAN_SQL}) WHERE plan_sha256=?5 AND environment_id=?6`,
        )
        .bind(...scoped, i.planId, p.at, i.planDigest, i.environmentId)
        .first<Row>();
      effects = { ...effects, plan };
      if (plan !== null) {
        const quote = quoteBuildCost(publicTimestamp(String(plan["created_at"]))),
          stored = JSON.parse(String(plan["cost_estimate"])) as Row;
        if (
          stored === null ||
          typeof stored !== "object" ||
          Array.isArray(stored) ||
          Object.keys(stored).length !== Object.keys(quote).length ||
          Object.entries(quote).some(([key, value]) => stored[key] !== value)
        )
          throw fail();
        const framework = parseNewProductionFrameworkPlan(
          JSON.parse(String(plan["framework_plan"])),
        );
        financial = {
          amountMicros: Number(quote.credit_micros),
          requirePaid: framework.mail.enabled,
          account: await readAccount(reader, i.organizationId, p.at),
          budget: await readProjectBudget(reader, i),
        };
        const capacity = await reader
          .prepare(
            `SELECT (${ACTIVE_DATABASES_SQL}) active,${ENVIRONMENT_HAS_DATABASE_SQL} has_database`,
          )
          .bind(i.organizationId, i.projectId, i.environmentId)
          .first<Row>();
        databaseCapacity = {
          enabled: framework.database.enabled,
          active: Number(capacity?.["active"] ?? 0),
          environmentHasDatabase: Number(capacity?.["has_database"] ?? 0) === 1,
        };
      }
    }
    if (i.eventType === "DeploymentRollbackRequestedV1")
      effects = {
        ...effects,
        rollback: await readApiRollbackSnapshot(reader, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          environmentId: i.environmentId,
          deploymentId: i.targetDeploymentId,
          revisionId: i.targetRevisionId,
        }),
      };
    if (i.eventType === "DeploymentPromotionRequestedV1") {
      promotion =
        (await reader
          .prepare(PROMOTION_ACCEPT_SQL)
          .bind(...promotionAcceptParameters(p))
          .first()) !== null;
      // Only an isolated project places a database on promotion, and only when the source revision's plan enables one.
      const capacity = promotion
        ? await reader
            .prepare(
              `SELECT (${ACTIVE_DATABASES_SQL}) active,${ENVIRONMENT_HAS_DATABASE_SQL} has_database,
               (SELECT project.data_mode='isolated' AND json_extract(plan.framework_plan,'$.database.enabled')=1 FROM deployment_revisions revision
                 JOIN deployment_plans plan ON plan.organization_id=revision.organization_id AND plan.project_id=revision.project_id AND plan.plan_id=revision.plan_id
                 JOIN projects project ON project.organization_id=revision.organization_id AND project.project_id=revision.project_id
                 WHERE revision.organization_id=?1 AND revision.project_id=?2 AND revision.deployment_id=?4 AND revision.revision_id=?5) enabled`,
            )
            .bind(
              i.organizationId,
              i.projectId,
              i.environmentId,
              i.sourceDeploymentId,
              i.sourceRevisionId,
            )
            .first<Row>()
        : null;
      databaseCapacity =
        capacity === null
          ? null
          : {
              enabled: Number(capacity["enabled"] ?? 0) === 1,
              active: Number(capacity["active"] ?? 0),
              environmentHasDatabase: Number(capacity["has_database"] ?? 0) === 1,
            };
    }
    if (
      i.eventType === "ProjectDeletionRequestedV1" ||
      i.eventType === "ProjectDataChangeRequestedV1"
    ) {
      const observed = await reader.batch([
        reader
          .prepare(
            `SELECT (${UNFINISHED_DATA_SQL}) busy_data,(${UNFINISHED_COMPUTE_SQL}) busy_compute`,
          )
          .bind(i.projectId),
        reader.prepare(`SELECT ${FENCE_HELD_SQL.replace("?3", DB_NOW)} held`).bind(...scoped),
        reader.prepare(API_DELETION_ADMISSION_SQL).bind(...scoped, i.operationId),
        reader
          .prepare(
            "SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND state='pending' LIMIT 1",
          )
          .bind(...scoped),
        reader
          .prepare(`SELECT (${OTHER_OPEN_OPERATION_SQL}) open_operation`)
          .bind(...scoped, i.operationId),
      ]);
      busyData = observed[0]?.results[0]?.["busy_data"] === 1;
      busyCompute = observed[0]?.results[0]?.["busy_compute"] === 1;
      held = observed[1]?.results[0]?.["held"] === 1;
      deletionAdmission = apiDeletionAdmissionOf(observed[2]?.results[0]);
      domainPending = (observed[3]?.results.length ?? 0) > 0;
      openOperation = observed[4]?.results[0]?.["open_operation"] === 1;
      if (i.eventType === "ProjectDeletionRequestedV1") {
        const deletion = await readDeletionInventoryPlan(reader, {
          organizationId: i.organizationId,
          projectId: i.projectId,
          operationId: i.operationId,
          recordedAt: i.occurredAt,
        });
        const previousOperationId = deletionAdmission?.previousOperationId ?? null;
        const previousAbsences =
          previousOperationId === null
            ? []
            : (
                await reader
                  .prepare(
                    "SELECT a.*,lower(hex(a.external_ref_hash)) hash FROM run_cleanup_attempts a WHERE a.organization_id=?1 AND a.project_id=?2 AND a.operation_id=?3 AND a.provider IN('aws','cloudflare') AND a.resource_kind IN('source-object','build-artifact') AND NOT EXISTS(SELECT 1 FROM run_cleanup_attempts n WHERE n.organization_id=a.organization_id AND n.project_id=a.project_id AND n.operation_id=a.operation_id AND n.provider=a.provider AND n.resource_kind=a.resource_kind AND n.external_ref_hash=a.external_ref_hash AND(n.attempted_at>a.attempted_at OR(n.attempted_at=a.attempted_at AND n.cleanup_attempt_id>a.cleanup_attempt_id))) ORDER BY a.cleanup_attempt_id",
                  )
                  .bind(...scoped, previousOperationId)
                  .all()
              ).results;
        effects = { ...effects, deletion, previousOperationId, previousAbsences };
      } else if (p.snapshot !== null)
        effects = {
          ...effects,
          dataChange: await readDataChangeInventoryPlan(reader, {
            organizationId: i.organizationId,
            projectId: i.projectId,
            operationId: i.operationId,
            snapshot: p.snapshot,
            now: i.occurredAt,
          }),
        };
    }
    if (i.eventType === "ProjectDataChangeRequestedV1" && p.snapshot !== null) {
      const state = await readApiProjectDataChangeState(context, {
        organizationId: i.organizationId,
        projectId: i.projectId,
        principalId: i.principalId,
      });
      const snap = p.snapshot;
      if (
        state === null ||
        state.lifecycleVersion !== i.expectedProjectVersion ||
        state.billingEpochId !== i.billingEpochId ||
        generatedJsonb(state.assignments) !== generatedJsonb(snap.transition.before) ||
        state.environmentHeads.length !== snap.environmentHeads.length ||
        snap.environmentHeads.some(
          (h) =>
            !state.environmentHeads.some(
              (v) =>
                v.environmentId === h.environmentId &&
                v.expectedHeadVersion === h.expectedHeadVersion,
            ),
        ) ||
        state.registrationGenerations.length !== snap.registrationGenerations.length ||
        snap.registrationGenerations.some(
          (h) =>
            !state.registrationGenerations.some(
              (v) =>
                v.dataEnvironmentId === h.dataEnvironmentId &&
                v.registrationVersion === h.registrationVersion,
            ),
        ) ||
        (i.dataChange === "share_prod_keeps_data" && !state.prodDatabaseReady)
      )
        throw fail();
      if (snap.transition.removeDevDeployment)
        renewal = await readApiDataChangeRenewalPlan(
          reader,
          {
            organizationId: i.organizationId,
            projectId: i.projectId,
            principalId: i.principalId,
            now: i.occurredAt,
          },
          i.devShareRenewal,
        );
      else if (i.devShareRenewal !== undefined) throw fail("data_change_not_applicable");
    }
    return {
      record,
      scope,
      status,
      grant,
      confirmationUsable,
      replay: null,
      effects,
      financial,
      promotion,
      busyData,
      busyCompute,
      held,
      openOperation,
      renewal,
      deletionAdmission,
      domainPending,
      databaseCapacity,
    };
  };
  const command: Command<
    Awaited<ReturnType<typeof read>>,
    { value: AcceptedApiProductOperation; replayed: boolean }
  > = {
    name: "productApi.acceptProductOperation",
    input: i,
    retryOn: [
      "row_version_conflict",
      "owner_changed",
      "scope_inactive",
      "insufficient_credits",
      "consent_changed",
      "precondition_changed",
      "operation_conflict",
    ],
    naturalKeyTables: [
      "credit_log",
      "credit_reservation",
      "api_idempotency_records",
      "operations",
      "product_command_intents",
      "deployments",
      "cleanup_runs",
    ],
    read,
    decide: (s) => {
      if (s.replay !== null) return { replay: { value: s.replay, replayed: true } };
      if (!s.scope || s.scope["active_billing_epoch_id"] !== i.billingEpochId)
        return { reject: fail() };
      if (CUTOVER.includes(i.eventType) && s.status?.["pending"] === 1)
        return { reject: fail("cutover_pending") };
      const requiresPublication =
        (DELEGATED.includes(i.eventType) && s.scope["environment_name"] === "prod") ||
        i.eventType === "DeploymentPromotionRequestedV1";
      if (
        i.delegation !== undefined &&
        (s.grant === null ||
          s.grant["grant_id"] !== i.delegation?.grantId ||
          operationAction(i.eventType) !== i.delegation?.action ||
          !restrictionAllows(i.delegation?.authorizationRestriction, {
            action: i.delegation.action,
            organizationId: i.organizationId,
            projectId: i.projectId,
          }))
      )
        return { reject: fail("operation_authorization_changed") };
      if (b.confirmation !== undefined && !s.confirmationUsable) return { reject: fail() };
      if (i.eventType === "ProjectHandleChangeRequestedV1" && s.status?.["taken"] === 1)
        return { reject: fail() };
      if (
        i.eventType === "ProjectDataChangeRequestedV1" &&
        s.scope["lifecycle_version"] !== i.expectedProjectVersion
      )
        return { reject: fail() };
      if (i.eventType === "DeploymentRequestedV1" && s.effects.plan === null)
        return { reject: fail() };
      const capacity = s.databaseCapacity;
      if (
        capacity?.enabled &&
        !capacity.environmentHasDatabase &&
        capacity.active >= DATABASE_LIMIT
      )
        return { reject: fail("database_limit_reached") };
      if (i.eventType === "DeploymentPromotionRequestedV1" && !s.promotion)
        return { reject: fail() };
      if (i.eventType === "DeploymentRollbackRequestedV1") {
        const target = s.effects.rollback === null ? null : apiRollbackTargetOf(s.effects.rollback);
        if (target?.dataChangeInProgress) return { reject: fail("data_change_in_progress") };
        if (
          target === null ||
          target.dataChanged ||
          target.dataEnvironmentId !== i.expectedDataEnvironmentId ||
          target.assignmentVersion !== i.expectedAssignmentVersion ||
          target.registrationVersion !== i.expectedRegistrationVersion
        )
          return { reject: fail("rollback_target_data_changed") };
      }
      if (i.eventType === "ProjectDeletionRequestedV1") {
        if (s.openOperation) return { reject: fail("project_operation_in_progress") };
        if (s.domainPending) return { reject: fail("native_domain_sync_pending") };
        if (
          s.deletionAdmission === null ||
          s.deletionAdmission.expectedProjectVersion !== i.expectedProjectVersion ||
          s.deletionAdmission.environmentId !== i.environmentId ||
          s.deletionAdmission.billingEpochId !== i.billingEpochId
        )
          return { reject: fail() };
        // An active project is checked too: a connection added after the plan must still refuse the accepted deletion.
        if (s.status?.["live_domain"] === 1)
          return { reject: fail("project_domain_delete_required") };
      }
      if (s.busyData || s.busyCompute || s.held)
        return { reject: fail("project_operation_in_progress") };
      const statements: D1PreparedStatement[] = [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        ...(CUTOVER.includes(i.eventType)
          ? [guard(db, "precondition_changed", CUTOVER_PENDING, scoped)]
          : []),
      ];
      if (i.eventType === "SourceLinkRequestedV1")
        statements.push(
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM project_source_bindings WHERE organization_id=?1 AND project_id=?2 AND provider='managed')",
            scoped,
          ),
        );
      if (i.eventType === "DeploymentRequestedV1")
        statements.push(
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${API_DEPLOYMENT_PLAN_SQL}) WHERE plan_sha256=?5 AND environment_id=?6)`,
            [...scoped, i.planId, p.at, i.planDigest, i.environmentId],
          ),
        );
      // A database created by this acceptance must not be the eleventh another accepted operation created meanwhile.
      if (
        (i.eventType === "DeploymentRequestedV1" ||
          i.eventType === "DeploymentPromotionRequestedV1") &&
        s.databaseCapacity?.enabled &&
        !s.databaseCapacity.environmentHasDatabase
      )
        statements.push(
          guard(
            db,
            "precondition_changed",
            `(${ACTIVE_DATABASES_SQL}) >= ?4 AND NOT ${ENVIRONMENT_HAS_DATABASE_SQL}`,
            [i.organizationId, i.projectId, i.environmentId, DATABASE_LIMIT],
          ),
        );
      // An operation that opened after the read makes the decision stale: the retry decides again and refuses it typed.
      if (i.eventType === "ProjectDeletionRequestedV1")
        statements.push(
          guard(db, "precondition_changed", OTHER_OPEN_OPERATION_SQL, [...scoped, i.operationId]),
        );
      if (i.eventType === "ProjectDeletionRequestedV1")
        statements.push(
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM(${API_DELETION_ADMISSION_SQL}) WHERE environment_id=?4 AND billing_epoch_id=?5 AND lifecycle_version=?6 AND previous_operation_id IS ?7)`,
            [
              ...scoped,
              i.operationId,
              i.environmentId,
              i.billingEpochId,
              i.expectedProjectVersion,
              s.effects.previousOperationId,
            ],
          ),
        );
      statements.push(
        ...acceptStatements(db, b, requiresPublication, delegated, {
          lifecycle: s.scope["lifecycle_state"] === "deleting" ? "deleting" : "active",
        }),
        ...productAcceptanceStatements(db, p, s.effects),
      );
      if (s.financial !== null) {
        // The build reservation is the operation id, so every later step (start, settle, release) finds it again.
        const f = s.financial,
          denied = buildAdmissionDenial({
            now: p.at,
            account: f.account,
            project: f.budget,
            amountMicros: f.amountMicros,
            requirePaid: f.requirePaid,
          });
        if (denied !== null) return { reject: new OrganizationCreditError(denied) };
        // The Stop budget in force at commit: a limit lowered after the read aborts the batch, which re-decides to the denial.
        statements.push(
          stopBudgetGuard(db, i, p.at, f.amountMicros),
          ...reserve(db, {
            organizationId: i.organizationId,
            reservationId: i.operationId,
            projectId: i.projectId,
            amountMicros: f.amountMicros,
            now: p.at,
            detail: { operationId: i.operationId },
          }).statements,
        );
      }
      if (s.renewal !== null) statements.push(...apiDataChangeRenewalStatements(db, s.renewal));
      const resultAt = statements.length;
      statements.push(
        db.prepare(OPERATION_SQL).bind(i.organizationId, i.operationId),
        db.prepare(EVENTS_SQL).bind(i.organizationId, i.operationId),
      );
      return {
        statements,
        result: (r) => ({
          value: acceptedOperationOf(r[resultAt]?.results[0], r[resultAt + 1]?.results ?? []),
          replayed: false,
        }),
      };
    },
    lookup: async (reader) => {
      const s = await read(reader);
      return s.replay === null ? undefined : { value: s.replay, replayed: true };
    },
  };
  let result: Awaited<
    ReturnType<
      typeof runCommand<
        Awaited<ReturnType<typeof read>>,
        { value: AcceptedApiProductOperation; replayed: boolean }
      >
    >
  >;
  try {
    result = await runCommand(db, command);
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string")
      throw fail(error.code === "idempotency_conflict" ? "idempotency_key_reused" : error.code);
    throw error;
  }
  if (result.replayed)
    await assertOperationDelegationCurrent(context, {
      organizationId: i.organizationId,
      operationId: result.value.operationId,
    });
  await ringDoorbell(context.directory, "outbox", shardId, b.availableAt ?? b.occurredAt);
  return result.value;
}
