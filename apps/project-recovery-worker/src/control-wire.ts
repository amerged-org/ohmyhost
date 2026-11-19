/**
 * The closed wire contract between the recovery Node container and the Worker that mediates its access to Control.
 * Both sides import this one module: the Worker validates every request body here before it names a private store
 * method, and the Node client decodes every answer here. There is no SQL, no database URL and no free-form method.
 * Binary values (sealed input ciphertext/nonce, archive digests) cross as tagged canonical base64 and come back
 * byte for byte.
 */
export type { NativeRestoreClaim } from "./native-restore-job.js";

/** The virtual hostname the container's egress interception answers. It is never resolved by DNS. */
export const RECOVERY_CONTROL_HOST = "recovery-control.internal";
/** The named outbound handler the Container class routes the virtual host to. */
export const RECOVERY_CONTROL_HANDLER = "control";
export const MAX_CONTROL_REQUEST_BYTES = 16 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
export const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const RECOVERY_CONTROL_METHODS = [
  "readClaimState",
  "claim",
  "acquireFence",
  "renewFence",
  "releaseFence",
  "readInventory",
  "authorizeNativeCapture",
  "prepareArchive",
  "dispatchArchive",
  "discardArchive",
  "finish",
  "readArchive",
  "readCleanupTarget",
  "recordNativeExportRetired",
  "readRestorePinDeletionTarget",
  "recordRestorePinDeletionAbsent",
  "readPinReconciliation",
  "completePinReconciliation",
  "readRestoreClaim",
  "readRestoreInput",
  "reserveRestorePin",
  "recordRestorePin",
  "recordRestorePinAbsent",
  "beginRestore",
  "assertRestoreImportAllowed",
  "isRestoreAcknowledged",
  "applyRestoreOffline",
  "acknowledgeRestore",
  "isRestoreRealmImported",
  "markRestoreRealmImported",
  "markRestoreImported",
  "revalidateRestore",
  "sanitizeRestore",
  "completeRestore",
] as const;
export type RecoveryControlMethod = (typeof RECOVERY_CONTROL_METHODS)[number];

/** Least privilege per container action: a run may capture, a download may only read the archive locator. */
export const CONTROL_METHODS_BY_ACTION = {
  run: [
    "readClaimState",
    "claim",
    "acquireFence",
    "renewFence",
    "releaseFence",
    "readInventory",
    "authorizeNativeCapture",
    "prepareArchive",
    "dispatchArchive",
    "discardArchive",
    "finish",
  ],
  download: ["readArchive"],
  purge: ["readCleanupTarget", "recordNativeExportRetired"],
  "purge-restore-pin": ["readRestorePinDeletionTarget", "recordRestorePinDeletionAbsent"],
  "reconcile-restore-pin": ["readPinReconciliation", "completePinReconciliation"],
  restore: [
    "readRestoreClaim",
    "readRestoreInput",
    "reserveRestorePin",
    "recordRestorePin",
    "recordRestorePinAbsent",
    "beginRestore",
    "assertRestoreImportAllowed",
    "isRestoreAcknowledged",
    "applyRestoreOffline",
    "acknowledgeRestore",
    "isRestoreRealmImported",
    "markRestoreRealmImported",
    "markRestoreImported",
    "revalidateRestore",
    "sanitizeRestore",
    "completeRestore",
  ],
} as const satisfies Record<string, readonly RecoveryControlMethod[]>;
export type ControlAction = keyof typeof CONTROL_METHODS_BY_ACTION;

export const CONTROL_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "token_expired",
  "not_found",
  "invalid_request",
  "payload_too_large",
  "recovery_fence_lost",
  "recovery_source_busy",
  "project_recovery_conflict",
  "recovery_scope_unavailable",
  "recovery_database_not_ready",
  "recovery_inventory_invalid",
  "recovery_cleanup_scope_unavailable",
  "control_outcome_unknown",
  "control_unavailable",
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/** Codes that say nothing was applied or that the outcome is unknown: the caller keeps the job running and retries later. */
const RETRYABLE: readonly ControlErrorCode[] = ["control_outcome_unknown", "control_unavailable"];

export class RecoveryControlError extends Error {
  constructor(readonly code: ControlErrorCode) {
    super(code);
    this.name = "RecoveryControlError";
  }
  get retryable(): boolean {
    return RETRYABLE.includes(this.code);
  }
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FAILURE = /^[A-Z][A-Z0-9_]{0,95}$/u;
const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof STATUSES)[number];

const invalid = (): never => {
  throw new RecoveryControlError("invalid_request");
};
export const isUlid = (value: unknown): value is string =>
  typeof value === "string" && ULID.test(value);
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Canonical standard base64 only (no whitespace, no alternate padding), so the bytes are the stored bytes. */
export function decodeBytes(value: unknown, minimum: number, maximum: number): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4) return invalid();
  let text: string;
  try {
    text = atob(value);
  } catch {
    return invalid();
  }
  const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
  if (bytes.byteLength < minimum || bytes.byteLength > maximum || encodeBytes(bytes) !== value)
    return invalid();
  return bytes;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const found = Object.keys(value).sort();
  const sorted = [...keys].sort();
  if (found.length !== sorted.length || found.some((key, index) => key !== sorted[index]))
    return invalid();
  return value as Record<string, unknown>;
}
const integer = (value: unknown, minimum: number, maximum: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : invalid();
const text = (value: unknown, pattern: RegExp): string =>
  typeof value === "string" && pattern.test(value) ? value : invalid();

export interface WireArchive {
  readonly sqlFiles: readonly string[];
  readonly bytes: number;
  readonly sha256: Uint8Array;
  readonly capturedAt: string;
  readonly nativeManifest?: string;
  readonly nativeManifestSha256?: Uint8Array;
}
export interface WireFence {
  readonly epoch: number;
  readonly holderId: string;
}

function parseFence(value: unknown): WireFence {
  const raw = record(value, ["epoch", "holderId"]);
  return {
    epoch: integer(raw["epoch"], 1, Number.MAX_SAFE_INTEGER),
    holderId: text(raw["holderId"], UUID),
  };
}

function parseArchive(value: unknown): WireArchive {
  const input = asRecord(value);
  const hasManifest =
    input["nativeManifest"] !== undefined || input["nativeManifestSha256"] !== undefined;
  const raw = record(value, [
    "sqlFiles",
    "bytes",
    "sha256",
    "capturedAt",
    ...(hasManifest ? ["nativeManifest", "nativeManifestSha256"] : []),
  ]);
  const files = raw["sqlFiles"];
  if (!validSqlFiles(files)) return invalid();
  if (files.includes("auth.sql") !== hasManifest) return invalid();
  const capturedAt = text(raw["capturedAt"], ISO);
  if (new Date(capturedAt).toISOString() !== capturedAt) return invalid();
  return {
    sqlFiles: files,
    bytes: integer(raw["bytes"], 1, 536_870_912),
    sha256: decodeBytes(raw["sha256"], 32, 32),
    capturedAt,
    ...(hasManifest
      ? {
          nativeManifest: text(raw["nativeManifest"], /^\{[\s\S]{1,16382}\}$/u),
          nativeManifestSha256: decodeBytes(raw["nativeManifestSha256"], 32, 32),
        }
      : {}),
  };
}

function validSqlFiles(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    [
      ["dev.sql"],
      ["prod.sql"],
      ["dev.sql", "prod.sql"],
      ["shared.sql"],
      ["auth.sql"],
      ["dev.sql", "auth.sql"],
      ["prod.sql", "auth.sql"],
      ["dev.sql", "prod.sql", "auth.sql"],
      ["shared.sql", "auth.sql"],
    ].some((set) => JSON.stringify(value) === JSON.stringify(set))
  );
}

const lease = (value: unknown): number => integer(value, 1_000, 900_000);

/**
 * Validates one request body. The body never names an organization, project, operation or claim: the Worker supplies
 * them from the ephemeral job token. Anything else in the body is refused.
 */
export function parseControlBody(
  method: RecoveryControlMethod,
  value: unknown,
): Record<string, unknown> {
  switch (method) {
    case "readClaimState":
    case "readInventory":
    case "readArchive":
    case "readCleanupTarget":
    case "readRestorePinDeletionTarget":
    case "recordRestorePinDeletionAbsent":
    case "readPinReconciliation":
    case "readRestoreClaim":
    case "readRestoreInput":
    case "reserveRestorePin":
    case "recordRestorePin":
    case "recordRestorePinAbsent":
    case "beginRestore":
    case "assertRestoreImportAllowed":
    case "markRestoreImported":
    case "completeRestore":
      return record(value, []);
    case "recordNativeExportRetired": {
      const raw = record(value, ["outcome"]);
      return { outcome: oneOf(raw["outcome"], ["absent", "tombstoned"] as const) };
    }
    case "completePinReconciliation": {
      const raw = record(value, ["outcome"]);
      return { outcome: oneOf(raw["outcome"], ["verified", "tombstoned"] as const) };
    }
    case "isRestoreRealmImported":
    case "markRestoreRealmImported":
    case "revalidateRestore":
    case "sanitizeRestore": {
      const raw = record(value, ["environmentId"]);
      return { environmentId: text(raw["environmentId"], ULID) };
    }
    case "isRestoreAcknowledged": {
      const raw = record(value, ["environmentId", "kind"]);
      return {
        environmentId: text(raw["environmentId"], ULID),
        kind: oneOf(raw["kind"], ["offline", "sanitized"] as const),
      };
    }
    case "acknowledgeRestore":
    case "applyRestoreOffline": {
      const raw = record(
        value,
        method === "applyRestoreOffline"
          ? ["environmentId", "revocationEpoch", "configurationRevision", "canonicalOrigin"]
          : ["environmentId", "kind", "revocationEpoch", "configurationRevision"],
      );
      return {
        environmentId: text(raw["environmentId"], ULID),
        revocationEpoch: integer(raw["revocationEpoch"], 1, 2_147_483_647),
        configurationRevision: integer(raw["configurationRevision"], 1, 2_147_483_647),
        ...(method === "applyRestoreOffline"
          ? {
              canonicalOrigin:
                raw["canonicalOrigin"] === null || typeof raw["canonicalOrigin"] === "string"
                  ? raw["canonicalOrigin"]
                  : invalid(),
            }
          : { kind: oneOf(raw["kind"], ["offline", "sanitized"] as const) }),
      };
    }
    case "claim": {
      // Before any fence: nothing. Inside a fence: the holder, and with it the epoch the denial step releases.
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) return {};
        if (keys.includes("epoch")) {
          const raw = record(value, ["epoch", "holderId"]);
          return { ...parseFence(raw) };
        }
      }
      const raw = record(value, ["holderId"]);
      return { holderId: text(raw["holderId"], UUID) };
    }
    case "acquireFence": {
      const raw = record(value, ["holderId", "leaseMilliseconds"]);
      return {
        holderId: text(raw["holderId"], UUID),
        leaseMilliseconds: lease(raw["leaseMilliseconds"]),
      };
    }
    case "renewFence": {
      const raw = record(value, ["epoch", "holderId", "leaseMilliseconds"]);
      return {
        ...parseFence({ epoch: raw["epoch"], holderId: raw["holderId"] }),
        leaseMilliseconds: lease(raw["leaseMilliseconds"]),
      };
    }
    case "releaseFence":
      return { ...parseFence(value) };
    case "authorizeNativeCapture": {
      const raw = record(value, ["fence"]);
      return { fence: parseFence(raw["fence"]) };
    }
    case "prepareArchive":
    case "dispatchArchive":
    case "discardArchive": {
      const raw = record(value, ["archive", "fence"]);
      return { archive: parseArchive(raw["archive"]), fence: parseFence(raw["fence"]) };
    }
    case "finish": {
      if (typeof value === "object" && value !== null && "archive" in value) {
        const raw = record(value, ["archive", "fence"]);
        return { archive: parseArchive(raw["archive"]), fence: parseFence(raw["fence"]) };
      }
      if (typeof value === "object" && value !== null && "fence" in value) {
        const raw = record(value, ["failureCode", "fence"]);
        return { failureCode: text(raw["failureCode"], FAILURE), fence: parseFence(raw["fence"]) };
      }
      const raw = record(value, ["failureCode"]);
      return { failureCode: text(raw["failureCode"], FAILURE) };
    }
  }
}

/** A request body as it travels: binary fields tagged canonical base64. */
export function encodeControlBody(body: Record<string, unknown>): string {
  return JSON.stringify(body, (_key, value: unknown) =>
    value instanceof Uint8Array ? encodeBytes(value) : value,
  );
}

const BYTES_TAG = "$b64";

/** The answer as it travels: every byte string becomes `{ "$b64": canonical base64 }`. */
export function encodeControlResult(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) =>
    item instanceof Uint8Array ? { [BYTES_TAG]: encodeBytes(item) } : item,
  );
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0]?.[0] === BYTES_TAG)
    return decodeBytes(entries[0][1], 0, MAX_CONTROL_RESPONSE_BYTES);
  return Object.fromEntries(entries.map(([key, item]) => [key, revive(item)]));
}

export interface WireSealedInput {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly keyVersion: number;
}
export type WireClaim =
  | { readonly status: JobStatus | "absent" }
  | {
      readonly status: "claimed";
      readonly preparedArchive: WireArchive | null;
      readonly expired: boolean;
      readonly denialCode: "RECOVERY_SCOPE_UNAVAILABLE" | "RECOVERY_INPUT_EXPIRED" | null;
      readonly replayed: boolean;
      readonly archiveBucket: string;
      readonly archiveKey: string;
      readonly sealedInput: WireSealedInput | null;
    };
export interface WireFenceLease extends WireFence {
  readonly outcome: "acquired" | "renewed" | "replayed";
  readonly leaseExpiresAt: string;
  readonly sourceOwnershipVersion: number;
  readonly sourceLifecycleVersion: number;
}
export interface WireDatabaseReference {
  readonly provider: "pgcf";
  readonly providerProjectId: string;
  readonly databaseId: string;
  readonly regionId: string;
  readonly postgresVersion: "18";
  readonly databaseName: string;
  readonly roleName: string;
  readonly databaseEnvironmentId: string;
  readonly targetVersion: number;
}
export interface WireInventoryEnvironment {
  readonly environmentId: string;
  readonly name: "dev" | "prod";
  readonly databaseEnvironmentId: string;
  readonly database: WireDatabaseReference | null;
}
export interface WireInventory {
  readonly dataMode: "shared" | "isolated";
  readonly ownershipVersion: number;
  readonly lifecycleVersion: number;
  readonly environments:
    | readonly [WireInventoryEnvironment]
    | readonly [WireInventoryEnvironment, WireInventoryEnvironment];
  readonly nativeAuthDatabase?: WireNativeAuthDatabase;
}
export interface WireNativeAuthDatabase {
  readonly kind: "native_auth_database";
  readonly provider: "pgcf";
  readonly providerProjectId: string;
  readonly projectId: string;
  readonly databaseId: string;
  readonly regionId: "us-dev" | "eu-dev";
  readonly roleName: string;
  readonly targetVersion: number;
  readonly realms: readonly {
    readonly environmentId: string;
    readonly schemaName: string;
    readonly revocationEpoch: number;
    readonly configurationRevision: number;
  }[];
}
export interface WireArchiveLocator extends WireArchive {
  readonly operationId: string;
  readonly bucket: string;
  readonly key: string;
  readonly expiresAt: string;
}

/** The typed closed surface the Node job runner uses. Scope is implicit: the token names it. */
export interface RecoveryControl {
  readClaimState(): Promise<{ readonly status: JobStatus } | null>;
  claim(input?: { readonly holderId: string; readonly epoch?: number }): Promise<WireClaim>;
  acquireFence(input: { holderId: string; leaseMilliseconds: number }): Promise<WireFenceLease>;
  renewFence(input: WireFence & { leaseMilliseconds: number }): Promise<WireFenceLease>;
  releaseFence(input: WireFence): Promise<{
    readonly outcome: "released" | "replayed" | "superseded" | "absent";
  }>;
  readInventory(): Promise<WireInventory | null>;
  authorizeNativeCapture?(input: { fence: WireFence }): Promise<{ readonly authorized: true }>;
  prepareArchive(input: {
    archive: WireArchive;
    fence: WireFence;
  }): Promise<{ readonly outcome: "prepared" | "replayed" }>;
  dispatchArchive?(input: {
    archive: WireArchive;
    fence: WireFence;
  }): Promise<{ readonly granted: boolean }>;
  discardArchive(input: {
    archive: WireArchive;
    fence: WireFence;
  }): Promise<{ readonly outcome: "discarded" | "replayed" }>;
  finish(
    input: { archive: WireArchive; fence: WireFence } | { failureCode: string; fence?: WireFence },
  ): Promise<{ readonly outcome: "finished" | "replayed" | "waiting"; readonly status: JobStatus }>;
  readArchive(): Promise<WireArchiveLocator | null>;
  readCleanupTarget(): Promise<{
    exportId: string;
    bucket: string;
    key: string;
    nativeEffect?: {
      state: "reserved" | "dispatched" | "verified" | "tombstoned" | "absent";
      bytes: number;
      sha256: string;
    };
  }>;
  recordNativeExportRetired?(input: { outcome: "absent" | "tombstoned" }): Promise<unknown>;
  readRestorePinDeletionTarget(): Promise<{ restoreId: string; bucket: string }>;
  recordRestorePinDeletionAbsent(): Promise<"recorded" | "replayed">;
  readPinReconciliation(): Promise<{
    bucket: string;
    key: string;
    bytes: number;
    sha256: string;
    state: "reserved" | "verified" | "tombstoned";
  }>;
  completePinReconciliation(input: {
    outcome: "verified" | "tombstoned";
  }): Promise<{ status: "verified" | "tombstoned" }>;
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  allowed.includes(value as T) ? (value as T) : invalid();
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
const bytesOf = (value: unknown, length?: number): Uint8Array =>
  value instanceof Uint8Array && (length === undefined || value.byteLength === length)
    ? value
    : invalid();

function resultArchive(value: unknown): WireArchive {
  const raw = asRecord(value);
  return {
    sqlFiles: validSqlFiles(raw["sqlFiles"]) ? raw["sqlFiles"] : invalid(),
    bytes: integer(raw["bytes"], 1, 536_870_912),
    sha256: bytesOf(raw["sha256"], 32),
    capturedAt: text(raw["capturedAt"], ISO),
    ...(raw["nativeManifest"] === undefined || raw["nativeManifest"] === null
      ? {}
      : {
          nativeManifest: text(raw["nativeManifest"], /^\{[\s\S]{1,16382}\}$/u),
          nativeManifestSha256: bytesOf(raw["nativeManifestSha256"], 32),
        }),
  };
}

function resultLease(value: unknown): WireFenceLease {
  const raw = asRecord(value);
  return {
    outcome: oneOf(raw["outcome"], ["acquired", "renewed", "replayed"] as const),
    epoch: integer(raw["epoch"], 1, Number.MAX_SAFE_INTEGER),
    holderId: text(raw["holderId"], UUID),
    leaseExpiresAt: typeof raw["leaseExpiresAt"] === "string" ? raw["leaseExpiresAt"] : invalid(),
    sourceOwnershipVersion: integer(raw["sourceOwnershipVersion"], 0, Number.MAX_SAFE_INTEGER),
    sourceLifecycleVersion: integer(raw["sourceLifecycleVersion"], 0, Number.MAX_SAFE_INTEGER),
  };
}

function resultClaim(value: unknown): WireClaim {
  const raw = asRecord(value);
  if (raw["status"] !== "claimed")
    return { status: oneOf(raw["status"], [...STATUSES, "absent"] as const) };
  const sealed = raw["sealedInput"];
  const sealedRaw = sealed === null ? null : asRecord(sealed);
  return {
    status: "claimed",
    preparedArchive: raw["preparedArchive"] === null ? null : resultArchive(raw["preparedArchive"]),
    expired: raw["expired"] === true,
    denialCode:
      raw["denialCode"] === null
        ? null
        : oneOf(raw["denialCode"], [
            "RECOVERY_SCOPE_UNAVAILABLE",
            "RECOVERY_INPUT_EXPIRED",
          ] as const),
    replayed: raw["replayed"] === true,
    archiveBucket: text(raw["archiveBucket"], /^ohmyho-(development|production)-backups$/u),
    archiveKey: text(
      raw["archiveKey"],
      /^(?:snapshots|native-exports)\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.zip$/u,
    ),
    sealedInput:
      sealedRaw === null
        ? null
        : {
            ciphertext: bytesOf(sealedRaw["ciphertext"]),
            nonce: bytesOf(sealedRaw["nonce"], 12),
            keyVersion: integer(sealedRaw["keyVersion"], 1, Number.MAX_SAFE_INTEGER),
          },
  };
}

function resultInventory(value: unknown): WireInventory | null {
  if (value === null) return null;
  const raw = asRecord(value);
  const environments = raw["environments"];
  if (!Array.isArray(environments) || environments.length < 1 || environments.length > 2)
    return invalid();
  const parse = (item: unknown, name: "dev" | "prod"): WireInventoryEnvironment => {
    const environment = asRecord(item);
    const database = environment["database"];
    const reference = database === null ? null : asRecord(database);
    return {
      environmentId: text(environment["environmentId"], ULID),
      name: oneOf(environment["name"], [name]),
      databaseEnvironmentId: text(environment["databaseEnvironmentId"], ULID),
      database:
        reference === null
          ? null
          : {
              provider: oneOf(reference["provider"], ["pgcf"] as const),
              providerProjectId: text(reference["providerProjectId"], /^prj_[a-z0-9]{20}$/u),
              databaseId: text(reference["databaseId"], /^[a-z][a-z0-9]{19}$/u),
              regionId: text(reference["regionId"], /^[a-z0-9-]{1,32}$/u),
              postgresVersion: oneOf(reference["postgresVersion"], ["18"] as const),
              databaseName: text(reference["databaseName"], /^[a-z][a-z0-9]{19}$/u),
              roleName: text(reference["roleName"], /^ohmyho_backup_[0-9a-z]{26}$/u),
              databaseEnvironmentId: text(reference["databaseEnvironmentId"], ULID),
              targetVersion: integer(reference["targetVersion"], 1, Number.MAX_SAFE_INTEGER),
            },
    };
  };
  return {
    dataMode: oneOf(raw["dataMode"], ["shared", "isolated"] as const),
    ownershipVersion: integer(raw["ownershipVersion"], 0, Number.MAX_SAFE_INTEGER),
    lifecycleVersion: integer(raw["lifecycleVersion"], 0, Number.MAX_SAFE_INTEGER),
    environments:
      environments.length === 1
        ? [parse(environments[0], "prod")]
        : [parse(environments[0], "dev"), parse(environments[1], "prod")],
    ...(raw["nativeAuthDatabase"] === undefined
      ? {}
      : {
          nativeAuthDatabase: (() => {
            const n = record(raw["nativeAuthDatabase"], [
              "kind",
              "provider",
              "providerProjectId",
              "projectId",
              "databaseId",
              "regionId",
              "roleName",
              "targetVersion",
              "realms",
            ]);
            const projectId = text(n["projectId"], ULID);
            const roleName = text(n["roleName"], /^omh_ab_[0-7][0-9a-hjkmnp-tv-z]{25}$/u);
            if (roleName !== `omh_ab_${projectId.toLowerCase()}`) return invalid();
            if (!Array.isArray(n["realms"]) || n["realms"].length < 1 || n["realms"].length > 2)
              return invalid();
            const realms = n["realms"].map((value) => {
              const realm = record(value, [
                "environmentId",
                "schemaName",
                "revocationEpoch",
                "configurationRevision",
              ]);
              const environmentId = text(realm["environmentId"], ULID);
              const schemaName = text(
                realm["schemaName"],
                /^omh_auth_[0-7][0-9a-hjkmnp-tv-z]{25}$/u,
              );
              if (schemaName !== `omh_auth_${environmentId.toLowerCase()}`) return invalid();
              return {
                environmentId,
                schemaName,
                revocationEpoch: integer(realm["revocationEpoch"], 1, 2147483647),
                configurationRevision: integer(realm["configurationRevision"], 1, 2147483647),
              };
            });
            if (
              new Set(realms.map((r) => r.environmentId)).size !== realms.length ||
              realms.some(
                (r, index) =>
                  index > 0 && r.environmentId <= (realms[index - 1]?.environmentId ?? ""),
              )
            )
              return invalid();
            return {
              kind: oneOf(n["kind"], ["native_auth_database"] as const),
              provider: oneOf(n["provider"], ["pgcf"] as const),
              providerProjectId: text(n["providerProjectId"], /^prj_[a-z0-9]{20}$/u),
              projectId,
              databaseId: text(n["databaseId"], /^[a-z][a-z0-9]{19}$/u),
              regionId: oneOf(n["regionId"], ["us-dev", "eu-dev"] as const),
              roleName,
              targetVersion: integer(n["targetVersion"], 1, Number.MAX_SAFE_INTEGER),
              realms,
            };
          })(),
        }),
  };
}

/** Decodes and shape-checks one answer. Binary values come back as the exact bytes the store holds. */
function restorePin(value: unknown) {
  const raw = record(value, ["bucket", "key", "bytes", "sha256", "state"]);
  return {
    bucket: text(raw["bucket"], /^ohmyho-(development|production)-backups$/u),
    key: text(
      raw["key"],
      /^restore-pins\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.zip$/u,
    ),
    bytes: integer(raw["bytes"], 1, 536870912),
    sha256: text(raw["sha256"], /^[a-f0-9]{64}$/u),
    state: oneOf(raw["state"], ["reserved", "verified"] as const),
  };
}
export function decodeControlResult(method: RecoveryControlMethod, body: string): unknown {
  let value: unknown;
  try {
    value = revive(JSON.parse(body));
  } catch {
    throw new RecoveryControlError("control_unavailable");
  }
  try {
    switch (method) {
      case "readRestoreClaim":
      case "beginRestore": {
        const raw = asRecord(value),
          scopeValue = record(raw["scope"], ["organizationId", "projectId", "restoreId"]);
        const scope = {
          organizationId: text(scopeValue["organizationId"], ULID),
          projectId: text(scopeValue["projectId"], ULID),
          restoreId: text(scopeValue["restoreId"], ULID),
        };
        if (raw["completed"] === true) {
          record(value, ["scope", "completed", "pin"]);
          const pin = restorePin(raw["pin"]);
          if (
            pin.state !== "verified" ||
            pin.key !==
              `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip`
          )
            return invalid();
          return { scope, completed: true, pin };
        }
        record(value, [
          "scope",
          "completed",
          "phase",
          "inputState",
          "imported",
          "archive",
          "target",
          "realms",
          "pin",
        ]);
        if (raw["completed"] !== false || typeof raw["imported"] !== "boolean") return invalid();
        const archive = record(raw["archive"], [
            "bucket",
            "key",
            "bytes",
            "sha256",
            "nativeManifest",
            "nativeManifestSha256",
            "capturedAt",
          ]),
          target = record(raw["target"], [
            "organizationId",
            "projectId",
            "databaseId",
            "providerProjectId",
            "regionId",
          ]);
        const phase = oneOf(raw["phase"], ["preflight", "restoring"] as const);
        if (
          target["organizationId"] !== scope.organizationId ||
          target["projectId"] !== scope.projectId ||
          !Array.isArray(raw["realms"]) ||
          raw["realms"].length > 2 ||
          (phase === "preflight" ? raw["realms"].length !== 0 : raw["realms"].length < 1)
        )
          return invalid();
        const realms = raw["realms"].map((item) => {
          const r = record(item, [
            "environmentId",
            "revocationEpoch",
            "configurationRevision",
            "canonicalOrigin",
          ]);
          return {
            environmentId: text(r["environmentId"], ULID),
            revocationEpoch: integer(r["revocationEpoch"], 1, 2_147_483_647),
            configurationRevision: integer(r["configurationRevision"], 1, 2_147_483_647),
            canonicalOrigin:
              r["canonicalOrigin"] === null
                ? null
                : text(r["canonicalOrigin"], /^https:\/\/[a-z0-9.-]+$/u),
          };
        });
        const key = text(
          archive["key"],
          /^(?:snapshots|native-exports)\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.zip$/u,
        );
        if (!key.startsWith(`native-exports/${scope.organizationId}/${scope.projectId}/`))
          return invalid();
        const pin = raw["pin"] === null ? null : restorePin(raw["pin"]);
        if (
          pin &&
          (pin.key !==
            `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip` ||
            pin.bucket !== archive["bucket"] ||
            pin.sha256 !== archive["sha256"] ||
            pin.bytes !== archive["bytes"])
        )
          return invalid();
        return {
          scope,
          completed: false,
          phase,
          inputState: oneOf(raw["inputState"], ["claimed", "consumed"] as const),
          imported: raw["imported"],
          pin,
          archive: {
            bucket: text(archive["bucket"], /^ohmyho-(development|production)-backups$/u),
            key,
            bytes: integer(archive["bytes"], 1, 536_870_912),
            sha256: text(archive["sha256"], /^[a-f0-9]{64}$/u),
            nativeManifest: text(archive["nativeManifest"], /^\{[\s\S]{1,16382}\}$/u),
            nativeManifestSha256: text(archive["nativeManifestSha256"], /^[a-f0-9]{64}$/u),
            capturedAt: text(archive["capturedAt"], ISO),
          },
          target: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            databaseId: text(target["databaseId"], /^[a-z][a-z0-9]{19}$/u),
            providerProjectId: text(target["providerProjectId"], /^prj_[a-z0-9]{20}$/u),
            regionId: oneOf(target["regionId"], ["us-dev", "eu-dev"] as const),
          },
          realms,
        };
      }
      case "reserveRestorePin": {
        const raw = record(value, ["bucket", "key", "bytes", "sha256", "state", "created"]);
        if (typeof raw["created"] !== "boolean") return invalid();
        return {
          ...restorePin({
            bucket: raw["bucket"],
            key: raw["key"],
            bytes: raw["bytes"],
            sha256: raw["sha256"],
            state: raw["state"],
          }),
          created: raw["created"],
        };
      }
      case "recordRestorePin":
      case "recordRestorePinAbsent":
        if (record(value, ["status"])["status"] !== "recorded") return invalid();
        return { status: "recorded" };
      case "readRestoreInput": {
        const raw = record(value, ["ciphertext", "nonce", "keyVersion"]),
          ciphertext = bytesOf(raw["ciphertext"]);
        if (ciphertext.byteLength < 17 || ciphertext.byteLength > 8208) return invalid();
        return {
          ciphertext,
          nonce: bytesOf(raw["nonce"], 12),
          keyVersion: integer(raw["keyVersion"], 1, 2_147_483_647),
        };
      }
      case "assertRestoreImportAllowed":
        if (record(value, ["allowed"])["allowed"] !== true) return invalid();
        return { allowed: true };
      case "isRestoreRealmImported":
      case "isRestoreAcknowledged": {
        const key = method === "isRestoreRealmImported" ? "imported" : "acknowledged",
          raw = record(value, [key]);
        if (typeof raw[key] !== "boolean") return invalid();
        return { [key]: raw[key] };
      }
      case "markRestoreRealmImported":
        if (record(value, ["imported"])["imported"] !== true) return invalid();
        return { imported: true };
      case "markRestoreImported":
        if (record(value, ["status"])["status"] !== "consumed") return invalid();
        return { status: "consumed" };
      case "sanitizeRestore": {
        const raw = record(value, ["status", "revocationEpoch", "configurationRevision"]);
        if (raw["status"] !== "sanitized") return invalid();
        return {
          status: "sanitized",
          revocationEpoch: integer(raw["revocationEpoch"], 1, 2_147_483_647),
          configurationRevision: integer(raw["configurationRevision"], 1, 2_147_483_647),
        };
      }
      case "applyRestoreOffline":
      case "acknowledgeRestore":
      case "revalidateRestore":
      case "completeRestore":
        if (record(value, ["status"])["status"] !== "ok") return invalid();
        return undefined;
      case "readClaimState":
        return value === null ? null : { status: oneOf(asRecord(value)["status"], STATUSES) };
      case "claim":
        return resultClaim(value);
      case "acquireFence":
      case "renewFence":
        return resultLease(value);
      case "releaseFence":
        return {
          outcome: oneOf(asRecord(value)["outcome"], [
            "released",
            "replayed",
            "superseded",
            "absent",
          ] as const),
        };
      case "readInventory":
        return resultInventory(value);
      case "authorizeNativeCapture":
        if (record(value, ["authorized"])["authorized"] !== true) return invalid();
        return { authorized: true };
      case "prepareArchive":
        return { outcome: oneOf(asRecord(value)["outcome"], ["prepared", "replayed"] as const) };
      case "dispatchArchive": {
        const raw = record(value, ["granted"]);
        if (typeof raw["granted"] !== "boolean") return invalid();
        return { granted: raw["granted"] };
      }
      case "discardArchive":
        return { outcome: oneOf(asRecord(value)["outcome"], ["discarded", "replayed"] as const) };
      case "finish": {
        const raw = asRecord(value);
        return {
          outcome: oneOf(raw["outcome"], ["finished", "replayed", "waiting"] as const),
          status: oneOf(raw["status"], STATUSES),
        };
      }
      case "readCleanupTarget": {
        const raw = asRecord(value);
        record(value, [
          "exportId",
          "bucket",
          "key",
          ...(raw["nativeEffect"] === undefined ? [] : ["nativeEffect"]),
        ]);
        return {
          ...(raw["nativeEffect"] === undefined
            ? {}
            : {
                nativeEffect: (() => {
                  const effect = record(raw["nativeEffect"], ["state", "bytes", "sha256"]);
                  return {
                    state: oneOf(effect["state"], [
                      "reserved",
                      "dispatched",
                      "verified",
                      "tombstoned",
                      "absent",
                    ] as const),
                    bytes: integer(effect["bytes"], 1, 536870912),
                    sha256: text(effect["sha256"], /^[a-f0-9]{64}$/u),
                  };
                })(),
              }),
          exportId: text(raw["exportId"], ULID),
          bucket: text(raw["bucket"], /^ohmyho-(development|production)-backups$/u),
          key:
            typeof raw["key"] === "string" && raw["key"].length > 0 && raw["key"].length <= 1024
              ? raw["key"]
              : invalid(),
        };
      }
      case "recordNativeExportRetired":
        return {
          outcome: oneOf(record(value, ["outcome"])["outcome"], ["recorded", "replayed"] as const),
        };
      case "readRestorePinDeletionTarget": {
        const raw = record(value, ["restoreId", "bucket"]);
        return {
          restoreId: text(raw["restoreId"], ULID),
          bucket: text(raw["bucket"], /^ohmyho-(development|production)-backups$/u),
        };
      }
      case "recordRestorePinDeletionAbsent":
        return oneOf(value, ["recorded", "replayed"] as const);
      case "readPinReconciliation": {
        const raw = record(value, ["bucket", "key", "bytes", "sha256", "state"]);
        return {
          bucket: text(raw["bucket"], /^ohmyho-(development|production)-backups$/u),
          key: text(
            raw["key"],
            /^restore-pins\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.zip$/u,
          ),
          bytes: integer(raw["bytes"], 1, 536870912),
          sha256: text(raw["sha256"], /^[a-f0-9]{64}$/u),
          state: oneOf(raw["state"], ["reserved", "verified", "tombstoned"] as const),
        };
      }
      case "completePinReconciliation": {
        const raw = record(value, ["status"]);
        return { status: oneOf(raw["status"], ["verified", "tombstoned"] as const) };
      }
      case "readArchive": {
        if (value === null) return null;
        const raw = asRecord(value);
        return {
          ...resultArchive(raw),
          operationId: text(raw["operationId"], ULID),
          bucket: text(raw["bucket"], /^ohmyho-(development|production)-backups$/u),
          key: typeof raw["key"] === "string" ? raw["key"] : invalid(),
          expiresAt: text(raw["expiresAt"], ISO),
        };
      }
    }
  } catch {
    throw new RecoveryControlError("control_unavailable");
  }
}
