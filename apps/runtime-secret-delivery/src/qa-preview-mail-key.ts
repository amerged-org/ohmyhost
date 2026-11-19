import { createEnvironmentSecretCipherKeyring } from "@ohmyhost/platform";
import { requireRuntimeSecretDeliveryBindings } from "./bindings.js";

const ORGANIZATION = "01M145HEM4JWAP8KJBG92BSCGE";
const PROJECT = "01M700N2PQY18W4NGX2TSM9FKT";
const ENVIRONMENT = "01M700N2PQY18W4NGX2TSM9FKZ";
const NAME = "OHMYHOST_MAIL_KEY";
const FIELDS = [
  "organizationId",
  "projectId",
  "environmentId",
  "name",
  "ciphertext",
  "nonce",
  "valueSha256",
  "keyVersion",
  "revision",
  "devAccessEpoch",
  "senderDomain",
  "senderRevision",
].sort();

type Envelope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  valueSha256: Uint8Array;
  keyVersion: number;
  revision: number;
  devAccessEpoch: number;
  senderDomain: string;
  senderRevision: string;
};
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}
function envelope(value: unknown): Envelope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== FIELDS.join(",")
  )
    throw new Error("qa_mail_key_unavailable");
  const row = value as Record<string, unknown>;
  if (
    row["organizationId"] !== ORGANIZATION ||
    row["projectId"] !== PROJECT ||
    row["environmentId"] !== ENVIRONMENT ||
    row["name"] !== NAME ||
    !(row["ciphertext"] instanceof Uint8Array) ||
    row["ciphertext"].byteLength < 17 ||
    row["ciphertext"].byteLength > 5136 ||
    !(row["nonce"] instanceof Uint8Array) ||
    row["nonce"].byteLength !== 12 ||
    !(row["valueSha256"] instanceof Uint8Array) ||
    row["valueSha256"].byteLength !== 32 ||
    !positive(row["keyVersion"]) ||
    !positive(row["revision"]) ||
    !positive(row["devAccessEpoch"]) ||
    typeof row["senderDomain"] !== "string" ||
    row["senderDomain"].length < 1 ||
    row["senderDomain"].length > 253 ||
    typeof row["senderRevision"] !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(row["senderRevision"])
  )
    throw new Error("qa_mail_key_unavailable");
  return row as Envelope;
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}
function same(a: Envelope, b: Envelope): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.environmentId === b.environmentId &&
    a.name === b.name &&
    a.keyVersion === b.keyVersion &&
    a.revision === b.revision &&
    a.devAccessEpoch === b.devAccessEpoch &&
    a.senderDomain === b.senderDomain &&
    a.senderRevision === b.senderRevision &&
    sameBytes(a.ciphertext, b.ciphertext) &&
    sameBytes(a.nonce, b.nonce) &&
    sameBytes(a.valueSha256, b.valueSha256)
  );
}

/** The only returned plaintext is the exact QA customer's existing gateway key. */
export async function readQaPreviewMailKey(rawBindings: unknown): Promise<string> {
  try {
    const bindings = requireRuntimeSecretDeliveryBindings(rawBindings);
    if (
      bindings.RUNTIME_QA_PREVIEW_MAIL_ENABLED !== "development-only-v1" ||
      !bindings.QA_MAIL_KEY_AUTHORITY
    )
      throw new Error("qa_mail_key_unavailable");
    const first = envelope(await bindings.QA_MAIL_KEY_AUTHORITY.read());
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: bindings.ENVIRONMENT_SECRET_KEY_BASE64,
      additionalKeysJson: bindings.ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON,
      currentKeyVersion: Number(bindings.ENVIRONMENT_SECRET_KEY_VERSION),
      crypto: globalThis.crypto,
    });
    const key = await cipher.decrypt(first);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new Error("qa_mail_key_unavailable");
    const after = envelope(await bindings.QA_MAIL_KEY_AUTHORITY.read());
    if (!same(first, after)) throw new Error("qa_mail_key_unavailable");
    return key;
  } catch {
    throw new Error("qa_mail_key_unavailable");
  }
}
