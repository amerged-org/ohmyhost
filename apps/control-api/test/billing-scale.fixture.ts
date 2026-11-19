import type { TransactionClient } from "@ohmyhost/database";

/**
 * Plain-SQL seeds of an organization and its project with their billing epoch on the real local
 * PostgreSQL schema, for the tests that still read PostgreSQL as their source.
 */
const SEEDED_AT = "2026-09-10T10:00:00.000Z";
const PROJECT_CREATED_AT = "2026-09-01T00:00:00.000Z";

export interface Wallet {
  readonly organizationId: string;
  readonly workosOrganizationId: string;
}
export interface Project {
  readonly projectId: string;
  readonly createdEventId: string;
  readonly epochId: string;
  readonly devEnvironmentId: string;
  readonly prodEnvironmentId: string;
  readonly handle: string;
}
export interface ProjectWallet extends Wallet {
  readonly project: Project;
}

export async function seedOrganization(c: TransactionClient, wallet: Wallet): Promise<void> {
  await c.query(
    `INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at)
    VALUES($1,$2,'active',1,decode(repeat('aa',32),'hex'),$3,$3,$3)`,
    [wallet.organizationId, wallet.workosOrganizationId, SEEDED_AT],
  );
}

/** An active project with its billing epoch, so the organization can be charged usage. */
export async function seedProject(c: TransactionClient, wallet: ProjectWallet): Promise<void> {
  const { project } = wallet;
  await c.query(
    `INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at)
    VALUES($1,$2,'Billing scale',$3,'human-id-4.2.0-sha256-project-handle-words-v1',0,$4,$5)`,
    [
      project.projectId,
      wallet.organizationId,
      project.handle,
      project.createdEventId,
      PROJECT_CREATED_AT,
    ],
  );
  await c.query(
    `INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
    VALUES($1,$2,$3,$4,'user:billing-scale-test')`,
    [project.epochId, project.projectId, wallet.organizationId, PROJECT_CREATED_AT],
  );
  await c.query(
    `INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
    VALUES($1,$2,'active',1,$3,$4)`,
    [project.projectId, wallet.organizationId, project.epochId, PROJECT_CREATED_AT],
  );
  await c.query(
    `INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at)
    VALUES($1,$2,$3,'dev','{}',$5,$5),($1,$2,$4,'prod','{}',$5,$5)`,
    [
      wallet.organizationId,
      project.projectId,
      project.devEnvironmentId,
      project.prodEnvironmentId,
      PROJECT_CREATED_AT,
    ],
  );
}
