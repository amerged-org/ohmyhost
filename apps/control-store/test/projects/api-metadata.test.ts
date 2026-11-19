import { beforeAll, afterAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createUlidFactory, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import {
  ProjectNotesConflict,
  PoweredByFlagRequiredError,
  PoweredByFlagIdempotencyConflictError,
} from "@ohmyhost/database";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import {
  createD1ProjectMetadataPorts,
  isD1ProjectMetadataRuntime,
} from "../../../control-api/src/d1-project-metadata.js";
import { createControlStore } from "../../src/store.js";
import { setPaid } from "../../src/catalog/credit/index.js";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import {
  seedProject,
  ulidOf,
  NOW,
  STORED_NOW,
  losingWriteResponses,
} from "../support/platform-fixtures.js";

let control: TestControl;
const WRITTEN_AT = "2026-10-29T07:00:00.123Z";
const RAW_NOTE = "historical\r\nmarkdown 🚀";
const clock = { now: () => new Date(WRITTEN_AT) },
  ids = () => createUlidFactory({ clock, entropy: new SystemEntropy() });
beforeAll(async () => {
  control = await createTestControl();
}, 120000);
afterAll(async () => {
  await control?.dispose();
});
async function fixture() {
  const p = await seedProject(control),
    org = p.organizationId,
    project = p.projectId;
  const store = createControlStore(control.bindings),
    d1 = createD1ProjectMetadataPorts({ runtime: store.apiMetadata, clock, ids: ids() }),
    scope = {
      organizationId: parseUlid(org),
      projectId: parseUlid(project),
      principalId: "user:fixture",
      requestId: "req-metadata",
    };
  return {
    p,
    store,
    d1,
    scope,
    request: { ...scope, idempotencyKey: "first", canonicalRequestDigest: Buffer.alloc(32, 7) },
  };
}
it("keeps the original metadata columns, microseconds, UTF8 byte/line limits and live note transactions", async () => {
  const r = await fixture();
  // The column lists and order are the original PostgreSQL ones: the import maps them one to one.
  const columns = {
    project_agent_notes: ["project_id", "version", "markdown", "updated_at"],
    project_agent_note_requests: [
      "organization_id",
      "project_id",
      "actor_id",
      "idempotency_key",
      "request_sha256",
      "version",
      "updated_at",
    ],
    project_powered_by_flag_requests: [
      "organization_id",
      "project_id",
      "actor_id",
      "idempotency_key",
      "request_sha256",
      "enabled",
      "enabled_at",
      "recorded_at",
    ],
  };
  for (const [table, names] of Object.entries(columns))
    expect(
      (await control.core.prepare(`PRAGMA table_info(${table})`).all()).results.map(
        (row) => row["name"],
      ),
      table,
    ).toEqual(names);
  expect(isD1ProjectMetadataRuntime(r.store.apiMetadata)).toBe(true);
  expect(isD1ProjectMetadataRuntime({})).toBe(false);
  expect(await r.d1.projectNotes.get(r.scope)).toEqual({
    version: 0,
    markdown: "",
    updatedAt: null,
  });
  const first = {
    ...r.request,
    markdown: "# Native notes\nUntrusted project data é 🚀",
    expectedVersion: 0,
  };
  const saved = { version: 1, updatedAt: WRITTEN_AT };
  expect(await r.d1.projectNotes.set(first)).toEqual(saved);
  expect(await r.d1.projectNotes.set(first)).toEqual(saved);
  const firstNotes = { ...saved, markdown: first.markdown };
  expect(await r.d1.projectNotes.get(r.scope)).toEqual(firstNotes);
  await expect(
    r.d1.projectNotes.set({ ...first, canonicalRequestDigest: Buffer.alloc(32, 8) }),
  ).rejects.toBeInstanceOf(ProjectNotesConflict);
  await expect(r.d1.projectNotes.set({ ...first, idempotencyKey: "stale" })).rejects.toBeInstanceOf(
    ProjectNotesConflict,
  );
  await control.core
    .prepare(
      "CREATE TRIGGER notes_late BEFORE INSERT ON project_agent_note_requests WHEN NEW.idempotency_key='late' BEGIN SELECT RAISE(ABORT,'late note receipt'); END",
    )
    .run();
  await expect(
    r.d1.projectNotes.set({
      ...first,
      idempotencyKey: "late",
      expectedVersion: 1,
      markdown: "must rollback",
    }),
  ).rejects.toThrow();
  expect(await r.d1.projectNotes.get(r.scope)).toEqual(firstNotes);
  const lost = createD1ProjectMetadataPorts({
    runtime: createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) })
      .apiMetadata,
    clock,
    ids: ids(),
  });
  // The first reply is lost after the write committed: the retry observes the accepted note, not a version conflict.
  expect(
    await lost.projectNotes.set({
      ...first,
      idempotencyKey: "second",
      expectedVersion: 1,
      markdown: "next accepted notes",
    }),
  ).toEqual({ version: 2, updatedAt: WRITTEN_AT });
  expect(await r.d1.projectNotes.get(r.scope)).toEqual({
    version: 2,
    markdown: "next accepted notes",
    updatedAt: WRITTEN_AT,
  });
  expect(await r.d1.projectNotes.storageJurisdiction(r.scope)).toBe("eu");
  const raw = await fixture(),
    text = "🚀".repeat(4096),
    at = "2026-10-29T07:00:00.123456Z";
  await control.core
    .prepare("INSERT INTO project_agent_notes VALUES(?1,2147483647,?2,?3)")
    .bind(raw.p.projectId, text, at)
    .run();
  expect(
    await control.core
      .prepare("SELECT markdown,updated_at FROM project_agent_notes WHERE project_id=?")
      .bind(raw.p.projectId)
      .first(),
  ).toEqual({ markdown: text, updated_at: at });
  for (const invalid of [text + "a", "x\n".repeat(250)]) {
    await expect(
      control.core
        .prepare("UPDATE project_agent_notes SET markdown=?2 WHERE project_id=?1")
        .bind(raw.p.projectId, invalid)
        .run(),
    ).rejects.toThrow();
  }
  await control.core
    .prepare("UPDATE projects SET lifecycle_state='deleted' WHERE project_id=?")
    .bind(raw.p.projectId)
    .run();
  expect(
    (
      await control.core
        .prepare("SELECT * FROM project_agent_notes WHERE project_id=?")
        .bind(raw.p.projectId)
        .all()
    ).results,
  ).toEqual([]);
}, 60000);
it("keeps flag replay and domain dependency, and commits receipt, period and audit together", async () => {
  const r = await fixture(),
    enable = { ...r.request, enabled: true };
  expect(await r.d1.poweredByFlag.get(r.scope)).toEqual({ enabled: false, enabledAt: null });
  const enabled = { enabled: true, enabledAt: WRITTEN_AT };
  expect(await r.d1.poweredByFlag.set(enable)).toEqual(enabled);
  expect(await r.d1.poweredByFlag.set(enable)).toEqual(enabled);
  // A paid domain on the project makes the flag required: disabling is refused until paid access exists.
  await control.core
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,?3,'awaiting_deployment','user:fixture',unhex(?4),unhex(?4),?5,?5)",
    )
    .bind(
      r.p.organizationId,
      r.p.projectId,
      "native-" + r.p.projectId.toLowerCase() + ".example.com",
      "ab".repeat(32),
      STORED_NOW,
    )
    .run();
  const disable = { ...r.request, idempotencyKey: "disable", enabled: false };
  await expect(r.d1.poweredByFlag.set(disable)).rejects.toBeInstanceOf(PoweredByFlagRequiredError);
  const paid = {
    organizationId: r.p.organizationId,
    enabled: true,
    source: "manual" as const,
    reason: "Paid access lifts the flag requirement",
    actorId: "operator:fixture",
    eventId: ulidOf("paid-flag", 11),
    now: clock.now().toISOString(),
  };
  await control.core.batch(
    setPaid(control.core, {
      organizationId: paid.organizationId,
      paidUntil: "2099-01-01T00:00:00.000Z",
      source: "manual",
      now: paid.now,
    }).statements,
  );
  expect(await r.d1.poweredByFlag.set(disable)).toEqual({ enabled: false, enabledAt: null });
  // The first request keeps answering with its original outcome even though the flag is off now.
  expect(await r.d1.poweredByFlag.set(enable)).toEqual(enabled);
  expect(await r.d1.poweredByFlag.get(r.scope)).toEqual({ enabled: false, enabledAt: null });
  await expect(
    r.d1.poweredByFlag.set({ ...enable, canonicalRequestDigest: Buffer.alloc(32, 10) }),
  ).rejects.toBeInstanceOf(PoweredByFlagIdempotencyConflictError);
  await control.core
    .prepare(
      "CREATE TRIGGER flag_late BEFORE INSERT ON project_powered_by_flag_requests WHEN NEW.idempotency_key='late' BEGIN SELECT RAISE(ABORT,'late flag receipt'); END",
    )
    .run();
  await expect(r.d1.poweredByFlag.set({ ...enable, idempotencyKey: "late" })).rejects.toThrow();
  expect(await r.d1.poweredByFlag.get(r.scope)).toEqual({ enabled: false, enabledAt: null });
  expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 60000);

/** One row of each original PostgreSQL metadata family, the note with a raw CRLF the application would have normalized away. */
async function seedPgNoteSource(pg: TestPostgres, r: Awaited<ReturnType<typeof fixture>>) {
  const { p } = r;
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO workos_organization_mappings(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at) VALUES($1,$2,'active',1,decode(repeat('00',32),'hex'),$3,$3,$3)",
      [p.organizationId, "org_metadata_" + p.organizationId, NOW],
    );
    await client.query(
      "INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at,region) VALUES($1,$2,'Metadata',$3,'customer-chosen-v1',0,$4,$5,'eu')",
      [p.projectId, p.organizationId, p.handle, ulidOf("original", 1), NOW],
    );
    await client.query(
      "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES($1,$2,$3,$4,'user:fixture')",
      [p.billingEpochId, p.projectId, p.organizationId, NOW],
    );
    await client.query(
      "INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at) VALUES($1,$2,'active',1,$3,$4)",
      [p.projectId, p.organizationId, p.billingEpochId, NOW],
    );
    await client.query(
      "INSERT INTO environments(organization_id,environment_id,project_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}',$4,$4),($1,$5,$3,'prod','{}',$4,$4)",
      [p.organizationId, p.devEnvironmentId, p.projectId, NOW, p.prodEnvironmentId],
    );
    await client.query(
      "INSERT INTO project_agent_notes(project_id,version,markdown,updated_at) VALUES($1,1,$2,$3)",
      [p.projectId, RAW_NOTE, WRITTEN_AT],
    );
    await client.query(
      "INSERT INTO project_agent_note_requests(organization_id,project_id,actor_id,idempotency_key,request_sha256,version,updated_at) VALUES($1,$2,'user:fixture','imported-notes',$3,1,$4)",
      [p.organizationId, p.projectId, Buffer.alloc(32, 7), WRITTEN_AT],
    );
    await client.query(
      "INSERT INTO project_powered_by_flag_requests(organization_id,project_id,actor_id,idempotency_key,request_sha256,enabled,enabled_at,recorded_at) VALUES($1,$2,'user:fixture','imported-flag',$3,true,$4,$4)",
      [p.organizationId, p.projectId, Buffer.alloc(32, 9), WRITTEN_AT],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

it("keeps the three original raw metadata families byte exact through a separate restore and the next note write", async () => {
  const pg = await startTestPostgres();
  try {
    await importAndContinue(pg);
  } finally {
    await pg.stop();
  }
}, 120000);

async function importAndContinue(pg: TestPostgres) {
  const r = await fixture();
  await seedPgNoteSource(pg, r);
  const script = (name: string) =>
      import(new URL(`../../../../scripts/${name}.mjs`, import.meta.url).href),
    mapper = await script("control-d1-api-metadata-mappings"),
    codec = await script("control-d1-codec"),
    pages = await script("control-d1-readback-pages");
  type Row = Record<string, string | null>;
  type Column = { name: string; pgType: string; sourceType: string; kind: string };
  const tables: { name: string; columns: Column[] }[] = [],
    rows = new Map<string, Row[]>();
  for (const table of mapper.API_METADATA_TARGETS as string[]) {
    const metadata = await pg.pool.query<{ name: string; pgType: string; sourceType: string }>(
      `SELECT a.attname name,format_type(CASE WHEN t.typtype='d' THEN t.typbasetype ELSE a.atttypid END,NULL) "pgType",CASE WHEN t.typname='ulid' THEN 'ulid' ELSE format_type(a.atttypid,NULL) END "sourceType" FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [table],
    );
    const columns = metadata.rows.map((column) => ({
      ...column,
      kind: codec.columnKind(column.pgType) as string,
    }));
    tables.push({ name: table, columns });
    const projection = columns
      .map((column) => `${codec.captureExpression(column)} AS "${column.name}"`)
      .join(",");
    rows.set(table, (await pg.pool.query<Row>(`SELECT ${projection} FROM ${table}`)).rows);
  }
  const targetPin = {
      migrations: migrationFiles("core").map((migration) => ({
        name: migration.name,
        sha256: createHash("sha256").update(migration.sql).digest("hex"),
      })),
    },
    manifest = { tables, targetPin },
    before = JSON.stringify([...rows]),
    records = mapper.mapApiMetadata(rows, manifest) as { table: string; row: Row }[];
  expect(JSON.stringify([...rows])).toBe(before);
  expect(records.map((record) => record.table).sort()).toEqual([
    "project_agent_note_requests",
    "project_agent_notes",
    "project_powered_by_flag_requests",
  ]);
  expect(() => mapper.mapApiMetadata(rows, { ...manifest, targetPin: { migrations: [] } })).toThrow(
    "API_METADATA_SCHEMA_PREREQUISITE",
  );
  const restored = await createTestControl();
  try {
    // Local leaf only: original parent identities are preloaded explicitly. No whole-source registration or parent admission proof follows.
    const parents = [];
    for (const table of [
      "org_directory",
      "project_directory",
      "organizations",
      "projects",
      "billing_epochs",
      "environments",
    ])
      for (const row of (await control.core.prepare(`SELECT * FROM ${table}`).all()).results) {
        const columns = Object.keys(row);
        parents.push(
          restored.core
            .prepare(
              `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
            )
            .bind(
              ...columns.map((column) =>
                Array.isArray(row[column]) ? Uint8Array.from(row[column] as number[]) : row[column],
              ),
            ),
        );
      }
    await restored.core.batch(parents);
    for (const record of records) {
      const columns = Object.keys(record.row);
      await restored.core
        .prepare(
          `INSERT INTO ${record.table}(${columns.join(",")}) VALUES(${columns.map((column) => (column === "request_sha256" ? "unhex(?)" : "?")).join(",")})`,
        )
        .bind(...columns.map((column) => record.row[column]))
        .run();
    }
    for (const table of tables) {
      const original = codec.tableProof(
        table.columns,
        (rows.get(table.name) ?? []).map((row) => table.columns.map((column) => row[column.name])),
      );
      expect(
        await pages.proveFixedProjectionPages(
          table.columns,
          mapper.readApiMetadataPages(restored.core, table.name),
        ),
      ).toEqual(original);
    }
    const rawNote = { ...r.request, idempotencyKey: "imported-notes", expectedVersion: 0 };
    const second = createD1ProjectMetadataPorts({
        runtime: createControlStore(restored.bindings).apiMetadata,
        clock,
        ids: ids(),
      }),
      next = {
        ...rawNote,
        idempotencyKey: "next-after-restore",
        expectedVersion: 1,
        markdown: "NEXT after captured bytes",
      };
    expect(
      (await restored.core.prepare("SELECT version,markdown FROM project_agent_notes").all())
        .results,
    ).toEqual([{ version: 1, markdown: RAW_NOTE }]);
    expect(await second.projectNotes.set(next)).toEqual({ version: 2, updatedAt: WRITTEN_AT });
    expect(await second.projectNotes.get(r.scope)).toEqual({
      version: 2,
      markdown: next.markdown,
      updatedAt: WRITTEN_AT,
    });
    expect((await restored.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await restored.dispose();
  }
}
