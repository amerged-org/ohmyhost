import {
  readPgcfPostgresConnectionString,
  readPgcfPostgresTarget,
  type PgcfPostgresTarget,
} from "@ohmyhost/database/worker-postgres";
import type { EncryptedEnvironmentSecret } from "@ohmyhost/platform";
import { nativeCustody } from "./custody.js";
import { nativeRequestDeadline } from "./deadline.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** Metadata only. The same tuple is recorded and checked by Core before and after private effects. */
export interface NativeAuthRegistryReceipt {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly regionId: "us-dev" | "eu-dev";
  readonly originHost: string;
  readonly schema: string;
  readonly role: string;
  readonly targetVersion: number;
  readonly registryVersion: number;
  readonly registryReference: string;
  readonly status: "active";
}
export type NativeAuthRegistryScope = Pick<
  NativeAuthRegistryReceipt,
  "projectId" | "environmentId"
>;
export interface NativeAuthRegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface NativeAuthRegistryAuthority {
  /** Checks the current owner, operation claim and exact reserved target. */
  authorizeRegistration(receipt: NativeAuthRegistryReceipt): Promise<boolean>;
  /** Returns an active current-owner registration; no cached or client-provided authority. */
  readRegistration(scope: NativeAuthRegistryScope): Promise<NativeAuthRegistryReceipt | null>;
  /** Authorizes a current generation revocation under the active operation. */
  authorizeRevocation(input: NativeAuthRegistryRevocation): Promise<boolean>;
  /** Project deletion has its own frozen inventory authority, never a deployment claim. */
  authorizeDeletion(input: NativeAuthRegistryDeletion): Promise<boolean>;
  authorizeDeletionQuiescence(input: NativeAuthRegistryDeletion): Promise<boolean>;
}
export interface NativeAuthRegistryDeletion {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly registryVersion: number;
  readonly registryReference: string;
}
export interface NativeAuthRegistryRevocation {
  readonly receipt: NativeAuthRegistryReceipt;
  readonly operationId: string;
  readonly claimId: string;
  readonly registryVersion: number;
}
interface Stored {
  readonly receipt: NativeAuthRegistryReceipt;
  readonly fingerprint: string;
  readonly credential: EncryptedEnvironmentSecret | null;
  readonly engineSecret: EncryptedEnvironmentSecret;
  readonly revokedAtVersion: number | null;
}
interface Deleted {
  readonly deleted: NativeAuthRegistryDeletion;
}

/** Private per-realm registry; callers never derive authority from customer HTTP headers. */
export function createNativeAuthRegistry(input: {
  readonly regionId: "us-dev" | "eu-dev";
  readonly keyBase64: string;
  readonly keyVersion?: number;
  readonly additionalKeysJson?: string;
  readonly storage: NativeAuthRegistryStorage;
  readonly authority: NativeAuthRegistryAuthority;
  /** Closes any cached database pool before a credential generation changes. */
  readonly invalidate: () => Promise<void>;
}) {
  const cipher = nativeCustody({
    NATIVE_AUTH_CUSTODY_KEY_BASE64: input.keyBase64,
    NATIVE_AUTH_CUSTODY_KEY_VERSION: input.keyVersion ?? 1,
    ...(input.additionalKeysJson === undefined
      ? {}
      : { NATIVE_AUTH_CUSTODY_ADDITIONAL_KEYS_JSON: input.additionalKeysJson }),
  });
  let pending = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const read = async () => {
    const value = await input.storage.get<Stored | Deleted>("registration");
    if (value !== undefined && "deleted" in value) throw unavailable();
    if (value !== undefined) readReceipt(value.receipt, input.regionId);
    return value;
  };
  return Object.freeze({
    register(
      value: Omit<NativeAuthRegistryReceipt, "status"> & { readonly connectionString: string },
    ): Promise<NativeAuthRegistryReceipt> {
      return serialize(async () => {
        const { connectionString, ...metadata } = value;
        const receipt = readReceipt({ ...metadata, status: "active" }, input.regionId);
        readPgcfPostgresConnectionString(connectionString, target(receipt));
        if (!(await input.authority.authorizeRegistration(receipt))) throw unavailable();
        const fingerprint = await digest(`${JSON.stringify(receipt)}\n${connectionString}`);
        const current = await read();
        if (current) {
          sameRealm(current.receipt, receipt);
          if (
            current.receipt.registryVersion === receipt.registryVersion &&
            current.revokedAtVersion === null &&
            current.fingerprint === fingerprint
          ) {
            if (!(await input.authority.authorizeRegistration(receipt))) throw unavailable();
            return receipt;
          }
          if (
            receipt.registryVersion <=
            Math.max(current.receipt.registryVersion, current.revokedAtVersion ?? 0)
          )
            throw unavailable();
        }
        const credential = await cipher.encrypt({
          ...cipherScope(receipt),
          name: await cipherName(receipt),
          value: connectionString,
        });
        const engineSecret =
          current?.engineSecret ??
          (await cipher.encrypt({
            ...cipherScope(receipt),
            name: "NATIVE_AUTH_ENGINE_SECRET",
            value: randomSecret(),
          }));
        if (!(await input.authority.authorizeRegistration(receipt))) throw unavailable();
        await input.invalidate();
        await input.storage.put("registration", {
          receipt,
          fingerprint,
          credential,
          engineSecret,
          revokedAtVersion: null,
        } satisfies Stored);
        if (!(await input.authority.authorizeRegistration(receipt))) throw unavailable();
        return receipt;
      });
    },
    resolve(
      scope: NativeAuthRegistryScope,
      deadlineAt?: number,
      initialCheck?: (receipt: NativeAuthRegistryReceipt) => Promise<unknown>,
      afterDecryptCheck?: (
        receipt: NativeAuthRegistryReceipt,
      ) => Promise<NativeAuthRegistryReceipt | null>,
    ): Promise<{
      readonly initialSnapshot?: unknown;
      readonly connectionString: string;
      readonly secret: string;
      readonly schema: string;
      readonly target: PgcfPostgresTarget;
      readonly receipt: NativeAuthRegistryReceipt;
    }> {
      const deadline = nativeRequestDeadline(deadlineAt);
      const resolving = serialize(async () => {
        if (
          !ULID.test(scope.projectId) ||
          !ULID.test(scope.environmentId) ||
          Object.keys(scope).sort().join(",") !== "environmentId,projectId"
        )
          throw unavailable();
        const current = await deadline.run(read);
        if (!current?.credential || current.revokedAtVersion !== null) throw unavailable();
        const receipt = current.receipt;
        if (receipt.projectId !== scope.projectId || receipt.environmentId !== scope.environmentId)
          throw unavailable();
        const initialSnapshot =
          initialCheck === undefined ? undefined : await deadline.run(() => initialCheck(receipt));
        if (
          initialCheck === undefined &&
          !equalReceipt(await deadline.run(() => input.authority.readRegistration(scope)), receipt)
        )
          throw unavailable();
        const connectionString = await cipher.decrypt({
          ...cipherScope(receipt),
          name: await cipherName(receipt),
          ...current.credential,
        });
        const secret = await cipher.decrypt({
          ...cipherScope(receipt),
          name: "NATIVE_AUTH_ENGINE_SECRET",
          ...current.engineSecret,
        });
        readPgcfPostgresConnectionString(connectionString, target(receipt));
        const afterDecrypt =
          afterDecryptCheck === undefined
            ? await deadline.run(() => input.authority.readRegistration(scope))
            : await deadline.run(() => afterDecryptCheck(receipt));
        if (!equalReceipt(afterDecrypt, receipt)) throw unavailable();
        return Object.freeze({
          ...(initialCheck === undefined ? {} : { initialSnapshot }),
          connectionString,
          secret,
          schema: receipt.schema,
          target: target(receipt),
          receipt,
        });
      });
      return deadline.run(() => resolving);
    },
    revoke(value: NativeAuthRegistryRevocation): Promise<void> {
      return serialize(async () => {
        const receipt = readReceipt(value.receipt, input.regionId);
        if (
          !ULID.test(value.operationId) ||
          !ULID.test(value.claimId) ||
          !Number.isSafeInteger(value.registryVersion) ||
          value.registryVersion > 2_147_483_647 ||
          value.registryVersion !== receipt.registryVersion + 1 ||
          !(await input.authority.authorizeRevocation(value))
        )
          throw unavailable();
        const current = await read();
        if (!current || !equalReceipt(current.receipt, receipt)) throw unavailable();
        if (current.revokedAtVersion === value.registryVersion && current.credential === null)
          return;
        if (current.revokedAtVersion !== null || !current.credential) throw unavailable();
        await input.invalidate();
        if (!(await input.authority.authorizeRevocation(value))) throw unavailable();
        await input.storage.put("registration", {
          ...current,
          credential: null,
          revokedAtVersion: value.registryVersion,
        } satisfies Stored);
        if (!(await input.authority.authorizeRevocation(value))) throw unavailable();
      });
    },
    quiesceForDeletion(value: NativeAuthRegistryDeletion): Promise<{ status: "quiesced" }> {
      return serialize(async () => {
        if (!(await input.authority.authorizeDeletionQuiescence(value))) throw unavailable();
        const current = await input.storage.get<Stored | Deleted>("registration");
        if (current && "deleted" in current && !sameDeletionRealm(current.deleted, value))
          throw unavailable();
        if (
          current &&
          !("deleted" in current) &&
          (current.receipt.organizationId !== value.organizationId ||
            current.receipt.projectId !== value.projectId ||
            current.receipt.environmentId !== value.environmentId ||
            current.receipt.registryReference !== value.registryReference ||
            current.receipt.registryVersion !== value.registryVersion)
        )
          throw unavailable();
        await input.invalidate();
        if (!(await input.authority.authorizeDeletionQuiescence(value))) throw unavailable();
        return { status: "quiesced" };
      });
    },
    purgeForDeletion(value: NativeAuthRegistryDeletion): Promise<{ status: "absent" }> {
      return serialize(async () => {
        if (
          Object.keys(value).sort().join(",") !==
            "environmentId,operationId,organizationId,projectId,registryReference,registryVersion" ||
          ![value.organizationId, value.projectId, value.environmentId, value.operationId].every(
            (id) => ULID.test(id),
          ) ||
          !Number.isSafeInteger(value.registryVersion) ||
          value.registryVersion < 1 ||
          value.registryVersion > 2_147_483_647 ||
          value.registryReference !== `${value.projectId}:${value.environmentId}` ||
          !(await input.authority.authorizeDeletion(value))
        )
          throw unavailable();
        const current = await input.storage.get<Stored | Deleted>("registration");
        if (current && "deleted" in current) {
          if (!sameDeletionRealm(current.deleted, value)) throw unavailable();
          return { status: "absent" };
        }
        if (
          current &&
          (current.receipt.organizationId !== value.organizationId ||
            current.receipt.projectId !== value.projectId ||
            current.receipt.environmentId !== value.environmentId ||
            current.receipt.registryReference !== value.registryReference ||
            current.receipt.registryVersion !== value.registryVersion)
        )
          throw unavailable();
        await input.invalidate();
        if (!(await input.authority.authorizeDeletion(value))) throw unavailable();
        // A single durable overwrite erases both encrypted credentials and the engine key.
        await input.storage.put("registration", { deleted: { ...value } } satisfies Deleted);
        if (!(await input.authority.authorizeDeletion(value))) throw unavailable();
        return { status: "absent" };
      });
    },
  });
}

function sameDeletionRealm(a: NativeAuthRegistryDeletion, b: NativeAuthRegistryDeletion): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.environmentId === b.environmentId &&
    a.registryVersion === b.registryVersion &&
    a.registryReference === b.registryReference
  );
}

function readReceipt(
  value: NativeAuthRegistryReceipt,
  regionId: "us-dev" | "eu-dev",
): NativeAuthRegistryReceipt {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "claimId,databaseId,environmentId,operationId,organizationId,originHost,projectId,providerProjectId,regionId,registryReference,registryVersion,role,schema,status,targetVersion" ||
    ![
      value.organizationId,
      value.projectId,
      value.environmentId,
      value.operationId,
      value.claimId,
    ].every((id) => typeof id === "string" && ULID.test(id)) ||
    !PROVIDER_ID.test(value.providerProjectId) ||
    value.regionId !== regionId ||
    value.status !== "active" ||
    value.role !== `omh_ar_${value.environmentId.toLowerCase()}` ||
    value.schema !== `omh_auth_${value.environmentId.toLowerCase()}` ||
    !Number.isSafeInteger(value.targetVersion) ||
    value.targetVersion < 1 ||
    value.targetVersion > 2_147_483_647 ||
    !Number.isSafeInteger(value.registryVersion) ||
    value.registryVersion < 1 ||
    value.registryVersion > 2_147_483_647 ||
    value.registryReference !== `${value.projectId}:${value.environmentId}`
  )
    throw unavailable();
  readPgcfPostgresTarget(target(value));
  return Object.freeze({ ...value });
}
function target(receipt: NativeAuthRegistryReceipt): PgcfPostgresTarget {
  return {
    provider: "pgcf",
    host: receipt.originHost,
    databaseId: receipt.databaseId,
    role: receipt.role,
  };
}
function sameRealm(a: NativeAuthRegistryReceipt, b: NativeAuthRegistryReceipt): void {
  if (
    a.organizationId !== b.organizationId ||
    a.projectId !== b.projectId ||
    a.environmentId !== b.environmentId ||
    a.regionId !== b.regionId
  )
    throw unavailable();
}
function equalReceipt(a: NativeAuthRegistryReceipt | null, b: NativeAuthRegistryReceipt): boolean {
  return (
    a !== null &&
    Object.keys(b).every((key) => Reflect.get(a, key) === Reflect.get(b, key)) &&
    Object.keys(a).length === Object.keys(b).length
  );
}
function cipherScope(receipt: NativeAuthRegistryReceipt) {
  return {
    organizationId: receipt.organizationId,
    projectId: receipt.projectId,
    environmentId: receipt.environmentId,
  };
}
async function cipherName(receipt: NativeAuthRegistryReceipt): Promise<string> {
  return `NATIVE_AUTH_REGISTRY_${receipt.registryVersion}_${await digest(JSON.stringify(receipt))}`;
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
function unavailable(): Error {
  return new Error("auth_unavailable");
}
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    return btoa(String.fromCharCode(...bytes));
  } finally {
    bytes.fill(0);
  }
}
