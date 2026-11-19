import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { TestPostgres } from "../../../control-api/test/postgres.js";
import type { D1Database } from "../../src/d1-types.js";
import type { gatewayFixture } from "./gateway-fixture.js";

const connect = (pg: Pick<TestPostgres, "pool">) => pg.pool.connect();
type PoolClient = Awaited<ReturnType<typeof connect>>;
const SEEDED_AT = "2026-09-01T00:00:00.000Z";
const SEEDED_MAPPING_AT = "2026-09-10T10:00:00.000Z";

interface SeededWallet {
  readonly organizationId: string;
  readonly workosOrganizationId: string;
  readonly project: {
    readonly projectId: string;
    readonly createdEventId: string;
    readonly epochId: string;
    readonly devEnvironmentId: string;
    readonly prodEnvironmentId: string;
    readonly handle: string;
  };
}

/** The organization mapping, project, billing epoch, ownership and environments, as plain SQL. */
async function seedOrganizationProject(c: PoolClient, wallet: SeededWallet): Promise<void> {
  const { project } = wallet;
  await c.query(
    `INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at)
    VALUES($1,$2,'active',1,decode(repeat('aa',32),'hex'),$3,$3,$3)`,
    [wallet.organizationId, wallet.workosOrganizationId, SEEDED_MAPPING_AT],
  );
  await c.query(
    `INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at)
    VALUES($1,$2,'Billing scale',$3,'human-id-4.2.0-sha256-project-handle-words-v1',0,$4,$5)`,
    [project.projectId, wallet.organizationId, project.handle, project.createdEventId, SEEDED_AT],
  );
  await c.query(
    `INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
    VALUES($1,$2,$3,$4,'user:billing-scale-test')`,
    [project.epochId, project.projectId, wallet.organizationId, SEEDED_AT],
  );
  await c.query(
    `INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
    VALUES($1,$2,'active',1,$3,$4)`,
    [project.projectId, wallet.organizationId, project.epochId, SEEDED_AT],
  );
  await c.query(
    `INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at)
    VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)`,
    [
      wallet.organizationId,
      project.projectId,
      project.devEnvironmentId,
      project.prodEnvironmentId,
      SEEDED_AT,
    ],
  );
}

/** Test-only identical accepted facts in the full original PG18 schema. Every native FK/trigger stays enabled.
 * This constructs a fresh synthetic oracle, not a converter/historical replay. The deployment/revision cycle
 * is built in the same valid order as production: deployment -> publication/revision -> active pointer.
 */
export async function seedOriginalGateway(
  pg: Pick<TestPostgres, "pool">,
  r: Pick<Awaited<ReturnType<typeof gatewayFixture>>, "project" | "db">,
  options: { legacyGateway?: boolean } = {},
) {
  const c = await connect(pg);
  try {
    await c.query("BEGIN");
    const p = r.project;
    const creation = await r.db
      .prepare("SELECT created_event_id FROM projects WHERE organization_id=? AND project_id=?")
      .bind(p.organizationId, p.projectId)
      .first<{ created_event_id: string }>();
    if (creation === null) throw new Error("Missing original project creation identity");
    const wallet = {
      organizationId: p.organizationId,
      workosOrganizationId: `org_gateway_${p.organizationId}`,
      project: {
        projectId: p.projectId,
        createdEventId: creation.created_event_id,
        epochId: p.billingEpochId,
        devEnvironmentId: p.devEnvironmentId,
        prodEnvironmentId: p.prodEnvironmentId,
        handle: p.handle,
      },
    };
    await seedOrganizationProject(c, wallet);
    for (const [source, target] of [
      ["operations", "operations"],
      ["source_connections", "github_source_connections"],
      ["repository_grants", "repository_grants"],
      ["deployment_plans", "deployment_plans"],
      ["build_source_uploads", "build_source_uploads"],
      ["build_executions", "build_executions"],
      ["build_artifacts", "build_artifacts"],
      ["cloudflare_project_domains", "cloudflare_project_domains"],
      ["deployments", "deployments"],
      ["wfp_candidate_receipts", "wfp_candidate_receipts"],
      ["shared_gateway_route_revisions", "shared_gateway_route_revisions"],
      ["wfp_publish_receipts", "wfp_publish_receipts"],
      ["deployment_revisions", "deployment_revisions"],
      ["product_command_intents", "product_command_intents"],
      ["outbox_events", "outbox_events"],
      ["product_workflow_runs", "product_workflow_runs"],
      ["product_provider_mutation_claims", "product_provider_mutation_claims"],
    ] as const) {
      if (!(options.legacyGateway && source === "shared_gateway_route_revisions"))
        await copyRows(
          c,
          r.db,
          source,
          target,
          p.organizationId,
          options.legacyGateway,
          source === "deployments" ? "deploy" : undefined,
        );
      if (source === "deployment_revisions")
        await copyRows(
          c,
          r.db,
          "deployments",
          "deployments",
          p.organizationId,
          options.legacyGateway,
          "dependent",
        );
    }
    const deployments = (
      await r.db
        .prepare(
          "SELECT deployment_id,active_revision_id,active_version,status FROM deployments WHERE organization_id=?",
        )
        .bind(p.organizationId)
        .all()
    ).results;
    for (const d of deployments)
      await c.query(
        "UPDATE deployments SET active_revision_id=$1,active_version=$2,status=$3 WHERE deployment_id=$4",
        [d["active_revision_id"], d["active_version"], d["status"], d["deployment_id"]],
      );
    const environments = (
      await r.db
        .prepare(
          "SELECT environment_id,active_deployment_id,active_revision_id,head_version FROM environments WHERE organization_id=?",
        )
        .bind(p.organizationId)
        .all()
    ).results;
    for (const e of environments)
      await c.query(
        "UPDATE environments SET active_deployment_id=$1,active_revision_id=$2,head_version=$3 WHERE organization_id=$4 AND environment_id=$5",
        [
          e["active_deployment_id"],
          e["active_revision_id"],
          e["head_version"],
          p.organizationId,
          e["environment_id"],
        ],
      );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function copyRows(
  c: PoolClient,
  db: D1Database,
  source: string,
  target: string,
  organizationId: string,
  legacyGateway = false,
  deploymentPhase?: "deploy" | "dependent",
) {
  const columns = (
    await c.query<{ column_name: string; data_type: string }>(
      "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
      [target],
    )
  ).rows;
  if (columns.length === 0) throw new Error(`Missing original table ${target}`);
  const rows = (
    await db.prepare(`SELECT * FROM ${source} WHERE organization_id=?`).bind(organizationId).all()
  ).results;
  for (const input of rows) {
    if (
      target === "deployments" &&
      deploymentPhase !== undefined &&
      (input["kind"] === "deploy") !== (deploymentPhase === "deploy")
    )
      continue;
    const row = { ...input };
    if (target === "deployments") {
      row["active_revision_id"] = null;
      row["active_version"] = 0;
      row["status"] = "running";
    }
    // Before149 the original schema required exactly15minutes, rather than the later24-hour plan window.
    if (legacyGateway && target === "deployment_plans")
      row["expires_at"] = new Date(Date.parse(String(row["created_at"])) + 900000).toISOString();
    if (legacyGateway && target === "wfp_publish_receipts") {
      const candidate = await db
        .prepare(
          "SELECT immutable_script_name FROM wfp_candidate_receipts WHERE candidate_receipt_id=?",
        )
        .bind(row["candidate_receipt_id"])
        .first<{ immutable_script_name: string }>();
      const domain = await db
        .prepare("SELECT handle FROM cloudflare_project_domains WHERE project_id=?")
        .bind(row["project_id"])
        .first<{ handle: string }>();
      if (!candidate || !domain) throw new Error("Missing original v7 fixture provenance");
      const gatewayName = (
        await c.query<{ script: string }>(
          "SELECT project_gateway_script_name($1,$2,'prod',$3) script",
          [row["project_id"], domain.handle, domain.handle + ".check.omh.st"],
        )
      ).rows[0]?.script;
      if (!gatewayName) throw new Error("Missing original gateway script identity");
      Object.assign(row, {
        gateway_contract_version: "ohmyhost.project-gateway/v7",
        gateway_script_name: gatewayName,
        gateway_target_script_name: candidate.immutable_script_name,
        gateway_workers_dev_subdomain: "fixture",
        gateway_internal_origin: `https://${gatewayName}.fixture.workers.dev`,
        gateway_public_origin: row["deployment_url"],
        gateway_provider_tag: Buffer.alloc(32, 1),
        gateway_module_sha256: Buffer.alloc(32, 2),
        gateway_egress_policy_sha256: createHash("sha256").update("[]").digest(),
        gateway_compatibility_date: "2026-10-12",
        gateway_observed_at: row["published_at"],
        gateway_version_id: "retained-v7-version",
        gateway_deployment_id: "retained-v7-deployment",
      });
    }
    const shared = columns.filter((col) => Object.hasOwn(row, col.column_name));
    const values = shared.map((col) => {
      const v = row[col.column_name];
      if (v === null) return null;
      if (col.data_type === "bytea") {
        if (!Array.isArray(v) && !(v instanceof Uint8Array))
          throw new Error("Invalid source fixture blob");
        return Buffer.from(v);
      }
      return col.data_type === "boolean" ? v === 1 : v;
    });

    await c.query(
      `INSERT INTO ${target}(${shared.map((col) => col.column_name).join(",")}) VALUES(${shared.map((_, i) => `$${i + 1}`).join(",")})`,
      values,
    );
  }
}
