/* global URL */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openLocalTarget,
  targetPin,
  importPlan,
  compareRecords,
} from "../scripts/control-d1-migration.mjs";
import { comparePhase, importOverlay } from "../scripts/control-d1-target.mjs";
import {
  finalTables,
  phasePlan,
  preloadContent,
  readInsertDependencies,
} from "../scripts/control-d1-phases.mjs";
import { sha256 } from "../scripts/control-d1-codec.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const at = (second) => `2026-10-29T10:00:${String(second).padStart(2, "0")}.000001Z`;

test("a preload round plus a final round imports exactly the capture of the stop, and refuses a changed imported row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omh-control-d1-phases-"));
  const target = await openLocalTarget({ repositoryRoot });
  try {
    const pin = await targetPin(repositoryRoot);
    const overlay = await importOverlay(target.db, repositoryRoot, pin);
    const closed = finalTables(
      await readInsertDependencies(
        target.db,
        new Set(overlay.triggers.map((trigger) => trigger.name)),
      ),
    );
    // Closure: a table below a final-only parent is final-only; an append-only table without parents is not.
    assert.ok(closed.has("workspace_mail_domains") && closed.has("project_mail_domain_bindings"));
    assert.ok(closed.has("function_runs"));
    assert.ok(!closed.has("contact_requests"));

    const contact = (n, message = "hello") => ({
      table: "contact_requests",
      row: {
        request_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        payload_sha256: sha256(String(n)),
        name: "Ada",
        email: "ada@example.com",
        company: "",
        message,
        created_at: at(n % 60),
        expires_at: "2027-10-29T10:00:00.000001Z",
      },
    });
    const functionRun = (second) => ({
      table: "function_runs",
      row: {
        organization_id: "0".repeat(26),
        run_id: "1".repeat(26),
        project_id: "2".repeat(26),
        environment_id: "3".repeat(26),
        deployment_id: "4".repeat(26),
        immutable_script_name: "script",
        cron: "* * * * *",
        scheduled_at: at(0),
        state: "due",
        attempt: "0",
        lease_until: null,
        started_at: null,
        finished_at: null,
        status_code: null,
        egress_allowed_origins: "[]",
        created_at: at(0),
        updated_at: at(second),
      },
    });
    const capture = (contacts, runSecond) => {
      const who = { captureId: randomUUID(), manifestSha256: sha256(randomBytes(8)) };
      return {
        format: "omh.control-d1.plan/v3",
        atomicProtocol: "contiguous-units-v1",
        qualificationOnly: true,
        ...who,
        digest: sha256(randomBytes(8)),
        targetPin: pin,
        mapped: ["contact_requests", "function_runs"],
        unhandled: [],
        unhandledViews: [],
        unhandledSequences: [],
        runtimeGates: [],
        sequenceRestores: [],
        gaps: [],
        verdict: "MAPPED_QUALIFICATION_ONLY",
        requiredTemporalTables: [],
        records: [
          ...Array.from({ length: contacts }, (_, n) => contact(n)),
          functionRun(runSecond),
        ],
      };
    };
    const run = (plan, name) =>
      importPlan({
        db: target.db,
        plan,
        targetId: "phases",
        key: randomBytes(32),
        journal: join(directory, `${name}.journal`),
        currentPin: pin,
        repositoryRoot,
        batchRows: 16,
      });
    const count = async (table) =>
      (await target.db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;

    // Round 1, online: the 40 contact requests of the first capture; the function run waits for the stop.
    const first = capture(40, 1);
    const identity = { captureId: first.captureId, manifestSha256: first.manifestSha256 };
    const preload = phasePlan(first, { phase: "preload", closed, identity });
    assert.equal(preload.records.length, 40);
    assert.deepEqual([preload.phaseInfo.imported, preload.phaseInfo.finalOnly], [40, 0]);
    await run(preload, "preload");
    assert.equal(await count("contact_requests"), 40);
    assert.equal(await count("function_runs"), 0);
    assert.equal(await count("core_historical_import"), 1);

    // A second capture shows an imported row changed: refused before any write, naming only table and count.
    const changed = capture(60, 2);
    changed.records[3] = contact(3, "changed");
    const baseline = preloadContent(first, closed);
    assert.throws(
      () => phasePlan(changed, { phase: "final", baseline, closed, identity }),
      (error) =>
        error.message === "CONTROL_D1_PHASE_SUPERSEDED" &&
        JSON.stringify(error.detail) === '{"contact_requests":1}',
    );

    // Final round, inside the stop: 20 new contact requests plus the changing function run, in the context of round 1.
    const second = capture(60, 2);
    const final = phasePlan(second, { phase: "final", baseline, closed, identity });
    assert.equal(final.records.length, 21);
    assert.deepEqual([final.phaseInfo.imported, final.phaseInfo.finalOnly], [20, 1]);
    await run(final, "final");
    assert.equal(await count("core_historical_import"), 1);
    assert.equal(
      (await target.db.prepare("SELECT import_id FROM core_historical_import").first()).import_id,
      first.captureId,
    );
    // The whole second capture is in the target; both rounds' receipts prove it.
    assert.deepEqual(await compareRecords(target.db, final.records), []);
    assert.deepEqual(await comparePhase(target.db, final, "phases"), []);
    assert.deepEqual(await comparePhase(target.db, preload, "phases"), []);
    assert.equal(await count("contact_requests"), 60);

    // A replay of the finished final round writes nothing and still verifies.
    await run(final, "final-replay");
    assert.equal(await count("contact_requests"), 60);
  } finally {
    await target.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
