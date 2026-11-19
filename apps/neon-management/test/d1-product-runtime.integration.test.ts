import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pgcfFixture, id, databaseId } from "./pgcf-runtime-fixture.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { managementWorkerFixture } from "./support/d1-management-worker.js";
import { MANAGEMENT_CLAIM } from "./support/d1-pgcf-scope.js";

it("issues and revokes a real native login and executes one SQL write through actual management/Core RPC with no Control SQL constructor", async () => {
  const provider = await pgcfFixture(false),
    worker = await managementWorkerFixture(provider);
  try {
    expect(await worker.call("placeProject", MANAGEMENT_CLAIM)).toMatchObject({
      ok: true,
      result: { status: "ready" },
    });
    const sql = "CREATE TABLE public.product_rows(id integer PRIMARY KEY,value text NOT NULL);",
      body = new TextEncoder().encode(sql);
    expect(
      await worker.call("migrateProject", {
        ...MANAGEMENT_CLAIM,
        migrations: [
          {
            path: "20261029000000_product.sql",
            body: Array.from(body),
            size: body.byteLength,
            digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          },
        ],
        auth: { provider: "none" },
      }),
    ).toMatchObject({ ok: true, result: { status: "ready" } });
    await worker.core
      .prepare(
        "UPDATE database_provider_target_heads SET activated_at='2026-10-28T10:00:00.000000Z',updated_at='2026-10-28T10:00:00.000000Z' WHERE project_id=?",
      )
      .bind(id(2))
      .run();
    const scope = { organizationId: id(1), projectId: id(2) },
      issued = await worker.call("issueDatabaseAccess", {
        ...scope,
        principalId: "user:fixture",
        requestId: "access",
        environment: "dev",
        mode: "read",
        ttlSeconds: 300,
        label: "native caller",
      });
    expect(issued).toMatchObject({
      ok: true,
      result: { provider: "pgcf", state: "active", mode: "read" },
    });
    const credential = issued.result as { access_id: string; role_name: string };
    expect(await worker.call("maintainDatabaseProducts")).toMatchObject({
      ok: true,
      result: { expiredWrites: 0, access: { expired: 0, budget: 0, dropped: 0, failed: 0 } },
    });
    expect(
      await worker.call("revokeDataChangeAccess", {
        ...scope,
        environmentId: id(4),
        operationId: id(19),
        claimId: id(18),
        losingEnvironmentId: id(5),
      }),
    ).toMatchObject({ ok: false });
    expect(
      (
        await provider.control.pool.query(
          "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname=$1",
          [credential.role_name],
        )
      ).rows,
    ).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolconnlimit: 5,
      },
    ]);
    const revoked = await worker.call("revokeDatabaseAccess", {
      ...scope,
      principalId: "user:fixture",
      accessId: credential.access_id,
    });
    expect(revoked, JSON.stringify(revoked)).toMatchObject({
      ok: true,
      result: { state: "revoked", revocation_reason: "principal" },
    });
    expect(
      (
        await provider.control.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
          credential.role_name,
        ])
      ).rowCount,
    ).toBe(0);
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
    const first = await worker.call("writeProject", write);
    expect(first).toMatchObject({
      ok: true,
      result: { state: "succeeded", command: "INSERT", affected_rows: 1 },
    });
    expect(await worker.call("writeProject", write)).toEqual(first);
    expect(
      await worker.call("writeProject", { ...write, canonicalRequestSha256: "dd".repeat(32) }),
    ).toMatchObject({ ok: true, result: { status: "rejected", code: "idempotency" } });
    const role = `ohmyho_rw_${id(4).toLowerCase()}`,
      handle = await provider.provider.readConnection(databaseId, role);
    const rows = await handle.consume(async (uri) => {
      const connection = await provider.connect(uri, {
        provider: "pgcf",
        host: handle.host,
        databaseId,
        role,
      });
      try {
        return (await connection.client.query("SELECT * FROM public.product_rows")).rows;
      } finally {
        await connection.close();
      }
    });
    expect(rows).toEqual([{ id: 1, value: "one" }]);
    expect(worker.queries.filter((query) => query === write.statement)).toHaveLength(1);
    expect(await worker.call("pool")).toEqual({ ok: true, result: 0 });
    expect((await worker.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 120000);

it("serves the original public database routes and scheduled compute through actual API/management/Core bindings with exact authorization and disjoint authorities", async () => {
  const provider = await pgcfFixture(false),
    worker = await managementWorkerFixture(provider, { publicApi: true });
  try {
    if (!worker.api) throw new Error("Missing API fixture");
    const api = worker.api;
    expect(await worker.call("placeProject", MANAGEMENT_CLAIM)).toMatchObject({
      ok: true,
      result: { status: "ready" },
    });
    const sql = "CREATE TABLE public.api_product_rows(id integer PRIMARY KEY,value text NOT NULL);",
      body = new TextEncoder().encode(sql);
    expect(
      await worker.call("migrateProject", {
        ...MANAGEMENT_CLAIM,
        migrations: [
          {
            path: "20261029000000_api_product.sql",
            body: Array.from(body),
            size: body.byteLength,
            digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          },
        ],
        auth: { provider: "none" },
      }),
    ).toMatchObject({ ok: true, result: { status: "ready" } });
    await worker.core
      .prepare(
        "UPDATE database_provider_target_heads SET activated_at='2026-10-28T10:00:00.000000Z',updated_at='2026-10-28T10:00:00.000000Z' WHERE project_id=?",
      )
      .bind(id(2))
      .run();
    const headers = {
        authorization: "Bearer sk_aaaaaaaaaaaaaaaaaaaaaaaa",
        "content-type": "application/json",
        "idempotency-key": "product-api",
      },
      base = `https://dev.app.ohmyho.st/v1/projects/${id(2)}/database/`;
    const send = (path: string, value?: unknown, extra: Record<string, string> = {}) =>
      api.fetch(base + path, {
        method: value === undefined ? "GET" : "POST",
        headers: { ...headers, ...extra },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    const issue = await send("access", {
      environment: "dev",
      mode: "read",
      ttl_seconds: 300,
      label: "public native",
    });
    const credential = (await issue.json()) as { access_id: string; connection_uri: string };
    expect(
      issue.status,
      JSON.stringify({
        access: (
          await worker.core.prepare("SELECT revocation_reason FROM project_database_access").all()
        ).results,
        errors: worker.appErrors,
        stats: provider.stats,
      }),
    ).toBe(201);
    expect(typeof credential.connection_uri).toBe("string");
    const history = await send("access");
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [{ access_id: credential.access_id, state: "active" }],
    });
    expect(
      (await api.fetch(base + "access/" + credential.access_id, { method: "DELETE", headers }))
        .status,
    ).toBe(200);
    const write = {
      environment: "dev",
      statement: "INSERT INTO public.api_product_rows(id,value) VALUES($1,$2)",
      parameters: [1, "once"],
    };
    const accepted = await send("write", write);
    expect(accepted.status).toBe(200);
    const written = (await accepted.json()) as { operation_id: string };
    expect((await send("write", write)).status).toBe(200);
    expect(
      (
        await send("query", {
          environment: "dev",
          statement: "SELECT * FROM public.api_product_rows",
          parameters: [],
        })
      ).status,
    ).toBe(200);
    const operation = await api.fetch(
      "https://dev.app.ohmyho.st/v1/operations/" + written.operation_id,
      { headers },
    );
    expect(operation.status).toBe(200);
    const member = { authorization: "Bearer sk_bbbbbbbbbbbbbbbbbbbbbbbb" };
    expect((await send("access", undefined, member)).status).toBe(200);
    expect((await send("write", write, member)).status).toBe(404);
    expect(
      (
        await api.fetch(`https://dev.app.ohmyho.st/v1/projects/${id(99)}/database/access`, {
          headers,
        })
      ).status,
    ).toBe(404);
    await makePaid(worker.core, id(1), "2099-01-01T00:00:00.000Z", new Date().toISOString());
    const compute = await send(
      "compute",
      { environment: "dev", memory_mib: 512, confirm: true },
      { "idempotency-key": "public-compute" },
    );
    const computeBody = await compute.json();
    expect(compute.status, JSON.stringify(computeBody)).toBe(202);
    const scheduled = await api.fetch("https://dev.app.ohmyho.st/fixture/scheduled", { headers });
    const progress = await scheduled.json();
    expect(progress).toMatchObject({ databaseProducts: { compute: { observed: 1, failed: 0 } } });
    const observed = await send("compute");
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ database: { memory_mib: 512 } });
    expect(provider.stats.resizes).toBe(1);
    expect((await send("access", undefined, { "x-fixture-mode": "missing" })).status).toBe(503);
    expect(worker.queries.filter((query) => query === write.statement)).toHaveLength(1);
  } finally {
    await worker.dispose();
    await provider.control.stop();
  }
}, 120000);
