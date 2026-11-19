import { parseUlid } from "../../shared/index.js";

const MAX_BYTES = 8 * 1024;
const FORMAT = "ohmyho.st/recovery-input/aes-256-gcm/v1";

export interface RecoveryInputScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
}

export interface SealedRecoveryInput {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly keyVersion: number;
}

/** Private queued-job material only; this key is separate from the user's archive password. */
export function createRecoveryInputCipher(input: {
  readonly key: Uint8Array;
  readonly keyVersion: number;
  readonly crypto: Crypto;
}) {
  if (
    !(input.key instanceof Uint8Array) ||
    input.key.byteLength !== 32 ||
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion < 1
  )
    throw new Error("recovery_input_invalid");
  const key = input.crypto.subtle.importKey("raw", new Uint8Array(input.key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return Object.freeze({
    async seal(scope: RecoveryInputScope, plaintext: Uint8Array): Promise<SealedRecoveryInput> {
      const aad = additionalData(scope, input.keyVersion);
      if (
        !(plaintext instanceof Uint8Array) ||
        plaintext.byteLength < 1 ||
        plaintext.byteLength > MAX_BYTES
      )
        throw new Error("recovery_input_invalid");
      const nonce = input.crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await input.crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad },
          await key,
          new Uint8Array(plaintext),
        ),
      );
      return { ciphertext, nonce, keyVersion: input.keyVersion };
    },
    async open(scope: RecoveryInputScope, sealed: SealedRecoveryInput): Promise<Uint8Array> {
      const aad = additionalData(scope, sealed.keyVersion);
      if (
        !(sealed.ciphertext instanceof Uint8Array) ||
        sealed.ciphertext.byteLength < 17 ||
        sealed.ciphertext.byteLength > MAX_BYTES + 16 ||
        !(sealed.nonce instanceof Uint8Array) ||
        sealed.nonce.byteLength !== 12
      )
        throw new Error("recovery_input_invalid");
      if (sealed.keyVersion !== input.keyVersion)
        throw new Error("recovery_input_decryption_failed");
      try {
        return new Uint8Array(
          await input.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(sealed.nonce), additionalData: aad },
            await key,
            new Uint8Array(sealed.ciphertext),
          ),
        );
      } catch {
        throw new Error("recovery_input_decryption_failed");
      }
    },
  });
}

function additionalData(scope: RecoveryInputScope, keyVersion: number): Uint8Array<ArrayBuffer> {
  try {
    parseUlid(scope.organizationId);
    parseUlid(scope.projectId);
    parseUlid(scope.operationId);
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error();
  } catch {
    throw new Error("recovery_input_invalid");
  }
  return new TextEncoder().encode(
    JSON.stringify([FORMAT, keyVersion, scope.organizationId, scope.projectId, scope.operationId]),
  );
}

export interface RecoveryJobInput {
  readonly version: 1;
  readonly passphrase: string;
}

/** Decodes only the authenticated archive password; configuration and credentials are not export inputs. */
export function parseRecoveryJobInput(bytes: Uint8Array): RecoveryJobInput {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES)
      throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !hasRecoveryKeys(value, ["version", "passphrase"]) ||
      value["version"] !== 1 ||
      typeof value["passphrase"] !== "string" ||
      value["passphrase"].trim().length === 0 ||
      new TextEncoder().encode(value["passphrase"]).length > 1024
    )
      throw new Error();
    return Object.freeze({ version: 1, passphrase: value["passphrase"] });
  } catch {
    throw new Error("recovery_input_invalid");
  }
}

function hasRecoveryKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Shared private dispatch protocol; no caller-selected credentials, locations or provider targets. */
export function parseRecoveryCommand(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("action" in value))
    throw new Error("RECOVERY_EVENT_INVALID");
  const action = value.action;
  if (
    action !== "run" &&
    action !== "download" &&
    action !== "purge" &&
    action !== "restore" &&
    action !== "purge-restore-pin" &&
    action !== "reconcile-restore-pin"
  )
    throw new Error("RECOVERY_EVENT_INVALID");
  const expected =
    action === "reconcile-restore-pin"
      ? `action,${Object.hasOwn(value, "delegation") ? "delegation," : ""}organizationId,principalId,projectId,restoreId`
      : action === "restore"
        ? "action,claimId,organizationId,projectId,restoreId"
        : action === "purge-restore-pin"
          ? "action,operationId,organizationId,projectId,restoreId"
          : action === "run"
            ? "action,claimId,operationId,organizationId,projectId"
            : action === "purge"
              ? "action,exportId,operationId,organizationId,projectId"
              : "action,operationId,organizationId,projectId";
  if (Object.keys(value).sort().join(",") !== expected) throw new Error("RECOVERY_EVENT_INVALID");
  const record = value as Record<string, unknown>;
  try {
    const { organizationId, projectId } = record;
    if (action === "reconcile-restore-pin") {
      if (
        typeof organizationId !== "string" ||
        typeof projectId !== "string" ||
        typeof record["restoreId"] !== "string" ||
        typeof record["principalId"] !== "string" ||
        record["principalId"].length < 1 ||
        record["principalId"].length > 256 ||
        (record["delegation"] !== undefined &&
          (typeof record["delegation"] !== "object" ||
            record["delegation"] === null ||
            Array.isArray(record["delegation"])))
      )
        throw new Error();
      return {
        action: "reconcile-restore-pin" as const,
        organizationId: parseUlid(organizationId),
        projectId: parseUlid(projectId),
        restoreId: parseUlid(record["restoreId"]),
        principalId: record["principalId"],
        ...(record["delegation"] === undefined ? {} : { delegation: record["delegation"] }),
      };
    }
    if (action === "restore") {
      if (
        typeof organizationId !== "string" ||
        typeof projectId !== "string" ||
        typeof record["restoreId"] !== "string" ||
        typeof record["claimId"] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(record["claimId"])
      )
        throw new Error();
      return {
        action: "restore" as const,
        organizationId: parseUlid(organizationId),
        projectId: parseUlid(projectId),
        restoreId: parseUlid(record["restoreId"]),
        claimId: record["claimId"],
      };
    }
    const { operationId } = record;
    if (
      typeof organizationId !== "string" ||
      typeof projectId !== "string" ||
      typeof operationId !== "string"
    )
      throw new Error();
    const scope = {
      organizationId: parseUlid(organizationId),
      projectId: parseUlid(projectId),
      operationId: parseUlid(operationId),
    };
    if (action === "download") return { action: "download" as const, ...scope };
    if (action === "purge-restore-pin") {
      if (typeof record["restoreId"] !== "string") throw new Error();
      return {
        action: "purge-restore-pin" as const,
        ...scope,
        restoreId: parseUlid(record["restoreId"]),
      };
    }
    if (action === "purge") {
      if (typeof record["exportId"] !== "string") throw new Error();
      return { action: "purge" as const, ...scope, exportId: parseUlid(record["exportId"]) };
    }
    const claimId = record["claimId"];
    if (
      typeof claimId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(claimId)
    )
      throw new Error();
    return { action: "run" as const, ...scope, claimId };
  } catch {
    throw new Error("RECOVERY_EVENT_INVALID");
  }
}
