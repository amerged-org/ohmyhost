import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { D1Database } from "../src/d1-types.js";
import { storedTimestamp } from "../src/timestamps.js";
import { activateTestCore, migrationFiles, type TestControl } from "./support/control-d1.js";
import { coreBootstrapWorker, initializeCoreFixture } from "./support/core-bootstrap.js";
import { splitStatements } from "./support/sql.js";
import { seedProject, type SeededProject } from "./support/platform-fixtures.js";
import { time } from "./support/cloudflare-fixtures.js";

const MIGRATION = new URL("../migrations/core/0710_paid_hostname_proofs.sql", import.meta.url);
const PROJECT_LEAVES = new URL(
  "../migrations/core/0711_paid_hostname_proofs_end_with_project.sql",
  import.meta.url,
);
const HOSTNAME = "shop.grandfather.example.net";
const MOVED = "shop.elsewhere.example.org";
const SECOND = "second.grandfather.example.org";

let miniflare: Miniflare;
let core: D1Database;
let project: SeededProject;
let second: SeededProject;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: coreBootstrapWorker,
    d1Databases: { CONTROL_CORE: "core-0710" },
  });
  // The schema before migration 0710, with the rows a live Core holds at that point.
  core = await initializeCoreFixture(
    miniflare,
    () => migrationFiles("core").filter((file) => file.name < "0710_"),
    activateTestCore,
  );
  const control = {
    core,
    bindings: { CONTROL_CORE: core },
    directory: core,
    shards: { CONTROL_SHARD_0000: core, CONTROL_SHARD_0001: core },
    dispose: () => miniflare.dispose(),
  } as unknown as TestControl;
  project = await seedProject(control);
  // A verified mail identity for the Paid hostname itself, exactly as the identity stored it before 0710.
  await core
    .prepare(
      `INSERT INTO project_application_domain_identities(organization_id,project_id,hostname,registrable_domain,revision,
        state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id)
       VALUES(?1,?2,?3,'grandfather.example.net',1,'verified',?4,?5,?6,?6,?7,?8,?9,'user:owner')`,
    )
    .bind(
      project.organizationId,
      project.projectId,
      HOSTNAME,
      `_omh-project.${HOSTNAME}`,
      `omh-domain-v1=${"b".repeat(43)}`,
      storedTimestamp(time(0)),
      storedTimestamp("2026-12-01T00:00:00.000Z"),
      new Uint8Array(32).fill(5),
      new Uint8Array(32).fill(6),
    )
    .run();
  // The project's Paid connection on that hostname, awaiting its deployment and not proven.
  await core
    .prepare(
      `INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,
        apply_idempotency_sha256,apply_request_sha256,created_at,updated_at)
       VALUES(?1,?2,?3,NULL,'awaiting_deployment','user:owner',?4,?5,?6,?6)`,
    )
    .bind(
      project.organizationId,
      project.projectId,
      HOSTNAME,
      new Uint8Array(32).fill(7),
      new Uint8Array(32).fill(8),
      storedTimestamp(time(0)),
    )
    .run();
  // A second project whose verified identity names a hostname with no Paid connection: 0710 copies it too.
  second = await seedProject(control);
  await core
    .prepare(
      `INSERT INTO project_application_domain_identities(organization_id,project_id,hostname,registrable_domain,revision,
        state,challenge_name,challenge_value,declared_at,verified_at,expires_at,idempotency_key_sha256,request_sha256,actor_id)
       VALUES(?1,?2,?3,'grandfather.example.org',1,'verified',?4,?5,?6,?6,?7,?8,?9,'user:owner')`,
    )
    .bind(
      second.organizationId,
      second.projectId,
      SECOND,
      `_omh-project.${SECOND}`,
      `omh-domain-v1=${"e".repeat(43)}`,
      storedTimestamp(time(0)),
      storedTimestamp("2026-12-01T00:00:00.000Z"),
      new Uint8Array(32).fill(11),
      new Uint8Array(32).fill(12),
    )
    .run();
}, 120_000);
afterAll(async () => miniflare.dispose());

async function migrate(): Promise<void> {
  await core.batch(
    splitStatements(readFileSync(MIGRATION, "utf8")).map((statement) => core.prepare(statement)),
  );
}

describe("migration 0710 paid hostname proofs", () => {
  it("copies a verified identity of a Paid hostname as that Paid proof, and keeps the identity", async () => {
    await migrate();

    const proof = await core
      .prepare(
        "SELECT state,challenge_name,challenge_value,expires_at FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3",
      )
      .bind(project.organizationId, project.projectId, HOSTNAME)
      .first<Record<string, string>>();
    expect(proof).toMatchObject({
      state: "verified",
      challenge_name: `_omh-project.${HOSTNAME}`,
      challenge_value: `omh-domain-v1=${"b".repeat(43)}`,
      expires_at: storedTimestamp("2026-12-01T00:00:00.000Z"),
    });
    const identity = await core
      .prepare(
        "SELECT state FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ state: string }>();
    expect(identity?.state).toBe("verified");
    const copied = await core
      .prepare(
        "SELECT state FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3",
      )
      .bind(second.organizationId, second.projectId, SECOND)
      .first<{ state: string }>();
    expect(copied?.state).toBe("verified");
  });

  it("leaves the Paid connection unproven and is idempotent on a second run", async () => {
    await migrate();
    const row = await core
      .prepare(
        "SELECT state,hostname_proven_at FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ state: string; hostname_proven_at: string | null }>();
    expect(row).toEqual({ state: "awaiting_deployment", hostname_proven_at: null });
    const count = await core
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
    const copies = await core
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2 AND hostname=?3",
      )
      .bind(second.organizationId, second.projectId, SECOND)
      .first<{ n: number }>();
    expect(copies?.n).toBe(1);
  });

  it("keeps the mail identity verified when the Paid hostname moves outside its domain", async () => {
    await core
      .prepare(
        "UPDATE paid_project_domains SET hostname=?3, updated_at=?4 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId, MOVED, storedTimestamp(time(1)))
      .run();
    const identity = await core
      .prepare(
        "SELECT state FROM project_application_domain_identities WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ state: string }>();
    expect(identity?.state).toBe("verified");
  });
});

describe("migration 0711 paid hostname proofs end with the project", () => {
  it("ends every proof of a project that changes owner or leaves its lifecycle, as the mail identity did", async () => {
    await migrate();
    await core.batch(
      splitStatements(readFileSync(PROJECT_LEAVES, "utf8")).map((statement) =>
        core.prepare(statement),
      ),
    );
    const before = await core
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ n: number }>();
    expect(before?.n).toBe(1);
    await core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    const after = await core
      .prepare(
        "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .first<{ n: number }>();
    expect(after?.n).toBe(0);
  });
});

describe("migration 0711 ownership transfer", () => {
  it("ends a project's proofs when its ownership is transferred", async () => {
    const HOST = "transfer.grandfather.example.net";
    await core
      .prepare(
        "INSERT INTO paid_hostname_proofs(organization_id,project_id,hostname,state,challenge_name,challenge_value,declared_at) VALUES(?1,?2,?3,'pending',?4,?5,?6)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        HOST,
        `_omh-project.${HOST}`,
        `omh-domain-v1=${"c".repeat(43)}`,
        storedTimestamp(time(2)),
      )
      .run();
    const count = () =>
      core
        .prepare(
          "SELECT count(*) AS n FROM paid_hostname_proofs WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(project.organizationId, project.projectId)
        .first<{ n: number }>();
    expect((await count())?.n).toBe(1);
    await core
      .prepare(
        "UPDATE billing_epochs SET ended_at=?3 WHERE organization_id=?1 AND billing_epoch_id=(SELECT active_billing_epoch_id FROM projects WHERE organization_id=?1 AND project_id=?2)",
      )
      .bind(project.organizationId, project.projectId, storedTimestamp(time(3)))
      .run();
    await core
      .prepare(
        "UPDATE projects SET owner_state='transferred' WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId)
      .run();
    expect((await count())?.n).toBe(0);
  });
});
