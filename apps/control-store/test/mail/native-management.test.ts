import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { mailFixture } from "./mail-fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { storedTimestamp } from "../../src/timestamps.js";
import type { D1Database } from "../../src/d1-types.js";
import { bytesOf } from "../../src/catalog/platform-support.js";
import { mailMetadataJsonb } from "../../src/catalog/mail/metadata-jsonb.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
let control: TestControl;
/** The original physical columns of the eight management families, in their original order. */
const COLUMNS: Record<string, string[]> = Object.fromEntries(
  Object.entries({
    resend_mail_domains:
      "domain_id organization_id project_id environment_id domain provider_domain_id provider_claimed_at provider_preflight_at verify_requested_at sending_key_id sending_key_claimed_at sending_key_ciphertext sending_key_nonce sending_key_sha256 sending_key_version sending receiving receiving_suspended last_entitlement_check_at last_reconcile_at sending_status receiving_status records dns_receipts webhook_url webhook_verified_at configured_at observed_at deleted_at webhook_secret_generation",
    resend_mail_commands:
      "organization_id project_id environment_id idempotency_key request_sha256 response created_at completed_at lease_until claimed_attempt domain_id",
    workspace_mail_domains:
      "domain_id organization_id domain registrable_domain legacy_domain_id custody_organization_id custody_project_id custody_environment_id revision status reputation_state reputation_suspended_at reputation_suspension_reason reputation_triggering_event_id reputation_version capabilities_lease_until capabilities_lease_token last_reconcile_at capabilities_dirty provider_domain_id provider_claimed_at provider_preflight_at verify_requested_at sending_key_id sending_key_claimed_at sending_key_ciphertext sending_key_nonce sending_key_sha256 sending_key_version sending_status receiving_status records dns_receipts configured_at observed_at retired_at",
    workspace_mail_commands:
      "organization_id idempotency_key domain_id operation principal_id request_sha256 response created_at completed_at lease_until claimed_attempt",
    project_application_domain_identities:
      "project_id organization_id hostname registrable_domain revision state challenge_name challenge_value declared_at verified_at expires_at revoked_at automatic_revalidation_attempted_at idempotency_key_sha256 request_sha256 actor_id",
    project_application_identity_commands:
      "organization_id project_id idempotency_key_sha256 request_sha256 response",
    project_application_identity_action_commands:
      "organization_id project_id actor_id action idempotency_key_sha256 request_sha256 response",
    project_mail_domain_bindings:
      "project_id organization_id environment_id mail_domain_id revision state sending legacy sender_addresses default_from default_reply_to application_identity_revision configured_at updated_at",
  }).map(([table, columns]) => [table, columns.split(" ")]),
);
beforeAll(async () => {
  control = await createTestControl();
}, 240000);
afterAll(async () => control?.dispose());
function targetValue(value: unknown) {
  return typeof value === "boolean"
    ? Number(value)
    : value instanceof Date
      ? storedTimestamp(value.toISOString())
      : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(value)
        ? storedTimestamp(value)
        : typeof value === "object" &&
            value !== null &&
            !(value instanceof Uint8Array) &&
            !(value instanceof ArrayBuffer)
          ? JSON.stringify(value)
          : value;
}
async function put(db: D1Database, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row),
    types = (await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; type: string }>())
      .results;
  await db
    .prepare(
      `INSERT INTO ${table}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
    )
    .bind(
      ...columns.map((column) =>
        row[column] !== null && types.find((value) => value.name === column)?.type === "BLOB"
          ? bytesOf(row[column])
          : targetValue(row[column]),
      ),
    )
    .run();
}
async function copyParents(target: D1Database, organizationId: string) {
  const statements = [];
  for (const table of [
    "org_directory",
    "project_directory",
    "organizations",
    "projects",
    "billing_epochs",
    "environments",
  ]) {
    const rows = (
      await control.core
        .prepare(`SELECT * FROM ${table} WHERE organization_id=?`)
        .bind(organizationId)
        .all()
    ).results;
    for (const row of rows) {
      const columns = Object.keys(row);
      statements.push(
        target
          .prepare(
            `INSERT INTO ${table}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...Object.values(row)),
      );
    }
  }
  await target.batch(statements);
}
const identity = (projectId: string, organizationId: string) => ({
  project_id: projectId,
  organization_id: organizationId,
  hostname: "app.example.com",
  registrable_domain: "example.com",
  revision: "9223372036854775807",
  state: "pending",
  challenge_name: "_omh-project.app.example.com",
  challenge_value: "a".repeat(32),
  declared_at: "2020-01-01T00:00:00.123456Z",
  expires_at: "2020-02-01T00:00:00.123456Z",
  idempotency_key_sha256: Buffer.alloc(32, 1),
  request_sha256: Buffer.alloc(32, 2),
  actor_id: "",
});
it("retains all eight original physical families, native defaults and otherwise legal historical values rejected by the prototype", async () => {
  // The Core renders metadata exactly as PostgreSQL jsonb text: key order by length then bytes, canonical numbers.
  const corpus: [unknown, string][] = [
    [
      { éé: 1, aaaa: 2, "\u{10000}": 3, "\ue000a": 4, aaa: 5 },
      '{"aaa": 5, "aaaa": 2, "éé": 1, "\ue000a": 4, "\u{10000}": 3}',
    ],
    [
      {
        nested: [{ z: true, aa: null }, ['a\n\b\t\r\f\\"/\u001f', false], []],
        object: { z: "é", a: "😀" },
      },
      '{"nested": [{"z": true, "aa": null}, ["a\\n\\b\\t\\r\\f\\\\\\"/\\u001f", false], []], "object": {"a": "😀", "z": "é"}}',
    ],
    [
      { positive: 1e21, negative: 1.234e-7, min: Number.MIN_VALUE, huge: 1e308, zero: -0 },
      `{"min": 0.${"0".repeat(323)}5, "huge": 1${"0".repeat(308)}, "zero": 0, "negative": 0.0000001234, "positive": 1${"0".repeat(21)}}`,
    ],
    [
      { omitted: undefined, array: [undefined, NaN, Infinity], plain: null },
      '{"array": [null, null, null], "plain": null}',
    ],
    [[true, false, null, {}, [], "scalar", 123], '[true, false, null, {}, [], "scalar", 123]'],
  ];
  for (const [value, text] of corpus) expect(mailMetadataJsonb(value)).toBe(text);
  // PostgreSQL jsonb refuses NUL, lone surrogates (in values and keys), cycles and bigint; so does the Core.
  for (const value of ["bad\0string", "bad\ud800string", { "bad\udc00key": "value" }])
    expect(() => mailMetadataJsonb(value)).toThrow();
  const cycle: Record<string, unknown> = {};
  cycle["cycle"] = cycle;
  for (const value of [cycle, 1n]) expect(() => mailMetadataJsonb(value)).toThrow();
  const f = await mailFixture(control);
  for (const [table, columns] of Object.entries(COLUMNS))
    expect(
      (
        await control.core.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
      ).results.map((row) => row.name),
    ).toEqual(columns);
  // Original legacy key receipts do not freeze their bytes and have no ciphertext minimum length.
  await f.update("UPDATE resend_mail_domains SET sending_key_ciphertext=?1 WHERE domain_id=?2", [
    Buffer.alloc(0),
    f.domainId,
  ]);
  expect(
    (
      await control.core
        .prepare(
          "SELECT length(sending_key_ciphertext) size FROM resend_mail_domains WHERE domain_id=?",
        )
        .bind(f.domainId)
        .first()
    )?.["size"],
  ).toBe(0);
  const resourceId = newUlid();
  await put(control.core, "workspace_mail_domains", {
    domain_id: resourceId,
    organization_id: f.scope.organizationId,
    domain: "müller.example",
    registrable_domain: "EXAMPLE",
    custody_organization_id: f.scope.organizationId,
    custody_project_id: f.scope.projectId,
    custody_environment_id: f.scope.environmentId,
    revision: "9223372036854775807",
    reputation_version: "9223372036854775807",
    status: "retired",
    retired_at: null,
    configured_at: "2026-10-20T00:00:00.123456Z",
  });
  const command = {
    organization_id: f.scope.organizationId,
    idempotency_key: "historical-command",
    domain_id: resourceId,
    operation: "x".repeat(512),
    principal_id: "p".repeat(1024),
    request_sha256: Buffer.alloc(32, 3),
    response: '"retained scalar"',
    created_at: "2026-10-20T00:00:00.123456Z",
    completed_at: null,
    claimed_attempt: 4,
  };
  await put(control.core, "workspace_mail_commands", command);
  await expect(
    control.core
      .prepare(
        "UPDATE workspace_mail_commands SET claimed_attempt=5 WHERE organization_id=? AND idempotency_key=?",
      )
      .bind(f.scope.organizationId, command.idempotency_key)
      .run(),
  ).rejects.toThrow();
  await put(
    control.core,
    "project_application_domain_identities",
    identity(f.scope.projectId, f.scope.organizationId),
  );
  expect(
    await control.core
      .prepare(
        "SELECT CAST(revision AS TEXT) revision,actor_id FROM project_application_domain_identities WHERE project_id=?",
      )
      .bind(f.scope.projectId)
      .first(),
  ).toEqual({ revision: "9223372036854775807", actor_id: "" });
  await expect(
    control.core
      .prepare(
        "UPDATE project_application_domain_identities SET hostname='changed.example.com' WHERE project_id=?",
      )
      .bind(f.scope.projectId)
      .run(),
  ).rejects.toThrow();
  expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("limits historical binding INSERT to the exact unactivated context and retains every static/live/closed-context refusal", async () => {
  const f = await mailFixture(control, false),
    historical = await createTestControl(2, { activated: false });
  try {
    await copyParents(historical.core, f.scope.organizationId);
    for (const table of ["workspace_mail_domains", "project_application_domain_identities"]) {
      const rows = (
        await control.core
          .prepare(`SELECT * FROM ${table} WHERE organization_id=?`)
          .bind(f.scope.organizationId)
          .all()
      ).results;
      for (const row of rows) await put(historical.core, table, row);
    }
    const binding = (await control.core
      .prepare("SELECT * FROM project_mail_domain_bindings WHERE project_id=?")
      .bind(f.scope.projectId)
      .first()) as Record<string, unknown>;
    expect(binding).toBeTruthy();
    // The original row was admitted while its proof was valid; advancing that proof to an expired instant does not rewrite the binding.
    const past = {
      verified_at: "2020-01-01T00:00:00.000000Z",
      expires_at: "2020-02-01T00:00:00.000000Z",
    };
    for (const db of [control.core, historical.core])
      await db
        .prepare(
          "UPDATE project_application_domain_identities SET verified_at=?,expires_at=? WHERE project_id=?",
        )
        .bind(past.verified_at, past.expires_at, f.scope.projectId)
        .run();
    // A live binding cannot be reactivated on an expired proof.
    await expect(
      control.core
        .prepare("UPDATE project_mail_domain_bindings SET state='active' WHERE project_id=?")
        .bind(f.scope.projectId)
        .run(),
    ).rejects.toThrow("mail_domain_mismatch");
    await expect(put(historical.core, "project_mail_domain_bindings", binding)).rejects.toThrow();
    const context = {
      singleton: 1,
      import_id: crypto.randomUUID(),
      manifest_sha256: Buffer.alloc(32, 4),
      source_fingerprint_sha256: Buffer.alloc(32, 5),
      expected_runtime_schema_sha256: Buffer.alloc(32, 6),
      temporal_tables: JSON.stringify(["project_mail_domain_bindings"]),
      started_at: "2026-10-29T00:00:00.000000Z",
    };
    await put(historical.core, "core_historical_import", context);
    await expect(
      put(historical.core, "project_mail_domain_bindings", {
        ...binding,
        default_from: "foreign@other.net",
      }),
    ).rejects.toThrow();
    await expect(
      put(historical.core, "project_mail_domain_bindings", {
        ...binding,
        environment_id: newUlid(),
      }),
    ).rejects.toThrow();
    await put(historical.core, "project_mail_domain_bindings", binding);
    expect(
      await historical.core
        .prepare("SELECT * FROM project_mail_domain_bindings WHERE project_id=?")
        .bind(f.scope.projectId)
        .first(),
    ).toEqual(binding);
    await historical.core
      .prepare(
        "UPDATE core_historical_import SET closed_at=?,comparison_sha256=?,restored_runtime_schema_sha256=expected_runtime_schema_sha256 WHERE singleton=1",
      )
      .bind("2026-10-29T00:00:01.000000Z", Buffer.alloc(32, 7))
      .run();
    await expect(
      historical.core
        .prepare("UPDATE project_mail_domain_bindings SET state='active' WHERE project_id=?")
        .bind(f.scope.projectId)
        .run(),
    ).rejects.toThrow();
    await historical.core
      .prepare(
        "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256)VALUES(1,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        "2026-10-29T00:00:02.000000Z",
        context.import_id,
        Buffer.alloc(32, 7),
        Buffer.alloc(32, 6),
      )
      .run();
    await expect(
      put(historical.core, "core_historical_import", {
        ...context,
        import_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await historical.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await historical.dispose();
  }
});

it("keeps final native website and global project lifecycle invalidation and refuses populated prototype replacement atomically", async () => {
  for (const path of ["insert", "update"] as const) {
    const f = await mailFixture(control, false),
      at = "2026-10-20T00:00:00.123456Z",
      website = {
        organization_id: f.scope.organizationId,
        project_id: f.scope.projectId,
        hostname:
          path === "insert"
            ? `api-${newUlid().toLowerCase()}.other.net`
            : `api-${newUlid().toLowerCase()}.example.com`,
        gateway_script_name: null,
        state: "awaiting_deployment",
        configured_by_principal_id: "user:fixture",
        apply_idempotency_sha256: Buffer.alloc(32, 8),
        apply_request_sha256: Buffer.alloc(32, 9),
        created_at: at,
        updated_at: at,
      };
    const bindingBefore = await control.core
      .prepare("SELECT state,sending FROM project_mail_domain_bindings WHERE project_id=?")
      .bind(f.scope.projectId)
      .first();
    await put(control.core, "paid_project_domains", website);
    if (path === "update")
      await f.update("UPDATE paid_project_domains SET hostname=?1 WHERE project_id=?2", [
        `api-${newUlid().toLowerCase()}.other.net`,
        f.scope.projectId,
      ]);
    // A Paid hostname outside the mail domain no longer revokes the mail identity or suspends its binding (0710).
    expect(
      (
        await control.core
          .prepare("SELECT state FROM project_application_domain_identities WHERE project_id=?")
          .bind(f.scope.projectId)
          .first()
      )?.["state"],
    ).toBe("verified");
    expect(
      await control.core
        .prepare("SELECT state,sending FROM project_mail_domain_bindings WHERE project_id=?")
        .bind(f.scope.projectId)
        .first(),
    ).toEqual(bindingBefore);
  }
  const f = await mailFixture(control),
    oldOrg = newUlid(),
    oldResource = newUlid();
  // Original stable FKs legally retain a suspended older-organization binding and pending proof for the global project.
  await put(control.core, "workspace_mail_domains", {
    domain_id: oldResource,
    organization_id: oldOrg,
    domain: `old-${oldResource.toLowerCase()}.example.com`,
    registrable_domain: "example.com",
    custody_organization_id: oldOrg,
    custody_project_id: f.scope.projectId,
    custody_environment_id: f.scope.environmentId,
    configured_at: f.now,
  });
  await control.core
    .prepare("DELETE FROM project_mail_domain_bindings WHERE project_id=?")
    .bind(f.scope.projectId)
    .run();
  await put(
    control.core,
    "project_application_domain_identities",
    identity(f.scope.projectId, oldOrg),
  );
  const binding = {
    project_id: f.scope.projectId,
    organization_id: oldOrg,
    environment_id: f.scope.environmentId,
    mail_domain_id: oldResource,
    state: "suspended",
    sending: true,
    legacy: false,
    sender_addresses: JSON.stringify([`hello@old-${oldResource.toLowerCase()}.example.com`]),
    default_from: `hello@old-${oldResource.toLowerCase()}.example.com`,
    application_identity_revision: 1,
    configured_at: f.now,
    updated_at: f.now,
  };
  await put(control.core, "project_mail_domain_bindings", binding);
  await f.update(
    "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE project_id=?1",
    [f.scope.projectId],
  );
  expect(
    (
      await control.core
        .prepare("SELECT state FROM project_mail_domain_bindings WHERE project_id=?")
        .bind(f.scope.projectId)
        .first()
    )?.["state"],
  ).toBe("detached");
  expect(
    (
      await control.core
        .prepare("SELECT state FROM project_application_domain_identities WHERE project_id=?")
        .bind(f.scope.projectId)
        .first()
    )?.["state"],
  ).toBe("revoked");
  const names = (
    await control.core
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'invalidate_changed_application_mail_domain_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  // A Paid connection's hostname no longer revokes the mail identity or suspends its bindings (migration 0710).
  expect(names).toEqual([]);
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('private')}}",
    d1Databases: { OLD: "old" },
  });
  try {
    const db = (await mf.getD1Database("OLD")) as unknown as D1Database,
      all = migrationFiles("core"),
      migration = all.find((file) => file.name === "0466_mail_original_management.sql");
    if (!migration) throw new Error("Missing native management migration");
    for (const file of all.filter((file) => file.name < migration.name))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    await copyParents(db, f.scope.organizationId);
    await put(db, "resend_mail_domains", {
      organization_id: f.scope.organizationId,
      domain_id: newUlid(),
      project_id: f.scope.projectId,
      environment_id: f.scope.environmentId,
      domain: `retained-${newUlid().toLowerCase()}.example.com`,
      sending: 1,
      receiving: 0,
      receiving_suspended: 0,
      configured_at: f.now,
    });
    const before = {
      schema: (
        await db
          .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
          .all()
      ).results,
      rows: (await db.prepare("SELECT * FROM resend_mail_domains").all()).results,
    };
    await expect(
      db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql))),
    ).rejects.toThrow();
    expect({
      schema: (
        await db
          .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
          .all()
      ).results,
      rows: (await db.prepare("SELECT * FROM resend_mail_domains").all()).results,
    }).toEqual(before);
  } finally {
    await mf.dispose();
  }
});
