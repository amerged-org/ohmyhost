import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrationsThrough,
  startTestPostgres,
  type TestPostgres,
} from "../../../apps/control-api/test/postgres.js";

let database: TestPostgres;
const identifier = (n: number) => String(n).padStart(26, "0");
const created = "2026-09-23T12:00:00.000Z";
const ids = {
  organization: identifier(1),
  project: identifier(2),
  dev: identifier(3),
  prod: identifier(4),
  source: identifier(5),
};

beforeAll(async () => {
  database = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await database?.stop();
}, 60_000);

/** Parent rows and append-only fixtures are written without FK or trigger checks; CHECKs still apply. */
async function replica<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    return await work(client);
  } finally {
    await client.query("SET session_replication_role=origin");
    client.release();
  }
}

function plan(client: PoolClient, planId: string, expiresAt: string, environmentId?: string) {
  const withEnvironment = environmentId !== undefined;
  return client.query(
    `INSERT INTO deployment_plans(plan_id,organization_id,project_id,source_connection_id,commit_sha,
       source_sha256,build_plan_sha256,plan_sha256,runtime,impacts,risks,cost_estimate,created_at,expires_at${withEnvironment ? ",environment_id" : ""})
     VALUES($1,$2,$3,$4,repeat('a',40),decode(repeat('aa',32),'hex'),decode(repeat('bb',32),'hex'),
       decode(repeat('cc',32),'hex'),'workers','[]','[]','{}',$5,$6${withEnvironment ? ",$7" : ""})`,
    [
      planId,
      ids.organization,
      ids.project,
      ids.source,
      created,
      expiresAt,
      ...(withEnvironment ? [environmentId] : []),
    ],
  );
}

function ticket(client: PoolClient, ticketId: string, expiresAt: string) {
  return client.query(
    `INSERT INTO dev_access_tickets(ticket_id,organization_id,project_id,environment_id,environment_name,
       handle,public_origin,dev_access_epoch,issued_to_principal_id,token_sha256,issued_at,expires_at)
     VALUES($1,$2,$3,$4,'dev','calm-otter-runs','https://dev-calm-otter-runs.check.omh.st',1,'user:'||$7,
       decode(md5($7)||md5($7),'hex'),$5,$6)`,
    [ticketId, ids.organization, ids.project, ids.dev, created, expiresAt, `token-${ticketId}`],
  );
}

const plus = (minutes: number) => new Date(Date.parse(created) + minutes * 60_000).toISOString();

describe("migration 149: plan environment and longer plan and ticket lifetimes", () => {
  it("backfills existing plans to Dev, accepts Prod plans and the new lifetimes, and reverts only when safe", async () => {
    await database.migrate("down", await migrationsThrough("149_plan_environment_and_ttls"));
    await replica(async (client) => {
      await client.query(
        `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at,handle,handle_version,handle_attempt)
         VALUES($1,$2,'Plan environment',$1,$3,'calm-otter-runs','customer-chosen-v1',0)`,
        [ids.project, ids.organization, created],
      );
      await client.query(
        `INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
         VALUES($1,$2,'active',1,$3,$4)`,
        [ids.project, ids.organization, identifier(6), created],
      );
      await client.query(
        `INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
         VALUES($1,$2,$3,$4,'user:migration-fixture')`,
        [identifier(6), ids.project, ids.organization, created],
      );
      await client.query(
        `INSERT INTO github_source_connections(organization_id,project_id,billing_epoch_id,source_connection_id,provider,external_repository_id,created_at)
         VALUES($1,$2,$3,$4,'github','1339976528',$5)`,
        [ids.organization, ids.project, identifier(6), ids.source, created],
      );
      await client.query(
        `INSERT INTO repository_grants(grant_id,organization_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at)
         VALUES($1,$2,$3,$4,$5,'github','154436098','1339976528','owner','repository','contents:read',$6)`,
        [identifier(7), ids.organization, ids.project, identifier(6), ids.source, created],
      );
      for (const [environmentId, name] of [
        [ids.dev, "dev"],
        [ids.prod, "prod"],
      ] as const)
        await client.query(
          `INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at,dev_access_epoch)
           VALUES($1,$2,$3,$4,'{}',$5,$5,CASE WHEN $4='dev' THEN 1 ELSE 0 END)`,
          [ids.organization, ids.project, environmentId, name, created],
        );
      await plan(client, identifier(10), plus(15));
      await ticket(client, identifier(20), plus(10));
      await expect(plan(client, identifier(11), plus(60))).rejects.toThrow(/shape_check/u);
    });

    await database.migrate("up");
    const backfilled = await database.pool.query(
      "SELECT environment_id FROM deployment_plans WHERE plan_id=$1",
      [identifier(10)],
    );
    expect(backfilled.rows).toEqual([{ environment_id: ids.dev }]);
    await replica(async (client) => {
      await plan(client, identifier(12), plus(24 * 60), ids.prod);
      await ticket(client, identifier(21), plus(60));
      await expect(plan(client, identifier(13), plus(24 * 60 + 1), ids.prod)).rejects.toThrow(
        /shape_check/u,
      );
      await expect(ticket(client, identifier(22), plus(30))).rejects.toThrow(/shape_check/u);
    });
    const down = await migrationsThrough("149_plan_environment_and_ttls");
    await expect(database.migrate("down", down)).rejects.toThrow(/cannot be reverted/u);
    await replica(async (client) => {
      await client.query("DELETE FROM deployment_plans WHERE plan_id=$1", [identifier(12)]);
      await client.query("DELETE FROM dev_access_tickets WHERE ticket_id=$1", [identifier(21)]);
    });
    // Successful newer down migrations remain applied when149 refuses its own rollback.
    // Restore the known head before using a count derived from the complete migration list.
    await database.migrate("up");
    await database.migrate("down", down);
    const columns = await database.pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='deployment_plans' AND column_name='environment_id'`,
    );
    expect(columns.rowCount).toBe(0);
    await database.migrate("up");
  });
});
