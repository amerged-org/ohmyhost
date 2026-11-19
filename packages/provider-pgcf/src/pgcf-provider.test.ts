import { describe, expect, it } from "vitest";
import {
  type PgcfScheduleUpsert,
  type PgcfWebhookInput,
  PgcfProjectProvider,
  PgcfProviderError,
} from "./pgcf-provider.js";

/** A valid but low-entropy signing secret, so the secret scanner reads it as a fixture. */
const WEBHOOK_SECRET = `whsec_${"a".repeat(24)}`;

const projectId = "prj_abcdefghijklmnopqrst",
  databaseId = "abcdefghijklmnopqrst",
  operationId = "op_abcdefghijklmnopqrst";
const db = {
  id: databaseId,
  project_id: projectId,
  region_id: "us-dev",
  name: "omh-example",
  size_class_id: "r512-s1g",
  resources: { memory_mib: 512, cpu_millicores: 250, storage_gib: 1 },
  desired_state: "running",
  observed_state: "ready",
  generation: 1,
  observed_generation: 1,
  effective_sleep_after_seconds: 60,
};
const op = {
  id: operationId,
  database_id: databaseId,
  project_id: projectId,
  generation: 1,
  kind: "database.create",
  status: "succeeded",
  error: null,
};
const role = {
  database_id: databaseId,
  name: "ohmyho_rw_example",
  owner: false,
  password_revision: 1,
  valid_until: null,
  connection_limit: 20,
  member_of: [],
  bypass_rls: false,
};
function provider(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  timeoutMs = 1000,
) {
  return new PgcfProjectProvider({
    baseUrl: "https://pgcf.example.com",
    projectId,
    apiKey: "test-integrator-secret-not-live",
    timeoutMs,
    fetch: (async (url: string | URL | Request, init: RequestInit) =>
      respond(String(url), init)) as typeof fetch,
  });
}
describe("project-bound PGCF management contract", () => {
  it("accepts bounded cold-resume receipts through pending restore, activation and deferred local wake", async () => {
    let current = {
      database: {
        ...db,
        observed_state: "provisioning",
        storage_residency: "restoring",
        storage_operation_id: operationId,
      },
      operation: { ...op, kind: "database.rehydrate", status: "running", generation: 2 },
    };
    const client = provider((url, init) => {
      if (url.includes("/operations/")) return Response.json(current.operation);
      expect(JSON.parse(String(init.body))).toEqual({ expected_generation: 1 });
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("cold-resume");
      return Response.json(current, { status: 202 });
    });
    expect(
      await client.changeDatabase(databaseId, "resume", "cold-resume", undefined, 1),
    ).toMatchObject({
      database: { generation: 1, storageResidency: "restoring", storageOperationId: operationId },
      operation: { generation: 2, kind: "database.rehydrate" },
    });
    current = {
      database: {
        ...current.database,
        generation: 3,
        observed_generation: 3,
        observed_state: "ready",
        storage_residency: "local",
      },
      operation: { ...current.operation, generation: 3, status: "succeeded" },
    };
    expect(await client.readOperation(operationId)).toMatchObject({
      generation: 3,
      kind: "database.rehydrate",
    });
    expect(
      await client.changeDatabase(databaseId, "resume", "cold-resume", undefined, 1),
    ).toMatchObject({ operation: { generation: 3 } });
    const failed = provider(() =>
      Response.json(
        {
          database: { ...db, storage_residency: "archived", storage_operation_id: operationId },
          operation: {
            ...op,
            kind: "database.rehydrate",
            status: "failed",
            generation: 2,
            error: { code: "build_failed" },
          },
        },
        { status: 202 },
      ),
    );
    expect(
      await failed.changeDatabase(databaseId, "resume", "failed-cold", undefined, 1),
    ).toMatchObject({ operation: { status: "failed", generation: 2 } });
    const replacedFailure = provider(() =>
      Response.json(
        {
          database: {
            ...db,
            observed_state: "provisioning",
            storage_residency: "restoring",
            storage_operation_id: "op_00000000000000000000",
          },
          operation: {
            ...op,
            kind: "database.rehydrate",
            status: "failed",
            generation: 2,
            error: { code: "build_failed" },
          },
        },
        { status: 202 },
      ),
    );
    expect(
      await replacedFailure.changeDatabase(
        databaseId,
        "resume",
        "failed-then-replaced",
        undefined,
        1,
      ),
    ).toMatchObject({ operation: { status: "failed", generation: 2 } });
    const archiveId = "op_00000000000000000000";
    const deferred = provider(() =>
      Response.json(
        {
          database: {
            ...db,
            desired_state: "suspended",
            observed_state: "hibernated",
            storage_residency: "archiving",
            storage_operation_id: archiveId,
          },
          operation: { ...op, kind: "database.resume", status: "pending", generation: 2 },
        },
        { status: 202 },
      ),
    );
    expect(
      await deferred.changeDatabase(databaseId, "resume", "deferred-resume", undefined, 1),
    ).toMatchObject({ operation: { kind: "database.resume", generation: 2 } });
    const parent = provider(() =>
      Response.json(
        {
          database: { ...db, storage_residency: "archiving", storage_operation_id: operationId },
          operation: { ...op, kind: "database.archive", status: "running" },
        },
        { status: 202 },
      ),
    );
    expect(
      await parent.changeDatabase(databaseId, "resume", "parent-resume", undefined, 1),
    ).toMatchObject({ operation: { kind: "database.archive", generation: 1 } });
  });

  it("keeps cold receipt exceptions scoped to resume, exact identity, current storage work and bounded generations", async () => {
    const valid = {
      database: { ...db, storage_residency: "restoring", storage_operation_id: operationId },
      operation: { ...op, kind: "database.rehydrate", status: "running", generation: 2 },
    };
    const answer = (value: unknown) => provider(() => Response.json(value, { status: 202 }));
    await expect(
      answer(valid).changeDatabase(databaseId, "suspend", "wrong-action", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer(valid).deleteRole(databaseId, role.name, "wrong-role-action"),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        database: { ...valid.database, storage_operation_id: "op_00000000000000000000" },
      }).changeDatabase(databaseId, "resume", "wrong-operation", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({ ...valid, operation: { ...valid.operation, status: "succeeded" } }).changeDatabase(
        databaseId,
        "resume",
        "early-success",
        undefined,
        1,
      ),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        database: { ...valid.database, generation: 3, observed_generation: 3 },
        operation: { ...valid.operation, status: "succeeded", generation: 3 },
      }).changeDatabase(databaseId, "resume", "unactivated-success", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        database: { ...valid.database, generation: 3, observed_generation: 3 },
        operation: { ...valid.operation, status: "succeeded", generation: 2 },
      }).changeDatabase(databaseId, "resume", "current-not-historical", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        database: { ...valid.database, generation: 4 },
        operation: { ...valid.operation, generation: 4 },
      }).changeDatabase(databaseId, "resume", "too-far", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        operation: { ...valid.operation, database_id: "zbcdefghijklmnopqrst" },
      }).changeDatabase(databaseId, "resume", "wrong-database", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        operation: { ...valid.operation, project_id: "prj_00000000000000000000" },
      }).changeDatabase(databaseId, "resume", "wrong-project", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        database: { ...valid.database, storage_residency: "other" },
      }).changeDatabase(databaseId, "resume", "bad-storage", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      answer({
        ...valid,
        operation: { ...valid.operation, kind: "database.resume" },
        database: { ...valid.database, storage_residency: "local" },
      }).changeDatabase(databaseId, "resume", "ordinary-future", undefined, 1),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
  });
  it("keeps provider identity and stable management idempotency through all successful lifecycle paths", async () => {
    const seen: { method?: string; key: string | null; body: unknown }[] = [];
    const client = provider((url, init) => {
      const headers = new Headers(init.headers);
      expect(init.redirect).toBe("manual");
      seen.push({
        ...(init.method === undefined ? {} : { method: init.method }),
        key: headers.get("Idempotency-Key"),
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.includes("connection-uri"))
        return Response.json({
          database_id: databaseId,
          role: role.name,
          host: `${databaseId}.db.example.com`,
          database: databaseId,
          includes_password: true,
          uri: `postgres://${role.name}:password@${databaseId}.db.example.com/${databaseId}?sslmode=require`,
        });
      if (url.includes("/roles") && init.method === "GET")
        return Response.json({ data: [role], next_cursor: null });
      if (url.endsWith("/roles")) return Response.json(role, { status: 201 });
      if (url.includes("/operations/")) return Response.json(op);
      if (url.includes("/usage?"))
        return Response.json({
          data: [
            {
              database_id: databaseId,
              project_id: projectId,
              start: "2026-10-26T00:00:00.000Z",
              end: "2026-10-26T01:00:00.000Z",
              final: true,
              metrics: { memory_mib_seconds: 1843200, egress_bytes: null },
              gaps: ["traffic_coverage"],
            },
          ],
          next_cursor: null,
        });
      return init.method === "GET"
        ? Response.json(db)
        : Response.json(
            {
              database: db,
              operation: {
                ...op,
                kind:
                  init.method === "PATCH"
                    ? "database.resize"
                    : init.method === "DELETE"
                      ? url.includes("/roles/")
                        ? "database.role.delete"
                        : "database.delete"
                      : url.endsWith("/suspend")
                        ? "database.suspend"
                        : url.endsWith("/resume")
                          ? "database.resume"
                          : "database.create",
              },
            },
            { status: 202 },
          );
    });
    const created = await client.createDatabase({
      name: "omh-example",
      regionId: "us-dev",
      sizeClassId: "r512-s1g",
      idempotencyKey: "omh-operation-create",
    });
    expect(created.database.resources.storageMiB).toBe(1024);
    expect(await client.readDatabase(databaseId)).toMatchObject({ projectId, id: databaseId });
    for (const suspension_reason of ["idle", "manual", null] as const)
      expect(
        await provider(() =>
          Response.json({
            ...db,
            desired_state: "suspended",
            observed_state: "hibernated",
            suspension_reason,
          }),
        ).readDatabase(databaseId),
      ).toMatchObject({ suspensionReason: suspension_reason });
    expect(await client.readOperation(operationId)).toMatchObject({
      status: "succeeded",
      databaseId,
    });
    for (const action of ["resize", "suspend", "resume", "delete"] as const)
      await client.changeDatabase(databaseId, action, `omh-${action}`, "r512-s1g");
    for (const action of ["suspend", "resume"] as const) {
      const power = provider((_url, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ expected_generation: 1 });
        expect(new Headers(init.headers).get("Idempotency-Key")).toBe(`omh-cas-${action}`);
        return Response.json(
          {
            database: { ...db, generation: 4, observed_generation: 4 },
            operation: { ...op, generation: 2, kind: `database.${action}` },
          },
          { status: 202 },
        );
      });
      expect(
        await power.changeDatabase(databaseId, action, `omh-cas-${action}`, undefined, 1),
      ).toMatchObject({ database: { generation: 4 }, operation: { generation: 2 } });
    }
    await expect(
      client.changeDatabase(databaseId, "delete", "omh-invalid-cas", undefined, 1),
    ).rejects.toMatchObject({ code: "input" });
    await expect(
      client.changeDatabase(databaseId, "suspend", "omh-invalid-cas", undefined, 0),
    ).rejects.toMatchObject({ code: "input" });
    expect(await client.createRole(databaseId, { name: role.name }, "omh-role")).toMatchObject({
      name: role.name,
    });
    const asyncRole = provider((_url, init) =>
      (init.method ?? "GET") === "POST"
        ? Response.json(
            { database: db, operation: { ...op, kind: "database.role.create", status: "running" } },
            { status: 202 },
          )
        : Response.json({ ...op, kind: "database.role.create", status: "succeeded" }),
    );
    // PGCF creates a role synchronously with 201 and a Role; an asynchronous role operation is a contract breach.
    await expect(
      asyncRole.createRole(databaseId, { name: role.name }, "omh-role-async"),
    ).rejects.toMatchObject({ code: "rejected", status: 202 });
    expect(await asyncRole.readOperation(operationId)).toMatchObject({
      kind: "database.role.create",
      status: "succeeded",
    });
    expect(await client.readRoles(databaseId)).toHaveLength(1);
    await client.deleteRole(databaseId, role.name, "omh-role-delete");
    const connection = await client.readConnection(databaseId, role.name);
    expect(JSON.stringify(connection)).toBe('{"redacted":true}');
    expect(connection.toString()).not.toContain("password");
    expect(await connection.consume(async (uri) => new URL(uri).pathname)).toBe(`/${databaseId}`);
    expect(
      await client.readUsage({ from: "2026-10-26T00:00:00.000Z", to: "2026-10-26T01:00:00.000Z" }),
    ).toMatchObject({ rows: [{ final: true, metrics: { egress_bytes: null } }] });
    expect(
      seen.filter((row) => row.method !== "GET").every((row) => row.key?.startsWith("omh-")),
    ).toBe(true);
    expect(seen[0]?.body).toMatchObject({ project_id: projectId });
  });
  it("fails closed on wrong tenant, target, ambiguous storage and credential redirects", async () => {
    for (const [payload, reason] of [
      [
        {
          error: {
            code: "conflict",
            details: { reason: "generation_changed" },
            message: "private-secret",
          },
        },
        "generation_changed",
      ],
      [
        {
          error: {
            code: "idempotency_in_progress",
            details: { reason: "generation_changed" },
            message: "private-secret",
          },
        },
        "idempotency_in_progress",
      ],
      [
        { error: { code: "conflict", details: { reason: "other" }, message: "private-secret" } },
        "other",
      ],
      [
        {
          error: {
            code: "conflict",
            details: { reason: "Private Secret: abc" },
            message: "private-secret",
          },
        },
        undefined,
      ],
      [
        {
          error: {
            code: "conflict",
            details: { reason: "a".repeat(49) },
            message: "private-secret",
          },
        },
        undefined,
      ],
      [
        {
          error: {
            code: "internal",
            details: { reason: "role_exists" },
            message: "private-secret",
          },
        },
        undefined,
      ],
      [
        {
          error: {
            code: "conflict",
            details: { reason: "generation_changed" },
            message: "x".repeat(5000),
          },
        },
        undefined,
      ],
    ] as const) {
      await expect(
        provider(() => Response.json(payload, { status: 409 })).changeDatabase(
          databaseId,
          "suspend",
          "omh-cas-conflict",
          undefined,
          1,
        ),
      ).rejects.toMatchObject({
        code: "rejected",
        status: 409,
        outcomeUnknown: false,
        conflictReason: reason,
        message: "PGCF provider rejected",
      });
    }

    await expect(
      provider(() => Response.json({ ...op, id: "op_00000000000000000000" })).readOperation(
        operationId,
      ),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json(
          { database: { ...db, name: "foreign-database" }, operation: op },
          { status: 202 },
        ),
      ).createDatabase({
        name: "omh-example",
        regionId: "us-dev",
        sizeClassId: "r512-s1g",
        idempotencyKey: "omh-create",
      }),
    ).rejects.toMatchObject({ code: "contract", outcomeUnknown: true });
    for (const invalid of [
      { ...db, project_id: "prj_00000000000000000000" },
      { ...db, id: "zbcdefghijklmnopqrst" },
      { ...db, resources: { ...db.resources, storage_mib: 500 } },
      { ...db, suspension_reason: "unknown" },
    ])
      await expect(
        provider(() => Response.json(invalid)).readDatabase(databaseId),
      ).rejects.toMatchObject({ code: "contract" });
    expect(
      (
        await provider(() =>
          Response.json({
            ...db,
            resources: { memory_mib: 256, cpu_millicores: 250, storage_mib: 500 },
          }),
        ).readDatabase(databaseId)
      ).resources.storageMiB,
    ).toBe(500);
    await expect(
      provider(
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.example.com" },
          }),
      ).readDatabase(databaseId),
    ).rejects.toMatchObject({ code: "redirect" });
    await expect(
      provider(() =>
        Response.json({
          database_id: databaseId,
          database: databaseId,
          role: role.name,
          host: "db.example.com",
          includes_password: true,
          uri: `postgres://${role.name}:secret@attacker.example.com/${databaseId}`,
        }),
      ).readConnection(databaseId, role.name),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ ...op, project_id: "prj_00000000000000000000" }),
      ).readOperation(operationId),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ ...role, database_id: "zbcdefghijklmnopqrst" }, { status: 201 }),
      ).createRole(databaseId, { name: role.name }, "role-create"),
    ).rejects.toMatchObject({ code: "contract" });
  });
  it("returns a same-key replay whose operation predates a later database generation", async () => {
    const later = { ...db, generation: 3, observed_generation: 3 };
    await expect(
      provider(() => Response.json({ database: later, operation: op }, { status: 202 })).deleteRole(
        databaseId,
        role.name,
        "omh-role-delete",
      ),
    ).resolves.toMatchObject({ database: { generation: 3 }, operation: { id: operationId } });
    await expect(
      provider(() =>
        Response.json(
          { database: later, operation: { ...op, kind: "database.resize" } },
          { status: 202 },
        ),
      ).changeDatabase(databaseId, "resize", "omh-resize", "r512-s1g"),
    ).resolves.toMatchObject({ operation: { generation: 1 } });
    await expect(
      provider(() =>
        Response.json({ database: db, operation: { ...op, generation: 2 } }, { status: 202 }),
      ).deleteRole(databaseId, role.name, "omh-role-delete"),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
    await expect(
      provider(() =>
        Response.json(
          { database: db, operation: { ...op, database_id: "zbcdefghijklmnopqrst" } },
          { status: 202 },
        ),
      ).deleteRole(databaseId, role.name, "omh-role-delete"),
    ).rejects.toMatchObject({ code: "contract", status: 202, outcomeUnknown: true });
  });
  it("bounds uncertain dispatch, refuses invalid inputs and never includes remote bodies in errors", async () => {
    expect(
      () =>
        new PgcfProjectProvider({
          baseUrl: "http://localhost",
          projectId,
          apiKey: "test-only-credential",
        }),
    ).toThrow(PgcfProviderError);
    const never = provider(() => new Promise<Response>(() => {}), 5);
    await expect(
      never.createDatabase({
        name: "omh-example",
        regionId: "us-dev",
        sizeClassId: "r512-s1g",
        idempotencyKey: "same-logical-operation",
      }),
    ).rejects.toMatchObject({ code: "timeout", outcomeUnknown: true });
    await expect(
      provider(() => Response.json({ password: "DO_NOT_LEAK" }, { status: 503 })).readDatabase(
        databaseId,
      ),
    ).rejects.toMatchObject({ code: "rejected", status: 503, message: "PGCF provider rejected" });
    await expect(
      provider(() => new Response("x".repeat(2 * 1024 * 1024 + 1))).readDatabase(databaseId),
    ).rejects.toMatchObject({ code: "oversize" });
    await expect(
      provider(() => new Response("not-json")).readDatabase(databaseId),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(never.changeDatabase(databaseId, "delete", "")).rejects.toMatchObject({
      code: "input",
    });
    await expect(never.createRole(databaseId, { name: "app" }, "key")).rejects.toMatchObject({
      code: "input",
    });
    await expect(
      never.readUsage({ from: "2026-10-26T00:01:00.000Z", to: "2026-10-26T01:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "input" });
  });
});

// Wire shapes: PGCF packages/contracts/src/webhooks.ts (Webhook, WebhookDelivery, WebhookTestResult, WebhookReplayResult), schedules.ts (Schedule, ScheduleRun, ScheduleRunAccepted), execution-usage.ts (ExecutionUsageRow).
const webhookId = "whk_abcdefghijklmnopqrst";
const deliveryId = "dlv_0123456789abcdef0123";
const eventId = "evt_0123456789abcdef0123";
const timestamp = "2026-10-31T10:00:00.000Z";
const webhook = {
  id: webhookId,
  project_id: projectId,
  url: "https://receiver.example.com/hooks",
  event_types: ["database.ready"],
  database_ids: [databaseId],
  header_names: [],
  created_at: timestamp,
};
const delivery = {
  id: deliveryId,
  event_id: eventId,
  event_type: "database.ready",
  webhook_id: webhookId,
  state: "delivered",
  attempts: 1,
  created_at: timestamp,
  next_attempt_at: null,
  delivered_at: timestamp,
  last_status: 200,
  last_error: null,
};
const schedule = {
  name: "cleanup",
  cron: "30 3 * * *",
  every_seconds: null,
  statements: ["delete from sessions"],
  role: "ohmyho_rw_example",
  timeout_ms: 60000,
  enabled: true,
  next_run_at: timestamp,
  created_at: timestamp,
};
const run = {
  id: 7,
  schedule: "cleanup",
  scheduled_at: timestamp,
  started_at: timestamp,
  finished_at: timestamp,
  outcome: "succeeded",
  sqlstate: null,
  attempts: 1,
  manual: false,
};
const usage = {
  database_id: databaseId,
  project_id: projectId,
  start: "2026-10-26T00:00:00.000Z",
  end: "2026-10-26T01:00:00.000Z",
  final: true,
  metrics: {
    schedule_runs_succeeded: 2,
    schedule_runs_failed: 0,
    schedule_runs_timed_out: 0,
    schedule_runs_outcome_unknown: 0,
    schedule_runs_rejected: 0,
    schedule_runs_skipped: 0,
    events_emitted: 3,
    event_bytes: 512,
    webhook_attempts: 3,
    webhook_deliveries_delivered: 3,
    webhook_deliveries_dead_lettered: 0,
  },
};
const webhookInput: PgcfWebhookInput = {
  url: "https://receiver.example.com/hooks",
  eventTypes: ["database.ready"],
  databaseIds: [databaseId],
};
const scheduleBase = { statements: ["select 1"], role: "ohmyho_rw_example" } as const;
const unreachable = () => provider(() => Promise.reject(new Error("must not be sent")));
const foreignProject = "prj_00000000000000000000";

describe("webhooks, schedules and execution usage contract", () => {
  it("creates a webhook with its key, sends only the wire fields and returns the secret", async () => {
    const seen: { path: string; method?: string; key: string | null; body: unknown }[] = [];
    const client = provider((url, init) => {
      seen.push({
        path: new URL(url).pathname,
        ...(init.method === undefined ? {} : { method: init.method }),
        key: new Headers(init.headers).get("Idempotency-Key"),
        body: JSON.parse(String(init.body)),
      });
      return Response.json({ ...webhook, secret: WEBHOOK_SECRET }, { status: 201 });
    });
    await expect(
      client.createWebhook(
        { ...webhookInput, headers: { "X-Receiver": "token-value" } },
        {
          key: "omh-wh-key",
        },
      ),
    ).resolves.toMatchObject({
      id: webhookId,
      databaseIds: [databaseId],
      secret: WEBHOOK_SECRET,
    });
    expect(seen).toEqual([
      {
        path: "/v1/webhooks",
        method: "POST",
        key: "omh-wh-key",
        body: {
          url: "https://receiver.example.com/hooks",
          event_types: ["database.ready"],
          database_ids: [databaseId],
          headers: { "X-Receiver": "token-value" },
        },
      },
    ]);
  });
  it("refuses webhook inputs outside the PGCF syntax before anything is sent", async () => {
    const refused = unreachable();
    const manyHeaders = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`X-Header-${index}`, "value"]),
    );
    const invalid: PgcfWebhookInput[] = [
      { ...webhookInput, url: "http://receiver.example.com/hooks" },
      { ...webhookInput, url: "https://user:secret@receiver.example.com/hooks" },
      { ...webhookInput, eventTypes: [] },
      { ...webhookInput, eventTypes: ["database ready"] },
      { ...webhookInput, databaseIds: [] },
      { ...webhookInput, databaseIds: ["not-a-database"] },
      { ...webhookInput, headers: { "Bad Name": "value" } },
      { ...webhookInput, headers: { "X-Empty": "" } },
      { ...webhookInput, headers: { "X-Dup": "a", "x-dup": "b" } },
      { ...webhookInput, headers: { "X-Long": "x".repeat(513) } },
      { ...webhookInput, headers: manyHeaders },
      // 720 raw characters that PGCF stores percent-encoded as 4220 characters: over its schema.
      { ...webhookInput, url: `https://example.com/${"é".repeat(700)}` },
    ];
    for (const input of invalid)
      await expect(refused.createWebhook(input, { key: "omh-wh-key" })).rejects.toMatchObject({
        code: "input",
      });
    await expect(refused.createWebhook(webhookInput, { key: "" })).rejects.toMatchObject({
      code: "input",
    });
  });
  it("refuses webhook answers of another project or with a malformed secret", async () => {
    for (const body of [
      { ...webhook, project_id: foreignProject, secret: WEBHOOK_SECRET },
      { ...webhook, secret: 12 },
      { ...webhook, secret: "short" },
      { ...webhook, created_at: "yesterday", secret: WEBHOOK_SECRET },
    ])
      await expect(
        provider(() => Response.json(body, { status: 201 })).createWebhook(webhookInput, {
          key: "omh-wh-key",
        }),
      ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json(
          { error: { code: "idempotency_conflict", message: "private-secret" } },
          { status: 409 },
        ),
      ).createWebhook(webhookInput, { key: "omh-wh-key" }),
    ).rejects.toMatchObject({
      code: "rejected",
      status: 409,
      outcomeUnknown: false,
      conflictReason: "idempotency_conflict",
    });
  });
  it("marks a wrong-shaped answer to a write as an uncertain outcome, but not a read", async () => {
    const writes: [number, (client: PgcfProjectProvider) => Promise<unknown>, unknown][] = [
      [201, (client) => client.createWebhook(webhookInput, { key: "omh-wh-key" }), webhook],
      [
        200,
        (client) => client.testWebhook(webhookId, { key: "omh-test-key-0001" }),
        { delivered: "yes", status: null, error: null, duration_ms: 1 },
      ],
      [
        202,
        (client) =>
          client.replayWebhookDelivery(databaseId, deliveryId, { key: "omh-test-key-0001" }),
        { delivery_id: eventId, state: "pending" },
      ],
      [
        200,
        (client) =>
          client.putSchedule(databaseId, "cleanup", { ...scheduleBase, everySeconds: 3600 }),
        { ...schedule, name: "other" },
      ],
      [
        202,
        (client) => client.runScheduleNow(databaseId, "cleanup", { key: "omh-test-key-0001" }),
        { schedule: "other", state: "queued" },
      ],
    ];
    for (const [status, call, body] of writes)
      await expect(call(provider(() => Response.json(body, { status })))).rejects.toMatchObject({
        code: "contract",
        status,
        outcomeUnknown: true,
      });
    await expect(
      provider(() => Response.json({ ...webhook, id: "whk_bbbbbbbbbbbbbbbbbbbb" })).getWebhook(
        webhookId,
      ),
    ).rejects.toMatchObject({ code: "contract", outcomeUnknown: false });
  });
  it("lists and reads webhooks of the project and deletes one on a bodiless 204", async () => {
    const seen: string[] = [];
    const client = provider((url, init) => {
      seen.push(`${init.method} ${url.replace("https://pgcf.example.com", "")}`);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/v1/webhooks?"))
        return Response.json({ data: [webhook], next_cursor: "cursor-2" });
      return Response.json(webhook);
    });
    await expect(client.listWebhooks({ limit: 2, cursor: "cursor-1" })).resolves.toEqual({
      items: [
        {
          id: webhookId,
          projectId,
          url: webhook.url,
          eventTypes: ["database.ready"],
          databaseIds: [databaseId],
          headerNames: [],
          createdAt: timestamp,
        },
      ],
      nextCursor: "cursor-2",
    });
    await expect(client.getWebhook(webhookId)).resolves.toMatchObject({ id: webhookId });
    // PGCF stores the normalized URL, which can be far longer than the 2048 characters it accepts raw.
    const storedUrl = `https://example.com/${"%C3%A9".repeat(700)}`;
    await expect(
      provider(() =>
        Response.json({ data: [{ ...webhook, url: storedUrl }], next_cursor: null }),
      ).listWebhooks({ limit: 1 }),
    ).resolves.toMatchObject({ items: [{ url: storedUrl }] });
    await expect(
      provider(() =>
        Response.json({ ...webhook, url: storedUrl, secret: WEBHOOK_SECRET }, { status: 201 }),
      ).createWebhook(webhookInput, { key: "omh-wh-key" }),
    ).resolves.toMatchObject({ url: storedUrl });
    await expect(
      client.deleteWebhook(webhookId, { key: "omh-test-key-0001" }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([
      `GET /v1/webhooks?limit=2&cursor=cursor-1`,
      `GET /v1/webhooks/${webhookId}`,
      `DELETE /v1/webhooks/${webhookId}`,
    ]);
    await expect(
      provider(() => Response.json(webhook)).deleteWebhook(webhookId, { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "rejected", status: 200 });
    await expect(
      provider(() => Response.json(webhook)).getWebhook("whk_bbbbbbbbbbbbbbbbbbbb"),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() => Response.json({ ...webhook, header_names: ["X-Receiver"] })).getWebhook(
        webhookId,
      ),
    ).resolves.toMatchObject({ headerNames: ["X-Receiver"] });
    await expect(
      provider(() => Response.json({ ...webhook, header_names: ["bad name"] })).getWebhook(
        webhookId,
      ),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ data: [webhook, webhook, webhook], next_cursor: null }),
      ).listWebhooks({ limit: 2 }),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ data: [{ ...webhook, project_id: foreignProject }], next_cursor: null }),
      ).listWebhooks({ limit: 2 }),
    ).rejects.toMatchObject({ code: "contract" });
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1, cursor: "" }])
      await expect(unreachable().listWebhooks(input)).rejects.toMatchObject({ code: "input" });
  });
  it("sends one webhook test and reports the receiver answer without retry", async () => {
    const seen: string[] = [];
    const client = provider((url, init) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      return Response.json({ delivered: false, status: 500, error: "http", duration_ms: 42 });
    });
    await expect(client.testWebhook(webhookId, { key: "omh-test-key-0001" })).resolves.toEqual({
      delivered: false,
      status: 500,
      error: "http",
      durationMs: 42,
    });
    expect(seen).toEqual([`POST /v1/webhooks/${webhookId}/test`]);
    await expect(
      provider(() =>
        Response.json({ delivered: true, status: 200, error: null, duration_ms: 9 }),
      ).testWebhook(webhookId, { key: "omh-test-key-0001" }),
    ).resolves.toMatchObject({ delivered: true, durationMs: 9 });
    await expect(
      provider(() =>
        Response.json({ delivered: true, status: 200, error: "http", duration_ms: 9 }),
      ).testWebhook(webhookId, { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ error: { code: "rate_limited", message: "private" } }, { status: 429 }),
      ).testWebhook(webhookId, { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "rejected", status: 429 });
  });
  it("sends each webhook test, delete, replay and schedule run under the caller's own Idempotency-Key", async () => {
    const sent: { path: string; key: string | null }[] = [];
    const client = provider((url, init) => {
      sent.push({
        path: new URL(url).pathname,
        key: new Headers(init.headers).get("Idempotency-Key"),
      });
      if (url.endsWith("/test"))
        return Response.json({ delivered: true, status: 200, error: null, duration_ms: 9 });
      if (url.endsWith("/replay"))
        return Response.json({ delivery_id: deliveryId, state: "pending" }, { status: 202 });
      if (url.endsWith("/run"))
        return Response.json({ schedule: "cleanup", state: "queued" }, { status: 202 });
      return new Response(null, { status: 204 });
    });
    await client.testWebhook(webhookId, { key: "omh-test-key-0001" });
    await client.deleteWebhook(webhookId, { key: "omh-delete-key-0001" });
    await client.replayWebhookDelivery(databaseId, deliveryId, { key: "omh-replay-key-0001" });
    await client.runScheduleNow(databaseId, "cleanup", { key: "omh-run-key-0001" });
    expect(sent).toEqual([
      { path: `/v1/webhooks/${webhookId}/test`, key: "omh-test-key-0001" },
      { path: `/v1/webhooks/${webhookId}`, key: "omh-delete-key-0001" },
      {
        path: `/v1/databases/${databaseId}/webhook-deliveries/${deliveryId}/replay`,
        key: "omh-replay-key-0001",
      },
      { path: `/v1/databases/${databaseId}/schedules/cleanup/run`, key: "omh-run-key-0001" },
    ]);
    await expect(unreachable().testWebhook(webhookId, { key: "two words" })).rejects.toMatchObject({
      code: "input",
    });
    await expect(
      unreachable().runScheduleNow(databaseId, "cleanup", { key: "" }),
    ).rejects.toMatchObject({ code: "input" });
  });

  it("lists deliveries of a database and replays one under the same id", async () => {
    const seen: string[] = [];
    const client = provider((url, init) => {
      seen.push(`${init.method} ${new URL(url).pathname}`);
      if (init.method === "POST")
        return Response.json({ delivery_id: deliveryId, state: "pending" }, { status: 202 });
      return Response.json({ data: [delivery], next_cursor: null });
    });
    await expect(client.listWebhookDeliveries(databaseId, { limit: 5 })).resolves.toEqual({
      items: [
        {
          id: deliveryId,
          eventId,
          eventType: "database.ready",
          webhookId,
          state: "delivered",
          attempts: 1,
          createdAt: timestamp,
          nextAttemptAt: null,
          deliveredAt: timestamp,
          lastStatus: 200,
          lastError: null,
        },
      ],
      nextCursor: null,
    });
    await expect(
      client.replayWebhookDelivery(databaseId, deliveryId, { key: "omh-test-key-0001" }),
    ).resolves.toEqual({
      deliveryId,
      state: "pending",
    });
    expect(seen).toEqual([
      `GET /v1/databases/${databaseId}/webhook-deliveries`,
      `POST /v1/databases/${databaseId}/webhook-deliveries/${deliveryId}/replay`,
    ]);
    await expect(
      provider(() =>
        Response.json(
          {
            error: {
              code: "conflict",
              message: "private",
              details: { reason: "delivery_pending" },
            },
          },
          { status: 409 },
        ),
      ).replayWebhookDelivery(databaseId, deliveryId, { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "rejected", status: 409, conflictReason: "delivery_pending" });
    await expect(
      provider(() =>
        Response.json({ delivery_id: eventId, state: "pending" }, { status: 202 }),
      ).replayWebhookDelivery(databaseId, deliveryId, { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({
          data: [{ ...delivery, event_type: "operation.unknown" }],
          next_cursor: null,
        }),
      ).listWebhookDeliveries(databaseId, { limit: 5 }),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      unreachable().listWebhookDeliveries(databaseId, { limit: 0 }),
    ).rejects.toMatchObject({ code: "input" });
  });
  it("sets a schedule with the wire body and key, creating or replacing it", async () => {
    const seen: { method?: string; key: string | null; body: unknown }[] = [];
    const client = provider((_url, init) => {
      seen.push({
        ...(init.method === undefined ? {} : { method: init.method }),
        key: new Headers(init.headers).get("Idempotency-Key"),
        body: JSON.parse(String(init.body)),
      });
      return Response.json(schedule, { status: seen.length === 1 ? 201 : 200 });
    });
    await expect(
      client.putSchedule(databaseId, "cleanup", {
        cron: "30 3 * * *",
        ...scheduleBase,
        timeoutMs: 60000,
      }),
    ).resolves.toMatchObject({
      name: "cleanup",
      cron: "30 3 * * *",
      everySeconds: null,
      timeoutMs: 60000,
      enabled: true,
    });
    await expect(
      client.putSchedule(databaseId, "cleanup", {
        everySeconds: 3600,
        ...scheduleBase,
        enabled: false,
      }),
    ).resolves.toMatchObject({ name: "cleanup" });
    expect(seen).toEqual([
      {
        method: "PUT",
        key: "omh-put-schedule",
        body: {
          cron: "30 3 * * *",
          statements: ["select 1"],
          role: "ohmyho_rw_example",
          timeout_ms: 60000,
        },
      },
      {
        method: "PUT",
        key: "omh-put-schedule",
        body: {
          every_seconds: 3600,
          statements: ["select 1"],
          role: "ohmyho_rw_example",
          enabled: false,
        },
      },
    ]);
  });
  it("refuses schedule inputs outside the PGCF limits before anything is sent", async () => {
    const refused = unreachable();
    const invalid: PgcfScheduleUpsert[] = [
      { ...scheduleBase },
      { ...scheduleBase, cron: "30 3 * * *", everySeconds: 3600 },
      { ...scheduleBase, cron: "* * *" },
      { ...scheduleBase, cron: "x".repeat(121) },
      { ...scheduleBase, everySeconds: 59 },
      { ...scheduleBase, everySeconds: 2_678_401 },
      { ...scheduleBase, everySeconds: 3600, statements: [] },
      { ...scheduleBase, everySeconds: 3600, statements: Array(21).fill("select 1") },
      { ...scheduleBase, everySeconds: 3600, statements: ["   "] },
      { ...scheduleBase, everySeconds: 3600, statements: ["x".repeat(16 * 1024 + 1)] },
      { ...scheduleBase, everySeconds: 3600, statements: Array(5).fill("x".repeat(16 * 1024)) },
      { ...scheduleBase, everySeconds: 3600, role: "Bad Role" },
      { ...scheduleBase, everySeconds: 3600, timeoutMs: 999 },
      { ...scheduleBase, everySeconds: 3600, timeoutMs: 900_001 },
      { ...scheduleBase, everySeconds: 3600, enabled: "yes" as unknown as boolean },
    ];
    for (const body of invalid)
      await expect(refused.putSchedule(databaseId, "cleanup", body)).rejects.toMatchObject({
        code: "input",
      });
    await expect(
      refused.putSchedule(databaseId, "Bad Name", { ...scheduleBase, everySeconds: 3600 }),
    ).rejects.toMatchObject({
      code: "input",
    });
  });
  it("refuses each malformed id or name alone before anything is sent", async () => {
    let sent = 0;
    const counting = new PgcfProjectProvider({
      baseUrl: "https://pgcf.example.com",
      projectId,
      apiKey: "test-integrator-secret-not-live",
      fetch: (async () => {
        sent += 1;
        throw new Error("must not be sent");
      }) as typeof fetch,
    });
    const traversal = `../v1/databases/${databaseId}`;
    const calls: readonly (() => Promise<unknown>)[] = [
      () => counting.deleteWebhook(traversal, { key: "omh-test-key-0001" }),
      () => counting.getWebhook("whk_abcdefghijklmnopqrst/../x"),
      () => counting.testWebhook("whk_abcdefghijklmnopqrst\n", { key: "omh-test-key-0001" }),
      () => counting.listWebhookDeliveries(`${databaseId}/x`, { limit: 5 }),
      () => counting.replayWebhookDelivery(traversal, deliveryId, { key: "omh-test-key-0001" }),
      () =>
        counting.replayWebhookDelivery(databaseId, "dlv_abcdefghijklmnopqrst/../x", {
          key: "omh-test-key-0001",
        }),
      () => counting.putSchedule(databaseId, "Bad Name", { ...scheduleBase, everySeconds: 3600 }),
      () =>
        counting.putSchedule(`${databaseId}/x`, "cleanup", { ...scheduleBase, everySeconds: 3600 }),
      () => counting.getSchedule(databaseId, "Bad Name"),
      () => counting.getSchedule(traversal, "cleanup"),
      () => counting.listSchedules(traversal),
      () => counting.deleteSchedule(databaseId, "../cleanup"),
      () => counting.listScheduleRuns(databaseId, "Bad Name", 5),
      () => counting.runScheduleNow(traversal, "cleanup", { key: "omh-test-key-0001" }),
      () => counting.runScheduleNow(databaseId, "Bad Name", { key: "omh-test-key-0001" }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "input" });
    expect(sent).toBe(0);
  });
  it("reads, lists, runs and deletes schedules and their runs", async () => {
    const seen: string[] = [];
    const client = provider((url, init) => {
      seen.push(`${init.method} ${url.replace("https://pgcf.example.com", "")}`);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (init.method === "POST" && url.endsWith("/run"))
        return Response.json({ schedule: "cleanup", state: "queued" }, { status: 202 });
      if (url.endsWith("/runs?limit=5")) return Response.json({ data: [run], next_cursor: null });
      if (url.endsWith("/schedules")) return Response.json({ data: [schedule], next_cursor: null });
      return Response.json(schedule);
    });
    await expect(client.getSchedule(databaseId, "cleanup")).resolves.toMatchObject({
      name: "cleanup",
      statements: ["delete from sessions"],
    });
    await expect(client.listSchedules(databaseId)).resolves.toHaveLength(1);
    await expect(client.listScheduleRuns(databaseId, "cleanup", 5)).resolves.toEqual([
      {
        id: 7,
        schedule: "cleanup",
        scheduledAt: timestamp,
        startedAt: timestamp,
        finishedAt: timestamp,
        outcome: "succeeded",
        sqlstate: null,
        attempts: 1,
        manual: false,
      },
    ]);
    await expect(
      client.runScheduleNow(databaseId, "cleanup", { key: "omh-test-key-0001" }),
    ).resolves.toEqual({
      schedule: "cleanup",
      state: "queued",
    });
    await expect(client.deleteSchedule(databaseId, "cleanup")).resolves.toBeUndefined();
    expect(seen).toEqual([
      `GET /v1/databases/${databaseId}/schedules/cleanup`,
      `GET /v1/databases/${databaseId}/schedules`,
      `GET /v1/databases/${databaseId}/schedules/cleanup/runs?limit=5`,
      `POST /v1/databases/${databaseId}/schedules/cleanup/run`,
      `DELETE /v1/databases/${databaseId}/schedules/cleanup`,
    ]);
  });
  it("refuses schedule answers that do not match the request", async () => {
    const answer = (body: unknown) => provider(() => Response.json(body, { status: 200 }));
    for (const body of [
      { ...schedule, name: "other" },
      { ...schedule, cron: null, every_seconds: null },
      { ...schedule, every_seconds: 3600 },
      { ...schedule, statements: [1] },
      { ...schedule, enabled: "yes" },
      { ...schedule, role: "Bad Role" },
      { ...schedule, next_run_at: "soon" },
    ])
      await expect(answer(body).getSchedule(databaseId, "cleanup")).rejects.toMatchObject({
        code: "contract",
      });
    await expect(
      answer({ data: [schedule], next_cursor: "more" }).listSchedules(databaseId),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      answer({ data: [{ ...run, outcome: "unknown" }], next_cursor: null }).listScheduleRuns(
        databaseId,
        "cleanup",
        5,
      ),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      answer({ data: [{ ...run, schedule: "other" }], next_cursor: null }).listScheduleRuns(
        databaseId,
        "cleanup",
        5,
      ),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() =>
        Response.json({ schedule: "cleanup", state: "running" }, { status: 202 }),
      ).runScheduleNow(databaseId, "cleanup", { key: "omh-test-key-0001" }),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(unreachable().listScheduleRuns(databaseId, "cleanup", 51)).rejects.toMatchObject({
      code: "input",
    });
  });
  it("reads execution usage of one database or the project and refuses rows outside the scope", async () => {
    const seen: string[] = [];
    const client = provider((url) => {
      seen.push(url.replace("https://pgcf.example.com", ""));
      return Response.json({ data: [usage], next_cursor: null });
    });
    const span = {
      from: "2026-10-26T00:00:00.000Z",
      to: "2026-10-26T02:00:00.000Z",
      granularity: "hour" as const,
      limit: 50,
    };
    await expect(client.readExecutionUsage({ ...span, scope: { databaseId } })).resolves.toEqual({
      rows: [
        {
          databaseId,
          projectId,
          start: usage.start,
          end: usage.end,
          final: true,
          metrics: usage.metrics,
        },
      ],
      nextCursor: null,
    });
    await expect(
      client.readExecutionUsage({ ...span, scope: { projectId } }),
    ).resolves.toMatchObject({ rows: [{ databaseId }] });
    expect(seen[0]).toContain(`database_id=${databaseId}`);
    expect(seen[0]).not.toContain("project_id");
    expect(seen[1]).toContain(`project_id=${projectId}`);
    const wire: URL[] = [];
    const daily = provider((url) => {
      wire.push(new URL(url));
      return Response.json({
        data: [
          {
            ...usage,
            start: "2026-10-26T00:00:00.000Z",
            end: "2026-10-27T00:00:00.000Z",
          },
        ],
        next_cursor: "next-page",
      });
    });
    await expect(
      daily.readExecutionUsage({
        scope: { projectId },
        from: "2026-10-26T00:00:00.000Z",
        to: "2026-10-28T00:00:00.000Z",
        granularity: "day",
        limit: 7,
        cursor: "page-2",
      }),
    ).resolves.toMatchObject({ rows: [{ databaseId }], nextCursor: "next-page" });
    expect(wire[0]?.pathname).toBe("/v1/execution-usage");
    expect(Object.fromEntries(wire[0]?.searchParams ?? [])).toEqual({
      project_id: projectId,
      from: "2026-10-26T00:00:00.000Z",
      to: "2026-10-28T00:00:00.000Z",
      granularity: "day",
      limit: "7",
      cursor: "page-2",
    });
    await expect(
      provider((url) => {
        wire.push(new URL(url));
        return Response.json({ data: [usage], next_cursor: null });
      }).readExecutionUsage({
        ...span,
        cursor: `${databaseId}|2026-10-26T01:00:00.000Z`,
        scope: { databaseId },
      }),
    ).resolves.toMatchObject({ rows: [{ databaseId }], nextCursor: null });
    expect(wire[1]?.href).toContain("cursor=abcdefghijklmnopqrst%7C2026-10-26T01%3A00%3A00.000Z");
    expect(Object.fromEntries(wire[1]?.searchParams ?? [])).toMatchObject({
      database_id: databaseId,
      granularity: "hour",
      limit: "50",
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      unreachable().readExecutionUsage({ ...span, scope: { databaseId }, signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "timeout" });
    const invalid = [
      { ...span, scope: { projectId: foreignProject } },
      { ...span, from: "2026-10-26T00:30:00.000Z", scope: { databaseId } },
      { ...span, granularity: "day" as const, scope: { databaseId } },
      {
        ...span,
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-03-01T00:00:00.000Z",
        scope: { databaseId },
      },
      { ...span, to: span.from, scope: { databaseId } },
      { ...span, limit: 0, scope: { databaseId } },
      { ...span, limit: 101, scope: { databaseId } },
      { ...span, cursor: "zbcdefghijklmnopqrst|2026-10-26T00:00:00.000Z", scope: { databaseId } },
      { ...span, cursor: "x".repeat(129), scope: { projectId } },
    ];
    for (const input of invalid)
      await expect(unreachable().readExecutionUsage(input)).rejects.toMatchObject({
        code: "input",
      });
    const rows = (body: unknown) =>
      provider(() => Response.json(body)).readExecutionUsage({ ...span, scope: { databaseId } });
    for (const body of [
      { data: [{ ...usage, metrics: { ...usage.metrics, mystery: 1 } }], next_cursor: null },
      {
        data: [{ ...usage, metrics: { ...usage.metrics, events_emitted: null } }],
        next_cursor: null,
      },
      {
        data: [{ ...usage, metrics: { ...usage.metrics, events_emitted: -1 } }],
        next_cursor: null,
      },
      {
        data: [{ ...usage, metrics: { ...usage.metrics, event_bytes: 1.5 } }],
        next_cursor: null,
      },
      {
        data: [{ ...usage, metrics: { ...usage.metrics, event_bytes: 2 ** 53 } }],
        next_cursor: null,
      },
      { data: [{ ...usage, final: "false" }], next_cursor: null },
      { data: [{ ...usage, database_id: "zbcdefghijklmnopqrst" }], next_cursor: null },
      { data: [{ ...usage, project_id: foreignProject }], next_cursor: null },
      {
        data: [{ ...usage, start: "2026-10-26T00:30:00.000Z", end: "2026-10-26T01:30:00.000Z" }],
        next_cursor: null,
      },
      {
        data: [{ ...usage, start: "2026-10-26T02:00:00.000Z", end: "2026-10-26T03:00:00.000Z" }],
        next_cursor: null,
      },
      {
        data: [{ ...usage, start: "2026-10-25T23:00:00.000Z", end: "2026-10-26T00:00:00.000Z" }],
        next_cursor: null,
      },
      { data: [usage], next_cursor: 5 },
    ])
      await expect(rows(body)).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() => Response.json({ data: [], next_cursor: null })).readExecutionUsage({
        scope: { projectId },
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-11-01T00:00:00.000Z",
        granularity: "day",
        limit: 100,
        cursor: "x".repeat(128),
      }),
    ).resolves.toEqual({ rows: [], nextCursor: null });
    await expect(
      provider(() => Response.json({ data: [usage, usage], next_cursor: null })).readExecutionUsage(
        {
          ...span,
          limit: 1,
          scope: { databaseId },
        },
      ),
    ).rejects.toMatchObject({ code: "contract" });
    await expect(
      provider(() => Response.json({ data: [usage], next_cursor: null })).readExecutionUsage({
        ...span,
        granularity: "day",
        to: "2026-10-27T00:00:00.000Z",
        scope: { databaseId },
      }),
    ).rejects.toMatchObject({ code: "contract" });
  });
});

describe("data event subscriptions and deliveries", () => {
  it("sends data.* and data.<topic> subscriptions unchanged and refuses malformed ones before any request", async () => {
    const seen: unknown[] = [];
    const client = provider((_url, init) => {
      seen.push(JSON.parse(String(init.body)));
      return Response.json(
        { ...webhook, event_types: ["data.*", "data.orders2"], secret: WEBHOOK_SECRET },
        { status: 201 },
      );
    });
    await client.createWebhook(
      { ...webhookInput, eventTypes: ["data.*", "data.orders2"] },
      { key: "omh-wh-key" },
    );
    expect(seen).toEqual([expect.objectContaining({ event_types: ["data.*", "data.orders2"] })]);
    const refused = unreachable();
    for (const eventType of [
      "data.Orders",
      "data.1x",
      "data.",
      "data.a-b",
      "database2.ready",
      "data.*.x",
    ])
      await expect(
        refused.createWebhook({ ...webhookInput, eventTypes: [eventType] }, { key: "omh-wh-key" }),
      ).rejects.toMatchObject({ code: "input" });
  });

  it("reads data deliveries with their data event type and PGCF data event id", async () => {
    const dataDelivery = {
      ...delivery,
      event_type: "data.orders",
      event_id: "aaaaaaaaaaaaaaaaaaaa:3:17",
    };
    await expect(
      provider(() =>
        Response.json({ data: [dataDelivery], next_cursor: null }),
      ).listWebhookDeliveries(databaseId, { limit: 5 }),
    ).resolves.toMatchObject({
      items: [{ eventType: "data.orders", eventId: "aaaaaaaaaaaaaaaaaaaa:3:17" }],
    });
    for (const override of [
      { event_type: "data.Orders" },
      { event_type: "data.*" },
      { event_id: "aaaaaaaaaaaaaaaaaaaa:03:17" },
    ]) {
      await expect(
        provider(() =>
          Response.json({ data: [{ ...dataDelivery, ...override }], next_cursor: null }),
        ).listWebhookDeliveries(databaseId, { limit: 5 }),
      ).rejects.toMatchObject({ code: "contract" });
    }
  });
});
