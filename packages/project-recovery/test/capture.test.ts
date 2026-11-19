import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, connect as connectTcp, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect, it, vi, type MockInstance } from "vitest";
import * as nativeBridge from "@ohmyhost/postgres-bridge";
import { startBridge as realStartBridge } from "../../postgres-bridge/src/bridge.js";
import { postgresProxy } from "../../postgres-bridge/test/postgres-proxy.js";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import { startTestPostgres } from "../../../apps/control-api/test/postgres.js";
import { captureProjectRecoveryArchive, captureProjectRecoveryArchiveV2 } from "../src/capture.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "../src/index.js";
import { projectSqlRoleName } from "../../platform/src/index.js";
import { prepareProjectRlsHelpers } from "../../../apps/neon-management/src/sql-role-bootstrap.js";
import {
  parsePostgresProofConnection,
  runPostgresCommand,
} from "../../../scripts/postgres-tools.mjs";

const id = (value: number) => String(value).padStart(26, "0");
const scope = {
  organizationId: id(1),
  projectId: id(2),
  backupId: id(3),
  dataMode: "isolated" as const,
  databaseEnvironments: [id(4), id(5)],
  environments: { dev: id(4), prod: id(5) },
};

it("captures read-only SQL snapshots and restores both databases with standard psql", async () => {
  const database = await startTestPostgres();
  const directory = await mkdtemp(join(tmpdir(), "omh-sql-capture-"));
  const controller = new AbortController();
  let locker: Client | undefined;
  let capture: ReturnType<typeof captureProjectRecoveryArchive> | undefined;
  try {
    const base = database.pool.options.connectionString;
    if (typeof base !== "string") throw new Error("Test database URL missing");
    await database.pool.query(
      "CREATE ROLE capture_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE ROLE capture_exporter LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS; CREATE ROLE capture_query LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
    );
    const sources = [];
    const writable = [];
    for (const name of ["dev", "prod"] as const) {
      await database.pool.query(`CREATE DATABASE capture_${name}`);
      const url = new URL(base);
      url.pathname = `/capture_${name}`;
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      try {
        await client.query(
          "CREATE TABLE public.documents(object_key text PRIMARY KEY); INSERT INTO public.documents VALUES ('initial.txt'); CREATE TABLE public.rls_documents(value text); INSERT INTO public.rls_documents VALUES('hidden-a'),('hidden-b'); ALTER TABLE public.rls_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE public.rls_documents FORCE ROW LEVEL SECURITY; CREATE POLICY deny_rows ON public.rls_documents USING(false); GRANT USAGE ON SCHEMA public TO capture_reader,capture_exporter,capture_query; GRANT SELECT ON ALL TABLES IN SCHEMA public TO capture_reader,capture_exporter,capture_query",
        );
        const environmentId = scope.environments[name];
        const migration = projectSqlRoleName(environmentId, "migration");
        for (const purpose of ["migration", "runtime", "readonly"] as const) {
          await client.query(
            `CREATE ROLE ${projectSqlRoleName(environmentId, purpose)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
          );
        }
        await client.query(`GRANT CREATE ON DATABASE capture_${name} TO ${migration}`);
        await client.query(`CREATE SCHEMA ohmyhost AUTHORIZATION ${migration}`);
        // The database platform's schema for data events: unreadable by the tenant, so a dump that
        // included it would fail.
        await client.query(
          "CREATE SCHEMA pgcf; CREATE TABLE pgcf.outbox(seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY); REVOKE ALL ON TABLE pgcf.outbox FROM PUBLIC; GRANT USAGE ON SCHEMA pgcf TO PUBLIC",
        );
        const helperUrl = new URL(url);
        helperUrl.username = migration;
        const helper = new Client({ connectionString: helperUrl.toString() });
        await helper.connect();
        try {
          await prepareProjectRlsHelpers(helper, environmentId);
        } finally {
          await helper.end();
        }
        await client.query(
          "CREATE TABLE public.rls_owned_documents(owner_id text, value text); INSERT INTO public.rls_owned_documents VALUES ('alice','private-a'),('bob','private-b'); ALTER TABLE public.rls_owned_documents ENABLE ROW LEVEL SECURITY; ALTER TABLE public.rls_owned_documents FORCE ROW LEVEL SECURITY; CREATE POLICY own_rows ON public.rls_owned_documents TO PUBLIC USING(owner_id=ohmyhost.user_id()) WITH CHECK(owner_id=ohmyhost.user_id()); GRANT USAGE ON SCHEMA ohmyhost TO capture_query,capture_exporter; GRANT EXECUTE ON FUNCTION ohmyhost.user_id(),ohmyhost.claims() TO capture_query,capture_exporter; GRANT SELECT ON public.rls_owned_documents TO capture_query,capture_exporter",
        );
      } finally {
        await client.end();
      }
      writable.push(url.toString());
      url.username = "capture_exporter";
      sources.push({ environmentId: scope.environments[name], connectionUrl: url.toString() });
    }
    const querySources = sources.map((source) => {
      const url = new URL(source.connectionUrl);
      url.username = "capture_query";
      return { ...source, connectionUrl: url.toString() };
    });
    const querySource = querySources[0];
    if (!querySource) throw new Error("Missing query source");
    const queryClient = new Client({ connectionString: querySource.connectionUrl });
    await queryClient.connect();
    try {
      expect((await queryClient.query("SELECT * FROM public.rls_documents")).rows).toEqual([]);
      expect((await queryClient.query("SELECT * FROM public.rls_owned_documents")).rows).toEqual(
        [],
      );
      await queryClient.query("BEGIN");
      await queryClient.query("SELECT set_config('ohmyhost.request_claims',$1,true)", [
        JSON.stringify({ sub: "alice", role: "authenticated" }),
      ]);
      expect(
        (await queryClient.query("SELECT value FROM public.rls_owned_documents")).rows,
      ).toEqual([{ value: "private-a" }]);
      await queryClient.query("ROLLBACK");
    } finally {
      await queryClient.end();
    }
    await expect(
      captureProjectRecoveryArchive({
        scope,
        databases: querySources,
        passphrase: "test1234",
        archivePath: join(directory, "partial-must-not-exist.zip"),
        maximumBytes: 4 * 1024 * 1024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "recovery_capture_failed" });
    locker = new Client({ connectionString: writable[0] });
    await locker.connect();
    await locker.query("BEGIN; LOCK TABLE public.documents IN ACCESS EXCLUSIVE MODE");
    const archivePath = join(directory, "snapshot.zip");
    capture = captureProjectRecoveryArchive({
      scope,
      databases: sources,
      passphrase: "test1234",
      archivePath,
      maximumBytes: 4 * 1024 * 1024,
      signal: controller.signal,
    });
    const observedCapture = capture.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      ready =
        (
          await database.pool.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='ohmyhost-project-recovery' AND state='idle in transaction'",
          )
        ).rows[0]?.n === 2;
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready).toBe(true);
    await locker.query("INSERT INTO public.documents VALUES ('late.txt')");
    const prod = new Client({ connectionString: writable[1] });
    await prod.connect();
    try {
      await prod.query("INSERT INTO public.documents VALUES ('late.txt')");
    } finally {
      await prod.end();
    }
    await locker.query("COMMIT");
    const result = await observedCapture;
    if ("error" in result) throw result.error;
    const receipt = result.value;
    expect(receipt.sqlFiles).toEqual(["dev.sql", "prod.sql"]);
    expect(JSON.stringify(receipt)).not.toContain("capture_reader");
    expect(JSON.stringify(receipt)).not.toContain("capture_exporter");
    expect(JSON.stringify(receipt)).not.toContain("test1234");
    const zip = new ZipReader(new Uint8ArrayReader(await readFile(archivePath)), {
      useWebWorkers: false,
    });
    try {
      const entries = await zip.getEntries();
      expect(entries.map((e) => e.filename)).toEqual(["dev.sql", "prod.sql"]);
      for (const [index, name] of (["dev", "prod"] as const).entries()) {
        const entry = entries.find((e) => e.filename === `${name}.sql`);
        if (!entry || !("getData" in entry) || !entry.getData) throw new Error("SQL entry missing");
        const sql = await entry.getData(new Uint8ArrayWriter(), { password: "test1234" });
        const path = join(directory, `${name}.sql`);
        await writeFile(path, sql, { mode: 0o600 });
        expect(Buffer.from(sql).toString("utf8")).toContain("PostgreSQL database dump");
        expect(Buffer.from(sql).toString("utf8")).not.toContain("pgcf");
        await database.pool.query(`CREATE DATABASE restored_${name} OWNER capture_reader`);
        const url = new URL(base);
        url.pathname = `/restored_${name}`;
        url.username = "capture_reader";
        await runPostgresCommand(
          "psql",
          ["-X", "--set=ON_ERROR_STOP=on", "--single-transaction", "--file", path],
          parsePostgresProofConnection(url.toString()).environment,
        );
        const restored = new Client({ connectionString: url.toString() });
        await restored.connect();
        try {
          expect(
            (await restored.query("SELECT object_key FROM public.documents ORDER BY object_key"))
              .rows,
          ).toEqual([{ object_key: "initial.txt" }]);
          expect((await restored.query("SELECT * FROM public.rls_documents")).rows).toEqual([]);
          expect((await restored.query("SELECT * FROM public.rls_owned_documents")).rows).toEqual(
            [],
          );
          await restored.query("BEGIN");
          await restored.query("SELECT set_config('ohmyhost.request_claims',$1,true)", [
            JSON.stringify({ sub: "bob", role: "authenticated" }),
          ]);
          expect(
            (await restored.query("SELECT value FROM public.rls_owned_documents")).rows,
          ).toEqual([{ value: "private-b" }]);
          expect((await restored.query("SELECT ohmyhost.claims() claims")).rows).toEqual([
            { claims: { sub: "bob", role: "authenticated" } },
          ]);
          await restored.query("ROLLBACK");
          expect((await restored.query("SELECT ohmyhost.user_id() user_id")).rows).toEqual([
            { user_id: null },
          ]);
        } finally {
          await restored.end();
        }
        const adminUrl = new URL(base);
        adminUrl.pathname = `/restored_${name}`;
        const admin = new Client({ connectionString: adminUrl.toString() });
        await admin.connect();
        try {
          expect(
            (await admin.query("SELECT value FROM public.rls_documents ORDER BY value")).rows,
          ).toEqual([{ value: "hidden-a" }, { value: "hidden-b" }]);
          expect(
            (await admin.query("SELECT value FROM public.rls_owned_documents ORDER BY value")).rows,
          ).toEqual([{ value: "private-a" }, { value: "private-b" }]);
          expect(
            (
              await admin.query(
                "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.rls_documents'::regclass",
              )
            ).rows,
          ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
        } finally {
          await admin.end();
        }
        const source = new Client({ connectionString: writable[index] });
        await source.connect();
        try {
          expect(
            (await source.query("SELECT count(*)::int n FROM public.documents")).rows[0]?.n,
          ).toBe(2);
        } finally {
          await source.end();
        }
      }
    } finally {
      await zip.close();
    }
    // Snapshot and pg_dump must share one bridge while retaining two simultaneous database
    // sessions. This isolated proxy speaks real PostgreSQL bytes; production's TLS is fixed by
    // the bridge connector and separately checked in its transport tests.
    await locker.end();
    locker = undefined;
    const pgcfId = "a".repeat(20);
    await database.pool.query(`CREATE DATABASE ${pgcfId} TEMPLATE capture_dev`);
    const proxy = await postgresProxy(Number(new URL(base).port));
    const opened: nativeBridge.Bridge[] = [];
    const bridged = vi.spyOn(nativeBridge, "startBridge").mockImplementation(async (raw) => {
      const value = await realStartBridge(raw, { connect: proxy.connect });
      opened.push(value);
      return value;
    });
    try {
      const pgcfScope = {
        ...scope,
        dataMode: "shared" as const,
        databaseEnvironments: [id(4)],
        environments: { dev: id(4), prod: id(4) },
      };
      const connection = {
        environmentId: id(4),
        connectionUrl: `postgresql://capture_exporter:test-password@pgcf.example.test/${pgcfId}`,
        transport: {
          provider: "pgcf" as const,
          websocketUrl: "wss://pgcf.example.test/",
          databaseId: pgcfId,
          role: "capture_exporter",
        },
      };
      const path = join(directory, "pgcf-snapshot.zip");
      const receipt = await captureProjectRecoveryArchive({
        scope: pgcfScope,
        databases: [connection],
        passphrase: "test1234",
        archivePath: path,
        maximumBytes: 4 * 1024 * 1024,
        signal: controller.signal,
      });
      expect(receipt.sqlFiles).toHaveLength(1);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.clients).toBe(0);
      expect(proxy.maximum).toBe(2);
      const archived = new ZipReader(new Uint8ArrayReader(await readFile(path)), {
        useWebWorkers: false,
      });
      try {
        const entry = (await archived.getEntries())[0];
        if (!entry || !("getData" in entry) || !entry.getData) throw new Error("SQL entry missing");
        const sql = Buffer.from(
          await entry.getData(new Uint8ArrayWriter(), { password: "test1234" }),
        ).toString("utf8");
        expect(sql).toContain("hidden-a");
        expect(sql).toContain("hidden-b");
        expect(sql).toContain("FORCE ROW LEVEL SECURITY");
      } finally {
        await archived.close();
      }
      const authResource = { kind: "native_auth_database" as const, databaseId: pgcfId };
      const schemaName = `omh_auth_${scope.environments.dev.toLowerCase()}`;
      const prodSchema = `omh_auth_${scope.environments.prod.toLowerCase()}`;
      const adminUrl = new URL(base);
      adminUrl.pathname = `/${pgcfId}`;
      const admin = new Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      try {
        await admin.query(
          `CREATE SCHEMA ${schemaName}; CREATE TABLE ${schemaName}.native_realm_policy(singleton boolean, revocation_epoch bigint, configuration_revision bigint); INSERT INTO ${schemaName}.native_realm_policy VALUES(true,1,2); CREATE TABLE ${schemaName}.omh_native_migrations(version integer,digest text); GRANT USAGE ON SCHEMA ${schemaName} TO capture_exporter; GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaName} TO capture_exporter`,
        );
        await admin.query(`INSERT INTO ${schemaName}.omh_native_migrations VALUES($1,$2)`, [
          NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
          NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        ]);
        await admin.query(
          `CREATE SCHEMA ${prodSchema}; CREATE TABLE ${prodSchema}.native_realm_policy(singleton boolean, revocation_epoch bigint, configuration_revision bigint); INSERT INTO ${prodSchema}.native_realm_policy VALUES(true,3,4); CREATE TABLE ${prodSchema}.omh_native_migrations(version integer,digest text); GRANT USAGE ON SCHEMA ${prodSchema} TO capture_exporter; GRANT SELECT ON ALL TABLES IN SCHEMA ${prodSchema} TO capture_exporter`,
        );
        await admin.query(`INSERT INTO ${prodSchema}.omh_native_migrations VALUES($1,$2)`, [
          NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
          NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        ]);
        // Preview policy custody is deliberately unreadable to the Native backup role.
        await admin.query(
          `CREATE TABLE ${schemaName}.native_preview_realm_policy(preview_id text); CREATE TABLE ${schemaName}.native_preview_policy_migrations(version integer); CREATE TABLE ${prodSchema}.native_preview_realm_policy(preview_id text); CREATE TABLE ${prodSchema}.native_preview_policy_migrations(version integer)`,
        );
        await admin.query(
          `CREATE TABLE ${schemaName}.backup_visibility_marker(email text); INSERT INTO ${schemaName}.backup_visibility_marker VALUES('dev-only-auth@example.test'); GRANT SELECT ON ${schemaName}.backup_visibility_marker TO capture_exporter; CREATE TABLE ${prodSchema}.backup_visibility_marker(email text); INSERT INTO ${prodSchema}.backup_visibility_marker VALUES('prod-auth@example.test'); GRANT SELECT ON ${prodSchema}.backup_visibility_marker TO capture_exporter`,
        );
      } finally {
        await admin.end();
      }
      const nativeManifest = {
        schemaVersion: "ohmyhost.native-auth-inventory/v1" as const,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        databaseId: pgcfId,
        migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
        migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        realms: [
          {
            environmentId: scope.environments.dev,
            schemaName,
            revocationEpoch: 1,
            configurationRevision: 2,
          },
          {
            environmentId: scope.environments.prod,
            schemaName: prodSchema,
            revocationEpoch: 3,
            configurationRevision: 4,
          },
        ],
      };
      const authReceipt = await captureProjectRecoveryArchiveV2({
        scope: {
          schemaVersion: "ohmyhost.recovery-scope/v2",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          backupId: scope.backupId,
          dataMode: scope.dataMode,
          environments: scope.environments,
          resources: [authResource],
          nativeManifest,
        },
        databases: [
          {
            resource: authResource,
            connectionUrl: connection.connectionUrl,
            transport: connection.transport,
          },
        ],
        passphrase: "test1234",
        archivePath: join(directory, "auth-snapshot.zip"),
        maximumBytes: 4 * 1024 * 1024,
        signal: controller.signal,
      });
      expect(authReceipt).toMatchObject({ format: "zip-aes256-ae2-v2", sqlFiles: ["auth.sql"] });
      const [devRealm, prodRealm] = nativeManifest.realms;
      if (!devRealm || !prodRealm) throw new Error("missing Native capture fixture realms");
      const prodOnlyInput = {
        scope: {
          schemaVersion: "ohmyhost.recovery-scope/v2" as const,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          backupId: scope.backupId,
          dataMode: scope.dataMode,
          environments: { prod: scope.environments.prod },
          resources: [authResource],
          nativeManifest: { ...nativeManifest, realms: [prodRealm] },
        },
        databases: [
          {
            resource: authResource,
            connectionUrl: connection.connectionUrl,
            transport: connection.transport,
          },
        ],
        passphrase: "test1234",
        archivePath: join(directory, "prod-auth-only.zip"),
        maximumBytes: 4 * 1024 * 1024,
        signal: controller.signal,
      };
      const prodOnlyReceipt = await captureProjectRecoveryArchiveV2(prodOnlyInput);
      expect(prodOnlyReceipt.nativeManifest?.realms).toMatchObject([
        { environmentId: scope.environments.prod },
      ]);
      expect(prodOnlyReceipt.nativeManifest?.realms).toHaveLength(1);
      const prodOnlyZip = new ZipReader(
        new Uint8ArrayReader(await readFile(prodOnlyInput.archivePath)),
        { useWebWorkers: false },
      );
      try {
        const entry = (await prodOnlyZip.getEntries())[0];
        if (!entry || !("getData" in entry) || !entry.getData)
          throw new Error("Prod Auth SQL missing");
        const sql = Buffer.from(
          await entry.getData(new Uint8ArrayWriter(), { password: "test1234" }),
        ).toString("utf8");
        expect(sql).toContain(prodSchema);
        expect(sql).toContain("prod-auth@example.test");
        expect(sql).not.toContain(schemaName);
        expect(sql).not.toContain("dev-only-auth@example.test");
        expect(sql).not.toContain("native_preview_realm_policy");
        expect(sql).not.toContain("native_preview_policy_migrations");
      } finally {
        await prodOnlyZip.close();
      }
      await expect(
        captureProjectRecoveryArchiveV2({
          ...prodOnlyInput,
          archivePath: join(directory, "missing-selected-auth.zip"),
          scope: {
            ...prodOnlyInput.scope,
            nativeManifest: {
              ...nativeManifest,
              realms: [{ ...prodRealm, environmentId: id(99), schemaName: `omh_auth_${id(99)}` }],
            },
          },
        }),
      ).rejects.toMatchObject({ code: "recovery_scope_mismatch" });
      await expect(
        captureProjectRecoveryArchiveV2({
          scope: {
            schemaVersion: "ohmyhost.recovery-scope/v2",
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            backupId: scope.backupId,
            dataMode: scope.dataMode,
            environments: scope.environments,
            resources: [authResource],
            nativeManifest: {
              ...nativeManifest,
              realms: [{ ...devRealm, revocationEpoch: 2 }, prodRealm],
            },
          },
          databases: [
            {
              resource: authResource,
              connectionUrl: connection.connectionUrl,
              transport: connection.transport,
            },
          ],
          passphrase: "test1234",
          archivePath: join(directory, "stale-auth.zip"),
          maximumBytes: 4 * 1024 * 1024,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "recovery_scope_mismatch" });
      const authZip = new ZipReader(
        new Uint8ArrayReader(await readFile(join(directory, "auth-snapshot.zip"))),
        { useWebWorkers: false },
      );
      try {
        const entry = (await authZip.getEntries())[0];
        if (!entry || !("getData" in entry) || !entry.getData) throw new Error("Auth SQL missing");
        const bytes = Buffer.from(
          await entry.getData(new Uint8ArrayWriter(), { password: "test1234" }),
        );
        const sql = bytes.toString("utf8");
        expect(sql).toContain("native_realm_policy");
        expect(sql).not.toContain("hidden-a");
        const realms = authReceipt.nativeManifest?.realms;
        expect(realms).toHaveLength(2);
        if (!realms) throw new Error("missing captured Native realms");
        for (const [index, realm] of realms.entries()) {
          const otherRealm = realms[1 - index];
          if (!otherRealm || realm.dumpOffset === undefined || realm.dumpBytes === undefined)
            throw new Error("missing Native realm capture metadata");
          const slice = bytes.subarray(realm.dumpOffset, realm.dumpOffset + realm.dumpBytes);
          expect(createHash("sha256").update(slice).digest("hex")).toBe(realm.dumpSha256);
          expect(slice.toString("utf8")).toContain(realm.schemaName);
          expect(slice.toString("utf8")).not.toContain(otherRealm.schemaName);
        }
      } finally {
        await authZip.close();
      }
      await expect(
        captureProjectRecoveryArchive({
          scope: pgcfScope,
          databases: [
            { ...connection, transport: { ...connection.transport, databaseId: "b".repeat(20) } },
          ],
          passphrase: "test1234",
          archivePath: join(directory, "refused.zip"),
          maximumBytes: 1024,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "recovery_database_unavailable" });
    } finally {
      bridged.mockRestore();
      await proxy.close();
    }
    await expect(
      captureProjectRecoveryArchive({
        scope: { ...scope, databaseEnvironments: [] },
        databases: [],
        passphrase: "test1234",
        archivePath: join(directory, "empty.zip"),
        maximumBytes: 1024,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "recovery_input_invalid" });
  } finally {
    controller.abort();
    await locker?.end();
    await capture?.catch(() => undefined);
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);

it("terminates a running native PostgreSQL command when capture is cancelled", async () => {
  const database = await startTestPostgres();
  const controller = new AbortController();
  try {
    const connectionUrl = database.pool.options.connectionString;
    if (typeof connectionUrl !== "string") throw new Error("Test PostgreSQL URL is missing");
    const command = runPostgresCommand(
      "psql",
      ["-X", "-Atq", "--command", "SELECT pg_sleep(10)"],
      {
        ...parsePostgresProofConnection(connectionUrl).environment,
        PGAPPNAME: "ohmyhost-capture-cancel-test",
      },
      { signal: controller.signal },
    ).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    let running = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      running =
        (
          await database.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='ohmyhost-capture-cancel-test' AND state='active') found",
          )
        ).rows[0]?.found === true;
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(true);
    controller.abort();
    const result = await Promise.race([
      command,
      new Promise((resolve) => setTimeout(() => resolve("did not stop"), 1000)),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).not.toContain(connectionUrl);
  } finally {
    controller.abort();
    await database.stop();
  }
});

it("aborts SQL capture when its exported snapshot connection is lost", async () => {
  const database = await startTestPostgres();
  const directory = await mkdtemp(join(tmpdir(), "omh-sql-lost-snapshot-"));
  const controller = new AbortController();
  let locker: Client | undefined;
  let capture: Promise<unknown> | undefined;
  try {
    const base = database.pool.options.connectionString;
    if (typeof base !== "string") throw new Error("Test database URL missing");
    await database.pool.query(
      "CREATE ROLE capture_reader LOGIN NOSUPERUSER; CREATE TABLE public.capture_data(id int); INSERT INTO public.capture_data VALUES (1); GRANT USAGE ON SCHEMA public TO capture_reader; GRANT SELECT ON public.capture_data TO capture_reader",
    );
    locker = new Client({ connectionString: base });
    await locker.connect();
    await locker.query("BEGIN; LOCK TABLE public.capture_data IN ACCESS EXCLUSIVE MODE");
    const url = new URL(base);
    url.username = "capture_reader";
    capture = captureProjectRecoveryArchive({
      scope: { ...scope, dataMode: "shared", databaseEnvironments: [scope.environments.dev] },
      databases: [{ environmentId: scope.environments.dev, connectionUrl: url.toString() }],
      passphrase: "test1234",
      archivePath: join(directory, "lost.zip"),
      maximumBytes: 1048576,
      signal: controller.signal,
    }).then(
      (result) => result,
      (error: unknown) => error,
    );
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      pid = (
        await database.pool.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name='ohmyhost-project-recovery' AND state='idle in transaction'",
        )
      ).rows[0]?.pid;
      if (pid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeTypeOf("number");
    await database.pool.query("SELECT pg_terminate_backend($1)", [pid]);
    expect(await capture).toMatchObject({ code: "recovery_database_unavailable" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    controller.abort();
    await locker?.end();
    await capture;
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Front for one real PostgreSQL: the first `refusals` connections get a FATAL ErrorResponse with
 * the given SQLSTATE, later connections are piped through unchanged. Local test lane only.
 */
async function refusingFront(targetPort: number, refusals: number, sqlstate: string) {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = createServer((client) => {
    accepted++;
    sockets.add(client);
    client.on("error", () => undefined);
    client.on("close", () => sockets.delete(client));
    if (accepted <= refusals) {
      client.end(errorResponse(sqlstate));
      return;
    }
    const upstream = connectTcp({ host: "127.0.0.1", port: targetPort });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => sockets.delete(upstream));
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    get accepted() {
      return accepted;
    },
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One PostgreSQL ErrorResponse message: `E`, int32 length, then S, V, C and M fields. */
function errorResponse(sqlstate: string): Buffer {
  const body = Buffer.from(
    `SFATAL\0VFATAL\0C${sqlstate}\0Mrefused while the database wakes\0\0`,
    "utf8",
  );
  const header = Buffer.alloc(5);
  header.write("E", 0, "ascii");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

it("retries a wake refusal with a fresh client and then captures the database", async () => {
  const database = await startTestPostgres();
  const directory = await mkdtemp(join(tmpdir(), "omh-sql-wake-retry-"));
  let end: MockInstance<Client["end"]> | undefined;
  let front: Awaited<ReturnType<typeof refusingFront>> | undefined;
  try {
    const base = database.pool.options.connectionString;
    if (typeof base !== "string") throw new Error("Test database URL missing");
    await database.pool.query("CREATE ROLE capture_retry_reader LOGIN NOSUPERUSER");
    await database.pool.query("CREATE DATABASE capture_retry");
    const owner = new URL(base);
    owner.pathname = "/capture_retry";
    const setup = new Client({ connectionString: owner.toString() });
    await setup.connect();
    try {
      await setup.query(
        "CREATE TABLE public.retry_data(id int); INSERT INTO public.retry_data VALUES (1); GRANT USAGE ON SCHEMA public TO capture_retry_reader; GRANT SELECT ON public.retry_data TO capture_retry_reader",
      );
    } finally {
      await setup.end();
    }
    front = await refusingFront(Number(new URL(base).port), 1, "57P03");
    const url = new URL(base);
    url.pathname = "/capture_retry";
    url.username = "capture_retry_reader";
    url.port = String(front.port);
    end = vi.spyOn(Client.prototype, "end");
    const receipt = await captureProjectRecoveryArchive({
      scope: { ...scope, dataMode: "shared", databaseEnvironments: [scope.environments.dev] },
      databases: [{ environmentId: scope.environments.dev, connectionUrl: url.toString() }],
      passphrase: "test1234",
      archivePath: join(directory, "retry.zip"),
      maximumBytes: 1048576,
      signal: new AbortController().signal,
    });
    expect(receipt.sqlFiles).toEqual(["shared.sql"]);
    expect(front.accepted).toBeGreaterThanOrEqual(2);
    // The refused client is ended once when it is discarded, the snapshot client once in finally.
    const captureClients = (end?.mock.contexts ?? []).filter(
      (client) =>
        (client as unknown as { connectionParameters: { application_name?: string } })
          .connectionParameters.application_name === "ohmyhost-project-recovery",
    );
    expect(captureClients).toHaveLength(2);
    expect(new Set(captureClients).size).toBe(2);
    expect(await readdir(directory)).toEqual(["retry.zip"]);
  } finally {
    end?.mockRestore();
    await front?.close();
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it("maps a refused login to recovery_database_unavailable without retrying", async () => {
  const database = await startTestPostgres();
  const directory = await mkdtemp(join(tmpdir(), "omh-sql-refused-login-"));
  try {
    const base = database.pool.options.connectionString;
    if (typeof base !== "string") throw new Error("Test database URL missing");
    const url = new URL(base);
    url.username = "recovery_role_that_does_not_exist";
    await expect(
      captureProjectRecoveryArchive({
        scope: { ...scope, dataMode: "shared", databaseEnvironments: [scope.environments.dev] },
        databases: [{ environmentId: scope.environments.dev, connectionUrl: url.toString() }],
        passphrase: "test1234",
        archivePath: join(directory, "refused-login.zip"),
        maximumBytes: 1048576,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "recovery_database_unavailable" });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await database.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
