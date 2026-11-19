import {
  readPgcfPostgresConnectionString,
  readPgcfPostgresTarget,
  type PgcfPostgresTarget,
} from "@ohmyhost/database";
import {
  createEnvironmentSecretCipher,
  projectSqlRoleName,
  type EncryptedEnvironmentSecret,
} from "@ohmyhost/platform";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
export type DatabaseRegion = "us" | "eu";
export interface DatabasePhysicalScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly physicalEnvironmentId: string;
  readonly region: DatabaseRegion;
}
export interface DatabaseBindingScope extends DatabasePhysicalScope {
  readonly environmentId: string;
  readonly registrationVersion: number;
}
export interface DatabaseRegistrationBase extends DatabasePhysicalScope {
  readonly operationId: string;
  readonly registrationVersion: number;
  readonly providerProjectId: string;
  readonly originHost: string;
  readonly originUser: string;
  readonly authorizedEnvironmentIds: readonly string[];
  readonly status: "active" | "revoked";
}
export interface NeonDatabaseRegistrationReceipt extends DatabaseRegistrationBase {
  readonly provider?: never;
  readonly branchId: string;
  readonly originDatabase: "neondb";
}
export interface PgcfDatabaseRegistrationReceipt extends DatabaseRegistrationBase {
  readonly provider: "pgcf";
  readonly databaseId: string;
  readonly originDatabase: string;
}
export type DatabaseRegistrationReceipt =
  | NeonDatabaseRegistrationReceipt
  | PgcfDatabaseRegistrationReceipt;
export type ProjectDatabaseRegistrationReceipt = DatabaseRegistrationReceipt;
export type DatabaseRegistration =
  | (Omit<NeonDatabaseRegistrationReceipt, "status"> & { readonly pooledConnectionString: string })
  | (Omit<PgcfDatabaseRegistrationReceipt, "status"> & { readonly connectionString: string });
export interface DatabaseRebinding {
  readonly expectedRegistration: DatabaseRegistrationReceipt;
  readonly registration: Omit<PgcfDatabaseRegistrationReceipt, "status"> & {
    readonly connectionString: string;
  };
}
export interface DatabaseRevocation extends DatabasePhysicalScope {
  readonly operationId: string;
  readonly registrationVersion: number;
  readonly expectedRegistration?: DatabaseRegistrationReceipt;
}
export interface DatabaseRegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface StoredRegistration {
  readonly receipt: DatabaseRegistrationReceipt;
  readonly credential: EncryptedEnvironmentSecret;
  readonly fingerprint: string;
  readonly authorizedSince: Readonly<Record<string, number>>;
  readonly rebindFrom?: DatabaseRegistrationReceipt;
}

/** This module never accepts a database target from customer query arguments. */
export function readDatabaseBindingScope(
  value: unknown,
  region: DatabaseRegion,
): DatabaseBindingScope {
  const input = record(value);
  exact(input, [
    "organizationId",
    "projectId",
    "physicalEnvironmentId",
    "region",
    "environmentId",
    "registrationVersion",
  ]);
  const scope = physicalScope(input, region);
  if (!ULID.test(String(input["environmentId"]))) throw unavailable();
  return Object.freeze({
    ...scope,
    environmentId: input["environmentId"] as string,
    registrationVersion: version(input["registrationVersion"]),
  });
}

export function readDatabaseRegistrationReceipt(value: unknown): DatabaseRegistrationReceipt {
  const input = record(value);
  exact(input, [
    "organizationId",
    "projectId",
    "physicalEnvironmentId",
    "region",
    "operationId",
    "registrationVersion",
    "providerProjectId",
    ...(input["provider"] === "pgcf" ? ["provider", "databaseId"] : ["branchId"]),
    "originHost",
    "originDatabase",
    "originUser",
    "authorizedEnvironmentIds",
    "status",
  ]);
  const scope = physicalScope(input);
  if (
    !ULID.test(String(input["operationId"])) ||
    !PROVIDER_ID.test(String(input["providerProjectId"])) ||
    input["originUser"] !== projectSqlRoleName(scope.physicalEnvironmentId, "runtime") ||
    (input["status"] !== "active" && input["status"] !== "revoked")
  )
    throw unavailable();
  const host = input["originHost"];
  if (input["provider"] === "pgcf") {
    const target = readPgcfPostgresTarget({
      provider: "pgcf",
      host,
      databaseId: input["databaseId"],
      role: input["originUser"],
    } as PgcfPostgresTarget);
    if (input["originDatabase"] !== target.databaseId) throw unavailable();
  } else {
    if (!PROVIDER_ID.test(String(input["branchId"])) || input["originDatabase"] !== "neondb")
      throw unavailable();
    const hostPattern =
      scope.region === "us"
        ? /^ep-[a-z0-9-]+-pooler\.(?:c-[0-9]+\.)?us-east-[12]\.aws\.neon\.tech$/u
        : /^ep-[a-z0-9-]+-pooler\.(?:c-[0-9]+\.)?eu-central-1\.aws\.neon\.tech$/u;
    if (typeof host !== "string" || !hostPattern.test(host)) throw unavailable();
  }
  const environments = input["authorizedEnvironmentIds"];
  if (
    !Array.isArray(environments) ||
    environments.length < 1 ||
    environments.length > 2 ||
    environments.some((id) => typeof id !== "string" || !ULID.test(id)) ||
    new Set(environments).size !== environments.length
  )
    throw unavailable();
  return Object.freeze({
    ...scope,
    operationId: input["operationId"] as string,
    registrationVersion: version(input["registrationVersion"]),
    providerProjectId: input["providerProjectId"] as string,
    ...(input["provider"] === "pgcf"
      ? {
          provider: "pgcf" as const,
          databaseId: input["databaseId"] as string,
          originDatabase: input["databaseId"] as string,
        }
      : { branchId: input["branchId"] as string, originDatabase: "neondb" as const }),
    originHost: host as string,
    originUser: input["originUser"] as string,
    authorizedEnvironmentIds: Object.freeze([...environments].sort()),
    status: input["status"],
  });
}

export function readDatabasePhysicalScope(
  value: unknown,
  region?: DatabaseRegion,
): DatabasePhysicalScope {
  const input = record(value);
  exact(input, ["organizationId", "projectId", "physicalEnvironmentId", "region"]);
  return physicalScope(input, region);
}

export function databaseObjectName(scope: DatabasePhysicalScope): string {
  return `${scope.organizationId}:${scope.projectId}:${scope.physicalEnvironmentId}`;
}

/** One registry key: the key version is stored with every credential sealed under it. */
export interface DatabaseRegistryKey {
  readonly keyVersion: number;
  readonly keyBase64: string;
}

/**
 * The current key seals every credential. The previous key, while present, only opens credentials
 * still sealed under it; each such credential is re-sealed under the current key when it is read.
 */
export interface DatabaseRegistryKeyRing {
  readonly current: DatabaseRegistryKey;
  readonly previous?: DatabaseRegistryKey;
}

/** Reads the registry key ring from the Worker's secrets; the version defaults to 1, the first key. */
export function databaseRegistryKeyRing(environment: {
  readonly DATABASE_REGISTRY_KEY: string;
  readonly DATABASE_REGISTRY_KEY_VERSION?: string;
  readonly DATABASE_REGISTRY_KEY_PREVIOUS?: string;
  readonly DATABASE_REGISTRY_KEY_PREVIOUS_VERSION?: string;
}): DatabaseRegistryKeyRing {
  const version = (value: string | undefined) => {
    if (value === undefined) return 1;
    if (!/^[1-9][0-9]{0,8}$/u.test(value)) throw unavailable();
    return Number(value);
  };
  const current = {
    keyVersion: version(environment.DATABASE_REGISTRY_KEY_VERSION),
    keyBase64: environment.DATABASE_REGISTRY_KEY,
  };
  if (environment.DATABASE_REGISTRY_KEY_PREVIOUS === undefined) return { current };
  return {
    current,
    previous: {
      keyVersion: version(environment.DATABASE_REGISTRY_KEY_PREVIOUS_VERSION),
      keyBase64: environment.DATABASE_REGISTRY_KEY_PREVIOUS,
    },
  };
}

export function createDatabaseRegistry(input: {
  readonly region: DatabaseRegion;
  readonly keyRing: DatabaseRegistryKeyRing;
  readonly storage: DatabaseRegistryStorage;
  readonly invalidate: (
    next: DatabaseRegistrationReceipt,
    credentialsChanged: boolean,
  ) => Promise<void>;
}) {
  const sealer = createEnvironmentSecretCipher({
    keyBase64: input.keyRing.current.keyBase64,
    keyVersion: input.keyRing.current.keyVersion,
    crypto,
  });
  const openers = new Map(
    [input.keyRing.current, input.keyRing.previous]
      .filter((key): key is DatabaseRegistryKey => key !== undefined)
      .map((key) => [
        key.keyVersion,
        createEnvironmentSecretCipher({
          keyBase64: key.keyBase64,
          keyVersion: key.keyVersion,
          crypto,
        }),
      ]),
  );
  let current: StoredRegistration | undefined;
  let transitionalEnvironments: readonly string[] | undefined;
  let ready: Promise<void> | undefined;
  let pending = Promise.resolve();
  const load = () =>
    (ready ??= input.storage.get<StoredRegistration>("registration").then((stored) => {
      if (stored !== undefined) {
        const receipt = readDatabaseRegistrationReceipt(stored.receipt);
        if (receipt.region !== input.region || typeof stored.fingerprint !== "string")
          throw unavailable();
        // Existing durable receipts permitted only their exact generation; that is their floor.
        const authorizedSince = readAuthorizedSince(stored.authorizedSince, receipt);
        current = { ...stored, receipt, authorizedSince };
      }
    }));
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const persist = async (next: StoredRegistration) => {
    // Publish the new generation before asynchronous cleanup, closing authorization races.
    const previous = current;
    const credentialsChanged =
      !previous ||
      previous.receipt.status !== "active" ||
      next.receipt.status !== "active" ||
      !previous.credential.valueSha256.every(
        (byte, index) => byte === next.credential.valueSha256[index],
      );
    transitionalEnvironments = credentialsChanged
      ? []
      : next.receipt.authorizedEnvironmentIds.filter((environmentId) =>
          previous.receipt.authorizedEnvironmentIds.includes(environmentId),
        );
    current = next;
    try {
      await input.invalidate(next.receipt, credentialsChanged);
      await input.storage.put("registration", next);
    } catch {
      // Re-read durable state on retry after an uncertain write; never authorize cached state.
      current = undefined;
      ready = undefined;
      throw unavailable();
    } finally {
      transitionalEnvironments = undefined;
    }
  };
  const authorizeConnection = async (value: DatabaseBindingScope) => {
    const scope = readDatabaseBindingScope(value, input.region);
    await load();
    const authorized = () => {
      const registered = current;
      if (
        (transitionalEnvironments && !transitionalEnvironments.includes(scope.environmentId)) ||
        !registered ||
        registered.receipt.status !== "active" ||
        registered.receipt.registrationVersion < scope.registrationVersion ||
        (registered.authorizedSince[scope.environmentId] ?? Number.POSITIVE_INFINITY) >
          scope.registrationVersion ||
        !registered.receipt.authorizedEnvironmentIds.includes(scope.environmentId)
      )
        throw unavailable();
      assertSameScope(scope, registered.receipt);
      return registered;
    };
    const registered = authorized();
    const opener = openers.get(registered.credential.keyVersion);
    if (opener === undefined) throw unavailable();
    const uri = await opener.decrypt({
      ...(await cipherIdentity(registered.receipt)),
      ...registered.credential,
    });
    if (registered.credential.keyVersion !== input.keyRing.current.keyVersion) {
      // Re-seal under the current key once; a concurrent change of the stored credential is not overwritten.
      const credential = await sealer.encrypt({
        ...(await cipherIdentity(registered.receipt)),
        value: uri,
      });
      await serialize(async () => {
        if (current === registered) await persist({ ...registered, credential });
      });
    }
    const latest = authorized();
    if (latest !== registered) {
      assertSameTarget(latest.receipt, registered.receipt);
      if (
        !registered.credential.valueSha256.every(
          (byte, index) => byte === latest.credential.valueSha256[index],
        )
      )
        throw unavailable();
    }
    validateConnectionUri(uri, latest.receipt);
    return Object.freeze({ uri, receipt: latest.receipt });
  };
  return Object.freeze({
    register(value: unknown): Promise<DatabaseRegistrationReceipt> {
      return serialize(async () => {
        const registration = record(value);
        const { pooledConnectionString, connectionString, ...metadata } = registration;
        const uri = metadata["provider"] === "pgcf" ? connectionString : pooledConnectionString;
        if (
          metadata["provider"] === "pgcf"
            ? pooledConnectionString !== undefined
            : connectionString !== undefined
        )
          throw unavailable();
        const receipt = readDatabaseRegistrationReceipt({ ...metadata, status: "active" });
        if (receipt.region !== input.region || typeof uri !== "string") throw unavailable();
        validateConnectionUri(uri, receipt);
        const fingerprint = await digest(`${JSON.stringify(receipt)}\n${uri}`);
        await load();
        if (current !== undefined) {
          assertSameScope(receipt, current.receipt);
          assertSameTarget(receipt, current.receipt);
          if (
            receipt.registrationVersion === current.receipt.registrationVersion &&
            fingerprint === current.fingerprint
          )
            return current.receipt;
          if (receipt.registrationVersion <= current.receipt.registrationVersion)
            throw unavailable();
        }
        const credential = await sealer.encrypt({
          ...(await cipherIdentity(receipt)),
          value: uri,
        });
        const authorizedSince = Object.freeze(
          Object.fromEntries(
            receipt.authorizedEnvironmentIds.map((environmentId) => [
              environmentId,
              current?.receipt.status === "active"
                ? (current.authorizedSince[environmentId] ?? receipt.registrationVersion)
                : receipt.registrationVersion,
            ]),
          ),
        );
        await persist({ receipt, credential, fingerprint, authorizedSince });
        return receipt;
      });
    },
    rebind(value: unknown): Promise<PgcfDatabaseRegistrationReceipt> {
      return serialize(async () => {
        const request = record(value);
        exact(request, ["expectedRegistration", "registration"]);
        const expected = readDatabaseRegistrationReceipt(request["expectedRegistration"]);
        if (expected.provider === "pgcf") throw unavailable();
        const registration = record(request["registration"]);
        const { connectionString, ...metadata } = registration;
        const receipt = readDatabaseRegistrationReceipt({ ...metadata, status: "active" });
        if (
          receipt.provider !== "pgcf" ||
          typeof connectionString !== "string" ||
          receipt.region !== input.region ||
          receipt.registrationVersion !== expected.registrationVersion + 1
        )
          throw unavailable();
        assertSameScope(receipt, expected);
        if (
          JSON.stringify(receipt.authorizedEnvironmentIds) !==
          JSON.stringify(expected.authorizedEnvironmentIds)
        )
          throw unavailable();
        validateConnectionUri(connectionString, receipt);
        const fingerprint = await digest(`${JSON.stringify(receipt)}\n${connectionString}`);
        await load();
        if (
          current?.fingerprint === fingerprint &&
          JSON.stringify(current.rebindFrom) === JSON.stringify(expected)
        )
          return receipt;
        if (!current || JSON.stringify(current.receipt) !== JSON.stringify(expected))
          throw unavailable();
        const credential = await sealer.encrypt({
          ...(await cipherIdentity(receipt)),
          value: connectionString,
        });
        await persist({
          receipt,
          credential,
          fingerprint,
          rebindFrom: expected,
          // A target replacement is a new authority generation even when logical scopes survive.
          authorizedSince: Object.freeze(
            Object.fromEntries(
              receipt.authorizedEnvironmentIds.map((id) => [id, receipt.registrationVersion]),
            ),
          ),
        });
        return receipt;
      });
    },
    revoke(value: unknown): Promise<DatabaseRegistrationReceipt> {
      return serialize(async () => {
        const revocation = record(value);
        exact(revocation, [
          "organizationId",
          "projectId",
          "physicalEnvironmentId",
          "region",
          "operationId",
          "registrationVersion",
          ...(Object.hasOwn(revocation, "expectedRegistration") ? ["expectedRegistration"] : []),
        ]);
        const scope = physicalScope(revocation, input.region);
        if (!ULID.test(String(revocation["operationId"]))) throw unavailable();
        const registrationVersion = version(revocation["registrationVersion"]);
        const expected =
          revocation["expectedRegistration"] === undefined
            ? undefined
            : readDatabaseRegistrationReceipt(revocation["expectedRegistration"]);
        if (expected) {
          assertSameScope(scope, expected);
          if (
            expected.status !== "active" ||
            registrationVersion !== expected.registrationVersion + 1
          )
            throw unavailable();
        }
        await load();
        const prior = current?.receipt ?? expected;
        if (!prior) throw unavailable();
        assertSameScope(scope, prior);
        if (
          expected &&
          (!sameTarget(prior, expected) ||
            JSON.stringify(prior.authorizedEnvironmentIds) !==
              JSON.stringify(expected.authorizedEnvironmentIds))
        )
          throw unavailable();
        const receipt = readDatabaseRegistrationReceipt({
          ...prior,
          operationId: revocation["operationId"],
          registrationVersion,
          status: "revoked",
        });
        const fingerprint = await digest(JSON.stringify(receipt));
        if (current) {
          if (
            registrationVersion === current.receipt.registrationVersion &&
            fingerprint === current.fingerprint
          )
            return current.receipt;
          if (registrationVersion <= current.receipt.registrationVersion) throw unavailable();
        }
        // Revocation keeps no decryptable connection string, only an audit receipt.
        await persist({
          receipt,
          fingerprint,
          authorizedSince: readAuthorizedSince(current?.authorizedSince, receipt),
          credential: {
            ciphertext: new Uint8Array(),
            nonce: new Uint8Array(),
            valueSha256: new Uint8Array(),
            keyVersion: input.keyRing.current.keyVersion,
          },
        });
        return receipt;
      });
    },
    async authorize(value: DatabaseBindingScope): Promise<string> {
      return (await authorizeConnection(value)).uri;
    },
    authorizeConnection,
    async inspect(value: unknown): Promise<DatabaseRegistrationReceipt | null> {
      const scope = readDatabasePhysicalScope(value, input.region);
      await load();
      if (!current) return null;
      assertSameScope(scope, current.receipt);
      return current.receipt;
    },
  });
}

/** Remove URI query options before giving pg an explicit strict TLS policy. */
export function databaseTlsConfiguration(connectionString: string) {
  const uri = new URL(connectionString);
  if (
    !/^postgres(?:ql)?:$/u.test(uri.protocol) ||
    uri.username === "" ||
    uri.password === "" ||
    uri.hostname === "" ||
    !["require", "verify-full"].includes(uri.searchParams.get("sslmode") ?? "")
  )
    throw unavailable();
  return {
    host: uri.hostname,
    port: 5432,
    database: decodeURIComponent(uri.pathname.slice(1)),
    user: decodeURIComponent(uri.username),
    password: decodeURIComponent(uri.password),
    ssl: { rejectUnauthorized: true, servername: uri.hostname },
  };
}

function validateConnectionUri(value: string, receipt: DatabaseRegistrationReceipt): void {
  if (receipt.provider === "pgcf") {
    readPgcfPostgresConnectionString(value, pgcfTarget(receipt));
    return;
  }
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    value.length > 5120 ||
    !/^postgres(?:ql)?:$/u.test(uri.protocol) ||
    uri.hostname !== receipt.originHost ||
    decodeURIComponent(uri.pathname.slice(1)) !== receipt.originDatabase ||
    decodeURIComponent(uri.username) !== receipt.originUser ||
    uri.password === "" ||
    (uri.port !== "" && uri.port !== "5432") ||
    uri.hash !== "" ||
    !["require", "verify-full"].includes(uri.searchParams.get("sslmode") ?? "") ||
    [...uri.searchParams.keys()].some((key) => key !== "sslmode" && key !== "channel_binding") ||
    uri.searchParams.getAll("sslmode").length !== 1 ||
    (uri.searchParams.has("channel_binding") &&
      uri.searchParams.get("channel_binding") !== "require")
  )
    throw unavailable();
}
export function pgcfTarget(receipt: PgcfDatabaseRegistrationReceipt): PgcfPostgresTarget {
  return {
    provider: "pgcf",
    host: receipt.originHost,
    databaseId: receipt.databaseId,
    role: receipt.originUser,
  };
}
async function cipherIdentity(receipt: DatabaseRegistrationReceipt) {
  return {
    organizationId: receipt.organizationId,
    projectId: receipt.projectId,
    environmentId: receipt.physicalEnvironmentId,
    name: `DATABASE_RUNTIME_V1_${receipt.registrationVersion}_${await digest(JSON.stringify(receipt))}`,
  };
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
function physicalScope(
  input: Record<string, unknown>,
  region?: DatabaseRegion,
): DatabasePhysicalScope {
  if (
    ![input["organizationId"], input["projectId"], input["physicalEnvironmentId"]].every(
      (id) => typeof id === "string" && ULID.test(id),
    ) ||
    (input["region"] !== "us" && input["region"] !== "eu") ||
    (region !== undefined && input["region"] !== region)
  )
    throw unavailable();
  return Object.freeze({
    organizationId: input["organizationId"] as string,
    projectId: input["projectId"] as string,
    physicalEnvironmentId: input["physicalEnvironmentId"] as string,
    region: input["region"],
  });
}
function assertSameScope(left: DatabasePhysicalScope, right: DatabasePhysicalScope): void {
  if (
    left.organizationId !== right.organizationId ||
    left.projectId !== right.projectId ||
    left.physicalEnvironmentId !== right.physicalEnvironmentId ||
    left.region !== right.region
  )
    throw unavailable();
}
function sameTarget(
  left: DatabaseRegistrationReceipt,
  right: DatabaseRegistrationReceipt,
): boolean {
  return (
    left.provider === right.provider &&
    left.providerProjectId === right.providerProjectId &&
    (left.provider === "pgcf"
      ? right.provider === "pgcf" && left.databaseId === right.databaseId
      : right.provider !== "pgcf" && left.branchId === right.branchId) &&
    left.originHost === right.originHost &&
    left.originDatabase === right.originDatabase &&
    left.originUser === right.originUser
  );
}
function assertSameTarget(
  left: DatabaseRegistrationReceipt,
  right: DatabaseRegistrationReceipt,
): void {
  if (!sameTarget(left, right)) throw unavailable();
}
function readAuthorizedSince(
  value: unknown,
  receipt: DatabaseRegistrationReceipt,
): Readonly<Record<string, number>> {
  if (value === undefined)
    return Object.freeze(
      Object.fromEntries(
        receipt.authorizedEnvironmentIds.map((environmentId) => [
          environmentId,
          receipt.registrationVersion,
        ]),
      ),
    );
  const input = record(value);
  exact(input, [...receipt.authorizedEnvironmentIds]);
  for (const floor of Object.values(input))
    if (version(floor) > receipt.registrationVersion) throw unavailable();
  return Object.freeze({ ...input }) as Readonly<Record<string, number>>;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw unavailable();
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw unavailable();
}
function unavailable(): Error {
  return new Error("project_database_unavailable");
}
