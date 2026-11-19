import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

import { newUlid } from "../src/catalog/common.js";
import type { D1Database, D1PreparedStatement } from "../src/d1-types.js";
import {
  bootstrapCore,
  coreBootstrapWorker,
  initializeCoreFixture,
} from "./support/core-bootstrap.js";
import {
  activateTestCore,
  migrationFiles,
  shardBinding,
  type TestControl,
} from "./support/control-d1.js";
import {
  seedProject,
  STORED_NOW,
  ulidOf,
  type SeededProject,
} from "./support/platform-fixtures.js";

// Migration 0820 rebuilds github_push_deployments, whose superseded_by_id references the same table with ON DELETE
// RESTRICT. The chains are built on the pre-0820 schema, where the commit tuple is still UNIQUE, so every row gets its
// own commit. Each chain ends at a running head; its superseded rows point along it, and their keys ascend or descend.
const REDELIVERY = migrationFiles("core").find(({ name }) =>
  name.endsWith("_github_push_redelivery.sql"),
)?.name as string;
// Superseded or cleanup_pending rows of each chain, before its head. The longest chain outgrows any small fixed number
// of leaf-first deletion passes, so the rebuild must not depend on the chain length.
const CHAIN_DEPTHS = [1, 3, 40, 70];
const CHAIN_ROWS = CHAIN_DEPTHS.reduce((sum, depth) => sum + depth + 1, 0);

type KeyOrder = "ascending" | "descending";

const migrationsWhere = (select: (name: string) => boolean) =>
  migrationFiles("core").filter(({ name }) => select(name));

function controlOf(db: D1Database): TestControl {
  return {
    core: db,
    bindings: { CONTROL_CORE: db },
    directory: db,
    shards: { [shardBinding(0)]: db, [shardBinding(1)]: db },
    dispose: async () => undefined,
  };
}

const commitOf = (n: number) => n.toString(16).padStart(40, "0");

const pushRows = async (db: D1Database) =>
  (
    await db
      .prepare("SELECT * FROM github_push_deployments ORDER BY push_deployment_id")
      .all<Record<string, unknown>>()
  ).results;

const foreignKeyViolations = async (db: D1Database) =>
  (await db.prepare("PRAGMA foreign_key_check").all()).results;

/**
 * The statements of one push row of `project`: its operation (none for a row that was superseded before it got one),
 * its inbox event and the row itself. A superseded row names its superseder, so the caller orders the rows parents first.
 */
function pushStatements(
  db: D1Database,
  project: SeededProject,
  connection: string,
  row: {
    id: string;
    commit: string;
    sequence: number;
    state: "running" | "superseded" | "cleanup_pending";
    supersededBy: string | null;
    operationless?: boolean;
  },
): D1PreparedStatement[] {
  const inboxEventId = newUlid();
  const deliveryGuid = crypto.randomUUID();
  const operationId = row.operationless ? null : newUlid();
  const statements: D1PreparedStatement[] = [];
  if (operationId !== null)
    statements.push(
      db
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
        )
        .bind(
          project.organizationId,
          operationId,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push','{}',?3,?4,'pending',5,?4,?5)",
      )
      .bind(
        inboxEventId,
        deliveryGuid,
        new Uint8Array(32).fill(1),
        STORED_NOW,
        project.organizationId,
      ),
    db
      .prepare(
        "INSERT INTO github_push_deployments(push_deployment_id,inbox_event_id,organization_id,project_id,source_connection_id,config_generation,delivery_guid,github_installation_id,external_repository_id,branch_ref,commit_sha,sequence,operation_id,state,superseded_by_id,cleanup_required,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,'42','77','refs/heads/main',?7,?8,?9,?10,?11,?12,?13,?13)",
      )
      .bind(
        row.id,
        inboxEventId,
        project.organizationId,
        project.projectId,
        connection,
        deliveryGuid,
        row.commit,
        row.sequence,
        operationId,
        row.state,
        row.supersededBy,
        row.state === "cleanup_pending" ? 1 : 0,
        STORED_NOW,
      ),
  );
  return statements;
}

/**
 * A project with one chain of every depth in CHAIN_DEPTHS, keyed in `order` from the oldest row of each chain to its
 * head. The superseded rows alternate between superseded and cleanup_pending; the oldest row of each chain is
 * superseded without an operation.
 */
async function seedProjectChains(
  db: D1Database,
  control: TestControl,
  order: KeyOrder,
): Promise<{ project: SeededProject; connection: string }> {
  const project = await seedProject(control);
  const connection = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','77',?5)",
      )
      .bind(
        project.organizationId,
        connection,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','42','77','Octo','App','contents:read',?6)",
      )
      .bind(
        project.organizationId,
        newUlid(),
        project.projectId,
        project.billingEpochId,
        connection,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
      )
      .bind(project.organizationId, project.projectId, connection, STORED_NOW),
  ]);
  let sequence = 0;
  let base = 0;
  for (const depth of CHAIN_DEPTHS) {
    const length = depth + 1;
    const ids = Array.from({ length }, (_, position) =>
      ulidOf(`push-${order}`, base + (order === "ascending" ? position : length - 1 - position)),
    );
    base += length;
    const statements: D1PreparedStatement[] = [];
    // parents first: a superseded row's superseded_by_id must exist when the row is inserted
    for (let position = length - 1; position >= 0; position -= 1) {
      const head = position === length - 1;
      sequence += 1;
      statements.push(
        ...pushStatements(db, project, connection, {
          id: ids[position] as string,
          commit: commitOf(sequence),
          sequence,
          state: head ? "running" : position % 2 === 0 ? "superseded" : "cleanup_pending",
          supersededBy: head ? null : (ids[position + 1] as string),
          operationless: position === 0,
        }),
      );
    }
    await db.batch(statements);
  }
  return { project, connection };
}

it("rebuilds a populated push table with superseded chains keyed in ascending and in descending order, keeping every row and a valid foreign key graph", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: coreBootstrapWorker,
    d1Databases: { CONTROL_CORE: "github-push-redelivery" },
  });
  try {
    const db = await initializeCoreFixture(miniflare, () =>
      migrationsWhere((name) => name < REDELIVERY),
    );
    await activateTestCore(db);
    const ascending = await seedProjectChains(db, controlOf(db), "ascending");
    await seedProjectChains(db, controlOf(db), "descending");
    const before = await pushRows(db);
    expect(before).toHaveLength(2 * CHAIN_ROWS);
    expect(
      (await db.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>())?.foreign_keys,
    ).toBe(1);
    expect(await foreignKeyViolations(db)).toEqual([]);

    await bootstrapCore(
      miniflare,
      migrationsWhere((name) => name === REDELIVERY),
    );

    expect(await pushRows(db)).toEqual(before);
    expect(await foreignKeyViolations(db)).toEqual([]);
    // the rebuilt table admits a second push of a commit that already has rows: the commit tuple is no longer unique
    const sameCommit = before.find((row) => row["project_id"] === ascending.project.projectId)?.[
      "commit_sha"
    ] as string;
    await db.batch(
      pushStatements(db, ascending.project, ascending.connection, {
        id: ulidOf("push-duplicate", 1),
        commit: sameCommit,
        sequence: CHAIN_ROWS + 1,
        state: "running",
        supersededBy: null,
      }),
    );
    expect(await pushRows(db)).toHaveLength(2 * CHAIN_ROWS + 1);
  } finally {
    await miniflare.dispose();
  }
}, 120_000);
