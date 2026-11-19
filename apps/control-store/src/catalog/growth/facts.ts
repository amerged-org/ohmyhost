import type { D1Database } from "../../d1-types.js";

/** Closed, minimized Core projections. Snapshot rows are explicitly identified as such. */
const queries = {
  attribution: `SELECT workos_user_id AS source_id, workos_user_id AS account_id, CASE WHEN origin_present=1 THEN origin_source ELSE NULL END AS r,
    utm_parameters, recorded_at FROM user_signup WHERE (origin_present=1 OR utm_parameters IS NOT NULL) AND workos_user_id > ?1
    ORDER BY workos_user_id LIMIT ?2`,
  onboarding: `SELECT request_id AS source_id, workos_user_id AS account_id, organization_id,
    created_at, completed_at FROM onboarding_requests WHERE request_id > ?1 ORDER BY request_id LIMIT ?2`,
  memberships: `SELECT organization_id || ':' || workos_user_id AS source_id, organization_id,
    workos_user_id AS account_id, state, effective_at, mapping_revision FROM organization_memberships
    WHERE organization_id || ':' || workos_user_id > ?1 ORDER BY organization_id, workos_user_id LIMIT ?2`,
  projects: `SELECT i.project_id AS source_id, i.project_id, i.created_organization_id AS organization_id,
    i.created_event_id, i.created_at,
    (SELECT CASE WHEN COUNT(*) = 1 AND MIN(e.created_by_principal_id) GLOB 'user:user_*' THEN substr(MIN(e.created_by_principal_id),6) WHEN COUNT(*) = 1 AND MIN(e.created_by_principal_id) GLOB 'user_*' THEN MIN(e.created_by_principal_id) ELSE NULL END
      FROM billing_epochs e WHERE e.project_id=i.project_id AND e.organization_id=i.created_organization_id AND e.started_at=i.created_at) AS account_id
    FROM project_identities i WHERE i.project_id > ?1 ORDER BY i.project_id LIMIT ?2`,
  source_publications: `SELECT operation_id AS source_id, operation_id, organization_id, project_id,
    CASE WHEN principal_id GLOB 'user:user_*' THEN substr(principal_id,6) WHEN principal_id GLOB 'user_*' THEN principal_id ELSE NULL END AS account_id, mode, state, created_at,
    (SELECT ev.event_id FROM operation_events ev WHERE ev.organization_id = managed_source_publications.organization_id AND ev.operation_id = managed_source_publications.operation_id AND ev.event_type = 'OperationSucceeded' ORDER BY ev.revision LIMIT 1) AS terminal_event_id,
    (SELECT ev.occurred_at FROM operation_events ev WHERE ev.organization_id = managed_source_publications.organization_id AND ev.operation_id = managed_source_publications.operation_id AND ev.event_type = 'OperationSucceeded' ORDER BY ev.revision LIMIT 1) AS terminal_at FROM managed_source_publications
    WHERE operation_id > ?1 ORDER BY operation_id LIMIT ?2`,
  deployments: `SELECT d.deployment_id AS source_id, d.deployment_id, d.organization_id, d.project_id,
    d.operation_id, d.environment_id, e.name AS target_environment, d.kind, d.status, d.created_at, d.updated_at,
    (SELECT CASE WHEN a.actor_type='user' AND a.actor_id GLOB 'user:user_*' THEN substr(a.actor_id,6) WHEN a.actor_type='user' AND a.actor_id GLOB 'user_*' THEN a.actor_id ELSE NULL END FROM audit_events a WHERE a.organization_id=d.organization_id AND a.operation_id=d.operation_id ORDER BY a.occurred_at, a.audit_event_id LIMIT 1) AS account_id,
    (SELECT p.candidate_receipt_id FROM deployment_revisions r JOIN wfp_publish_receipts p ON p.wfp_receipt_id=r.wfp_receipt_id AND p.organization_id=r.organization_id AND p.project_id=r.project_id WHERE r.organization_id=d.organization_id AND r.project_id=d.project_id AND r.deployment_id=d.deployment_id AND r.revision_id=d.active_revision_id AND p.environment_id=d.environment_id AND p.product_deployment_id=d.deployment_id LIMIT 1) AS candidate_receipt_id,
    (SELECT ev.event_id FROM operation_events ev WHERE ev.organization_id=d.organization_id AND ev.operation_id=d.operation_id AND ev.event_type = CASE WHEN d.status='succeeded' THEN 'OperationSucceeded' ELSE 'OperationFailed' END ORDER BY ev.revision LIMIT 1) AS terminal_event_id,
    (SELECT ev.occurred_at FROM operation_events ev WHERE ev.organization_id=d.organization_id AND ev.operation_id=d.operation_id AND ev.event_type = CASE WHEN d.status='succeeded' THEN 'OperationSucceeded' ELSE 'OperationFailed' END ORDER BY ev.revision LIMIT 1) AS terminal_at,
    (SELECT x.diagnostic_event_id FROM deployment_diagnostics x WHERE x.deployment_id=d.deployment_id AND x.organization_id=d.organization_id AND x.project_id=d.project_id AND x.environment_id=d.environment_id AND x.source='runtime' AND x.code='HEALTH_CHECK_FAILED' ORDER BY x.occurred_at, x.diagnostic_event_id LIMIT 1) AS health_evidence_id
    FROM deployments d JOIN environments e ON e.organization_id = d.organization_id
      AND e.environment_id = d.environment_id WHERE d.deployment_id > ?1
      ORDER BY d.deployment_id LIMIT ?2`,
} as const;
export type GrowthFactSource = keyof typeof queries;
export interface GrowthFactPage {
  facts: Record<string, unknown>[];
  next_cursor: string | null;
  source_watermark: null;
  history_floor: null;
  evidence_kind: "snapshot" | "original";
}

/** A cursor is a source-local primary key, never SQL or a provider query. */
export async function readGrowthFactPage(db: D1Database, input: unknown): Promise<GrowthFactPage> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("Invalid fact page");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["source", "cursor", "limit"].includes(key)) ||
    typeof value["source"] !== "string" ||
    !Object.hasOwn(queries, value["source"]) ||
    !(
      value["cursor"] === null ||
      (typeof value["cursor"] === "string" && value["cursor"].length <= 260)
    ) ||
    !Number.isInteger(value["limit"]) ||
    (value["limit"] as number) < 1 ||
    (value["limit"] as number) > 200
  ) {
    throw new TypeError("Invalid fact page");
  }
  const source = value["source"] as GrowthFactSource;
  const limit = value["limit"] as number;
  const result = await db
    .prepare(queries[source])
    .bind(value["cursor"] ?? "", limit + 1)
    .all<Record<string, unknown>>();
  if (!result.success) throw new Error("Fact source unavailable");
  const facts = result.results.slice(0, limit);
  const last = facts.at(-1);
  return {
    facts,
    next_cursor:
      result.results.length > limit && typeof last?.["source_id"] === "string"
        ? last["source_id"]
        : null,
    source_watermark: null,
    history_floor: null,
    evidence_kind: source === "projects" ? "original" : "snapshot",
  };
}

/** Only a confirmed, unambiguous Stripe customer maps to its canonical Core organization. */
export async function resolveGrowthStripeCustomer(
  db: D1Database,
  input: unknown,
): Promise<{ organization_id: string } | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("Invalid customer");
  const value = input as Record<string, unknown>,
    id = value["customer_id"];
  if (
    Object.keys(value).length !== 1 ||
    typeof id !== "string" ||
    !/^cus_[A-Za-z0-9_]{1,128}$/.test(id)
  )
    throw new TypeError("Invalid customer");
  const result = await db
    .prepare(
      "SELECT organization_id FROM stripe_billing_customers WHERE provider_id=?1 AND provider_confirmed_at IS NOT NULL LIMIT 2",
    )
    .bind(id)
    .all<{ organization_id: string }>();
  if (!result.success) throw new Error("Customer mapping unavailable");
  const [mapping] = result.results;
  return result.results.length === 1 && mapping
    ? { organization_id: mapping.organization_id }
    : null;
}
