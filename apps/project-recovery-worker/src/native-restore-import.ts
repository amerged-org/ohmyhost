import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startBridge } from "@ohmyhost/postgres-bridge";
import { readNativeRestoreArchive } from "@ohmyhost/project-recovery/native-restore-archive";
import { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { parsePgcfProofConnection } from "../../../scripts/postgres-tools.mjs";

/** Reject psql commands other than pg_dump's restrict markers and COPY terminators. */
export function validateNativeRestoreDump(sql: Uint8Array): void {
  inspectNativeRestoreDump(sql);
}

function inspectNativeRestoreDump(sql: Uint8Array, schemaName?: string): readonly Uint8Array[] {
  if (sql.length < 1 || sql.length > 256 * 1024 * 1024 || sql.includes(0))
    throw new Error("native_restore_dump_invalid");
  const bytes = Buffer.from(sql.buffer, sql.byteOffset, sql.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let start = 0; start < bytes.length; start += 65536)
      decoder.decode(bytes.subarray(start, Math.min(start + 65536, bytes.length)), {
        stream: true,
      });
    decoder.decode();
  } catch {
    throw new Error("native_restore_dump_invalid");
  }
  let copy = false,
    restrict: string | undefined,
    closed = false,
    removalStart = -1,
    removalEnd = -1;
  for (let start = 0; start < bytes.length; ) {
    const newline = bytes.indexOf(10, start),
      end = newline < 0 ? bytes.length : newline;
    if (end - start > 16 * 1024 * 1024) throw new Error("native_restore_dump_invalid");
    const view = bytes.subarray(start, end);
    const next = newline < 0 ? bytes.length : newline + 1;
    if (copy) {
      if (view.length === 2 && view[0] === 92 && view[1] === 46) copy = false;
      start = next;
      continue;
    }
    const line = view.toString("utf8");
    if (/^COPY .+ FROM stdin;\r?$/u.test(line)) {
      copy = true;
      start = next;
      continue;
    }
    if (schemaName !== undefined && line === `CREATE SCHEMA ${schemaName};`) {
      if (removalStart !== -1) throw new Error("native_restore_dump_invalid");
      removalStart = start;
      removalEnd = next;
    }
    if (!line.startsWith("\\")) {
      start = next;
      continue;
    }
    const open = /^\\restrict ([A-Za-z0-9]+)\r?$/u.exec(line);
    const close = /^\\unrestrict ([A-Za-z0-9]+)\r?$/u.exec(line);
    if (open && !restrict && !closed) {
      restrict = open[1];
      start = next;
      continue;
    }
    if (close && restrict && !closed && close[1] === restrict) {
      closed = true;
      start = next;
      continue;
    }
    throw new Error("native_restore_dump_invalid");
  }
  if (copy || !restrict || !closed) throw new Error("native_restore_dump_invalid");
  if (schemaName === undefined) return [sql];
  if (removalStart < 0 || removalEnd < 0) throw new Error("native_restore_dump_invalid");
  return [sql.subarray(0, removalStart), sql.subarray(removalEnd)];
}

/** Boundaries and hashes come from the encrypted, Core-bound manifest, not from SQL text. */
export function splitNativeRestoreDumps(
  sql: Uint8Array,
  realms: readonly {
    readonly environmentId: string;
    readonly schemaName: string;
    readonly dumpOffset: number;
    readonly dumpBytes: number;
    readonly dumpSha256: string;
  }[],
) {
  if (
    realms.length < 1 ||
    realms.length > 2 ||
    realms.some(
      (realm, index) =>
        index > 0 && realm.environmentId <= (realms[index - 1]?.environmentId ?? ""),
    )
  )
    throw new Error("native_restore_dump_invalid");
  let offset = 0;
  return realms
    .map((realm) => {
      if (
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(realm.environmentId) ||
        realm.schemaName !== `omh_auth_${realm.environmentId.toLowerCase()}` ||
        realm.dumpOffset !== offset ||
        !Number.isSafeInteger(realm.dumpBytes) ||
        realm.dumpBytes < 1 ||
        !/^[a-f0-9]{64}$/u.test(realm.dumpSha256) ||
        offset + realm.dumpBytes > sql.length
      )
        throw new Error("native_restore_dump_invalid");
      const part = sql.subarray(offset, offset + realm.dumpBytes);
      offset += realm.dumpBytes;
      if (createHash("sha256").update(part).digest("hex") !== realm.dumpSha256)
        throw new Error("native_restore_dump_invalid");
      const result = inspectNativeRestoreDump(part, realm.schemaName);
      return { environmentId: realm.environmentId, schemaName: realm.schemaName, sql: result };
    })
    .map((realm, index, all) => {
      if (index === all.length - 1 && offset !== sql.length)
        throw new Error("native_restore_dump_invalid");
      return realm;
    });
}

type RestoreArchiveInput = {
  readonly target: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly databaseId: string;
    readonly providerProjectId: string;
    readonly regionId: string;
  };
  readonly archive: Uint8Array;
  readonly archiveSha256: string;
  readonly nativeManifest: string;
  readonly nativeManifestSha256: string;
  readonly passphrase: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
};
const preparedBrand = Symbol("native-restore-prepared");
type PreparedNativeRestore = {
  readonly [preparedBrand]: true;
  readonly scope: string;
  readonly archiveSha256: string;
  readonly nativeManifestSha256: string;
  readonly realms: ReturnType<typeof splitNativeRestoreDumps>;
};

/** Authenticate, decrypt and validate every realm slice before any realm is taken offline. */
export async function prepareNativeRestore(
  input: RestoreArchiveInput,
): Promise<PreparedNativeRestore> {
  const opened = await readNativeRestoreArchive(input);
  if (
    opened.manifest.organizationId !== input.target.organizationId ||
    opened.manifest.projectId !== input.target.projectId ||
    opened.manifest.databaseId !== input.target.databaseId
  )
    throw new Error("native_restore_scope_invalid");
  return {
    [preparedBrand]: true,
    scope: JSON.stringify(input.target),
    archiveSha256: input.archiveSha256,
    nativeManifestSha256: input.nativeManifestSha256,
    realms: splitNativeRestoreDumps(
      opened.sql,
      opened.manifest.realms as unknown as Parameters<typeof splitNativeRestoreDumps>[1],
    ),
  };
}

/** Recreate only the approved schemas, then import each realm with its private migrator. */
export async function importNativeRestore(
  input: RestoreArchiveInput & {
    readonly provider: PgcfProjectProvider;
    readonly prepared?: PreparedNativeRestore;
    readonly signal: AbortSignal;
    /** Restore-specific Core proof, rechecked before private credential use and before commit. */
    readonly authorize: () => Promise<void>;
    readonly isRealmImported: (environmentId: string) => Promise<boolean>;
    readonly recordRealmImported: (environmentId: string) => Promise<void>;
  },
): Promise<void> {
  const prepared = input.prepared ?? (await prepareNativeRestore(input));
  if (
    prepared[preparedBrand] !== true ||
    prepared.scope !== JSON.stringify(input.target) ||
    prepared.archiveSha256 !== input.archiveSha256 ||
    prepared.nativeManifestSha256 !== input.nativeManifestSha256 ||
    input.provider.projectId !== input.target.providerProjectId
  )
    throw new Error("native_restore_scope_invalid");
  const realms = prepared.realms;
  await input.authorize();
  const database = await input.provider.readDatabase(input.target.databaseId);
  if (
    database.id !== input.target.databaseId ||
    database.projectId !== input.target.providerProjectId ||
    database.regionId !== input.target.regionId ||
    database.desiredState === "deleted"
  )
    throw new Error("native_restore_scope_invalid");
  const ownerHandle = await input.provider.readConnection(input.target.databaseId, "app");
  const withRole = async (
    role: string,
    work: (environment: Readonly<Record<string, string>>) => Promise<void>,
  ) => {
    const handle =
      role === "app"
        ? ownerHandle
        : await input.provider.readConnection(input.target.databaseId, role);
    if (handle.host !== ownerHandle.host) throw new Error("native_restore_scope_invalid");
    await handle.consume(async (uri) => {
      await input.authorize();
      const connection = parsePgcfProofConnection(uri, {
        provider: "pgcf",
        host: handle.host,
        databaseId: input.target.databaseId,
        role,
      });
      const bridge = await startBridge({
        endpoint: `wss://${handle.host}/`,
        database: input.target.databaseId,
        user: role,
        port: 0,
      });
      try {
        await work({
          ...connection.environment,
          PGHOST: bridge.host,
          PGPORT: String(bridge.port),
          PGSSLMODE: "disable",
          PGCHANNELBINDING: "disable",
          PGGSSENCMODE: "disable",
          PGCONNECT_TIMEOUT: "75",
          PGOPTIONS: "-c client_min_messages=warning",
        });
      } finally {
        await bridge.close();
      }
    });
  };
  const roles = await input.provider.readRoles(input.target.databaseId);
  for (const realm of realms) {
    const roleName = `omh_am_${realm.environmentId.toLowerCase()}`;
    const role = roles.find((candidate) => candidate.name === roleName);
    if (
      !role ||
      role.databaseId !== input.target.databaseId ||
      role.owner ||
      role.bypassRls ||
      role.connectionLimit !== 2 ||
      role.validUntil !== null ||
      role.memberOf.length !== 0
    )
      throw new Error("native_restore_scope_invalid");
  }
  // Each committed realm is journaled; a lost response reimports only the unjournaled realm.
  // All realms remain OFF until every journal, ACL proof and sanitizer succeeds.
  for (const realm of realms) {
    await input.authorize();
    if (await input.isRealmImported(realm.environmentId)) continue;
    const migrator = `omh_am_${realm.environmentId.toLowerCase()}`;
    await withRole("app", async (environment) => {
      const statement = `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='${realm.schemaName}' AND nspowner=current_user::regrole) THEN RAISE EXCEPTION 'restore schema mismatch'; END IF; END $$; DROP SCHEMA "${realm.schemaName}" CASCADE; CREATE SCHEMA "${realm.schemaName}"; REVOKE ALL ON SCHEMA "${realm.schemaName}" FROM PUBLIC; GRANT USAGE,CREATE ON SCHEMA "${realm.schemaName}" TO "${migrator}";`;
      await runNativeRestoreTransaction({
        environment,
        sql: new Uint8Array(),
        drops: `DO $$ BEGIN IF current_user<>'app' OR session_user<>'app' OR current_database()<>'${input.target.databaseId}' OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=current_user::regrole) THEN RAISE EXCEPTION 'restore owner mismatch'; END IF; END $$;\n${statement}`,
        lockScope: input.target,
        signal: input.signal,
        authorize: input.authorize,
      });
    });
    await withRole(migrator, async (environment) => {
      await runNativeRestoreTransaction({
        environment,
        sql: realm.sql,
        drops: `DO $$ BEGIN IF current_user<>'${migrator}' OR session_user<>'${migrator}' OR current_database()<>'${input.target.databaseId}' THEN RAISE EXCEPTION 'restore role mismatch'; END IF; END $$;`,
        lockScope: input.target,
        signal: input.signal,
        authorize: input.authorize,
      });
    });
    await input.recordRealmImported(realm.environmentId);
  }
}

/** psql remains inside BEGIN until Core confirms the restore fence immediately before COMMIT. */
export async function runNativeRestoreTransaction(input: {
  readonly environment: Readonly<Record<string, string>>;
  readonly sql: Uint8Array | readonly Uint8Array[];
  readonly drops: string;
  readonly lockScope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly databaseId: string;
  };
  readonly signal: AbortSignal;
  readonly authorize: () => Promise<void>;
}): Promise<void> {
  input.signal.throwIfAborted();
  const { organizationId, projectId, databaseId } = input.lockScope;
  if (
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(organizationId) ||
    !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(projectId) ||
    !/^[a-z][a-z0-9]{19}$/u.test(databaseId)
  )
    throw new Error("native_restore_scope_invalid");
  const lockName = `ohmyho-native-restore/v1:${organizationId}:${projectId}:${databaseId}`;
  const marker = `omh_restore_${randomBytes(24).toString("hex")}`,
    lockMarker = `${marker}_locked`;
  const child = spawn(
    "psql",
    [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--no-password",
    ],
    {
      // The child receives only libpq settings and PATH, not the Worker's globally
      // augmented ProcessEnv configuration or unrelated parent-process secrets.
      env: {
        ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}),
        ...input.environment,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      signal: input.signal,
      killSignal: "SIGKILL",
    },
  );
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) child.kill("SIGKILL");
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void exited.catch(() => undefined);
  const waitForMarker = (expected: string) =>
    new Promise<void>((resolve, reject) => {
      let output = "";
      const cleanup = () => {
        child.stdout.off("data", onData);
        child.off("close", onClose);
        child.off("error", onError);
      };
      const fail = () => {
        cleanup();
        reject(new Error("native_restore_failed"));
      };
      const onClose = () => fail(),
        onError = () => fail();
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 65536) {
          child.kill("SIGKILL");
          fail();
        } else if (output.split(/\r?\n/u).includes(expected)) {
          cleanup();
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.once("close", onClose);
      child.once("error", onError);
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  try {
    child.stdin.on("error", () => child.kill("SIGKILL"));
    const write = async (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        input.signal.throwIfAborted();
        const part = bytes.subarray(offset, Math.min(offset + 65536, bytes.length));
        if (!child.stdin.write(Buffer.from(part.buffer, part.byteOffset, part.byteLength)))
          await once(child.stdin, "drain");
      }
    };
    const locked = waitForMarker(lockMarker);
    await Promise.all([
      write(
        Buffer.from(
          `BEGIN;\nSELECT pg_advisory_xact_lock(hashtextextended('${lockName}', 0));\n\\echo ${lockMarker}\n`,
        ),
      ),
      locked,
    ]);
    // A stale claimant can wait behind an earlier COMMIT; it must not execute
    // any mutation until the live external claim is checked after the lock.
    await input.authorize();
    const ready = waitForMarker(marker);
    void ready.catch(() => undefined);
    await write(Buffer.from(`${input.drops}\n`));
    const pieces = input.sql instanceof Uint8Array ? [input.sql] : input.sql;
    for (const piece of pieces) await write(piece);
    await Promise.all([write(Buffer.from(`\n\\echo ${marker}\n`)), ready]);
    await input.authorize();
    child.stdin.end("COMMIT;\n\\q\n");
    if ((await exited) !== 0) throw new Error("native_restore_failed");
  } catch {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    throw new Error("native_restore_failed");
  } finally {
    clearTimeout(timer);
  }
}
