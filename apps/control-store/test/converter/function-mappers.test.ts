import { Buffer } from "node:buffer";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { TestPostgres } from "../../../control-api/test/postgres.js";
import { createControlStore } from "../../src/store.js";
import { createCoreSchedulerPersistence } from "../../../functions-scheduler/src/persistence.js";
import { runSchedulerTick } from "../../../functions-scheduler/src/tick.js";
import type { ScheduledDispatchPort } from "../../../functions-scheduler/src/dispatch.js";
import { seedOwnedSource, seedTargetParents } from "./owned-domain-fixture.js";
import type { D1Database } from "../../src/d1-types.js";

type Row = Record<string, string | null>;
type Column = { name: string; pgType: string; sourceType: string; kind: string };
type RecordFact = { table: string; row: Row; atomicGroup?: string; deferForeignKeys?: boolean };
interface Image {
  manifest: {
    captureId: string;
    targetPin: unknown;
    tables: { name: string; columns: Column[] }[];
  };
  manifestSha256: string;
  rows: Map<string, Row[]>;
}
interface Fixture {
  pool: TestPostgres["pool"];
  db: D1Database;
  directory: string;
  key: Buffer;
  image(name: string): Promise<Image>;
  activate(label: string): Promise<void>;
  dispose(): Promise<void>;
}
const script = (name: string) =>
  import(new URL(`../../../../scripts/${name}.mjs`, import.meta.url).href);
const at = "2026-10-29T00:00:00.123456Z";

it("preserves both original120 raw families through pinned leaf import, bounded native-key proofs and a second restore with real NEXT scheduler calls", async () => {
  const support = await import(
    new URL("../../../../tests/support/control-conversion-fixture.mjs", import.meta.url).href
  );
  const fixture = (await support.originalControlFixture("function-facts")) as Fixture;
  let source: Awaited<ReturnType<typeof seedOwnedSource>> | undefined;
  let restored: { db: D1Database; dispose(): Promise<void> } | undefined;
  try {
    // Native constraints are genuine. This helper supplies original-compatible accepted parents,
    // not a closed Source admission producer; their global conversion remains explicitly unqualified.
    source = await seedOwnedSource(fixture.pool);
    const r = source.r;
    // The schedule of the activated deployment, with the Worker script of its staged candidate receipt.
    await fixture.pool.query(
      `INSERT INTO environment_function_schedules(organization_id,project_id,environment_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,updated_at)
       SELECT $1::ulid,$2::ulid,$3::ulid,$4::ulid,$5::ulid,receipt.immutable_script_name,$6::jsonb,$7::jsonb,$8::timestamptz
       FROM wfp_candidate_receipts receipt
       WHERE receipt.organization_id=$1 AND receipt.project_id=$2 AND receipt.environment_id=$3
         AND receipt.product_deployment_id=$4 AND receipt.candidate_receipt_id=$5`,
      [
        r.scope.organizationId,
        r.scope.projectId,
        r.scope.environmentId,
        r.deploymentId,
        r.candidateReceiptId,
        JSON.stringify(["0 3 * * *"]),
        JSON.stringify([
          "https://a.example.test",
          "https://a.example.test",
          "https://z.example.test",
        ]),
        at,
      ],
    );
    for (let n = 0; n < 130; n++)
      await fixture.pool.query(
        "INSERT INTO function_runs(run_id,organization_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,lease_until,started_at,finished_at,status_code,egress_allowed_origins,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz+make_interval(mins=>$9),'succeeded',$10,NULL,NULL,$8,$11,$12::jsonb,$8,$8)",
        [
          String(900000 + n).padStart(26, "0"),
          r.scope.organizationId,
          r.scope.projectId,
          r.scope.environmentId,
          r.deploymentId,
          n === 129 ? "Ж".repeat(700000) : `retained/脚本/${n}`,
          `legacy cron ${n} ü`,
          at,
          n,
          n % 4,
          n % 2 ? 204 : null,
          n % 2
            ? '[null,{"native":9223372036854775807}]'
            : '["https://a.example.test","https://a.example.test"]',
        ],
      );
    const image = await fixture.image("functions-native"),
      functions = await script("control-d1-functions-mappings"),
      codec = await script("control-d1-codec"),
      executor = await script("control-d1-target"),
      pages = await script("control-d1-readback-pages"),
      wfp = await script("control-d1-wfp-mappings"),
      secret = await script("control-d1-secret-mappings"),
      storage = await script("control-d1-storage-mappings"),
      spine = await script("control-d1-spine-mappings");
    const originals = JSON.stringify([...image.rows]);
    const functionRecords = functions.mapFunctionSchedules(
      image.rows,
      image.manifest,
    ) as RecordFact[];
    expect(functionRecords).toHaveLength(131);
    for (const [table, names] of Object.entries(functions.FUNCTION_COLUMNS) as [string, string][]) {
      const metadata = image.manifest.tables.find((t) => t.name === table);
      expect(metadata?.columns.map((c) => c.name)).toEqual(names.split(","));
      expect(
        metadata?.columns
          .filter((c) => c.name.endsWith("_id"))
          .every((c) => c.sourceType === "ulid"),
      ).toBe(true);
    }
    const records = [
      ...wfp.mapWfp(image.rows, image.manifest, image),
      ...secret.mapSecret(image.rows, image.manifest, image),
      ...storage.mapStorage(image.rows, image.manifest, image),
      ...functionRecords,
    ] as RecordFact[];
    const corePlan = {
      format: "omh.control-d1.plan/v3",
      atomicProtocol: "contiguous-units-v1",
      qualificationOnly: true,
      captureId: image.manifest.captureId,
      manifestSha256: image.manifestSha256,
      targetPin: image.manifest.targetPin,
      records,
      sequenceRestores: [],
      unhandledSequences: ["WHOLE-SOURCE-ALLOCATORS-UNQUALIFIED"],
      runtimeGates: ["LOCAL-FUNCTION-LEAF-ONLY"],
      unhandled: ["SOURCE-ADMISSION-AND-OTHER-PARENTS-UNQUALIFIED"],
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
    const plan = { ...corePlan, digest: codec.sha256(Buffer.from(codec.canonical(corePlan))) };
    const operationRecords = (
      spine.mapOperations(image.rows, image.manifest, image) as RecordFact[]
    ).filter((record) => record.table === "operations");
    const prepare = (db: D1Database) =>
      seedTargetParents(
        r.db,
        db,
        operationRecords,
        source?.bucket ?? {},
        image.rows.get("environments") ?? [],
      );
    const load = (db: D1Database, name: string) =>
      executor.importPlan({
        db,
        plan,
        targetId: name,
        key: fixture.key,
        journal: join(fixture.directory, `${name}.journal`),
        currentPin: image.manifest.targetPin,
        batchRows: 1,
      });
    await prepare(fixture.db);
    expect((await load(fixture.db, "functions-first")).verdict).toBe("INCOMPLETE");
    await load(fixture.db, "functions-first");
    for (const table of functions.FUNCTION_TARGETS as string[]) {
      const columns = image.manifest.tables.find((t) => t.name === table)?.columns;
      if (!columns) throw new Error("Missing captured function columns");
      const proof = await pages.proveFixedProjectionPages(
        columns,
        functions.readFunctionSchedulePages(fixture.db, table),
      );
      expect(proof).toEqual(
        codec.tableProof(
          columns,
          (image.rows.get(table) ?? []).map((row) => columns.map((c) => row[c.name])),
        ),
      );
      const keys = functions.FUNCTION_KEYS[table] as string[];
      const search = (
        await fixture.db
          .prepare(
            `EXPLAIN QUERY PLAN SELECT ${keys.join(",")} FROM ${table} WHERE (${keys.join(",")})>(${keys.map(() => "?").join(",")}) ORDER BY ${keys.join(",")} LIMIT 128`,
          )
          .bind(...keys.map(() => "0".repeat(26)))
          .all()
      ).results;
      expect(search.some((row) => /SEARCH .*USING PRIMARY KEY/u.test(String(row["detail"])))).toBe(
        true,
      );
    }
    expect((await fixture.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await fixture.db.prepare("SELECT next_fire_at FROM environment_function_schedules").first()
      )?.["next_fire_at"],
    ).toBeNull();
    const second = (await executor.openLocalTarget({ repositoryRoot: support.repositoryRoot })) as {
      db: D1Database;
      dispose(): Promise<void>;
    };
    restored = second;
    await prepare(second.db);
    expect((await load(second.db, "functions-restored")).verdict).toBe("INCOMPLETE");
    for (const table of functions.FUNCTION_TARGETS as string[]) {
      const values: Row[] = [];
      for await (const page of functions.readFunctionSchedulePages(second.db, table))
        values.push(...page);
      const columns = image.manifest.tables.find((t) => t.name === table)?.columns;
      if (!columns) throw new Error("Missing captured function columns");
      expect(
        codec.tableProof(
          columns,
          values.map((row) => columns.map((c) => row[c.name])),
        ),
      ).toEqual(
        codec.tableProof(
          columns,
          (image.rows.get(table) ?? []).map((row) => columns.map((c) => row[c.name])),
        ),
      );
    }
    // LOCAL fixture activation permits the actual NEXT consumer; never a whole-source operator approval.
    await fixture.activate("functions-native-next");
    const tickAt = new Date("2026-10-29T03:00:00.000Z"),
      dispatch: ScheduledDispatchPort = {
        execute: async () => ({ outcome: "succeeded", statusCode: 204 }),
      };
    const core = await runSchedulerTick({
      persistence: createCoreSchedulerPersistence(
        createControlStore({ CONTROL_CORE: fixture.db }).functionsScheduler,
      ),
      dispatch,
      at: tickAt,
      now: () => tickAt,
    });
    const expectedTick = {
      scheduledAt: "2026-10-29T03:00:00.000Z",
      inserted: 1,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
      purged: 0,
    };
    expect(core).toEqual(expectedTick);
    const runtimeSchema = await executor.schemaFingerprint(second.db);
    const localProof = codec.sha256(
      Buffer.from(codec.canonical({ scope: "LOCAL-FUNCTION-LEAF-RESTORE", runtimeSchema })),
    );
    const importContext = await second.db
      .prepare("SELECT import_id FROM core_historical_import WHERE singleton=1")
      .first();
    const activatedAt = new Date().toISOString().replace(/Z$/u, "000Z");
    if (importContext)
      await second.db
        .prepare(
          "UPDATE core_historical_import SET closed_at=?1,comparison_sha256=unhex(?2),restored_runtime_schema_sha256=unhex(?3) WHERE singleton=1",
        )
        .bind(activatedAt, localProof, runtimeSchema)
        .run();
    await second.db
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,'00000000-0000-4000-8000-000000000091',?1,?2,unhex(?3),unhex(?4))",
      )
      .bind(activatedAt, importContext?.["import_id"] ?? null, localProof, runtimeSchema)
      .run();
    const restoredNext = await runSchedulerTick({
      persistence: createCoreSchedulerPersistence(
        createControlStore({ CONTROL_CORE: second.db }).functionsScheduler,
      ),
      dispatch,
      at: tickAt,
      now: () => tickAt,
    });
    expect(restoredNext).toEqual(expectedTick);

    expect(JSON.stringify([...image.rows])).toBe(originals);
  } finally {
    await restored?.dispose();
    await source?.source.dispose();
    await fixture.dispose();
  }
}, 240000);

it("refuses absent/schema-mismatched/altered original function inputs and preserves arbitrary source JSON/text instead of normalizing it", async () => {
  const functions = await script("control-d1-functions-mappings");
  expect(() => functions.mapFunctionSchedules(new Map(), { tables: [] })).toThrow("PREREQUISITE");
  const pin = {
    targetPin: {
      migrations: Object.entries(functions.FUNCTION_SCHEMA_PINS).map(([name, sha256]) => ({
        name,
        sha256,
      })),
    },
    tables: [],
  };
  expect(() => functions.mapFunctionSchedules(new Map(), pin)).toThrow("SOURCE_REQUIRED");
  await expect(async () => {
    for await (const page of functions.readFunctionSchedulePages({} as D1Database, "arbitrary"))
      void page;
  }).rejects.toThrow("READBACK_TABLE");
});
