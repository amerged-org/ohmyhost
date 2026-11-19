import type { SaasCnameTarget } from "@ohmyhost/contracts/platform-origins";
import { parseAdditionalCloudflareCipherKeys } from "./secrets.js";

export interface CloudflareDomainManagementBaseBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_PLATFORM_ZONE_ID: string;
  readonly CLOUDFLARE_SAAS_ZONE_ID: string;
  readonly CLOUDFLARE_SAAS_CNAME_TARGET: SaasCnameTarget;
  readonly CLOUDFLARE_SAAS_API_TOKEN: string;
  readonly CLOUDFLARE_OAUTH_CLIENT_ID: string;
  readonly CLOUDFLARE_OAUTH_CLIENT_SECRET: string;
  readonly CLOUDFLARE_OAUTH_REDIRECT_URI:
    | "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback"
    | "https://app.ohmyho.st/v1/cloudflare/oauth/callback";
  readonly CLOUDFLARE_OAUTH_STATE_FORMAT: "json-v1";
  readonly CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64: string;
  readonly CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION: string;
  readonly CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON?: string;
  readonly CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN: string;
  readonly DEV_ACCESS: {
    issueRuntimeProbe(input: unknown): Promise<unknown>;
  };
  readonly RUNTIME_PROBES: { beginProbe(input: unknown): Promise<unknown> };
  readonly GENERAL_CF_RUNTIME: unknown;
  readonly SCOPED_DNS_RUNTIME: unknown;
  readonly APPLICATION_IDENTITY_RUNTIME: unknown;
  readonly MAIL_DNS_RUNTIME: unknown;
}

export interface CloudflareDomainManagementBindings extends CloudflareDomainManagementBaseBindings {
  readonly NATIVE_AUTH_ADMIN_US: { applyRealmPolicy(input: unknown): Promise<unknown> };
  readonly NATIVE_AUTH_ADMIN_EU: { applyRealmPolicy(input: unknown): Promise<unknown> };
}
const NATIVE_CAPABILITIES = ["NATIVE_AUTH_ADMIN_US", "NATIVE_AUTH_ADMIN_EU"] as const;

export function requireCloudflareDomainManagementBindings(
  value: unknown,
): CloudflareDomainManagementBindings {
  return readBindings(value, NATIVE_CAPABILITIES) as CloudflareDomainManagementBindings;
}
/** Closed composition for the existing Production service; customer input cannot select it. */
export function requireLegacyProductionCloudflareDomainManagementBindings(
  value: unknown,
): CloudflareDomainManagementBaseBindings {
  const bindings = readBindings(value, []);
  if (
    bindings.CLOUDFLARE_OAUTH_REDIRECT_URI !== "https://app.ohmyho.st/v1/cloudflare/oauth/callback"
  )
    invalid();
  return bindings;
}

const CORE_CAPABILITIES = [
  "GENERAL_CF_RUNTIME",
  "SCOPED_DNS_RUNTIME",
  "APPLICATION_IDENTITY_RUNTIME",
  "MAIL_DNS_RUNTIME",
] as const;

function readBindings(
  value: unknown,
  native: readonly string[],
): CloudflareDomainManagementBaseBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Cloudflare domain-management bindings are invalid");
  }
  const bindings = value as Record<string, unknown>;
  const additionalName = "CLOUDFLARE_OAUTH_TOKEN_CIPHER_ADDITIONAL_KEYS_JSON";
  const names = Object.getOwnPropertyNames(bindings).filter((name) => name !== additionalName);
  const expected = [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_OAUTH_CLIENT_ID",
    "CLOUDFLARE_OAUTH_CLIENT_SECRET",
    "CLOUDFLARE_OAUTH_REDIRECT_URI",
    "CLOUDFLARE_OAUTH_STATE_FORMAT",
    "CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64",
    "CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION",
    "CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN",
    "CLOUDFLARE_PLATFORM_ZONE_ID",
    "CLOUDFLARE_SAAS_API_TOKEN",
    "CLOUDFLARE_SAAS_CNAME_TARGET",
    "CLOUDFLARE_SAAS_ZONE_ID",
    "DEV_ACCESS",
    "RUNTIME_CONFIGURATION_STATE",
    "RUNTIME_PROBES",
    ...CORE_CAPABILITIES,
    ...native,
  ].sort();
  if (names.sort().join(",") !== expected.join(",")) invalid();
  for (const name of [...CORE_CAPABILITIES, ...native])
    if (typeof bindings[name] !== "object" || bindings[name] === null) invalid();
  for (const name of native)
    if (typeof Reflect.get(bindings[name] as object, "applyRealmPolicy") !== "function") invalid();
  if (
    bindings["RUNTIME_CONFIGURATION_STATE"] !== "configured" ||
    !hex32(bindings["CLOUDFLARE_ACCOUNT_ID"]) ||
    !hex32(bindings["CLOUDFLARE_PLATFORM_ZONE_ID"]) ||
    !hex32(bindings["CLOUDFLARE_SAAS_ZONE_ID"]) ||
    bindings["CLOUDFLARE_SAAS_CNAME_TARGET"] !==
      (bindings["CLOUDFLARE_OAUTH_REDIRECT_URI"] ===
      "https://app.ohmyho.st/v1/cloudflare/oauth/callback"
        ? "customers.ohmyho.st"
        : "customers.omh.st") ||
    !secret(bindings["CLOUDFLARE_SAAS_API_TOKEN"], 20, 4_096) ||
    !identifier(bindings["CLOUDFLARE_OAUTH_CLIENT_ID"], 8, 256) ||
    !secret(bindings["CLOUDFLARE_OAUTH_CLIENT_SECRET"], 16, 512) ||
    !callbackUri(bindings["CLOUDFLARE_OAUTH_REDIRECT_URI"]) ||
    bindings["CLOUDFLARE_OAUTH_STATE_FORMAT"] !== "json-v1" ||
    !canonicalBase64Key(bindings["CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_BASE64"]) ||
    !/^[1-9][0-9]{0,8}$/u.test(String(bindings["CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION"])) ||
    !secret(bindings["CLOUDFLARE_PLATFORM_WEB_DOMAIN_API_TOKEN"], 20, 4_096) ||
    typeof bindings["DEV_ACCESS"] !== "object" ||
    bindings["DEV_ACCESS"] === null ||
    Array.isArray(bindings["DEV_ACCESS"]) ||
    typeof Reflect.get(bindings["DEV_ACCESS"], "issueRuntimeProbe") !== "function" ||
    typeof bindings["RUNTIME_PROBES"] !== "object" ||
    bindings["RUNTIME_PROBES"] === null ||
    Array.isArray(bindings["RUNTIME_PROBES"]) ||
    typeof Reflect.get(bindings["RUNTIME_PROBES"], "beginProbe") !== "function"
  ) {
    invalid();
  }
  if (Object.hasOwn(bindings, additionalName) && typeof bindings[additionalName] !== "string")
    invalid();
  try {
    parseAdditionalCloudflareCipherKeys(
      bindings[additionalName],
      Number(bindings["CLOUDFLARE_OAUTH_TOKEN_CIPHER_KEY_VERSION"]),
    );
  } catch {
    invalid();
  }
  return bindings as unknown as CloudflareDomainManagementBaseBindings;
}

function callbackUri(value: unknown): boolean {
  return (
    value === "https://dev.app.ohmyho.st/v1/cloudflare/oauth/callback" ||
    value === "https://app.ohmyho.st/v1/cloudflare/oauth/callback"
  );
}

function canonicalBase64Key(value: unknown): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return false;
  try {
    return Buffer.from(value, "base64").byteLength === 32;
  } catch {
    return false;
  }
}

function hex32(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function identifier(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function secret(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function invalid(): never {
  throw new TypeError("Cloudflare domain-management bindings are invalid");
}
