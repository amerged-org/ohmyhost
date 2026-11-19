import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { endPaid, makePaid } from "../../control-store/test/support/credit-fixtures.js";
import {
  CORE_DATABASE_ID,
  MANAGEMENT_CLAIM,
  MANAGEMENT_SCOPE,
  seedManagementScope,
} from "./support/d1-pgcf-scope.js";
import { databaseId, id, pgcfFixture } from "./pgcf-runtime-fixture.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; entrypoints, Core commands and D1 are the production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

const scope = { organizationId: id(1), projectId: id(2) };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

it("runs database access, SQL writes and queries, compute changes and the maintenance sweep through the actual Worker classes on real D1 and PostgreSQL", async () => {
  const control = await createTestControl(),
    provider = await pgcfFixture(false);
  const entry = await import("../../control-store/src/worker-main.js"),
    worker = await import("../src/worker-main.js");
  vi.spyOn(globalThis, "fetch").mockImplementation(provider.providerFetch);
  const coreBindings = {
    CONTROL_CORE: control.core,
    CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
    CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
  };
  host.env = coreBindings;
  // A temporary role's login can be made to fail once, so the issue path has to take its role back.
  let failTemporaryLogin = false;
  // Runs once, right after the owner connection of a read credential has revoked TEMPORARY inside its transaction.
  let afterOwnerRevoke: (() => Promise<void>) | undefined;
  const connect: typeof provider.connect = async (uri, target) => {
    if (failTemporaryLogin && target.role.startsWith("ohmyho_da_")) {
      failTemporaryLogin = false;
      throw new Error("temporary role login refused");
    }
    const connection = await provider.connect(uri, target);
    if (target.role !== "app" || afterOwnerRevoke === undefined) return connection;
    return {
      close: connection.close,
      client: {
        query: (async (...args: Parameters<typeof connection.client.query>) => {
          const result = await connection.client.query(...args);
          if (typeof args[0] === "string" && args[0].startsWith("REVOKE TEMPORARY")) {
            const hook = afterOwnerRevoke;
            afterOwnerRevoke = undefined;
            await hook?.();
          }
          return result;
        }) as typeof connection.client.query,
      },
    };
  };
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    DATABASE_MANAGEMENT_RUNTIME: new entry.DatabaseManagementRuntime({}, coreBindings),
    DATABASE_PRODUCT_RUNTIME: new entry.DatabaseProductRuntime({}, coreBindings),
    PROJECT_DATABASE_ADMIN_US: provider.admin("us"),
    PROJECT_DATABASE_ADMIN_EU: provider.admin("eu"),
    PGCF_API_URL: "https://pgcf-api.aixyte.com",
    PGCF_APPS_PROJECT_ID: provider.provider.projectId,
    PGCF_APPS_API_KEY: "test-only-integrator-key",
  };
  host.env = bindings;
  // The same PostgreSQL client also serves product SQL, whose result type carries the command tag.
  type ProductConnect = NonNullable<ConstructorParameters<typeof worker.NeonManagementService>[3]>;
  let failClose = false,
    failRollback = false;
  const productConnect: ProductConnect = async (uri, target) => {
    const connection = (await provider.connect(uri, target)) as unknown as Awaited<
      ReturnType<ProductConnect>
    >;
    return {
      client: {
        query: ((query: unknown) =>
          failRollback && query === "ROLLBACK"
            ? Promise.reject(new Error("rollback lost"))
            : connection.client.query(query as never)) as typeof connection.client.query,
      },
      close: async () => {
        await connection.close();
        if (failClose) throw new Error("connection disposal failed");
      },
    };
  };
  // The pause of a deployment's owner grants before their one retry is recorded and can release a held lock.
  let duringPause: (() => Promise<void>) | undefined;
  const sleep = async (ms: number) => {
    await provider.sleep(ms);
    await duringPause?.();
  };
  const service = new worker.NeonManagementService({}, bindings, connect, productConnect, sleep);
  try {
    await seedManagementScope(control.core);
    expect(await service.placeProject(MANAGEMENT_CLAIM)).toMatchObject({ status: "ready" });
    const sql = "CREATE TABLE public.product_rows(id integer PRIMARY KEY,value text NOT NULL);",
      body = new TextEncoder().encode(sql);
    const migration = {
      ...MANAGEMENT_CLAIM,
      migrations: [
        {
          path: "20261029000000_product.sql",
          body,
          size: body.byteLength,
          digest: `sha256:${digest(sql)}`,
        },
      ],
      auth: { provider: "none" },
    };
    await service.migrateProject(migration);
    await control.core
      .prepare(
        "UPDATE database_provider_target_heads SET activated_at='2026-10-28T10:00:00.000000Z',updated_at='2026-10-28T10:00:00.000000Z' WHERE project_id=?",
      )
      .bind(id(2))
      .run();

    // Access: issue, a login refusal that takes the role back, the maintenance sweep and revocation.
    const request = {
      ...scope,
      principalId: "user:fixture",
      requestId: "access",
      environment: "dev",
      mode: "read",
      ttlSeconds: 300,
      label: "native caller",
    };
    const issued = (await service.issueDatabaseAccess(request)) as {
      access_id: string;
      role_name: string;
    };
    expect(issued).toMatchObject({ provider: "pgcf", state: "active", mode: "read" });
    await expect(
      service.issueDatabaseAccess({ ...request, label: undefined, extra: 1 }),
    ).rejects.toThrow("Invalid database product request");
    await expect(service.issueDatabaseAccess({ ...request, requestId: "" })).rejects.toThrow(
      "Invalid database access request",
    );
    failTemporaryLogin = true;
    const issueLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await service.issueDatabaseAccess({ ...request, requestId: "refused" })).toEqual({
      status: "rejected",
      code: "unavailable",
    });
    // Before PGCF has hardened a database PUBLIC still persists large objects and WAL messages: the migration's grants stay harmless,
    // the read credential is refused with its role taken back, and the write credential is unaffected.
    const credentialRoles = async () =>
      (
        await provider.control.pool.query(
          "SELECT rolname FROM pg_roles WHERE rolname LIKE 'ohmyho_da_%' ORDER BY rolname",
        )
      ).rows;
    const rolesBefore = await credentialRoles();
    await provider.baseline(false);
    await service.migrateProject(migration);
    expect(await service.issueDatabaseAccess({ ...request, requestId: "unhardened" })).toEqual({
      status: "rejected",
      code: "unavailable",
    });
    const unhardenedWrite = (await service.issueDatabaseAccess({
      ...request,
      mode: "write",
      requestId: "unhardened-write",
    })) as { access_id: string };
    expect(unhardenedWrite).toMatchObject({ mode: "write", state: "active" });
    await service.revokeDatabaseAccess({
      ...scope,
      principalId: "user:fixture",
      accessId: unhardenedWrite.access_id,
    });
    // A migration holds the migrations lock while TEMPORARY is open: the owner grants of a read credential cannot run
    // and the refused credential says so in the log. A deployment's owner grants wait for the same lock, retry once
    // after a pause, and park the deployment only when the lock is still held: then nothing is applied.
    const owner = await provider.native("app");
    await owner.query(`GRANT TEMPORARY ON DATABASE ${databaseId} TO PUBLIC`);
    const holder = await owner.connect();
    const unlock = async () => {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended('ohmyhost:migrations', 0))");
    };
    const publicTemporary = async () =>
      (
        await provider.control.pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname=$1 AND a.grantee=0 AND a.privilege_type='TEMPORARY') AS open",
          [databaseId],
        )
      ).rows[0].open;
    await holder.query("SELECT pg_advisory_lock(hashtextextended('ohmyhost:migrations', 0))");
    try {
      expect(await service.issueDatabaseAccess({ ...request, requestId: "busy" })).toEqual({
        status: "rejected",
        code: "unavailable",
      });
      // Held through both attempts: the deployment is reconciled and nothing was applied.
      expect(await service.migrateProject(migration)).toEqual({
        status: "reconciliation_required",
        reason: "owner_grants_busy",
      });
      expect(await publicTemporary()).toBe(true);
      // Released during the pause: the retry completes the migration.
      duringPause = unlock;
      expect(await service.migrateProject(migration)).toMatchObject({ status: "ready" });
      duringPause = undefined;
      expect(await publicTemporary()).toBe(false);
      expect(provider.sleeps.filter((ms) => ms === 10_000)).toHaveLength(2);
    } finally {
      duringPause = undefined;
      await unlock();
      holder.release();
    }
    expect(await credentialRoles()).toEqual(rolesBefore);
    // The log tells a refused read proof from an outage by fixed codes alone, and a missing PGCF baseline
    // (`grants` in place) from owner grants that could not run (`busy`).
    expect(issueLog.mock.calls.map(([line]) => String(line))).toEqual([
      JSON.stringify({
        event: "database_access_issue_failed",
        mode: "read",
        proof: null,
        grants: null,
      }),
      JSON.stringify({
        event: "database_access_issue_failed",
        mode: "read",
        proof: ["persisting_function"],
        grants: "current",
      }),
      JSON.stringify({
        event: "database_access_issue_failed",
        mode: "read",
        proof: ["database_privilege", "persisting_function"],
        grants: "busy",
      }),
    ]);
    issueLog.mockRestore();
    await provider.baseline(true);
    await service.migrateProject(migration);
    // A deploy's owner grants and a read credential's write the same catalog rows and must not overlap: the credential's
    // grants stop after their first statement, a deploy starts its own, and PostgreSQL shows it waiting on a lock.
    await owner.query(`GRANT TEMPORARY ON DATABASE ${databaseId} TO PUBLIC`);
    const waiting = async () =>
      Number(
        (
          await provider.control.pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            [databaseId],
          )
        ).rows[0].n,
      );
    let overlap: Promise<{ value: unknown } | { error: unknown }> | undefined;
    afterOwnerRevoke = async () => {
      overlap = service.migrateProject(migration).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      for (let tries = 0; tries < 400 && (await waiting()) === 0; tries++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await waiting()).toBeGreaterThan(0);
    };
    const racing = (await service.issueDatabaseAccess({ ...request, requestId: "racing" })) as {
      access_id: string;
    };
    expect(racing).toMatchObject({ mode: "read", state: "active" });
    expect(await overlap).toMatchObject({ value: { status: "ready" } });
    await service.revokeDatabaseAccess({
      ...scope,
      principalId: "user:fixture",
      accessId: racing.access_id,
    });
    await owner.end();
    expect(
      await service.revokeDatabaseAccess({
        ...scope,
        principalId: "user:fixture",
        accessId: id(99),
      }),
    ).toEqual({ status: "rejected", code: "not_found" });
    expect(await service.maintainDatabaseProducts()).toMatchObject({
      expiredWrites: 0,
      access: { expired: 0, budget: 0, dropped: 0, failed: 0 },
    });
    // A sweep after the lifetime revokes the expired role through the same provider path.
    expect(
      await worker.maintainProductionD1DatabaseProducts(
        bindings,
        new Date(Date.now() + 3_600_000),
        connect,
      ),
    ).toMatchObject({ access: { expired: 1, failed: 0 } });
    expect(
      await service.revokeDatabaseAccess({
        ...scope,
        principalId: "user:fixture",
        accessId: issued.access_id,
      }),
    ).toMatchObject({ state: "revoked" });
    const second = (await service.issueDatabaseAccess({ ...request, requestId: "again" })) as {
      access_id: string;
    };
    expect(
      await service.revokeDatabaseAccess({
        ...scope,
        principalId: "user:fixture",
        accessId: second.access_id,
      }),
    ).toMatchObject({ state: "revoked", revocation_reason: "principal" });
    await expect(
      service.revokeDataChangeAccess({
        ...scope,
        environmentId: id(4),
        operationId: id(19),
        claimId: id(18),
        losingEnvironmentId: id(5),
      }),
    ).rejects.toThrow();

    // Writes: accepted once, replayed byte for byte, refused under a changed digest, SQL failures kept as outcomes.
    const write = {
      ...scope,
      environment: "dev",
      principalId: "user:fixture",
      requestId: "write",
      idempotencyKey: "one-write",
      canonicalRequestSha256: "cc".repeat(32),
      statement: "INSERT INTO public.product_rows(id,value) VALUES($1,$2)",
      parameters: [1, "one"],
    };
    await control.core
      .prepare(
        "UPDATE pgcf_database_entitlement_policies SET suspended_by_entitlement=1,suspension_operation_id=?5,suspension_generation=1 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND database_id=?4",
      )
      .bind(scope.organizationId, scope.projectId, id(4), databaseId, "op_" + "c".repeat(20))
      .run();
    const sqlConnectionsBeforeRefusal = provider.stats.sqlConnections;
    const requestsBeforeRefusal = provider.requests.length;
    expect(await service.writeProject(write)).toEqual({
      status: "rejected",
      code: "paid_plan_required",
    });
    expect(provider.stats.sqlConnections).toBe(sqlConnectionsBeforeRefusal);
    expect(provider.requests).toHaveLength(requestsBeforeRefusal);
    await control.core
      .prepare(
        "UPDATE pgcf_database_entitlement_policies SET suspended_by_entitlement=0,suspension_operation_id=NULL,suspension_generation=NULL WHERE organization_id=? AND project_id=? AND physical_environment_id=? AND database_id=?",
      )
      .bind(scope.organizationId, scope.projectId, id(4), databaseId)
      .run();
    const first = await service.writeProject(write);
    expect(first).toMatchObject({ state: "succeeded", command: "INSERT", affected_rows: 1 });
    expect(await service.writeProject(write)).toEqual(first);
    expect(
      await service.writeProject({ ...write, canonicalRequestSha256: "dd".repeat(32) }),
    ).toMatchObject({ status: "rejected", code: "idempotency" });
    expect(
      await service.writeProject({ ...write, idempotencyKey: "duplicate", requestId: "dup" }),
    ).toMatchObject({ state: "failed" });
    // A confirmed COMMIT stays confirmed when the connection cannot be disposed afterwards.
    failClose = true;
    expect(
      await service.writeProject({
        ...write,
        idempotencyKey: "close",
        requestId: "close",
        parameters: [2, "two"],
      }),
    ).toMatchObject({ state: "succeeded", command: "INSERT", affected_rows: 1 });
    failClose = false;
    expect(
      await service.queryProject({
        ...scope,
        environment: "dev",
        statement: "SELECT id,value FROM public.product_rows WHERE id = $1",
        parameters: [1],
      }),
    ).toMatchObject({ rows: [{ id: 1, value: "one" }] });
    await expect(
      service.queryProject({
        ...scope,
        environment: "dev",
        statement: "DELETE FROM x",
        parameters: [],
      }),
    ).rejects.toThrow("Project database diagnostic query is invalid");
    // A failed diagnostic is a rejection even when the rollback after it is lost with the connection.
    failRollback = true;
    expect(
      await service.queryProject({
        ...scope,
        environment: "dev",
        statement: "SELECT 1/0",
        parameters: [],
      }),
    ).toEqual({ status: "rejected" });
    failRollback = false;

    expect(await service.readRuntimeBinding(MANAGEMENT_SCOPE)).toMatchObject({ status: "ready" });
    // Compute: the observed shape, the invalid request, a Free project refused and a Paid one resized.
    const compute = { ...scope, environment: "dev" as const };
    expect(await service.readCompute(compute)).toMatchObject({
      project_id: id(2),
      database: { provider: "pgcf" },
    });
    await expect(service.readCompute({ ...compute, environment: "staging" })).rejects.toThrow(
      "Invalid compute request",
    );
    await expect(service.readCompute([])).rejects.toThrow("Invalid compute request");
    await makePaid(control.core, id(1), "2099-01-01T00:00:00.000Z", new Date().toISOString());
    const change = async (memoryMiB: number, key: string) =>
      (await service.changeCompute({
        ...compute,
        memoryMiB,
        principalId: "user:fixture",
        requestId: key,
        idempotencyKey: key,
        canonicalRequestSha256: digest(key),
      })) as { status: string; operationId: string };
    const accepted = await change(512, "compute-key");
    expect(accepted.status).toBe("accepted");
    expect(await service.runComputeChange({ ...scope, operationId: accepted.operationId })).toEqual(
      { status: "succeeded" },
    );
    expect(provider.stats.resizes).toBe(1);
    expect(await service.readCompute(compute)).toMatchObject({ database: { memory_mib: 512 } });
    // A Paid project that lapses before the provider was asked is not resized: the plan changed.
    const lapsed = await change(1024, "lapsed-key");
    await endPaid(control.core, id(1), new Date().toISOString());
    expect(await service.runComputeChange({ ...scope, operationId: lapsed.operationId })).toEqual({
      status: "failed",
    });
    expect(provider.stats.resizes).toBe(1);

    // Scheduled: entitlement reconciliation and the sweep; usage is read on demand through collectUsage only.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scheduler = new worker.default({} as never, bindings);
    await expect(scheduler.scheduled({ scheduledTime: Date.now() })).resolves.toBeUndefined();
    expect(log.mock.calls.some(([line]) => String(line).includes("database_access_sweep"))).toBe(
      true,
    );
    expect(
      log.mock.calls.some(([line]) => String(line).includes("database_webhook_orphan_sweep")),
    ).toBe(true);
    await expect(scheduler.fetch()).resolves.toMatchObject({ status: 404 });
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(databaseId).toHaveLength(20);
  } finally {
    vi.restoreAllMocks();
    await control.dispose();
    await provider.control.stop();
  }
}, 240000);
