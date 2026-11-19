import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { guard } from "../../src/guards.js";
import {
  activateTestCore,
  createTestControl,
  migrationFiles,
  type TestControl,
} from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { buildRig, cid } from "../support/build-fixtures.js";
import { transferBuildProject } from "../support/build-history.fixture.js";
import { ulidOf } from "../support/platform-fixtures.js";

it("upgrades populated Build tables byte-for-byte and preserves original058 historical scope", async () => {
  const harness = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('private')}}",
    d1Databases: { CONTROL_CORE: "build-history" },
  });
  try {
    const db = (await harness.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const migration = migrationFiles("core").find((f) => f.name === "0325_build_history_scope.sql");
    if (migration === undefined) throw new Error("Build history migration missing");
    //0384 is an unserved-only assignment migration, qualified independently. This deliberately
    //activated pre0325 fixture exercises Build's historical upgrade, not an authority reopen.
    //0352 and later foreign keys name the unique environment identity key that0325 would create. The old populated
    //schema gets exactly that key (0325 uses IF NOT EXISTS) as soon as its parent table exists, so every other
    //migration runs in native order and the Build tables keep their pre0325 foreign keys until the upgrade lands.
    for (const file of migrationFiles("core").filter(
      (f) => f.name !== migration.name && !f.name.startsWith("0384_"),
    )) {
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
      if (file.name.startsWith("0334_"))
        await db
          .prepare(
            "CREATE UNIQUE INDEX IF NOT EXISTS environment_identities_project_environment ON environment_identities (project_id, environment_id)",
          )
          .run();
      if (file.name.startsWith("0758_"))
        expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    }
    expect(
      (await db.prepare("PRAGMA foreign_key_list(project_previews)").all()).results
        .filter((fk) => fk["table"] === "environment_data_assignments")
        .map((fk) => ({ from: fk["from"], to: fk["to"] })),
    ).toEqual([
      { from: "organization_id", to: "organization_id" },
      { from: "project_id", to: "project_id" },
      { from: "environment_id", to: "environment_id" },
      { from: "assignment_version", to: "assignment_version" },
    ]);
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: () => harness.dispose(),
    };
    const r = await buildRig(control),
      p = r.project;
    await r.store.build.claimBuildInput(r.claim);
    await r.store.build.putBuildReceipt(r.envelope);
    const usage = {
      runner: "cloudflare-build-sandbox",
      instanceType: "standard-3",
      status: "SUCCEEDED",
      startedAt: "2026-10-28T12:00:00.000Z",
      provisioningStartedAt: "2026-10-28T12:00:00.800Z",
      completedAt: "2026-10-28T12:01:57.286Z",
    };
    // An original unreserved observation is immutable evidence, never retroactively billed.
    await r.store.build.putBuildUsage({ receipt: r.receipt, usage });
    const snapshot = async () => {
      const [reservations, receipts, measured] = await db.batch([
        db.prepare("SELECT * FROM build_input_reservations ORDER BY operation_id"),
        db.prepare("SELECT * FROM build_receipts ORDER BY operation_id"),
        db.prepare("SELECT * FROM build_usage ORDER BY operation_id"),
      ]);
      return [reservations?.results, receipts?.results, measured?.results];
    };
    const before = await snapshot();
    await expect(
      db.batch([
        ...splitStatements(migration.sql).map((sql) => db.prepare(sql)),
        guard(db, "precondition_changed", "1"),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect(await snapshot()).toEqual(before);
    expect(
      await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name GLOB '*_0325*'").first(),
    ).toEqual({ n: 0 });
    await db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql)));
    expect(await snapshot()).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    for (const table of ["build_receipts", "build_input_reservations"]) {
      const fks = (await db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results;
      expect(
        fks
          .filter((fk) => fk["table"] === "environment_identities")
          .map((fk) => ({ from: fk["from"], to: fk["to"], on_delete: fk["on_delete"] })),
      ).toEqual([
        { from: "project_id", to: "project_id", on_delete: "RESTRICT" },
        { from: "environment_id", to: "environment_id", on_delete: "RESTRICT" },
      ]);
    }
    const importedOperation = ulidOf("retained-build-import", 1),
      importedClaim = cid();
    // The operation was accepted while its owner was current. Import that parent before retiring its scope.
    await db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) SELECT organization_id,?2,project_id,state,billing_epoch_id,created_at,updated_at FROM operations WHERE organization_id=?1 AND operation_id=?3",
      )
      .bind(p.organizationId, importedOperation, r.scope.operationId)
      .run();
    await transferBuildProject(control, r);
    // The Core preserves existing historical aliases; none belongs to today's active owner.
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM environments e JOIN projects p USING(organization_id,project_id) WHERE e.organization_id=? AND p.owner_state='active'",
        )
        .bind(p.organizationId)
        .first(),
    ).toEqual({ n: 0 });
    expect(await snapshot()).toEqual(before);
    await expect(r.store.build.claimBuildInput({ ...r.claim, claimId: cid() })).rejects.toThrow();
    expect(
      await r.store.build.authorizeBuildStart({ scope: r.scope, claimId: r.claim.claimId }),
    ).toBe(false);
    await expect(r.store.build.putBuildReceipt(r.envelope)).rejects.toThrow();
    await r.store.build.putBuildUsage({ receipt: r.receipt, usage });

    await db.batch([
      db
        .prepare(
          `INSERT INTO build_input_reservations(organization_id,project_id,environment_id,operation_id,input_fingerprint,claim_id,claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until)
        SELECT organization_id,project_id,environment_id,?2,input_fingerprint,?3,claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until FROM build_input_reservations WHERE organization_id=?1 AND operation_id=?4`,
        )
        .bind(p.organizationId, importedOperation, importedClaim, r.scope.operationId),
      db
        .prepare(
          `INSERT INTO build_receipts(organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,created_at,input_fingerprint,build_claim_id)
        SELECT organization_id,project_id,environment_id,?2,?3,build_project_name,created_at,input_fingerprint,?4 FROM build_receipts WHERE organization_id=?1 AND operation_id=?5`,
        )
        .bind(
          p.organizationId,
          importedOperation,
          `sandbox:${importedOperation}`,
          importedClaim,
          r.scope.operationId,
        ),
    ]);
    const importedReceipt = {
      ...r.receipt,
      buildId: `sandbox:${importedOperation}`,
      scope: { ...r.scope, operationId: importedOperation },
    };
    await r.store.build.putBuildUsage({ receipt: importedReceipt, usage });
    expect(
      (await db.prepare("SELECT DISTINCT organization_id,billing_epoch_id FROM build_usage").all())
        .results,
    ).toEqual([{ organization_id: p.organizationId, billing_epoch_id: p.billingEpochId }]);
    expect(await db.prepare("SELECT count(*) n FROM credit_log").first()).toEqual({ n: 0 });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(
      db.prepare("UPDATE build_receipts SET provider_build_id='changed'").run(),
    ).rejects.toThrow("append-only");
    await expect(db.prepare("DELETE FROM build_input_reservations").run()).rejects.toThrow(
      "append-only",
    );
    await expect(
      db.prepare("UPDATE build_input_reservations SET claim_id=?").bind(cid()).run(),
    ).rejects.toThrow("expired claim renewal");
    await expect(
      db
        .prepare("DELETE FROM environment_identities WHERE environment_id=?")
        .bind(p.devEnvironmentId)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    const other = await buildRig(control);
    await expect(
      db
        .prepare(
          `INSERT INTO build_receipts(organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,created_at)
      VALUES(?1,?2,?3,?4,'foreign','foreign','2026-10-28T10:00:00.000000Z')`,
        )
        .bind(p.organizationId, p.projectId, other.project.devEnvironmentId, importedOperation)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
  } finally {
    await harness.dispose();
  }
}, 120_000);

it("imports a former owner's receipt and reservation without fabricating any old environment alias", async () => {
  const control = await createTestControl();
  try {
    const r = await buildRig(control),
      p = r.project,
      db = control.core;
    await r.store.build.claimBuildInput(r.claim);
    await r.store.build.putBuildReceipt(r.envelope);
    const { nextOrg } = await transferBuildProject(control, r);
    const projectId = ulidOf("historical-build-project", 1),
      environmentId = ulidOf("historical-build-environment", 1),
      oldEpoch = ulidOf("historical-build-epoch", 1),
      newEpoch = ulidOf("historical-build-epoch", 2),
      operationId = ulidOf("historical-build-operation", 1),
      createdEvent = ulidOf("historical-build-created", 1),
      claimId = cid();
    // This models the exact final snapshot/import shape: a historical project/epoch/scope and a single CURRENT
    // environment under its new owner. There never was a current environments row for the old imported scope.
    // Neither the migration nor the import needs to fabricate one to make an otherwise valid Build FK pass.
    await db.batch([
      db
        .prepare(
          `INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at)
        SELECT organization_id,?3,created_organization_id,name,?4,'historical-build','customer-chosen-v1',0,lifecycle_state,lifecycle_version,'active',1,?5,data_mode,region,dev_access_mode,created_at,updated_at FROM projects WHERE organization_id=?1 AND project_id=?2`,
        )
        .bind(p.organizationId, p.projectId, projectId, createdEvent, oldEpoch),
      db
        .prepare(
          "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,'2026-10-28T10:00:00.000000Z','user:history-import')",
        )
        .bind(p.organizationId, oldEpoch, projectId),
      // Import the accepted operation before retiring its historical scope; no operation-admission trigger is disabled.
      db
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,'2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')",
        )
        .bind(p.organizationId, operationId, projectId, oldEpoch),
      db
        .prepare(
          "UPDATE billing_epochs SET ended_at='2026-10-28T12:02:00.000000Z' WHERE organization_id=?1 AND billing_epoch_id=?2",
        )
        .bind(p.organizationId, oldEpoch),
      db
        .prepare(
          "UPDATE projects SET owner_state='transferred' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, projectId),
      db
        .prepare(
          `INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at)
        SELECT ?1,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,'active',2,?4,data_mode,region,dev_access_mode,created_at,updated_at FROM projects WHERE organization_id=?2 AND project_id=?3`,
        )
        .bind(nextOrg, p.organizationId, projectId, newEpoch),
      db
        .prepare(
          "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,'2026-10-28T12:02:00.000000Z','user:history-import')",
        )
        .bind(nextOrg, newEpoch, projectId),
      db
        .prepare(
          "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,'dev','{}',0,1,'2026-10-28T10:00:00.000000Z','2026-10-28T12:02:00.000000Z')",
        )
        .bind(nextOrg, environmentId, projectId),
      db
        .prepare(
          `INSERT INTO build_input_reservations(organization_id,project_id,environment_id,operation_id,input_fingerprint,claim_id,claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until)
        SELECT organization_id,?2,?3,?4,input_fingerprint,?5,claim_mode,claimed_at,lease_expires_at,attempt_number,created_at,start_allowed_until FROM build_input_reservations WHERE organization_id=?1 AND operation_id=?6`,
        )
        .bind(
          p.organizationId,
          projectId,
          environmentId,
          operationId,
          claimId,
          r.scope.operationId,
        ),
      db
        .prepare(
          `INSERT INTO build_receipts(organization_id,project_id,environment_id,operation_id,provider_build_id,build_project_name,created_at,input_fingerprint,build_claim_id)
        SELECT organization_id,?2,?3,?4,?5,build_project_name,created_at,input_fingerprint,?6 FROM build_receipts WHERE organization_id=?1 AND operation_id=?7`,
        )
        .bind(
          p.organizationId,
          projectId,
          environmentId,
          operationId,
          `sandbox:${operationId}`,
          claimId,
          r.scope.operationId,
        ),
    ]);
    expect(
      await db
        .prepare("SELECT count(*) n FROM environments WHERE organization_id=?1 AND project_id=?2")
        .bind(p.organizationId, projectId)
        .first(),
    ).toEqual({ n: 0 });
    const scope = { projectId, environmentId, operationId },
      receipt = { scope, buildId: `sandbox:${operationId}`, projectName: r.receipt.projectName };
    await r.store.build.putBuildUsage({
      receipt,
      usage: {
        runner: "cloudflare-build-sandbox",
        instanceType: "standard-3",
        status: "SUCCEEDED",
        startedAt: "2026-10-28T12:00:00.000Z",
        provisioningStartedAt: "2026-10-28T12:00:00.800Z",
        completedAt: "2026-10-28T12:01:57.286Z",
      },
    });
    expect(
      await db
        .prepare("SELECT organization_id,billing_epoch_id FROM build_usage WHERE operation_id=?")
        .bind(operationId)
        .first(),
    ).toEqual({ organization_id: p.organizationId, billing_epoch_id: oldEpoch });
    await expect(
      r.store.build.claimBuildInput({ ...r.claim, scope, claimId: cid() }),
    ).rejects.toThrow();
    expect(await r.store.build.authorizeBuildStart({ scope, claimId })).toBe(false);
    await expect(
      r.store.build.putBuildReceipt({ ...r.envelope, receipt, claimId }),
    ).rejects.toThrow();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 120_000);
