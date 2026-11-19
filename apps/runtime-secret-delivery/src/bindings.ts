import { requireD1RuntimeSecretPersistence } from "./d1-persistence.js";
/// <reference lib="dom" />

import { createEnvironmentSecretCipherKeyring } from "@ohmyhost/platform";
import type { PreviewSecretBindings } from "./preview-secrets.js";

export interface WfpRuntimeSecretManagementBinding {
  stageVerifiedArtifact(input: unknown): Promise<unknown>;
  prepareExistingCandidate(input: unknown): Promise<unknown>;
  activateCandidate(input: unknown): Promise<unknown>;
  compensateGatewayActivation(input: unknown): Promise<unknown>;
  compensateActivation(input: unknown): Promise<unknown>;
  removeCandidate(input: unknown): Promise<unknown>;
  observeActivation(input: unknown): Promise<unknown>;
  syncRuntimeSecrets(input: unknown): Promise<unknown>;
}

export interface RuntimeSecretDeliveryBindings extends PreviewSecretBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly RUNTIME_SECRET_RUNTIME: unknown;
  readonly ENVIRONMENT_SECRET_KEY_BASE64: string;
  readonly ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON: string;
  readonly ENVIRONMENT_SECRET_KEY_VERSION: string;
  readonly WFP_MANAGEMENT: WfpRuntimeSecretManagementBinding;
  readonly RUNTIME_QA_PREVIEW_MAIL_ENABLED?: "development-only-v1";
  readonly QA_MAIL_KEY_AUTHORITY?: { read(): Promise<unknown> };
}

/** Sorted: the Worker accepts exactly these bindings, so a direct Core database binding is refused. */
const BINDINGS = [
  "ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON",
  "ENVIRONMENT_SECRET_KEY_BASE64",
  "ENVIRONMENT_SECRET_KEY_VERSION",
  "RUNTIME_CONFIGURATION_STATE",
  "RUNTIME_SECRET_RUNTIME",
  "WFP_MANAGEMENT",
] as const;
const QA_BINDINGS = [
  ...BINDINGS,
  "RUNTIME_QA_PREVIEW_MAIL_ENABLED",
  "QA_MAIL_KEY_AUTHORITY",
].sort();

export function requireRuntimeSecretDeliveryBindings(
  value: unknown,
): Readonly<RuntimeSecretDeliveryBindings> {
  if (!isRecord(value)) {
    throw new TypeError("Runtime secret delivery binding inventory is not exact");
  }
  const previewNames = [
    "PROJECT_PREVIEW_AUTHORITY",
    "PREVIEW_SECRET_AUTHORITY",
    "PREVIEW_MAIL_GATEWAY",
    "PREVIEW_STORAGE_GATEWAY",
    "PREVIEW_AI_GATEWAY",
  ];
  const baseNames = Object.keys(value)
    .filter((name) => !previewNames.includes(name))
    .sort()
    .join(",");
  if (baseNames !== BINDINGS.join(",") && baseNames !== QA_BINDINGS.join(","))
    throw new TypeError("Runtime secret delivery binding inventory is not exact");
  const previewPresent = previewNames.filter((name) => Object.hasOwn(value, name));
  if (
    previewPresent.length !== 0 &&
    (previewPresent.length !== previewNames.length ||
      !isRecord(value["PROJECT_PREVIEW_AUTHORITY"]) ||
      typeof value["PROJECT_PREVIEW_AUTHORITY"]["authorizeRuntime"] !== "function" ||
      !isRecord(value["PREVIEW_SECRET_AUTHORITY"]) ||
      typeof value["PREVIEW_SECRET_AUTHORITY"]["readEnvelopes"] !== "function" ||
      typeof value["PREVIEW_SECRET_AUTHORITY"]["listCustomerSecretNames"] !== "function" ||
      ["PREVIEW_MAIL_GATEWAY", "PREVIEW_STORAGE_GATEWAY", "PREVIEW_AI_GATEWAY"].some(
        (name) => !isRecord(value[name]) || typeof value[name]["fetch"] !== "function",
      ))
  )
    throw new TypeError("Runtime secret delivery preview bindings are invalid");
  if (
    baseNames === QA_BINDINGS.join(",") &&
    (value["RUNTIME_QA_PREVIEW_MAIL_ENABLED"] !== "development-only-v1" ||
      !isRecord(value["QA_MAIL_KEY_AUTHORITY"]) ||
      typeof value["QA_MAIL_KEY_AUTHORITY"]["read"] !== "function")
  )
    throw new TypeError("Runtime secret delivery QA binding is invalid");
  if (value["RUNTIME_CONFIGURATION_STATE"] !== "configured") {
    throw new TypeError("Runtime secret delivery is disabled");
  }
  const management = value["WFP_MANAGEMENT"];
  if (
    !isRecord(management) ||
    typeof management["stageVerifiedArtifact"] !== "function" ||
    typeof management["prepareExistingCandidate"] !== "function" ||
    typeof management["activateCandidate"] !== "function" ||
    typeof management["compensateGatewayActivation"] !== "function" ||
    typeof management["compensateActivation"] !== "function" ||
    typeof management["removeCandidate"] !== "function" ||
    typeof management["observeActivation"] !== "function" ||
    typeof management["syncRuntimeSecrets"] !== "function"
  ) {
    throw new TypeError("Runtime secret delivery requires its private WFP management binding");
  }
  if (
    !validKeyring(
      value["ENVIRONMENT_SECRET_KEY_BASE64"],
      value["ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON"],
      value["ENVIRONMENT_SECRET_KEY_VERSION"],
    ) ||
    typeof value["ENVIRONMENT_SECRET_KEY_VERSION"] !== "string" ||
    !/^[1-9][0-9]{0,8}$/u.test(value["ENVIRONMENT_SECRET_KEY_VERSION"])
  ) {
    throw new TypeError("Runtime secret delivery cipher configuration is invalid");
  }
  requireD1RuntimeSecretPersistence(value["RUNTIME_SECRET_RUNTIME"]);
  return Object.freeze(value as unknown as RuntimeSecretDeliveryBindings);
}

function validKeyring(primaryKey: unknown, additionalKeys: unknown, currentVersion: unknown) {
  if (
    !canonicalKey(primaryKey) ||
    typeof currentVersion !== "string" ||
    !/^[1-9][0-9]{0,8}$/u.test(currentVersion)
  ) {
    return false;
  }
  if (
    typeof additionalKeys !== "string" ||
    additionalKeys.length === 0 ||
    additionalKeys.length > 2_048
  ) {
    return false;
  }
  try {
    createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: primaryKey,
      additionalKeysJson: additionalKeys,
      currentKeyVersion: Number(currentVersion),
      crypto: globalThis.crypto,
    });
    return true;
  } catch {
    return false;
  }
}

function canonicalKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).byteLength === 32;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
