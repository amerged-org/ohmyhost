/* global URL */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openLocalTarget,
  targetPin,
  importPlan,
  compareRecords,
} from "../scripts/control-d1-migration.mjs";
import { schemaFingerprint } from "../scripts/control-d1-target.mjs";
import {
  bindingApplier,
  bindingQuery,
  comparePages,
  importApiBulk,
  renderLiteral,
  renderStatement,
} from "../scripts/control-d1-bulk.mjs";
import { sha256 } from "../scripts/control-d1-codec.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const at = (n) =>
  `2026-10-29T${String(Math.floor(n / 3600) % 24).padStart(2, "0")}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000001Z`;
const ulid = (n) => `01${String(n).padStart(24, "0")}`;
const hostile = [
  "semi;\nnewline",
  "it's a'b''c",
  "-- comment",
  "/* block */",
  'dq"x',
  "back\\slash",
  "emoji \u{1F600}    ",
  "crlf\r\nline",
  "END;\nCREATE TABLE evil(x);\n--",
  "  padded  ",
  "?1 ? ?",
];

test("the import-API transport renders exact files, keeps the overlay and receipt guarantees, and survives failed and lost files", async () => {
  // Rendering is exact before any database is involved.
  assert.equal(renderLiteral("9223372036854775807"), "'9223372036854775807'");
  assert.equal(renderLiteral(Uint8Array.from([0, 255, 16])), "X'00ff10'");
  assert.equal(renderLiteral("it's"), "'it''s'");
  assert.throws(() => renderLiteral("a\u0000b"), /BULK_LITERAL/u);
  assert.throws(() => renderLiteral("\ud800"), /BULK_LITERAL/u);
  assert.equal(
    renderStatement({
      sql: "SELECT ?2, ?1, ?, 'it''s ?', \"q?\" -- c ?\n",
      params: ["a", "b", "c"],
    }),
    "SELECT 'b', 'a', 'c', 'it''s ?', \"q?\" -- c ?\n",
  );

  const directory = await mkdtemp(join(tmpdir(), "omh-control-d1-bulk-"));
  const target = await openLocalTarget({ repositoryRoot });
  try {
    const pin = await targetPin(repositoryRoot);
    const initialSchema = await schemaFingerprint(target.db);
    const who = { captureId: randomUUID(), manifestSha256: sha256(randomBytes(8)) };
    const organization = (n) => ({
      table: "organizations",
      row: {
        organization_id: ulid(n),
        workos_organization_id: `org_${n}`,
        state: "active",
        mapping_revision: "1",
        snapshot_sha256: sha256(`org${n}`),
        snapshot_fetched_at: at(n),
        synchronized_at: at(n),
        beta_admitted_at: null,
        signup_source: null,
        created_at: at(n),
        updated_at: at(n),
        bucket: String(n % 1024),
      },
    });
    const contact = (n, message = JSON.stringify({ n, text: hostile[n % hostile.length] })) => ({
      table: "contact_requests",
      row: {
        request_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        payload_sha256: sha256(`contact${n}`),
        name: `${hostile[n % hostile.length]}${n}`.slice(0, 100),
        email: "ada@example.com",
        company: "",
        message,
        created_at: at(n % 80000),
        expires_at: "2027-10-29T10:00:00.000001Z",
      },
    });
    const evidence = (n) => ({
      table: "evidence_exports",
      row: {
        export_id: ulid(900 + n),
        organization_id: ulid(1),
        table_name: "contact_requests",
        period_start: at(n),
        period_end: at(n + 1),
        row_count: n % 4 === 0 ? "9223372036854775807" : n % 2 === 0 ? "9007199254740993" : "5",
        sha256: sha256(`evidence${n}`),
        r2_key: `exports/${n}`,
        created_at: at(n),
        source_format: "x",
      },
    });
    // Too long for the limit below: this one keeps the ordinary batch path, between two runs of files.
    const long = contact(9000, "x".repeat(8000));
    const records = [
      ...Array.from({ length: 30 }, (_, n) => organization(n + 1)),
      ...Array.from({ length: 2500 }, (_, n) => contact(n)),
      ...Array.from({ length: 1500 }, (_, n) => contact(2500 + n)),
      long,
      ...Array.from({ length: 100 }, (_, n) => evidence(n)),
      ...Array.from({ length: 1500 }, (_, n) => contact(5000 + n)),
    ];
    const plan = {
      format: "omh.control-d1.plan/v3",
      atomicProtocol: "contiguous-units-v1",
      qualificationOnly: true,
      ...who,
      digest: sha256(randomBytes(8)),
      targetPin: pin,
      mapped: ["organizations", "contact_requests"],
      unhandled: [],
      unhandledViews: [],
      unhandledSequences: [],
      runtimeGates: [],
      sequenceRestores: [],
      gaps: [],
      verdict: "MAPPED_QUALIFICATION_ONLY",
      requiredTemporalTables: [],
      records,
    };
    const limits = {
      recordsPerFile: 1200,
      bytesPerFile: 1e9,
      statementBytes: 8_000,
      minimumRun: 50,
    };
    const applier = bindingApplier(target.db);
    const calls = [];
    const run = async (name, apply) => {
      const bulk = importApiBulk({
        apply,
        query: bindingQuery(target.db),
        limits,
        pause: async () => {},
      });
      return importPlan({
        db: target.db,
        plan,
        targetId: "bulk",
        key: randomBytes(32),
        journal: join(directory, `${name}.journal`),
        currentPin: pin,
        repositoryRoot,
        batchRows: 100,
        bulk,
      });
    };
    const count = async (sql) => (await target.db.prepare(sql).first()).n;

    // Run 1: the second file is poisoned and fails as a whole; the first stays, with its receipt.
    await assert.rejects(
      run("first", async (bytes) => {
        calls.push("first");
        if (calls.length >= 2)
          return applier(
            Buffer.concat([
              bytes,
              Buffer.from("INSERT INTO guard_fail(code) SELECT 'claim_lost';\n"),
            ]),
          );
        return applier(bytes);
      }),
    );
    assert.equal(
      await count("SELECT count(*) n FROM command_log WHERE name='control-d1.import-file'"),
      1,
    );
    assert.equal(await count("SELECT count(*) n FROM organizations"), 30);
    assert.equal(
      await count("SELECT count(*) n FROM contact_requests"),
      1170,
      "the failed file left no row behind",
    );

    // Run 2: the finished file is not sent again; a lost reply and a transient failure are told apart by the receipt.
    calls.length = 0;
    const result = await run("second", async (bytes) => {
      calls.push("second");
      if (calls.length === 2) throw new Error("transient transport failure before the file landed");
      await applier(bytes);
      if (calls.length === 4) throw new Error("the reply was lost after the file landed");
      return {};
    });
    const files = result.applied.filter((entry) => entry.file);
    assert.equal(files.length, 6);
    assert.equal(files.filter((entry) => entry.replayed).length, 1);
    assert.equal(calls.length, 6, "five files were left, one of them sent twice");
    assert.equal(
      await count("SELECT count(*) n FROM command_log WHERE name='control-d1.import-file'"),
      6,
    );
    assert.equal(await count("SELECT count(*) n FROM contact_requests"), 5501);

    // Everything is in the target exactly, found by key order page scans and by the per-record reader alike.
    assert.deepEqual(await compareRecords(target.db, records), []);
    const proofs = [];
    assert.deepEqual(
      await comparePages(target.db, records, {
        exact: false,
        pageRows: 700,
        report: (proof) => proofs.push(proof),
      }),
      [],
    );
    assert.ok(
      proofs.every(
        (proof) =>
          proof.sha256 === proof.expectedSha256 &&
          proof.extra === 0 &&
          proof.rows === proof.expected,
      ),
    );

    // The overlay triggers are all back: the schema equals the migrated schema.
    assert.equal(await schemaFingerprint(target.db), initialSchema);
    await target.db.batch([
      target.db
        .prepare(
          "INSERT INTO organizations(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,created_at,updated_at,bucket) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          ulid(99),
          "org_99",
          "active",
          1,
          Uint8Array.from(Buffer.alloc(32, 7)),
          at(1),
          at(1),
          at(1),
          at(1),
          1,
        ),
    ]);

    // The page-scan comparison finds a changed row and, when exact, a row nobody named.
    await target.db
      .prepare("UPDATE evidence_exports SET row_count=row_count+1 WHERE export_id=?")
      .bind(ulid(905))
      .run();
    const changed = await comparePages(target.db, records, { exact: false });
    assert.deepEqual(
      changed.map((index) => records[index].row.export_id),
      [ulid(905)],
    );
    await target.db
      .prepare("UPDATE evidence_exports SET row_count=? WHERE export_id=?")
      .bind(5, ulid(905))
      .run();
    assert.deepEqual(await comparePages(target.db, records, { exact: false }), []);
    assert.ok(
      (await comparePages(target.db, records, { exact: true })).length > 0,
      "the extra organization is named",
    );

    // The journal shows what happened to the files.
    const journal = (await readFile(join(directory, "first.journal"), "utf8"))
      .split("\n")
      .filter(Boolean);
    assert.ok(journal.some((line) => line.includes("file_rolled_back")));
  } finally {
    await target.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
