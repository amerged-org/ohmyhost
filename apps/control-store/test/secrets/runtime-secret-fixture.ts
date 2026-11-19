import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import {
  promotionIntent,
  seedAcceptedOperation,
  seedOperation,
  seedPublishedClaim,
} from "../support/accepted-operation.js";
import type { TestControl } from "../support/control-d1.js";
import { seedProject, STORED_NOW, bytes } from "../support/platform-fixtures.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";

/** Complete accepted source graph; provider claim is last, after its immutable intent/outbox/workflow parents. */
export async function acceptedSecretFixture(
  control: TestControl,
  environment: "dev" | "prod" = "prod",
) {
  const project = await seedProject(control, {
      handle: `secret-${newUlid().toLowerCase()}-studio`,
    }),
    db = control.core,
    env = environment === "prod" ? project.prodEnvironmentId : project.devEnvironmentId;
  const { claim, published } = await seedPublishedClaim(project, env, (operationId) =>
    seedWfpPublication(project, { operationId, environmentId: env }),
  );
  return {
    project,
    db,
    published,
    operationId: claim.operationId,
    claimId: claim.claimId,
    scope: {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: env,
    },
    store: createControlStore(control.bindings),
  };
}
export async function promotionMailFixture(control: TestControl) {
  const r = await acceptedSecretFixture(control, "dev"),
    p = r.project,
    db = r.db,
    target = p.prodEnvironmentId;
  await db.batch([
    db
      .prepare("UPDATE operations SET state='succeeded' WHERE organization_id=? AND operation_id=?")
      .bind(p.organizationId, r.operationId),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state='completed',terminal_evidence='{}',completed_at=updated_at WHERE organization_id=? AND operation_id=?",
      )
      .bind(p.organizationId, r.operationId),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=? AND project_id=?",
      )
      .bind(p.organizationId, p.projectId),
  ]);
  // The accepted promotion of that published revision into Production holds the project's claim next.
  const promoted = await seedAcceptedOperation(p, target, {
    eventType: "DeploymentPromotionRequestedV1",
    operationId: await seedOperation(p),
    intent: (operation) =>
      promotionIntent(p, operation, target, {
        ...r.published,
        environmentId: p.devEnvironmentId,
      }),
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'OHMYHOST_MAIL_KEY',?4,?5,?6,1,1,?7,?7)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        bytes(24, 4),
        bytes(12, 5),
        bytes(32, 6),
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at) VALUES(?1,?2,1,?3,?4)",
      )
      .bind(p.organizationId, p.projectId, bytes(32, 6), STORED_NOW),
  ]);
  return { ...r, operationId: promoted.operationId, claimId: promoted.claimId, target };
}
