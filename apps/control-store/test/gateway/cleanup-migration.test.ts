import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { guard } from "../../src/guards.js";
import { activateTestCore, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { newUlid } from "../../src/catalog/common.js";
import { gatewayFixture } from "./gateway-fixture.js";

async function beforeCleanup() {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('private')}}",
    d1Databases: { CONTROL_CORE: "cleanup-migration" },
  });
  const db = (await engine.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  const migration = migrationFiles("core").find(
    (f) => f.name === "0364_gateway_cleanup_authority.sql",
  );
  if (!migration) throw new Error("Missing cleanup migration");
  try {
    // The state before the cleanup authority: the migration itself is withheld, and so are the later ones that read its tables
    // (0634 and 0720 redefine the claim delete guard over the candidate cleanup tables).
    for (const f of migrationFiles("core").filter(
      (f) =>
        f.name !== migration.name &&
        f.name !== "0647_cancelled_claim_release.sql" &&
        f.name !== "0720_r2_reservation_failure_release.sql",
    ))
      await db.batch(splitStatements(f.sql).map((s) => db.prepare(s)));
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      bindings: { CONTROL_CORE: db },
      directory: db,
      shards: { CONTROL_SHARD_0000: db },
      dispose: () => engine.dispose(),
    };
    return { control, db, apply: () => splitStatements(migration.sql).map((s) => db.prepare(s)) };
  } catch (e) {
    await engine.dispose();
    throw e;
  }
}
it("preserves all opaque prototype bytes and projects only exact original request/lease authority, with late-failure rollback", async () => {
  const a = await beforeCleanup();
  try {
    const r = await gatewayFixture(a.control);
    const request = newUlid(),
      claim = newUlid(),
      at = "2026-10-28T10:00:00.000000Z",
      future = "2099-01-01T00:00:00.000000Z";
    await a.db
      .prepare(
        "INSERT INTO wfp_candidate_cleanups(organization_id,candidate_receipt_id,project_id,cleanup_request_id,operation_id,reason,requested_at,claim_id,claim_attempt_number,claimed_at,lease_expires_at,expected_resources,resource_receipts,outcome,outcome_detail,observed_at) VALUES(?1,?2,?3,?4,?5,'failed',?6,?7,2,?6,?8,'[{\"opaque\":\"legacy identity\"}]','[{\"opaque\":\"legacy observation\"}]','old-opaque','{\"not_absence_proof\":true}',?6)",
      )
      .bind(
        r.scope.organizationId,
        r.candidateReceiptId,
        r.scope.projectId,
        request,
        r.accepted.operationId,
        at,
        claim,
        future,
      )
      .run();
    const before = (await a.db.prepare("SELECT * FROM wfp_candidate_cleanups").all()).results;
    await expect(
      a.db.batch([...a.apply(), guard(a.db, "precondition_changed", "1")]),
    ).rejects.toThrow("guard_precondition_changed");
    expect((await a.db.prepare("SELECT * FROM wfp_candidate_cleanups").all()).results).toEqual(
      before,
    );
    expect(
      await a.db
        .prepare("SELECT count(*) n FROM sqlite_schema WHERE name='wfp_candidate_cleanup_requests'")
        .first(),
    ).toEqual({ n: 0 });
    await a.db.batch(a.apply());
    expect((await a.db.prepare("SELECT * FROM wfp_candidate_cleanups").all()).results).toEqual(
      before,
    );
    expect(
      await a.db.prepare("SELECT count(*) n FROM wfp_candidate_cleanup_receipts").first(),
    ).toEqual({ n: 0 });
    const input = {
      ...r.scope,
      operationId: r.accepted.operationId,
      claimId: claim,
      candidateReceiptId: r.candidateReceiptId,
      productDeploymentId: r.deploymentId,
      scriptName: r.script,
      providerTag: r.providerTag,
    };
    // The migrated request and lease authorize exactly this removal.
    expect(await r.store.gateway.management.authorizeCandidateRemoval(input)).toEqual({
      authorized: true,
    });
    for (const change of [
      { claimId: newUlid() },
      { operationId: r.previous.operationId },
      { providerTag: "c".repeat(32) },
      { environmentId: r.project.devEnvironmentId },
    ]) {
      await expect(
        r.store.gateway.management.authorizeCandidateRemoval({ ...input, ...change }),
      ).rejects.toThrow();
    }
    const expired = "2026-10-28T11:00:00.000000Z";
    await a.db
      .prepare("UPDATE wfp_candidate_cleanup_claims SET lease_expires_at=? WHERE claim_id=?")
      .bind(expired, claim)
      .run();
    await expect(r.store.gateway.management.authorizeCandidateRemoval(input)).rejects.toThrow();
    await expect(a.db.prepare("DELETE FROM wfp_candidate_cleanups").run()).rejects.toThrow(
      "read-only",
    );
    await expect(
      a.db.prepare("UPDATE wfp_candidate_cleanup_requests SET reason='compensate'").run(),
    ).rejects.toThrow("append-only");
    expect((await a.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await a.control.dispose();
  }
}, 120000);
it.each(["partial-claim", "foreign-candidate"])(
  "refuses ambiguous/lossy prototype projection %s and preserves original bytes/schema",
  async (kind) => {
    const a = await beforeCleanup();
    try {
      const r = await gatewayFixture(a.control),
        at = "2026-10-28T10:00:00.000000Z";
      await a.db
        .prepare(
          "INSERT INTO wfp_candidate_cleanups(organization_id,candidate_receipt_id,project_id,cleanup_request_id,operation_id,reason,requested_at,claim_id,expected_resources) VALUES(?1,?2,?3,?4,?5,'failed',?6,?7,'[]')",
        )
        .bind(
          r.scope.organizationId,
          kind === "foreign-candidate" ? newUlid() : r.candidateReceiptId,
          r.scope.projectId,
          newUlid(),
          r.accepted.operationId,
          at,
          kind === "partial-claim" ? newUlid() : null,
        )
        .run();
      const before = (await a.db.prepare("SELECT * FROM wfp_candidate_cleanups").all()).results;
      await expect(a.db.batch(a.apply())).rejects.toThrow();
      expect((await a.db.prepare("SELECT * FROM wfp_candidate_cleanups").all()).results).toEqual(
        before,
      );
      expect(
        await a.db
          .prepare(
            "SELECT count(*) n FROM sqlite_schema WHERE name='wfp_candidate_cleanup_requests'",
          )
          .first(),
      ).toEqual({ n: 0 });
    } finally {
      await a.control.dispose();
    }
  },
  120000,
);
