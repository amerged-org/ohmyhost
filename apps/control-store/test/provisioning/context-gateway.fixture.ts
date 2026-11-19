import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import type { TestControl } from "../support/control-d1.js";
import { seedProject, STORED_NOW, bytes } from "../support/platform-fixtures.js";
import {
  seedAcceptedOperation,
  seedOperation,
  seedPublishedClaim,
  releaseProviderClaim,
} from "../support/accepted-operation.js";
import { seedContextPublication as seedWfpPublication } from "./context-source-fixture.js";

/** Real canonical accepted/publication parents and a fresh same-project artifact-reuse candidate. No fake schema. */
export async function contextGatewayFixture(
  control: TestControl,
  options: { publishedEnvironment?: "dev" | "prod" } = {},
) {
  const project = await seedProject(control, {
      handle: `gateway-${newUlid().toLowerCase()}-studio`,
    }),
    env = project.prodEnvironmentId,
    db = control.core;
  const publishedEnvironment =
    options.publishedEnvironment === "dev" ? project.devEnvironmentId : env;
  const { claim: previous, published } = await seedPublishedClaim(
    project,
    publishedEnvironment,
    (operationId) =>
      seedWfpPublication(project, { operationId, environmentId: publishedEnvironment }),
  );
  await db
    .prepare("UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2")
    .bind(project.organizationId, previous.operationId)
    .run();
  await releaseProviderClaim(project);
  const operationId = await seedOperation(project),
    deploymentId = newUlid(),
    candidateReceiptId = newUlid(),
    providerTag = "b".repeat(32);
  const script = `p-${project.projectId.toLowerCase()}-prod-${deploymentId.toLowerCase()}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
      )
      .bind(project.organizationId, deploymentId, project.projectId, env, operationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO wfp_candidate_receipts(candidate_receipt_id,organization_id,project_id,environment_id,operation_id,product_deployment_id,artifact_id,dispatch_namespace,immutable_script_name,artifact_sha256,provider_tag,build_reused,staged_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'ohmyho-production',?8,?9,?10,1,?11)",
      )
      .bind(
        candidateReceiptId,
        project.organizationId,
        project.projectId,
        env,
        operationId,
        deploymentId,
        published.artifactId,
        script,
        bytes(32, 3),
        providerTag,
        STORED_NOW,
      ),
  ]);
  const source = await db
    .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
    .bind(published.planId)
    .first<{ source_connection_id: string }>();
  if (!source) throw new Error("Accepted source fixture missing");
  const claimed = await seedAcceptedOperation(project, env, {
    operationId,
    intent: {
      plan_id: published.planId,
      source_connection_id: source.source_connection_id,
      deployment_id: deploymentId,
      source_generation: 1,
    },
  });
  const accepted = { operationId: claimed.operationId, claimId: claimed.claimId };
  const scope = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    environmentId: env,
  };
  const mutation = {
    ...scope,
    operationId: accepted.operationId,
    claimId: accepted.claimId,
    expectedRevision: 1,
  };
  const activation = { ...mutation, candidateReceiptId, egressAllowedOrigins: [] };
  return {
    project,
    db,
    published,
    previous,
    accepted,
    scope,
    mutation,
    activation,
    deploymentId,
    candidateReceiptId,
    providerTag,
    script,
    store: createControlStore(control.bindings),
    hostname: project.handle + ".check.omh.st",
  };
}
