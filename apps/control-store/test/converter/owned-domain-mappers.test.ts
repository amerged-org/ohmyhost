import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { TestPostgres } from "../../../control-api/test/postgres.js";
import { expect, it } from "vitest";
import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { seedOwnedSource, seedTargetParents } from "./owned-domain-fixture.js";

type Row = Record<string, string | null>;
type RecordFact = { table: string; row: Row; atomicGroup?: string; deferForeignKeys?: boolean };
type Column = { name: string; kind: string; pgType: string; sourceType: string };
interface Image {
  manifest: {
    captureId: string;
    targetPin: unknown;
    tables: { name: string; columns: Column[] }[];
    views: { name: string; definition: string }[];
  };
  manifestSha256: string;
  rows: Map<string, Row[]>;
}
interface NativeFixture {
  pool: TestPostgres["pool"];
  db: D1Database;
  directory: string;
  key: Buffer;
  image(name: string): Promise<Image>;
  dispose(): Promise<void>;
}
const script = (name: string) =>
  import(new URL(`../../../../scripts/${name}.mjs`, import.meta.url).href);
const fixtureModule = () =>
  import(new URL("../../../../tests/support/control-conversion-fixture.mjs", import.meta.url).href);

it("imports all nineteen native owned families via the real pinned executor and reads unchanged typed facts, effective head and replay", async () => {
  const fixture = (await (
    await fixtureModule()
  ).originalControlFixture("owned-domain")) as NativeFixture;
  let source: Awaited<ReturnType<typeof seedOwnedSource>> | undefined;
  try {
    source = await seedOwnedSource(fixture.pool);
    const image = await fixture.image("owned"),
      wfp = await script("control-d1-wfp-mappings"),
      secrets = await script("control-d1-secret-mappings"),
      storage = await script("control-d1-storage-mappings"),
      spine = await script("control-d1-spine-mappings"),
      codec = await script("control-d1-codec"),
      executor = await script("control-d1-target"),
      view = await script("control-d1-wfp-view"),
      pages = await script("control-d1-readback-pages"),
      beforeSchema = await executor.schemaFingerprint(fixture.db);
    const specs = [
      { columns: wfp.WFP_COLUMNS, map: wfp.mapWfp, read: wfp.readWfpSourceFacts },
      {
        columns: secrets.SECRET_COLUMNS,
        map: secrets.mapSecret,
        read: secrets.readSecretSourceFacts,
      },
      {
        columns: storage.STORAGE_COLUMNS,
        map: storage.mapStorage,
        read: storage.readStorageSourceFacts,
      },
    ];
    for (const spec of specs)
      for (const [table, names] of Object.entries(spec.columns) as [string, string][]) {
        expect(
          image.manifest.tables
            .find((t) => t.name === table)
            ?.columns.map((c) => c.name)
            .sort(),
        ).toEqual(names.split(",").sort());
        expect(
          image.rows.get(table)?.length,
          `${table} must exercise real retained facts`,
        ).toBeGreaterThan(0);
      }
    const operationRecords = (
      spine.mapOperations(image.rows, image.manifest, image) as RecordFact[]
    ).filter((record) => record.table === "operations");
    await seedTargetParents(
      source.r.db,
      fixture.db,
      operationRecords,
      source.bucket,
      image.rows.get("environments") ?? [],
    );
    const records: RecordFact[] = specs.flatMap((spec) =>
      spec.map(image.rows, image.manifest, image),
    );
    const cycles = records.filter((r) => r.deferForeignKeys);
    expect(cycles.map((r) => r.table)).toEqual([
      "deployments",
      "wfp_candidate_receipts",
      "shared_gateway_route_revisions",
      "wfp_publish_receipts",
      "deployment_revisions",
    ]);
    expect(new Set(cycles.map((r) => r.atomicGroup)).size).toBe(1);
    expect(
      records
        .filter((r) => r.table === "shared_gateway_route_revisions")
        .filter((r) => r.row["revision"] !== "1")
        .every((r) => !r.deferForeignKeys),
    ).toBe(true);
    const plan = {
      format: "omh.control-d1.plan/v3",
      atomicProtocol: "contiguous-units-v1",
      qualificationOnly: true,
      captureId: image.manifest.captureId,
      manifestSha256: image.manifestSha256,
      targetPin: image.manifest.targetPin,
      records,
      sequenceRestores: [],
      unhandledSequences: ["UNQUALIFIED-WHOLE-CONTROL-ALLOCATORS"],
      runtimeGates: ["LOCAL-OWNED-DOMAIN-ONLY"],
      unhandled: ["OTHER-CONTROL-DOMAINS"],
      unhandledViews: [],
      gaps: [],
      verdict: "INCOMPLETE",
      requiredTemporalTables: [
        "wfp_candidate_receipts",
        "wfp_candidate_cleanup_receipts",
        "wfp_publish_receipts",
        "wfp_rollback_activation_receipts",
        "runtime_secret_delivery_stage_activations",
      ],
    };
    const complete = { ...plan, digest: codec.sha256(Buffer.from(codec.canonical(plan))) };
    const run = (db = fixture.db, label = "owned-native-fixture") =>
      executor.importPlan({
        db,
        plan: complete,
        targetId: label,
        key: fixture.key,
        journal: join(fixture.directory, `${label}-import.journal`),
        currentPin: image.manifest.targetPin,
        batchRows: 1,
      });
    const deferredStatements = new WeakSet<D1PreparedStatement>();
    const inspect = (sql: string) => {
      const statement = fixture.db.prepare(sql);
      if (sql === "PRAGMA defer_foreign_keys=ON") deferredStatements.add(statement);
      return statement;
    };
    const failing: D1Database = {
      prepare: inspect,
      batch: (statements) =>
        fixture.db.batch(
          statements.some((statement) => deferredStatements.has(statement))
            ? [
                ...statements,
                fixture.db.prepare("INSERT INTO guard_fail(code) VALUES('precondition_changed')"),
              ]
            : statements,
        ),
    };
    await expect(run(failing)).rejects.toThrow("CONTROL_D1_IMPORT_UNCONFIRMED");
    // The final failure rolls the WHOLE minimal serving cycle and its import receipt back, even at rowHint1.
    for (const record of cycles) {
      const identity =
        record.table === "shared_gateway_route_revisions"
          ? "revision"
          : record.table === "wfp_candidate_receipts"
            ? "candidate_receipt_id"
            : record.table === "wfp_publish_receipts"
              ? "wfp_receipt_id"
              : record.table === "deployment_revisions"
                ? "revision_id"
                : "deployment_id";
      const clauses = [identity, "organization_id", "project_id"];
      expect(
        await fixture.db
          .prepare(
            `SELECT count(*) n FROM ${record.table} WHERE ${clauses.map((key) => `${key}=?`).join(" AND ")}`,
          )
          .bind(...clauses.map((key) => record.row[key]))
          .first(),
      ).toEqual({ n: 0 });
    }
    expect((await fixture.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    let lost = false;
    const uncertain: D1Database = {
      prepare: inspect,
      batch: async (statements) => {
        const result = await fixture.db.batch(statements);
        if (!lost && statements.some((statement) => deferredStatements.has(statement))) {
          lost = true;
          throw new Error("Lost actual committed cycle reply");
        }
        return result;
      },
    };
    expect((await run(uncertain)).verdict).toBe("INCOMPLETE");
    expect(lost).toBe(true);
    for (const spec of specs) {
      const facts: Map<string, Row[]> = await spec.read(fixture.db);
      for (const [table, rows] of facts) {
        const columns = image.manifest.tables.find((t) => t.name === table)?.columns;
        if (columns === undefined) throw new Error("Missing native table metadata");
        const values = (rs: Row[]) => rs.map((r) => columns.map((c) => r[c.name]));
        expect(codec.tableProof(columns, values(rows)), table).toEqual(
          codec.tableProof(columns, values(image.rows.get(table) ?? [])),
        );
      }
    }
    // Actual original and actual Core views choose the address revision3 over retained rollback2 and publish1.
    const viewColumns = (
      await fixture.pool.query<{ column_name: string; data_type: string }>(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='effective_wfp_publish_receipts' ORDER BY ordinal_position",
      )
    ).rows;
    const coreSelected = viewColumns.map((c) =>
      c.data_type === "bytea"
        ? `CASE WHEN ${c.column_name} IS NULL THEN NULL ELSE lower(hex(${c.column_name})) END ${c.column_name}`
        : c.data_type === "bigint"
          ? `CAST(${c.column_name} AS TEXT) ${c.column_name}`
          : c.column_name,
    );
    const nativeSelected = viewColumns.map(
      (c) =>
        `${codec.captureExpression({ name: c.column_name, pgType: c.data_type, kind: codec.columnKind(c.data_type) })} AS ${c.column_name}`,
    );
    const expected = (
      await fixture.pool.query(
        `SELECT ${nativeSelected.join(",")} FROM effective_wfp_publish_receipts ORDER BY wfp_receipt_id`,
      )
    ).rows;
    expect(
      (
        await fixture.db
          .prepare(
            `SELECT ${coreSelected.join(",")} FROM effective_wfp_publish_receipts ORDER BY wfp_receipt_id`,
          )
          .all()
      ).results,
    ).toEqual(expected);
    expect(expected.map((r) => r["shared_gateway_revision"])).toEqual(["3"]);
    const originalView = image.manifest.views.find(
      (entry) => entry.name === "effective_wfp_publish_receipts",
    );
    if (!originalView) throw new Error("Missing native original effective view");
    expect(originalView.definition).toBe(view.EFFECTIVE_WFP_DEFINITION);
    const nativeContract = (
      await fixture.pool.query(
        `SELECT a.attname AS name,
          format_type(CASE WHEN t.typtype='d' THEN t.typbasetype ELSE a.atttypid END,
            CASE WHEN t.typtype='d' THEN t.typtypmod ELSE a.atttypmod END) AS "pgType",
          format_type(a.atttypid,a.atttypmod) AS "sourceType"
          FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
          WHERE a.attrelid='effective_wfp_publish_receipts'::regclass
            AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      )
    ).rows.map((column) => ({ ...column, kind: codec.columnKind(column["pgType"]) }));
    expect(view.EFFECTIVE_WFP_COLUMNS).toEqual(nativeContract);
    const parents = new Set([
      "wfp_publish_receipts",
      "environments",
      "deployment_revisions",
      "wfp_rollback_activation_receipts",
      "projects",
      "shared_gateway_route_revisions",
      "shared_gateway_address_receipts",
    ]);
    const qualified = view.qualifyEffectiveWfpView(image, parents);
    expect(qualified.gaps).toEqual([]);
    expect(qualified.readers.map((reader: { sourceName: string }) => reader.sourceName)).toEqual([
      "effective_wfp_publish_receipts",
    ]);
    const expectedProof = codec.tableProof(
      nativeContract,
      expected.map((row) => nativeContract.map((column) => row[column["name"]])),
    );
    expect(
      await pages.proveFixedProjectionPages(nativeContract, view.readEffectiveWfpPages(fixture.db)),
    ).toEqual(expectedProof);
    const second = await executor.openLocalTarget({
      repositoryRoot: (await fixtureModule()).repositoryRoot,
    });
    try {
      await seedTargetParents(
        source.r.db,
        second.db,
        operationRecords,
        source.bucket,
        image.rows.get("environments") ?? [],
      );
      await run(second.db, "owned-independent-restore");
      expect(
        await pages.proveFixedProjectionPages(
          nativeContract,
          view.readEffectiveWfpPages(second.db),
        ),
      ).toEqual(expectedProof);
    } finally {
      await second.dispose();
    }
    for (const [definitions, expectedCode] of [
      [[], "CONTROL_D1_VIEW_REQUIRED"],
      [
        [{ ...originalView, definition: originalView.definition + " " }],
        "CONTROL_D1_VIEW_DEFINITION_UNQUALIFIED",
      ],
      [[originalView, originalView], "CONTROL_D1_VIEW_DEFINITION_UNQUALIFIED"],
    ] as const) {
      const result = view.qualifyEffectiveWfpView(
        { manifest: { ...image.manifest, views: definitions } },
        parents,
      );
      expect(result.readers).toEqual([]);
      expect(result.gaps[0]?.code).toBe(expectedCode);
    }
    expect(view.qualifyEffectiveWfpView(image, new Set()).gaps[0]?.code).toBe(
      "CONTROL_D1_VIEW_PARENT_UNQUALIFIED",
    );
    expect(
      view.qualifyEffectiveWfpView({ manifest: { ...image.manifest, views: [] } }, new Set()),
    ).toEqual({ readers: [], gaps: [] });
    expect(
      view.qualifyEffectiveWfpView(
        { manifest: { ...image.manifest, targetPin: { migrations: [] } } },
        parents,
      ).gaps[0]?.code,
    ).toBe("CONTROL_D1_VIEW_SCHEMA_UNQUALIFIED");
    const changedType = structuredClone(image.manifest);
    const changedColumn = changedType.tables
      .find((entry) => entry.name === "wfp_publish_receipts")
      ?.columns.find((column) => column.name === "artifact_id");
    if (!changedColumn) throw new Error("Missing original publication artifact column");
    changedColumn.sourceType = "text";
    expect(view.qualifyEffectiveWfpView({ manifest: changedType }, parents).gaps[0]?.code).toBe(
      "CONTROL_D1_VIEW_COLUMN_CONTRACT_UNQUALIFIED",
    );
    const completeViews = await script("control-d1-view-readers");
    expect(
      completeViews.qualifySourceViews(
        { manifest: { ...image.manifest, views: [originalView] } },
        parents,
      ).readers,
    ).toEqual(qualified.readers);
    expect((await fixture.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await executor.schemaFingerprint(fixture.db)).toBe(beforeSchema);
    expect((await run()).applied.every((r: { replayed: boolean }) => r.replayed)).toBe(true);
    expect(
      await fixture.db.prepare("SELECT count(*) n FROM core_authority_activation").first(),
    ).toEqual({ n: 0 });
    const changed = structuredClone(image.rows);
    const arr = changed.get("runtime_secret_delivery_stages")?.[0];
    if (!arr) throw new Error("Missing native source stage");
    arr["applied_secret_names"] = "[0:0]={A}";
    expect(() => secrets.mapSecret(changed, image.manifest, image)).toThrow(
      "CONTROL_D1_IDENTITY_ARRAY_BOUNDS",
    );
    // Native PostgreSQL accepts these original values; authenticated capture preserves them, and D1 refuses
    // explicitly instead of truncating time or erasing an array lower bound. No actual row/credential is read.
    await source.insert("environment_secret_requests", {
      organization_id: source.r.scope.organizationId,
      project_id: source.r.scope.projectId,
      environment_id: source.r.scope.environmentId,
      action: "set",
      name: "ORIGINAL",
      idempotency_key: "native-infinite",
      request_sha256: Buffer.alloc(32, 8),
      response: null,
      requested_at: "infinity",
      completed_at: null,
    });
    const infinite = await fixture.image("native-infinite");
    expect(() => secrets.mapSecret(infinite.rows, infinite.manifest, infinite)).toThrow(
      "CONTROL_D1_SECRET_TIMESTAMP_UNREPRESENTABLE",
    );
    await fixture.pool.query(
      "DELETE FROM environment_secret_requests WHERE idempotency_key='native-infinite'",
    );
    const originalStage = image.rows.get("runtime_secret_delivery_stages")?.[0];
    if (originalStage === undefined) throw new Error("Missing native stage");
    await source.insert("runtime_secret_delivery_stages", {
      ...originalStage,
      stage_receipt_id: newUlid(),
      lease_id: newUlid(),
      manifest_sha256: Buffer.from(String(originalStage["manifest_sha256"]), "hex"),
      applied_secret_names: "[0:0]={A}",
      manifest_secret_count: "1",
    });
    const lowerBound = await fixture.image("native-lower-bound");
    expect(() => secrets.mapSecret(lowerBound.rows, lowerBound.manifest, lowerBound)).toThrow(
      "CONTROL_D1_IDENTITY_ARRAY_BOUNDS",
    );
    for (const { map } of specs)
      expect(() =>
        map(image.rows, { ...image.manifest, targetPin: { migrations: [] } }, image),
      ).toThrow(/CONTROL_D1_.*SCHEMA_PREREQUISITE/);
  } finally {
    await source?.source.dispose();
    await fixture.dispose();
  }
}, 240000);
