import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { ZipWriter } from "@zip.js/zip.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
export { NATIVE_AUTH_SCHEMA_MIGRATION_SHA256, NATIVE_AUTH_SCHEMA_MIGRATION_VERSION };

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
export type RecoveryErrorCode =
  | "recovery_database_unavailable"
  | "recovery_capture_failed"
  | "recovery_input_invalid"
  | "recovery_source_changed"
  | "recovery_archive_invalid"
  | "recovery_archive_too_large"
  | "recovery_destination_exists"
  | "recovery_checksum_mismatch"
  | "recovery_scope_mismatch"
  | "recovery_io_failed";
export class RecoveryArchiveError extends Error {
  constructor(readonly code: RecoveryErrorCode) {
    super(code);
    this.name = "RecoveryArchiveError";
  }
}
export interface RecoveryScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly backupId: string;
  readonly dataMode: "shared" | "isolated";
  readonly databaseEnvironments: readonly string[];
  /** Current physical data identities; shared assignments may have the same value. */
  readonly environments: Readonly<{ dev?: string; prod: string }>;
}
export interface RecoveryInputFile {
  readonly namespaceId: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export type RecoveryResource =
  | Readonly<{ kind: "application_database"; environmentId: string }>
  | Readonly<{ kind: "native_auth_database"; databaseId: string }>;
export interface NativeAuthRecoveryManifest {
  readonly schemaVersion: "ohmyhost.native-auth-inventory/v1";
  readonly organizationId: string;
  readonly projectId: string;
  readonly databaseId: string;
  readonly migrationVersion: number;
  readonly migrationDigest: string;
  readonly realms: readonly Readonly<{
    environmentId: string;
    schemaName: string;
    revocationEpoch: number;
    configurationRevision: number;
    dumpOffset?: number;
    dumpBytes?: number;
    dumpSha256?: string;
  }>[];
}
export interface RecoveryScopeV2 {
  readonly schemaVersion: "ohmyhost.recovery-scope/v2";
  readonly organizationId: string;
  readonly projectId: string;
  readonly backupId: string;
  readonly dataMode: "shared" | "isolated";
  readonly environments: Readonly<{ dev?: string; prod: string }>;
  readonly resources: readonly RecoveryResource[];
  readonly nativeManifest?: NativeAuthRecoveryManifest;
}
export interface RecoveryInputFileV2 {
  readonly resource: RecoveryResource;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface RecoveryReceipt {
  readonly format: "zip-aes256-ae2-v1";
  readonly backupId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly sqlFiles: readonly string[];
}
export type RecoveryReceiptV2 = Omit<RecoveryReceipt, "format"> & {
  readonly format: "zip-aes256-ae2-v2";
  readonly nativeManifest?: NativeAuthRecoveryManifest;
  readonly nativeManifestSha256?: string;
};

/** Packs trusted SQL dumps only; no configuration, runtime secret or object-storage contents. */
export async function createProjectRecoveryArchive(input: {
  readonly scope: RecoveryScope;
  readonly files: readonly RecoveryInputFile[];
  readonly inputDirectory: string;
  readonly archivePath: string;
  readonly passphrase: string;
  readonly capturedAt: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}): Promise<RecoveryReceipt> {
  const scope = parseRecoveryScope(input.scope);
  if (
    input.files.length !== scope.databaseEnvironments.length ||
    new Set(input.files.map((file) => file.namespaceId)).size !== input.files.length
  )
    invalid();
  for (const file of input.files) {
    exact(file, ["namespaceId", "path", "bytes", "sha256"]);
    if (
      !scope.databaseEnvironments.includes(file.namespaceId) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      !SHA256.test(file.sha256)
    )
      invalid();
  }
  const names = input.files.map((file) =>
    scope.dataMode === "shared"
      ? "shared.sql"
      : file.namespaceId === scope.environments.dev
        ? "dev.sql"
        : "prod.sql",
  );
  return writeArchive(input, scope.backupId, names, "zip-aes256-ae2-v1");
}

/** Versioned inventory uses a project Auth database identity, never a fabricated environment. */
export async function createProjectRecoveryArchiveV2(input: {
  readonly scope: RecoveryScopeV2;
  readonly files: readonly RecoveryInputFileV2[];
  readonly inputDirectory: string;
  readonly archivePath: string;
  readonly passphrase: string;
  readonly capturedAt: string;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
}): Promise<RecoveryReceiptV2> {
  const scope = parseRecoveryScopeV2(input.scope);
  if (input.files.length !== scope.resources.length) invalid();
  const identities = new Set(scope.resources.map(resourceKey));
  const seen = new Set<string>();
  for (const file of input.files) {
    exact(file, ["resource", "path", "bytes", "sha256"]);
    const key = resourceKey(file.resource);
    if (
      !identities.has(key) ||
      seen.has(key) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      !SHA256.test(file.sha256)
    )
      invalid();
    seen.add(key);
  }
  if (scope.nativeManifest) {
    const file = input.files.find((item) => item.resource.kind === "native_auth_database");
    if (
      !file ||
      scope.nativeManifest.realms.some(
        (realm) =>
          realm.dumpOffset === undefined ||
          realm.dumpBytes === undefined ||
          realm.dumpSha256 === undefined,
      )
    )
      invalid();
    const end = scope.nativeManifest.realms.reduce(
      (total, realm) => total + (realm.dumpBytes ?? 0),
      0,
    );
    if (end !== file.bytes) invalid();
    await verifyNativeSlices(
      await sourcePath(await realpath(input.inputDirectory), file.path),
      scope.nativeManifest.realms,
    );
  }
  const named = input.files
    .map((file) => ({
      file,
      name:
        file.resource.kind === "native_auth_database"
          ? "auth.sql"
          : scope.dataMode === "shared"
            ? "shared.sql"
            : file.resource.environmentId === scope.environments.dev
              ? "dev.sql"
              : "prod.sql",
    }))
    .sort(
      (a, b) =>
        ["shared.sql", "dev.sql", "prod.sql", "auth.sql"].indexOf(a.name) -
        ["shared.sql", "dev.sql", "prod.sql", "auth.sql"].indexOf(b.name),
    );
  const manifest =
    scope.nativeManifest === undefined ? undefined : JSON.stringify(scope.nativeManifest);
  const receipt = await writeArchive(
    {
      ...input,
      files: named.map((item) => item.file),
      ...(manifest === undefined ? {} : { manifest }),
    },
    scope.backupId,
    named.map((item) => item.name),
    "zip-aes256-ae2-v2",
  );
  return {
    ...receipt,
    ...(manifest === undefined
      ? {}
      : {
          nativeManifest: scope.nativeManifest,
          nativeManifestSha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
        }),
  };
}

async function verifyNativeSlices(
  path: string,
  realms: NativeAuthRecoveryManifest["realms"],
): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(65536);
    for (const realm of realms) {
      if (
        realm.dumpOffset === undefined ||
        realm.dumpBytes === undefined ||
        realm.dumpSha256 === undefined
      )
        invalid();
      const hash = createHash("sha256");
      let offset = realm.dumpOffset,
        remaining = realm.dumpBytes;
      while (remaining > 0) {
        const result = await file.read(buffer, 0, Math.min(buffer.length, remaining), offset);
        if (result.bytesRead < 1) throw new RecoveryArchiveError("recovery_source_changed");
        hash.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
        remaining -= result.bytesRead;
      }
      if (hash.digest("hex") !== realm.dumpSha256)
        throw new RecoveryArchiveError("recovery_source_changed");
    }
  } finally {
    await file.close();
  }
}

async function writeArchive<Format extends RecoveryReceipt["format"] | RecoveryReceiptV2["format"]>(
  input: {
    readonly files: readonly {
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    }[];
    readonly inputDirectory: string;
    readonly archivePath: string;
    readonly passphrase: string;
    readonly capturedAt: string;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
    readonly manifest?: string;
  },
  backupId: string,
  names: string[],
  format: Format,
): Promise<Omit<RecoveryReceipt, "format"> & { readonly format: Format }> {
  const limit = maximum(input.maximumBytes);
  validateRecoveryPassphrase(input.passphrase);
  timestamp(input.capturedAt);
  if (
    input.files.reduce((total, file) => total + file.bytes, 0) +
      (input.manifest === undefined ? 0 : Buffer.byteLength(input.manifest)) >
    limit
  )
    throw new RecoveryArchiveError("recovery_archive_too_large");
  const root = await realpath(input.inputDirectory);
  const paths = await Promise.all(input.files.map((file) => sourcePath(root, file.path)));
  const signal = input.signal ?? AbortSignal.timeout(900000);
  signal.throwIfAborted();
  let output;
  try {
    output = await open(input.archivePath, "wx", 0o600);
  } catch (error) {
    throw new RecoveryArchiveError(
      isExists(error) ? "recovery_destination_exists" : "recovery_io_failed",
    );
  }
  const hash = createHash("sha256");
  let bytes = 0,
    complete = false;
  const destination = new WritableStream<Uint8Array>({
    async write(chunk) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > limit + 1024 * 1024) throw new RecoveryArchiveError("recovery_archive_too_large");
      hash.update(chunk);
      await output.writeFile(chunk);
    },
  });
  const zip = new ZipWriter(destination, {
    password: input.passphrase,
    encryptionStrength: 3,
    zipCrypto: false,
    useWebWorkers: false,
    useCompressionStream: false,
    bufferedWrite: false,
    lastModDate: new Date(input.capturedAt),
    signal,
  });
  try {
    for (const [index, file] of input.files.entries()) {
      const path = paths[index],
        name = names[index];
      if (!path || !name) invalid();
      await zip.add(
        name,
        Readable.toWeb(Readable.from(verifiedSource(path, file))) as ReadableStream<Uint8Array>,
      );
    }
    if (input.manifest !== undefined)
      await zip.add(
        "manifest.json",
        Readable.toWeb(
          Readable.from([Buffer.from(input.manifest, "utf8")]),
        ) as ReadableStream<Uint8Array>,
      );
    await zip.close();
    await output.sync();
    complete = true;
    return {
      format,
      backupId,
      bytes,
      sha256: `sha256:${hash.digest("hex")}`,
      capturedAt: input.capturedAt,
      sqlFiles: names,
    };
  } catch (error) {
    throw recoveryError(error);
  } finally {
    await output.close();
    if (!complete) await unlink(input.archivePath);
  }
}

export function parseRecoveryScope(value: RecoveryScope): RecoveryScope {
  exact(value, [
    "organizationId",
    "projectId",
    "backupId",
    "dataMode",
    "databaseEnvironments",
    "environments",
  ]);
  const environments = parseEnvironmentMap(value.environments);
  for (const id of [value.organizationId, value.projectId, value.backupId])
    if (typeof id !== "string" || !ULID.test(id)) invalid();
  if (
    !["shared", "isolated"].includes(value.dataMode) ||
    (value.dataMode === "isolated" && environments.dev === environments.prod)
  )
    invalid();
  if (
    !Array.isArray(value.databaseEnvironments) ||
    value.databaseEnvironments.length < 1 ||
    value.databaseEnvironments.length > 2 ||
    new Set(value.databaseEnvironments).size !== value.databaseEnvironments.length ||
    value.databaseEnvironments.some(
      (id) =>
        !Object.values(environments).includes(id) ||
        (value.dataMode === "shared" && id !== (environments.dev ?? environments.prod)),
    )
  )
    invalid();
  return {
    organizationId: value.organizationId,
    projectId: value.projectId,
    backupId: value.backupId,
    dataMode: value.dataMode,
    databaseEnvironments: [...value.databaseEnvironments].sort(),
    environments,
  };
}

export function parseRecoveryScopeV2(value: RecoveryScopeV2): RecoveryScopeV2 {
  exact(value, [
    "schemaVersion",
    "organizationId",
    "projectId",
    "backupId",
    "dataMode",
    "environments",
    "resources",
    ...(value.nativeManifest === undefined ? [] : ["nativeManifest"]),
  ]);
  const environments = parseEnvironmentMap(value.environments);
  if (
    value.schemaVersion !== "ohmyhost.recovery-scope/v2" ||
    ![value.organizationId, value.projectId, value.backupId].every(
      (id) => typeof id === "string" && ULID.test(id),
    ) ||
    !["shared", "isolated"].includes(value.dataMode) ||
    (value.dataMode === "isolated" && environments.dev === environments.prod) ||
    !Array.isArray(value.resources) ||
    value.resources.length < 1 ||
    value.resources.length > 3
  )
    invalid();
  const keys = value.resources.map(resourceKey);
  if (
    new Set(keys).size !== keys.length ||
    value.resources.filter((r) => r.kind === "native_auth_database").length > 1 ||
    value.resources.some(
      (r) =>
        r.kind === "application_database" &&
        (!Object.values(environments).includes(r.environmentId) ||
          (value.dataMode === "shared" &&
            r.environmentId !== (environments.dev ?? environments.prod))),
    )
  )
    invalid();
  const native = value.resources.find((resource) => resource.kind === "native_auth_database");
  if ((native === undefined) !== (value.nativeManifest === undefined)) invalid();
  const manifest =
    value.nativeManifest === undefined
      ? undefined
      : parseNativeAuthRecoveryManifest(value.nativeManifest);
  if (
    native !== undefined &&
    (manifest?.organizationId !== value.organizationId ||
      manifest.projectId !== value.projectId ||
      manifest.databaseId !== native.databaseId)
  )
    invalid();
  return {
    ...value,
    environments,
    resources: [...value.resources].sort((a, b) => resourceKey(a).localeCompare(resourceKey(b))),
    ...(manifest === undefined ? {} : { nativeManifest: manifest }),
  };
}

/** Archive scopes require real Prod and may retain the historical Dev/Prod map. */
function parseEnvironmentMap(value: RecoveryScope["environments"]): RecoveryScope["environments"] {
  const hasDev = typeof value === "object" && value !== null && Object.hasOwn(value, "dev");
  exact(value, hasDev ? ["dev", "prod"] : ["prod"]);
  for (const id of Object.values(value)) if (typeof id !== "string" || !ULID.test(id)) invalid();
  return { ...value };
}

export function parseNativeAuthRecoveryManifest(
  value: NativeAuthRecoveryManifest,
): NativeAuthRecoveryManifest {
  exact(value, [
    "schemaVersion",
    "organizationId",
    "projectId",
    "databaseId",
    "migrationVersion",
    "migrationDigest",
    "realms",
  ]);
  if (
    value.schemaVersion !== "ohmyhost.native-auth-inventory/v1" ||
    !ULID.test(value.organizationId) ||
    !ULID.test(value.projectId) ||
    !/^[a-z][a-z0-9]{19}$/u.test(value.databaseId) ||
    value.migrationVersion !== NATIVE_AUTH_SCHEMA_MIGRATION_VERSION ||
    value.migrationDigest !== NATIVE_AUTH_SCHEMA_MIGRATION_SHA256 ||
    !Array.isArray(value.realms) ||
    value.realms.length < 1 ||
    value.realms.length > 2
  )
    invalid();
  const realms = value.realms
    .map((realm): NativeAuthRecoveryManifest["realms"][number] => {
      const { dumpOffset, dumpBytes, dumpSha256 } = realm;
      const hasDump =
        dumpOffset !== undefined || dumpBytes !== undefined || dumpSha256 !== undefined;
      exact(realm, [
        "environmentId",
        "schemaName",
        "revocationEpoch",
        "configurationRevision",
        ...(hasDump ? ["dumpOffset", "dumpBytes", "dumpSha256"] : []),
      ]);
      if (
        !ULID.test(realm.environmentId) ||
        realm.schemaName !== `omh_auth_${realm.environmentId.toLowerCase()}` ||
        !Number.isSafeInteger(realm.revocationEpoch) ||
        realm.revocationEpoch < 1 ||
        !Number.isSafeInteger(realm.configurationRevision) ||
        realm.configurationRevision < 1
      )
        invalid();
      const identity = {
        environmentId: realm.environmentId,
        schemaName: realm.schemaName,
        revocationEpoch: realm.revocationEpoch,
        configurationRevision: realm.configurationRevision,
      };
      if (!hasDump) return identity;
      if (
        typeof dumpOffset !== "number" ||
        !Number.isSafeInteger(dumpOffset) ||
        dumpOffset < 0 ||
        typeof dumpBytes !== "number" ||
        !Number.isSafeInteger(dumpBytes) ||
        dumpBytes < 1 ||
        typeof dumpSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(dumpSha256)
      )
        invalid();
      return { ...identity, dumpOffset, dumpBytes, dumpSha256 };
    })
    .sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  if (new Set(realms.map((realm) => realm.environmentId)).size !== realms.length) invalid();
  let nextOffset = 0;
  if (realms.some((realm) => realm.dumpOffset !== undefined)) {
    for (const realm of realms) {
      if (
        realm.dumpOffset !== nextOffset ||
        realm.dumpBytes === undefined ||
        realm.dumpSha256 === undefined
      )
        invalid();
      nextOffset += realm.dumpBytes;
      if (!Number.isSafeInteger(nextOffset)) invalid();
    }
  }
  return {
    schemaVersion: "ohmyhost.native-auth-inventory/v1",
    organizationId: value.organizationId,
    projectId: value.projectId,
    databaseId: value.databaseId,
    migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
    realms,
  };
}

export function resourceKey(value: RecoveryResource): string {
  if (!value || typeof value !== "object") invalid();
  if (value.kind === "application_database") {
    exact(value, ["kind", "environmentId"]);
    if (typeof value.environmentId !== "string" || !ULID.test(value.environmentId)) invalid();
    return `application_database:${value.environmentId}`;
  }
  if (value.kind === "native_auth_database") {
    exact(value, ["kind", "databaseId"]);
    if (typeof value.databaseId !== "string" || !/^[a-z][a-z0-9]{19}$/u.test(value.databaseId))
      invalid();
    return `native_auth_database:${value.databaseId}`;
  }
  return invalid();
}

async function sourcePath(root: string, path: string): Promise<string> {
  if (
    typeof path !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,512}$/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    invalid();
  const absolute = resolve(root, path);
  if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isFile()) invalid();
  return absolute;
}
async function* verifiedSource(
  path: string,
  expected: { readonly bytes: number; readonly sha256: string },
): AsyncGenerator<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (!status.isFile() || status.size !== expected.bytes)
      throw new RecoveryArchiveError("recovery_source_changed");
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      count += chunk.length;
      if (count > expected.bytes) throw new RecoveryArchiveError("recovery_source_changed");
      hash.update(chunk);
      yield chunk;
    }
    if (count !== expected.bytes || `sha256:${hash.digest("hex")}` !== expected.sha256)
      throw new RecoveryArchiveError("recovery_source_changed");
  } finally {
    await file.close();
  }
}
function exact(value: unknown, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== keys.sort().join(",")
  )
    invalid();
}
function maximum(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 40) invalid();
  return value;
}
export function validateRecoveryPassphrase(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value) > 1024)
    invalid();
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}
function isExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
function invalid(): never {
  throw new RecoveryArchiveError("recovery_input_invalid");
}
function recoveryError(error: unknown): RecoveryArchiveError {
  return error instanceof RecoveryArchiveError
    ? error
    : new RecoveryArchiveError("recovery_io_failed");
}
