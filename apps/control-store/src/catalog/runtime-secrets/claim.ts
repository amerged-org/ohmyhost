import { AI_KEY_NAME, BROWSER_KEY_NAME } from "@ohmyhost/platform/shared";
import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { publicTimestamp, routeOrganization, type CatalogContext } from "../common.js";
import { bytesOf } from "../platform-support.js";
import {
  claimInput,
  parse,
  integer,
  storedNames,
  DeliveryInputError,
  DeliveryScopeError,
  type Row,
} from "./contracts.js";
import {
  ACTIVE_SCOPE,
  STATE_DOCUMENT,
  params,
  parseState,
  stateFence,
  initializeState,
} from "./facts.js";

// Literal original trigger-specific authority. Claiming a delivery does NOT add the platform-write lifecycle guard.
const AUTHORIZED = `EXISTS(${ACTIVE_SCOPE}) AND (?4='reconcile' OR EXISTS(
 SELECT 1 FROM product_command_intents intent
 JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
 JOIN product_provider_mutation_claims claim ON claim.organization_id=intent.organization_id AND claim.project_id=intent.project_id AND claim.environment_id=intent.environment_id AND claim.operation_id=intent.operation_id AND claim.event_type=intent.event_type
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?5
 AND intent.event_type=CASE ?4 WHEN 'deploy' THEN 'DeploymentRequestedV1' WHEN 'rollback' THEN 'DeploymentRollbackRequestedV1' WHEN 'promotion' THEN 'DeploymentPromotionRequestedV1' END
 AND operation.state IN ('queued','running')))`;
const PLAN = `SELECT plan.framework_plan FROM deployment_plans plan WHERE plan.organization_id=?1 AND plan.project_id=?2 AND plan.plan_id=CASE ?4
 WHEN 'deploy' THEN (SELECT intent.plan_id FROM product_command_intents intent WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?5 AND intent.event_type='DeploymentRequestedV1')
 WHEN 'promotion' THEN (SELECT revision.plan_id FROM product_command_intents intent JOIN deployment_revisions revision ON revision.organization_id=intent.organization_id AND revision.project_id=intent.project_id AND revision.deployment_id=intent.source_deployment_id AND revision.revision_id=intent.source_revision_id WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?5 AND intent.event_type='DeploymentPromotionRequestedV1')
 WHEN 'rollback' THEN (SELECT revision.plan_id FROM product_command_intents intent JOIN deployment_revisions revision ON revision.organization_id=intent.organization_id AND revision.project_id=intent.project_id AND revision.deployment_id=intent.target_deployment_id AND revision.revision_id=intent.target_revision_id WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?5)
 ELSE (SELECT revision.plan_id FROM environments environment JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id AND revision.revision_id=environment.active_revision_id WHERE environment.organization_id=?1 AND environment.project_id=?2 AND environment.environment_id=?3) END`;
const PLAN_AVAILABLE = `?4='reconcile' OR (?4='deploy' AND EXISTS(${PLAN})) OR (?4 IN ('rollback','promotion') AND EXISTS(
 SELECT 1 FROM product_command_intents intent JOIN deployment_revisions revision ON revision.organization_id=intent.organization_id AND revision.project_id=intent.project_id
 AND revision.deployment_id=CASE ?4 WHEN 'rollback' THEN intent.target_deployment_id ELSE intent.source_deployment_id END
 AND revision.revision_id=CASE ?4 WHEN 'rollback' THEN intent.target_revision_id ELSE intent.source_revision_id END
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?5
 AND (?4<>'promotion' OR (intent.event_type='DeploymentPromotionRequestedV1' AND revision.artifact_id=intent.source_artifact_id))))`;
const AUTH_DOCUMENT = `SELECT json_object('authorized',(${AUTHORIZED}),'planAvailable',(${PLAN_AVAILABLE}),'mailEnabled',EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.mail.enabled')=1),'aiEnabled',EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.ai.enabled')=1),'browserEnabled',EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.browser.enabled')=1)) value`;
// The lease's staging deployment operation is still queued or running: its stage row names the lease.
const OWNER_LIVE = `SELECT EXISTS(SELECT 1 FROM runtime_secret_delivery_states state
 JOIN runtime_secret_delivery_stages stage ON stage.organization_id=state.organization_id AND stage.project_id=state.project_id AND stage.environment_id=state.environment_id AND stage.lease_id=state.active_lease_id
 JOIN operations operation ON operation.organization_id=stage.organization_id AND operation.project_id=stage.project_id AND operation.operation_id=stage.operation_id
 WHERE state.organization_id=?1 AND state.project_id=?2 AND state.environment_id=?3 AND operation.state IN ('queued','running')) value`;
interface Snapshot {
  document: string | null;
  authorityDocument: string;
  state: Row | null;
  authorized: boolean;
  planAvailable: boolean;
  ownerLive: boolean;
  secrets: Row[];
}
export type ClaimResult =
  | { outcome: "current"; generation: number; releaseSequence: number }
  | { outcome: "busy"; generation: number; releaseSequence: number; retryAt: string }
  | {
      outcome: "claimed";
      generation: number;
      trigger: "deploy" | "rollback" | "promotion" | "reconcile";
      runtimeProvider: "wfp";
      releaseSequence: number;
      leaseId: string;
      leaseExpiresAt: string;
      secrets: {
        name: string;
        ciphertext: Uint8Array;
        nonce: Uint8Array;
        valueSha256: Uint8Array;
        keyVersion: number;
        revision: number;
      }[];
      appliedSecretNames: string[];
      providerTag?: string;
    };
export async function claimDelivery(context: CatalogContext, raw: unknown): Promise<ClaimResult> {
  const input = parse(claimInput, raw),
    { db } = await routeOrganization(context, input.organizationId),
    scopeParams = params(input),
    bindings = [...scopeParams, input.trigger, input.operationId ?? null];
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const [a, s, owner, secrets] = await reader.batch([
      reader.prepare(AUTH_DOCUMENT).bind(...bindings),
      reader.prepare(STATE_DOCUMENT).bind(...scopeParams),
      reader.prepare(OWNER_LIVE).bind(...scopeParams),
      reader
        .prepare(
          `SELECT name,ciphertext,nonce,value_sha256,key_version,CAST(revision AS TEXT) revision FROM environment_secrets
    WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND (name<>'OHMYHOST_MAIL_KEY' OR EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.mail.enabled')=1)) AND (name<>'${AI_KEY_NAME}' OR EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.ai.enabled')=1)) AND (name<>'${BROWSER_KEY_NAME}' OR EXISTS(SELECT 1 FROM (${PLAN}) WHERE json_extract(framework_plan,'$.browser.enabled')=1)) ORDER BY name`,
        )
        .bind(...bindings),
    ]);
    const document = s?.results[0]?.["value"],
      authorityDocument = a?.results[0]?.["value"];
    if (typeof authorityDocument !== "string") throw new DeliveryScopeError();
    const authority = JSON.parse(authorityDocument) as {
      authorized: number;
      planAvailable: number;
    };
    return {
      authorityDocument,
      document: typeof document === "string" ? document : null,
      state: parseState(typeof document === "string" ? document : null),
      authorized: authority.authorized === 1,
      planAvailable: authority.planAvailable === 1,
      ownerLive: owner?.results[0]?.["value"] === 1,
      secrets: secrets?.results ?? [],
    };
  };
  const decide = (snapshot: Snapshot) => {
    if (!snapshot.authorized) throw new DeliveryScopeError();
    const state = snapshot.state,
      generation = integer(state?.["desired_generation"] ?? "0");
    if (
      state?.["active_lease_id"] !== null &&
      state?.["active_lease_id"] !== undefined &&
      typeof state["lease_expires_at"] === "string" &&
      (state["lease_expires_at"] > input.claimedAt ||
        // An expired lease whose staging operation is still live is not work for the cron yet.
        (input.trigger === "reconcile" && snapshot.ownerLive))
    )
      return {
        outcome: "busy" as const,
        generation,
        releaseSequence: integer(state["claimed_release_sequence"], 1),
        retryAt: publicTimestamp(state["lease_expires_at"]),
      };
    const reconcileNeeded =
      input.force === true ||
      generation > integer(state?.["applied_generation"] ?? "0") ||
      state?.["last_failure_code"] != null ||
      state?.["active_lease_id"] != null;
    if (
      !snapshot.planAvailable ||
      (input.trigger === "reconcile" && (!reconcileNeeded || state?.["provider_tag"] == null))
    )
      return {
        outcome: "current" as const,
        generation,
        releaseSequence: integer(
          state?.["active_lease_id"] != null
            ? state["claimed_release_sequence"]
            : (state?.["applied_release_sequence"] ?? "0"),
        ),
      };
    const releaseSequence = integer(state?.["next_release_sequence"] ?? "1", 1),
      appliedSecretNames = storedNames(state?.["applied_secret_names"] ?? "[]");
    if (snapshot.secrets.length > 100) throw new DeliveryInputError();
    const secrets = snapshot.secrets.map((row) => {
      if (typeof row["name"] !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row["name"]))
        throw new DeliveryInputError();
      return {
        name: row["name"],
        ciphertext: bytesOf(row["ciphertext"]),
        nonce: bytesOf(row["nonce"]),
        valueSha256: bytesOf(row["value_sha256"]),
        keyVersion: integer(row["key_version"], 1),
        revision: integer(row["revision"], 1),
      };
    });
    return {
      outcome: "claimed" as const,
      generation,
      trigger: input.trigger,
      runtimeProvider: "wfp" as const,
      releaseSequence,
      leaseId: input.leaseId,
      leaseExpiresAt: new Date(Date.parse(input.claimedAt) + input.leaseMilliseconds).toISOString(),
      secrets,
      appliedSecretNames,
      ...(typeof state?.["provider_tag"] === "string"
        ? { providerTag: state["provider_tag"] }
        : {}),
    };
  };
  const command: Command<Snapshot, ClaimResult> = {
    name: "runtimeSecrets.claim",
    input,
    read,
    decide: (snapshot) => {
      const result = decide(snapshot);
      if (result.outcome !== "claimed" && snapshot.state !== null) return { replay: result };
      const statements = [
        guard(db, "precondition_changed", `(${AUTH_DOCUMENT}) IS NOT ?6`, [
          ...bindings,
          snapshot.authorityDocument,
        ]),
        stateFence(db, input, snapshot.document),
        initializeState(db, input, input.claimedAt),
      ];
      if (result.outcome === "claimed")
        statements.push(
          db
            .prepare(
              `UPDATE runtime_secret_delivery_states SET active_lease_id=?4,claimed_generation=desired_generation,claimed_release_sequence=next_release_sequence,next_release_sequence=next_release_sequence+1,claimed_trigger=?5,claimed_at=?6,lease_expires_at=?7,updated_at=?6 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3`,
            )
            .bind(
              ...scopeParams,
              input.leaseId,
              input.trigger,
              input.claimedAt,
              result.leaseExpiresAt.slice(0, -1) + "000Z",
            ),
          guard(db, "precondition_changed", "changes()<>1"),
        );
      return { statements, result: () => result };
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["runtime_secret_delivery_states"],
    lookup: async (reader) => {
      const snapshot = await read(reader);
      if (snapshot.state === null) return undefined;
      // Original retry after a lost claim commit is busy/current. Never reconstruct an old generation with a NEW cipher snapshot.
      const result = decide(snapshot);
      return result.outcome === "claimed" ? undefined : result;
    },
  };
  return runCommand(db, command);
}
