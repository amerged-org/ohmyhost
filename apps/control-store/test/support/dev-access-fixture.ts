import { newUlid } from "../../src/catalog/common.js";
import type { TestControl } from "./control-d1.js";
import { seedProject, STORED_NOW } from "./platform-fixtures.js";

export const DEV_ACCESS_PRINCIPAL = "user:user_dev";

/** An active project whose administrator owns a configured dev domain: everything the Dev access checks read. */
export async function seedDevAccessProject(
  control: TestControl,
  options: { handle?: string } = {},
) {
  const project = await seedProject(control, options),
    db = control.core,
    origin = `https://dev-${project.handle}.check.omh.st`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_dev','admin','active',1,?2,?3,'evt')",
      )
      .bind(project.organizationId, new Uint8Array(32).fill(1), STORED_NOW),
    db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
      )
      .bind(project.organizationId, newUlid(), DEV_ACCESS_PRINCIPAL, STORED_NOW),
    db
      .prepare(
        "INSERT INTO cloudflare_project_domains(organization_id,project_id,operation_id,handle,zone_name,production_domain,development_domain,configured_by_principal_id,idempotency_key_sha256,request_sha256,configured_at) VALUES(?1,?2,?3,?4,'omh.st',?5,?6,?7,?8,?8,?9)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        newUlid(),
        project.handle,
        `${project.handle}.omh.st`,
        origin.slice("https://".length),
        DEV_ACCESS_PRINCIPAL,
        new Uint8Array(32).fill(2),
        STORED_NOW,
      ),
  ]);
  return { project, origin, principalId: DEV_ACCESS_PRINCIPAL };
}
