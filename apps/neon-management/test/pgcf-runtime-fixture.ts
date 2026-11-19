import { expect } from "vitest";
import { Pool, type PoolClient } from "pg";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { createDatabaseRegistry } from "../../project-database-runtime/src/registry.js";
import { createPgcfManagement } from "../src/pgcf-runtime.js";
import { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { databaseSizeForClass } from "@ohmyhost/contracts/database-sizes";
import type { ProjectDatabaseRegistrationMetadata } from "@ohmyhost/database";
import { parseUlid, projectSqlRoleName, type DatabaseMigrationClient } from "@ohmyhost/platform";
import { applyPgcfBaseline, undoPgcfBaseline } from "./support/pgcf-baseline.js";
export const id = (n: number) => parseUlid(String(n).padStart(26, "0"));
export const databaseId = "abcdefghijklmnopqrst",
  projectId = "prj_abcdefghijklmnopqrst",
  providerOperationId = "op_abcdefghijklmnopqrst",
  deleteOperationId = "op_bbcdefghijklmnopqrst";
/** Plain BEGIN/COMMIT around the seed rows. */
async function inTransaction(pool: Pool, work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await work(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function pgcfFixture(legacy = true, sourceRegion: "us" | "eu" = "us") {
  const control = await startTestPostgres();
  const source: ProjectDatabaseRegistrationMetadata = {
    organizationId: id(1),
    projectId: id(2),
    physicalEnvironmentId: id(4),
    operationId: id(10),
    registrationVersion: 1,
    region: sourceRegion,
    providerProjectId: "source-neon",
    branchId: "br-source",
    originHost:
      sourceRegion === "us"
        ? "ep-source-pooler.us-east-1.aws.neon.tech"
        : "ep-source-pooler.eu-central-1.aws.neon.tech",
    originDatabase: "neondb",
    originUser: projectSqlRoleName(id(4), "runtime"),
    authorizedEnvironmentIds: [id(4), id(5)],
    status: "active",
  };
  await inTransaction(control.pool, async (c) => {
    await c.query(
      `INSERT INTO projects(project_id,created_organization_id,name,handle,handle_version,handle_attempt,created_event_id,created_at,data_mode,region) VALUES($1,$2,'Cutover','calm-otter-imports','human-id-4.2.0-sha256-project-handle-words-v1',0,$3,'2026-09-01','shared',$4)`,
      [id(2), id(1), id(9), sourceRegion],
    );
    await c.query(
      `INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES($1,$2,$3,'2026-09-01','user:owner')`,
      [id(3), id(2), id(1)],
    );
    await c.query(
      `INSERT INTO project_ownerships(project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at) VALUES($1,$2,'active',1,$3,'2026-09-01')`,
      [id(2), id(1), id(3)],
    );
    await c.query(
      `INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,created_at,updated_at) VALUES($1,$2,$3,'dev','{}','2026-09-01','2026-09-01'),($1,$2,$4,'prod','{}','2026-09-01','2026-09-01')`,
      [id(1), id(2), id(4), id(5)],
    );
    await c.query(
      `INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES($1,$2,$3,'succeeded','2026-09-01','2026-09-01',$4)`,
      [id(1), id(10), id(2), id(3)],
    );
    if (legacy) {
      await c.query(
        `INSERT INTO neon_project_placement_receipts(organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,provider_project_id,default_branch_id,operation_ids,state,observed_at) VALUES($1,$2,$3,$4,$5,'ohmyho-'||$2::ulid::text,'${sourceRegion === "us" ? "aws-us-east-1" : "aws-eu-central-1"}',17,'source-neon','br-source','{}','ready','2026-09-01')`,
        [id(1), id(2), id(4), id(10), id(11)],
      );
      await c.query(
        `INSERT INTO project_database_registration_receipts(organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,status,metadata,observed_at) VALUES($1,$2,$3,$4,$5,1,'active',$6::jsonb,'2026-09-01')`,
        [id(1), id(2), id(4), id(10), id(11), JSON.stringify(source)],
      );
    }
  });
  const request = { operationId: id(20), manifestSha256: "ab".repeat(32) };
  if (legacy) {
    // The operator's cutover authorization with its running operation, as plain rows.
    const approvedAt = new Date().toISOString();
    await inTransaction(control.pool, async (c) => {
      await c.query(
        `INSERT INTO operations(organization_id,operation_id,project_id,state,created_at,updated_at,billing_epoch_id) VALUES($1,$2,$3,'running',$4,$4,$5)`,
        [id(1), request.operationId, id(2), approvedAt, id(3)],
      );
      await c.query(
        `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES($1,$2,$3,$4,0,'OperationQueued',NULL,'{}',$6),($1,$5,$3,$4,1,'OperationStarted','provider-cutover:start','{}',$6)`,
        [id(1), id(21), request.operationId, id(2), id(22), approvedAt],
      );
      await c.query(
        `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES($1,$2,$3,$4,'DatabaseProviderCutoverAuthorized','principal','operator:fixture',jsonb_build_object('manifestSha256',$5::text),$6,$7)`,
        [id(1), id(23), id(2), request.operationId, request.manifestSha256, approvedAt, id(3)],
      );
      await c.query(
        `INSERT INTO database_provider_cutover_authorizations(operation_id,organization_id,project_id,physical_environment_id,manifest_sha256,expected_lifecycle_version,source_target_version,source_registration,target_provider_project_id,target_region_id,target_size_class_id,approved_at,approved_by) VALUES($1,$2,$3,$4,$5,1,1,$6::jsonb,$7,'us-dev','r512-s1g',$8,'operator:fixture')`,
        [
          request.operationId,
          id(1),
          id(2),
          id(4),
          Buffer.from(request.manifestSha256, "hex"),
          JSON.stringify(source),
          projectId,
          approvedAt,
        ],
      );
    });
  }
  const stats = {
    creates: 0,
    roleCreates: 0,
    resizes: 0,
    invalidations: 0,
    deletes: 0,
    sqlConnections: 0,
    wakes: 0,
  };
  const makeRegistry = (region: "us" | "eu") => {
    let stored: unknown;
    return createDatabaseRegistry({
      region,
      keyRing: { current: { keyVersion: 1, keyBase64: btoa("k".repeat(32)) } },
      storage: {
        async get<T>() {
          return stored as T | undefined;
        },
        async put(_key: string, value: unknown) {
          stored = structuredClone(value);
        },
      },
      invalidate: async () => {
        stats.invalidations++;
      },
    });
  };
  const registries = { us: makeRegistry("us"), eu: makeRegistry("eu") },
    registry = registries.us;
  const { status: _sourceStatus, ...sourceInput } = source;
  void _sourceStatus;
  if (legacy) {
    await registries[sourceRegion].register({
      ...sourceInput,
      pooledConnectionString: `postgresql://${source.originUser}:source-test-password@${source.originHost}/neondb?sslmode=require`,
    });
  }
  const native = async (role: string) => {
    const uri = new URL(String(control.pool.options.connectionString));
    uri.pathname = `/${databaseId}`;
    uri.username = role;
    uri.password = "target-test-password";
    uri.search = "";
    return new Pool({ connectionString: uri.toString(), max: 1 });
  };
  /** The PGCF baseline on the database, or PUBLIC holding the persisting functions again as before it. */
  const baseline = (hardened: boolean) => {
    const superuser = String(control.pool.options.connectionString);
    return hardened
      ? applyPgcfBaseline(superuser, databaseId, "app")
      : undoPgcfBaseline(superuser, databaseId, "app");
  };
  const roles = new Map<string, Record<string, unknown>>();
  /** The webhooks PGCF stores for the whole project, in creation order; a listing pages through them by offset. */
  const webhooks: Record<string, unknown>[] = [];
  const requestedOrigins = new Set<string>();
  const requests: { method: string; path: string; key: string | null }[] = [];
  const state = {
    regionId: "us-dev",
    sizeClassId: "r512-s1g",
    name: `ohmyho-${id(2).toLowerCase()}-${id(4).toLowerCase()}`,
    desiredState: "running",
    suspensionReason: null as "manual" | "idle" | null,
    observedState: "ready",
    generation: 1,
    observedGeneration: 1,
    createStatus: "succeeded",
    createReads: 0,
    createSucceedsAfterReads: null as number | null,
    deleteStatus: "pending",
    /** Operation GET reads, counted from the first read; null leaves the status as set. */
    deleteReads: 0,
    deleteSucceedsAfterReads: null as number | null,
    deleteFailsAfterReads: null as number | null,
    databaseHttpStatus: 200,
    /** The statuses PGCF answers the next webhook deletions with, then 204. 204 and 404 remove the webhook (404: gone already). */
    webhookDeleteStatuses: [] as number[],
    loseCreateResponse: false,
    loseDeleteResponse: false,
    rejectRoleLogin: "",
    loseRoleResponseName: "",
  };
  const db = () => ({
    id: databaseId,
    project_id: projectId,
    region_id: state.regionId,
    name: state.name,
    size_class_id: state.sizeClassId,
    resources: {
      memory_mib: databaseSizeForClass(state.sizeClassId).memoryMiB,
      cpu_millicores: databaseSizeForClass(state.sizeClassId).cpuMillicores,
      storage_mib: databaseSizeForClass(state.sizeClassId).storageMiB,
    },
    desired_state: state.desiredState,
    suspension_reason: state.suspensionReason,
    observed_state: state.observedState,
    generation: state.generation,
    observed_generation: state.observedGeneration,
    effective_sleep_after_seconds: 60,
  });
  const op = () => ({
    id: providerOperationId,
    project_id: projectId,
    database_id: databaseId,
    generation: 1,
    kind: "database.create",
    status: state.createStatus,
    error: null,
  });
  const resizeReceipts = new Map<string, ReturnType<typeof op>>();
  const lifecycleReceipts = new Map<string, ReturnType<typeof op>>();
  const providerFetch = (async (url: string | URL | Request, init: RequestInit) => {
    const parsed = new URL(String(url));
    requestedOrigins.add(parsed.origin);
    requests.push({
      method: init.method ?? "GET",
      path: parsed.pathname,
      key: new Headers(init.headers).get("Idempotency-Key"),
    });
    if (parsed.pathname === "/v1/databases" && init.method === "POST") {
      const creation = JSON.parse(String(init.body)) as {
        name: string;
        size_class_id: string;
        region_id: string;
      };
      state.name = creation.name;
      state.regionId = creation.region_id;
      state.sizeClassId = creation.size_class_id;
      if (stats.creates === 0) {
        stats.creates++;
        await control.pool.query(
          "CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'target-test-password'",
        );
        await control.pool.query(`CREATE DATABASE ${databaseId} OWNER app`);
        // The PGCF baseline: PUBLIC loses the persisting functions and the owner passes them on.
        await baseline(true);
      }
      if (state.loseCreateResponse) {
        state.loseCreateResponse = false;
        throw new Error("accepted create response lost");
      }
      return Response.json({ database: db(), operation: op() }, { status: 202 });
    }
    if (parsed.pathname === `/v1/databases/${databaseId}` && init.method === "PATCH") {
      const key = new Headers(init.headers).get("Idempotency-Key");
      if (!key) throw new Error("Missing resize identity");
      let operation = resizeReceipts.get(key);
      if (!operation) {
        const input = JSON.parse(String(init.body)) as { size_class_id: string };
        databaseSizeForClass(input.size_class_id);
        state.sizeClassId = input.size_class_id;
        state.observedGeneration = ++state.generation;
        stats.resizes++;
        operation = {
          ...op(),
          id: "op_" + "r".repeat(20),
          kind: "database.resize",
          generation: state.generation,
          status: "succeeded",
        };
        resizeReceipts.set(key, operation);
      }
      return Response.json({ database: db(), operation }, { status: 202 });
    }
    const lifecycle = new RegExp(`^/v1/databases/${databaseId}/(suspend|resume)$`, "u").exec(
      parsed.pathname,
    );
    if (lifecycle && init.method === "POST") {
      const action = lifecycle[1] === "suspend" ? "suspend" : "resume";
      const key = new Headers(init.headers).get("Idempotency-Key");
      if (!key) throw new Error("Missing lifecycle identity");
      let operation = lifecycleReceipts.get(key);
      if (!operation) {
        const input = init.body
          ? (JSON.parse(String(init.body)) as { expected_generation?: number })
          : {};
        if (
          input.expected_generation !== undefined &&
          input.expected_generation !== state.generation
        )
          return Response.json({ error: "generation_changed" }, { status: 409 });
        state.desiredState = action === "suspend" ? "suspended" : "running";
        state.suspensionReason = action === "suspend" ? "manual" : null;
        state.observedState = action === "suspend" ? "hibernated" : "ready";
        state.observedGeneration = ++state.generation;
        operation = {
          ...op(),
          id: "op_" + (action === "suspend" ? "s" : "u").repeat(20),
          kind: `database.${action}`,
          generation: state.generation,
          status: "succeeded",
        };
        lifecycleReceipts.set(key, operation);
      }
      return Response.json({ database: db(), operation }, { status: 202 });
    }
    for (const operation of lifecycleReceipts.values())
      if (parsed.pathname === `/v1/operations/${operation.id}`) return Response.json(operation);
    if (parsed.pathname === `/v1/operations/${"op_" + "r".repeat(20)}`) {
      const operation = [...resizeReceipts.values()][0];
      if (!operation) throw new Error("Missing resize receipt");
      return Response.json(operation);
    }
    if (parsed.pathname.endsWith("/roles") && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        connection_limit: number;
        valid_until?: string;
        bypass_rls: boolean;
        member_of?: string[];
        membership_options?: { inherit: boolean; set: boolean };
      };
      if (
        !/^(?:ohmyho_(?:(?:m|rw|ro|backup)_[0-7][0-9a-hjkmnp-tv-z]{25}|da_[0-7][0-9a-hjkmnp-tv-z]{25}_[a-z0-9]{8})|omh_(?:ar|am|ab)_[0-7][0-9a-hjkmnp-tv-z]{25})$/u.test(
          body.name,
        )
      )
        throw Error("unexpected role");
      stats.roleCreates++;
      await control.pool.query(
        `CREATE ROLE ${body.name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${body.bypass_rls ? "BYPASSRLS" : "NOBYPASSRLS"} CONNECTION LIMIT ${body.connection_limit} PASSWORD 'target-test-password'`,
      );
      if (body.valid_until) {
        const command = await control.pool.query<{ sql: string }>(
          "SELECT format('ALTER ROLE %I VALID UNTIL %L',$1::text,$2::text) sql",
          [
            body.name,
            new Date(Math.floor(Date.parse(body.valid_until) / 1000) * 1000).toISOString(),
          ],
        );
        const sql = command.rows[0]?.sql;
        if (!sql) throw new Error("Missing expiry SQL");
        await control.pool.query(sql);
      }
      for (const member of body.member_of ?? [])
        await control.pool.query(
          `GRANT ${member} TO ${body.name} WITH INHERIT ${body.membership_options?.inherit === false ? "FALSE" : "TRUE"}, SET ${body.membership_options?.set === false ? "FALSE" : "TRUE"}, ADMIN FALSE`,
        );
      const role = {
        database_id: databaseId,
        name: body.name,
        owner: false,
        password_revision: 1,
        valid_until: body.valid_until ?? null,
        connection_limit: body.connection_limit,
        member_of: body.member_of ?? [],
        bypass_rls: body.bypass_rls,
        ...(body.membership_options ? { membership_options: body.membership_options } : {}),
      };
      roles.set(body.name, role);
      if (state.rejectRoleLogin === body.name)
        await control.pool.query(`ALTER ROLE ${body.name} NOLOGIN`);
      if (state.loseRoleResponseName === body.name) {
        state.loseRoleResponseName = "";
        throw new Error("accepted role response lost");
      }
      return Response.json(role, { status: 201 });
    }
    if (
      init.method === "DELETE" &&
      parsed.pathname.startsWith(`/v1/databases/${databaseId}/roles/`)
    ) {
      const role = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
      if (!/^ohmyho_da_[0-7][0-9a-hjkmnp-tv-z]{25}_[a-z0-9]{8}$/u.test(role))
        throw new Error("Unexpected temporary role");
      await control.pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1",
        [role],
      );
      await control.pool.query(`DROP ROLE IF EXISTS ${role}`);
      roles.delete(role);
      return Response.json(
        {
          database: db(),
          operation: { ...op(), kind: "database.role.delete", status: "succeeded" },
        },
        { status: 202 },
      );
    }
    if (parsed.pathname.endsWith("/roles"))
      return Response.json({ data: [...roles.values()], next_cursor: null });
    if (parsed.pathname.endsWith("/connection-uri")) {
      const role = parsed.pathname.split("/").at(-2);
      if (!role || (!roles.has(role) && role !== "app")) throw Error("unknown role");
      return Response.json({
        database_id: databaseId,
        database: databaseId,
        role,
        host: `${databaseId}.db.example.com`,
        uri: `postgres://${role}:target-test-password@${databaseId}.db.example.com/${databaseId}?sslmode=require`,
        includes_password: true,
      });
    }
    if (init.method === "DELETE" && parsed.pathname === `/v1/databases/${databaseId}`) {
      stats.deletes++;
      if (state.desiredState !== "deleted") {
        state.generation++;
      }
      state.desiredState = "deleted";
      if (state.loseDeleteResponse) {
        state.loseDeleteResponse = false;
        throw new Error("accepted deletion response lost");
      }
      return Response.json(
        {
          database: db(),
          operation: {
            ...op(),
            id: deleteOperationId,
            kind: "database.delete",
            status: state.deleteStatus,
            generation: state.generation,
          },
        },
        { status: 202 },
      );
    }
    if (parsed.pathname === "/v1/webhooks" && (init.method ?? "GET") === "GET") {
      const limit = Number(parsed.searchParams.get("limit")),
        offset = Number(parsed.searchParams.get("cursor") ?? 0);
      return Response.json({
        data: webhooks.slice(offset, offset + limit),
        next_cursor: offset + limit < webhooks.length ? String(offset + limit) : null,
      });
    }
    if (init.method === "DELETE" && parsed.pathname.startsWith("/v1/webhooks/")) {
      const status = state.webhookDeleteStatuses.shift() ?? 204;
      if (status !== 204 && status !== 404) return new Response(null, { status });
      const index = webhooks.findIndex(
        (webhook) => webhook["id"] === parsed.pathname.split("/").at(-1),
      );
      if (index >= 0) webhooks.splice(index, 1);
      return new Response(null, { status: index >= 0 ? status : 404 });
    }
    if (parsed.pathname === `/v1/operations/${deleteOperationId}`) {
      const reads = ++state.deleteReads;
      if (state.deleteSucceedsAfterReads !== null && reads >= state.deleteSucceedsAfterReads) {
        state.deleteStatus = "succeeded";
        state.observedState = "deleted";
        state.observedGeneration = state.generation;
      }
      if (state.deleteFailsAfterReads !== null && reads >= state.deleteFailsAfterReads)
        state.deleteStatus = "failed";
      return Response.json({
        ...op(),
        id: deleteOperationId,
        kind: "database.delete",
        status: state.deleteStatus,
        generation: state.generation,
      });
    }
    if (parsed.pathname === `/v1/operations/${providerOperationId}`) {
      if (++state.createReads >= (state.createSucceedsAfterReads ?? Infinity))
        state.createStatus = "succeeded";
      return Response.json(op());
    }
    if (parsed.pathname === `/v1/databases/${databaseId}` && state.databaseHttpStatus !== 200)
      return new Response(null, { status: state.databaseHttpStatus });
    return parsed.pathname.includes("/operations/") ? Response.json(op()) : Response.json(db());
  }) as typeof fetch;
  // Records the wait without spending real time, so tests can assert the exact schedule.
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const provider = new PgcfProjectProvider({
    baseUrl: "https://pgcf.example.com",
    projectId,
    apiKey: "test-only-integrator-key",
    fetch: providerFetch,
  });
  const connect: Parameters<typeof createPgcfManagement>[0]["connect"] = async (uri, target) => {
    expect(new URL(uri).hostname).toBe(target.host);
    stats.sqlConnections++;
    if (state.desiredState === "suspended") {
      if (state.suspensionReason !== "idle")
        throw new Error("manually suspended database cannot wake");
      stats.wakes++;
      state.desiredState = "running";
      state.suspensionReason = null;
      state.observedState = "ready";
      state.observedGeneration = ++state.generation;
    }
    const pool = await native(target.role);
    let client;
    try {
      client = await pool.connect();
    } catch (error) {
      await pool.end();
      throw error;
    }
    return {
      client: client as unknown as DatabaseMigrationClient,
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  };
  const admin: Parameters<typeof createPgcfManagement>[0]["admin"] = (region) =>
    registries[region] as unknown as Parameters<typeof createPgcfManagement>[0]["admin"] extends (
      region: "us" | "eu",
    ) => infer A
      ? A
      : never;
  return {
    control,
    source,
    request,
    registry,
    registries,
    native,
    baseline,
    provider,
    providerFetch,
    connect,
    sleep,
    sleeps,
    admin,
    roles,
    webhooks,
    stats,
    state,
    requestedOrigins,
    requests,
  };
}
