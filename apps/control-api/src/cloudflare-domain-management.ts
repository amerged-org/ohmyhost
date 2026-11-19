import { createHash } from "node:crypto";
import { isSaasCnameTarget } from "@ohmyhost/contracts/platform-origins";
import { parseUlid } from "@ohmyhost/platform";
import { IdempotencyKeyReusedError, ProductSurfaceConflictError } from "./contracts.js";
import { OrganizationCreditError } from "@ohmyhost/database";

import type {
  CloudflareDnsAuthorizationStatusView,
  CloudflareDomainAuthorizationCompletion,
  CloudflareDomainAuthorizationView,
  CloudflareDomainManagementPort,
  PaidDomainPlanView,
  PaidDomainView,
  ProductSurfaceResult,
} from "./contracts.js";

export interface CloudflareDomainManagementBinding {
  beginAuthorization(input: unknown): Promise<unknown>;
  getStatus(input: unknown): Promise<unknown>;
  configureDomains(input: unknown): Promise<unknown>;
  completeAuthorization(input: unknown): Promise<unknown>;
  planPaidDomain(input: unknown): Promise<unknown>;
  applyPaidDomain(input: unknown): Promise<unknown>;
  getPaidDomain(input: unknown): Promise<unknown>;
  deletePaidDomain(input: unknown): Promise<unknown>;
}

export class CloudflareDnsAuthorizationClosedError extends Error {
  public constructor() {
    super("Cloudflare authorization is expired or already consumed");
    this.name = "CloudflareDnsAuthorizationClosedError";
  }
}

export class CloudflareZoneNotBoundError extends Error {
  public constructor() {
    super(
      "Declare a Paid domain or mail sender in this project's requested zone before authorizing Cloudflare.",
    );
    this.name = "CloudflareZoneNotBoundError";
  }
}

export class CloudflareDomainManagementUnavailableError extends Error {
  public constructor() {
    super("Cloudflare domain management is unavailable");
    this.name = "CloudflareDomainManagementUnavailableError";
  }
}

export function createUnavailableCloudflareDomainManagementPort(): CloudflareDomainManagementPort {
  const unavailable = async (): Promise<never> => {
    throw new CloudflareDomainManagementUnavailableError();
  };
  return Object.freeze({
    beginAuthorization: unavailable,
    getStatus: unavailable,
    configureDomains: unavailable,
    planPaidDomain: unavailable,
    applyPaidDomain: unavailable,
    getPaidDomain: unavailable,
    deletePaidDomain: unavailable,
    completeAuthorization: unavailable,
  });
}

export function createCloudflareDomainManagementPort(
  binding: CloudflareDomainManagementBinding,
): CloudflareDomainManagementPort {
  if (
    !isRecord(binding) ||
    typeof binding.beginAuthorization !== "function" ||
    typeof binding.getStatus !== "function" ||
    typeof binding.configureDomains !== "function" ||
    typeof binding.completeAuthorization !== "function" ||
    typeof binding.planPaidDomain !== "function" ||
    typeof binding.applyPaidDomain !== "function" ||
    typeof binding.getPaidDomain !== "function" ||
    typeof binding.deletePaidDomain !== "function"
  ) {
    throw new TypeError("Cloudflare domain-management Service Binding is invalid");
  }
  const port: CloudflareDomainManagementPort = {
    async beginAuthorization(input) {
      validateScope(input);
      validatePaidHostname(input.zone);
      const raw = await invoke(() =>
        binding.beginAuthorization({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.principalId,
          idempotencyKeySha256: digestString(input.idempotencyKey),
          requestSha256: digestBytes(input.canonicalRequestDigest),
          zone: input.zone,
        }),
      );
      if (
        isRecord(raw) &&
        hasExactKeys(raw, ["status"]) &&
        raw["status"] === "authorization_closed"
      )
        throw new CloudflareDnsAuthorizationClosedError();
      if (
        isRecord(raw) &&
        hasExactKeys(raw, ["code", "status"]) &&
        raw["status"] === "conflict" &&
        raw["code"] === "cloudflare_zone_not_bound"
      )
        throw new CloudflareZoneNotBoundError();
      if (
        isRecord(raw) &&
        hasExactKeys(raw, ["code", "status"]) &&
        raw["status"] === "conflict" &&
        raw["code"] === "idempotency_key_reused"
      )
        throw new IdempotencyKeyReusedError();
      return parseAuthorization(raw);
    },
    async getStatus(input) {
      validateScope(input);
      return parseStatus(
        await invoke(() =>
          binding.getStatus({
            organizationId: input.organizationId,
            projectId: input.projectId,
            actorId: input.principalId,
          }),
        ),
      );
    },
    async configureDomains(input) {
      validateScope(input);
      const raw = await invoke(() =>
        binding.configureDomains({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.principalId,
          idempotencyKeySha256: digestString(input.idempotencyKey),
          requestSha256: digestBytes(input.canonicalRequestDigest),
          projectHandle: input.projectHandle,
        }),
      );
      if (
        isRecord(raw) &&
        hasExactKeys(raw, ["code", "status"]) &&
        raw["status"] === "conflict" &&
        raw["code"] === "project_domains_conflict"
      )
        throw new ProductSurfaceConflictError("project_domains_conflict");
      return parseProductOperation(raw);
    },
    async planPaidDomain(input) {
      validateScope(input);
      validatePaidHostname(input.hostname);
      const raw = await invoke(() =>
        binding.planPaidDomain({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.principalId,
          hostname: input.hostname,
        }),
      );
      rejectUndeployedProduction(raw);
      return parsePaidDomainPlan(raw);
    },
    async applyPaidDomain(input) {
      validateScope(input);
      validatePaidHostname(input.hostname);
      const raw = await invoke(() =>
        binding.applyPaidDomain({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.principalId,
          hostname: input.hostname,
          idempotencyKeySha256: digestString(input.idempotencyKey),
          requestSha256: digestBytes(input.canonicalRequestDigest),
        }),
      );
      rejectUndeployedProduction(raw);
      rejectDomainDnsConflict(raw);
      rejectPaidConnectionConflict(raw);
      return parsePaidDomainView(raw);
    },
    async getPaidDomain(input) {
      validateScope(input);
      return parsePaidDomainView(
        await invoke(() =>
          binding.getPaidDomain({
            organizationId: input.organizationId,
            projectId: input.projectId,
            actorId: input.principalId,
          }),
        ),
      );
    },
    async deletePaidDomain(input) {
      validateScope(input);
      validatePaidHostname(input.hostname);
      const raw = await invoke(() =>
        binding.deletePaidDomain({
          organizationId: input.organizationId,
          projectId: input.projectId,
          actorId: input.principalId,
          hostname: input.hostname,
          idempotencyKeySha256: digestString(input.idempotencyKey),
          requestSha256: digestBytes(input.canonicalRequestDigest),
          ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
        }),
      );
      rejectDomainDnsConflict(raw);
      rejectPaidConnectionConflict(raw);
      return parsePaidDomainView(raw);
    },
    async completeAuthorization(input) {
      if (
        !isOpaqueCallbackValue(input.code, 8, 2048) ||
        !isOpaqueCallbackValue(input.state, 16, 2048) ||
        input.principalId.length < 1 ||
        input.principalId.length > 256 ||
        containsControlCharacter(input.principalId)
      ) {
        throw new TypeError("Cloudflare OAuth callback is invalid");
      }
      const raw = await invoke(() =>
        binding.completeAuthorization({
          code: input.code,
          state: input.state,
          principalId: input.principalId,
        }),
      );
      if (!isRecord(raw) || !hasExactKeys(raw, ["status"])) {
        throw new CloudflareDomainManagementUnavailableError();
      }
      const status = raw["status"];
      if (!COMPLETION_STATUSES.has(status as CloudflareDomainAuthorizationCompletion)) {
        throw new CloudflareDomainManagementUnavailableError();
      }
      return status as CloudflareDomainAuthorizationCompletion;
    },
  };
  return Object.freeze(port);
}

const COMPLETION_STATUSES = new Set<CloudflareDomainAuthorizationCompletion>([
  "authorized",
  "invalid",
  "token_exchange_failed",
  "zone_observe_failed",
  "token_encrypt_failed",
  "grant_persist_failed",
]);

/** Plan and apply alone answer this exact conflict before any claim or provider effect. */
function rejectUndeployedProduction(value: unknown): void {
  if (
    isRecord(value) &&
    hasExactKeys(value, ["code", "status"]) &&
    value["status"] === "conflict" &&
    value["code"] === "production_deployment_required"
  )
    throw new ProductSurfaceConflictError("production_deployment_required");
}

/**
 * A Paid hostname that another project holds, or that this project has not proven, is a named conflict. So is a
 * connection of another hostname (or another member's), or one still being deleted, for apply and for delete.
 */
function rejectPaidConnectionConflict(value: unknown): void {
  if (
    isRecord(value) &&
    hasExactKeys(value, ["code", "status"]) &&
    value["status"] === "conflict" &&
    PAID_CONNECTION_CONFLICTS.has(String(value["code"]))
  )
    throw new ProductSurfaceConflictError(value["code"] as PaidConnectionConflict);
}

type PaidConnectionConflict =
  | "domain_hostname_taken"
  | "domain_ownership_required"
  | "domain_already_configured"
  | "domain_deleting";
const PAID_CONNECTION_CONFLICTS: ReadonlySet<string> = new Set<PaidConnectionConflict>([
  "domain_hostname_taken",
  "domain_ownership_required",
  "domain_already_configured",
  "domain_deleting",
]);

/** Preserve the specific safe DNS conflict instead of disguising it as a retryable outage. */
function rejectDomainDnsConflict(value: unknown): void {
  if (
    isRecord(value) &&
    hasExactKeys(value, ["code", "status"]) &&
    value["status"] === "conflict" &&
    value["code"] === "domain_dns_conflict"
  )
    throw new ProductSurfaceConflictError("domain_dns_conflict");
}

function parsePaidDomainPlan(value: unknown): PaidDomainPlanView {
  const record = paidRecord(value, [
    "cnameTarget",
    "effects",
    "environment",
    "hostname",
    "risks",
    "status",
  ]);
  if (
    record["status"] !== "planned" ||
    record["environment"] !== "prod" ||
    !isSaasCnameTarget(record["cnameTarget"]) ||
    typeof record["hostname"] !== "string" ||
    !Array.isArray(record["effects"]) ||
    !record["effects"].every((item) => typeof item === "string") ||
    !Array.isArray(record["risks"]) ||
    !record["risks"].every((item) => typeof item === "string")
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  validatePaidHostname(record["hostname"]);
  return record as unknown as PaidDomainPlanView;
}

function parsePaidDomainView(value: unknown): PaidDomainView {
  if (
    isRecord(value) &&
    hasExactKeys(value, ["status", "code"]) &&
    value["status"] === "payment_required" &&
    ["paid_plan_required", "insufficient_organization_credits", "project_budget_exceeded"].includes(
      String(value["code"]),
    )
  )
    throw new OrganizationCreditError(
      value["code"] as
        | "paid_plan_required"
        | "insufficient_organization_credits"
        | "project_budget_exceeded",
    );
  if (
    isRecord(value) &&
    hasExactKeys(value, ["status", "code"]) &&
    value["status"] === "conflict" &&
    value["code"] === "idempotency_key_reused"
  ) {
    throw new IdempotencyKeyReusedError();
  }
  const record = paidRecord(value, [
    "cnameTarget",
    "customHostnameStatus",
    "environment",
    "hostname",
    "sslStatus",
    "status",
    "suspensionReason",
    "url",
    "validationRecords",
  ]);
  const status = record["status"];
  const hostname = record["hostname"];
  const validationRecords = record["validationRecords"];
  if (
    ![
      "not_configured",
      "awaiting_deployment",
      "pending",
      "active",
      "reconciliation_required",
      "deleted",
      "suspended",
    ].includes(String(status)) ||
    ![
      null,
      "paid_plan_required",
      "insufficient_organization_credits",
      "project_budget_exceeded",
    ].includes(record["suspensionReason"] as null | string) ||
    (status === "suspended") !== (record["suspensionReason"] !== null) ||
    (status === "suspended" && record["url"] !== null) ||
    record["environment"] !== "prod" ||
    !isSaasCnameTarget(record["cnameTarget"]) ||
    (hostname !== null && typeof hostname !== "string") ||
    (record["customHostnameStatus"] !== null &&
      typeof record["customHostnameStatus"] !== "string") ||
    (record["sslStatus"] !== null && typeof record["sslStatus"] !== "string") ||
    !Array.isArray(validationRecords) ||
    validationRecords.length > 16 ||
    !validationRecords.every(validValidationRecord) ||
    (record["url"] !== null && record["url"] !== `https://${String(hostname)}`) ||
    (status === "awaiting_deployment" &&
      (hostname === null ||
        record["customHostnameStatus"] !== null ||
        record["sslStatus"] !== null ||
        record["url"] !== null ||
        validationRecords.length !== 0))
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  if (typeof hostname === "string") validatePaidHostname(hostname);
  return record as unknown as PaidDomainView;
}

function paidRecord(value: unknown, keys: readonly string[]) {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  return value;
}

function validValidationRecord(value: unknown) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["content", "name", "purpose", "type"]) &&
    (value["type"] === "CNAME" || value["type"] === "TXT") &&
    typeof value["name"] === "string" &&
    typeof value["content"] === "string" &&
    ["traffic", "ownership", "ssl", "dcv_delegation"].includes(String(value["purpose"]))
  );
}

function validatePaidHostname(value: string) {
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value) ||
    value.endsWith(".poc.aixyte.com") ||
    value === "omh.st" ||
    value.endsWith(".omh.st") ||
    value === "ohmyho.st" ||
    value.endsWith(".ohmyho.st")
  ) {
    throw new TypeError("Paid domain hostname is invalid");
  }
}

function parseAuthorization(value: unknown): CloudflareDomainAuthorizationView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authorizationId", "authorizationUrl", "expiresAt"])
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  let authorizationId;
  try {
    authorizationId = parseUlid(String(value["authorizationId"]));
  } catch {
    throw new CloudflareDomainManagementUnavailableError();
  }
  if (!isCanonicalTimestamp(value["expiresAt"])) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  let url: URL;
  try {
    url = new URL(String(value["authorizationUrl"]));
  } catch {
    throw new CloudflareDomainManagementUnavailableError();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== "dash.cloudflare.com" ||
    url.pathname !== "/oauth2/auth" ||
    url.hash !== "" ||
    !url.searchParams.has("client_id") ||
    !url.searchParams.has("state")
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  return Object.freeze({
    authorizationId,
    authorizationUrl: url.toString(),
    expiresAt: value["expiresAt"],
  });
}

function parseStatus(value: unknown): CloudflareDnsAuthorizationStatusView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "zone", "scopes", "expiresAt"]) ||
    !(
      [
        "not_authorized",
        "pending",
        "authorized",
        "reauthorization_required",
        "expired",
        "revoked",
      ] as string[]
    ).includes(String(value["status"])) ||
    (value["status"] === "not_authorized"
      ? value["zone"] !== null
      : typeof value["zone"] !== "string") ||
    !Array.isArray(value["scopes"]) ||
    value["scopes"].length > 2 ||
    value["scopes"].some((scope) => scope !== "dns.write" && scope !== "zone.read") ||
    new Set(value["scopes"]).size !== value["scopes"].length ||
    (value["expiresAt"] !== null && !isCanonicalTimestamp(value["expiresAt"]))
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  const zone = value["zone"] as string | null;
  if (zone !== null) validatePaidHostname(zone);
  const status = value["status"] as CloudflareDnsAuthorizationStatusView["status"];
  const scopes = [...value["scopes"]].sort() as ("dns.write" | "zone.read")[];
  if (
    (status === "authorized" && scopes.join(",") !== "dns.write,zone.read") ||
    (status === "not_authorized" && (scopes.length !== 0 || value["expiresAt"] !== null)) ||
    (status === "reauthorization_required" && (scopes.length !== 0 || value["expiresAt"] !== null))
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  return Object.freeze({
    status,
    zone,
    scopes: Object.freeze(scopes),
    expiresAt: value["expiresAt"] as string | null,
  });
}

function parseProductOperation(value: unknown): ProductSurfaceResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "location", "body"]) ||
    value["status"] !== 202 ||
    typeof value["location"] !== "string" ||
    !/^\/v1\/operations\/[0-9A-HJKMNP-TV-Z]{26}$/u.test(value["location"]) ||
    !isRecord(value["body"])
  ) {
    throw new CloudflareDomainManagementUnavailableError();
  }
  return Object.freeze({ status: 202, location: value["location"], body: value["body"] });
}

function validateScope(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly principalId: string;
}): void {
  parseUlid(input.organizationId);
  parseUlid(input.projectId);
  if (
    input.principalId.length < 1 ||
    input.principalId.length > 256 ||
    containsControlCharacter(input.principalId)
  ) {
    throw new TypeError("Cloudflare domain-management scope is invalid");
  }
}

function digestString(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestBytes(value: Uint8Array): `sha256:${string}` {
  if (value.byteLength !== 32) throw new TypeError("Canonical request digest is invalid");
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

async function invoke(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch {
    throw new CloudflareDomainManagementUnavailableError();
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(value).toISOString() === value
  );
}

function isOpaqueCallbackValue(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    !containsControlCharacter(value) &&
    /^[A-Za-z0-9._~-]+$/u.test(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
