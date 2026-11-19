const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAXIMUM_RESPONSE_BYTES = 128 * 1024;
const MAXIMUM_PAGES = 100;
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const ID_PATTERN = /^[0-9a-f]{32}$/u;
const PROVIDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DNS_NAME_PATTERN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/u;
const HOSTNAME_STATUSES = new Set([
  "active",
  "pending",
  "active_redeploying",
  "moved",
  "pending_deletion",
  "deleted",
  "pending_blocked",
  "pending_migration",
  "pending_provisioned",
  "test_pending",
  "test_active",
  "test_active_apex",
  "test_blocked",
  "test_failed",
  "provisioned",
  "blocked",
]);
const SSL_STATUSES = new Set([
  "initializing",
  "pending_validation",
  "deleted",
  "pending_issuance",
  "pending_deployment",
  "pending_deletion",
  "pending_expiration",
  "expired",
  "active",
  "initializing_timed_out",
  "validation_timed_out",
  "issuance_timed_out",
  "deployment_timed_out",
  "deletion_timed_out",
  "pending_cleanup",
  "staging_deployment",
  "staging_active",
  "deactivating",
  "inactive",
  "backup_issued",
  "holding_deployment",
]);

export interface CloudflareCustomHostnameTarget {
  readonly hostname: string;
  readonly customerCnameTarget: string;
}

export interface CloudflareCustomHostnameDnsRecord {
  readonly purpose: "traffic" | "ownership" | "ssl";
  readonly type: "CNAME" | "TXT";
  readonly name: string;
  readonly content: string;
}

export type CloudflareCustomHostnameStatus =
  | "active"
  | "pending"
  | "active_redeploying"
  | "moved"
  | "pending_deletion"
  | "deleted"
  | "pending_blocked"
  | "pending_migration"
  | "pending_provisioned"
  | "test_pending"
  | "test_active"
  | "test_active_apex"
  | "test_blocked"
  | "test_failed"
  | "provisioned"
  | "blocked";

export type CloudflareCustomHostnameSslStatus =
  | "initializing"
  | "pending_validation"
  | "deleted"
  | "pending_issuance"
  | "pending_deployment"
  | "pending_deletion"
  | "pending_expiration"
  | "expired"
  | "active"
  | "initializing_timed_out"
  | "validation_timed_out"
  | "issuance_timed_out"
  | "deployment_timed_out"
  | "deletion_timed_out"
  | "pending_cleanup"
  | "staging_deployment"
  | "staging_active"
  | "deactivating"
  | "inactive"
  | "backup_issued"
  | "holding_deployment";

export interface CloudflareCustomHostnameSslValidationRecord {
  readonly status?: string;
  readonly cname?: string;
  readonly cnameTarget?: string;
  readonly httpBody?: string;
  readonly httpUrl?: string;
  readonly txtName?: string;
  readonly txtValue?: string;
  readonly wildcard?: boolean;
}

export interface CloudflareCustomHostnameSslReceipt {
  readonly sslId: string | null;
  readonly status: CloudflareCustomHostnameSslStatus | null;
  readonly type: "dv" | null;
  readonly method: "http" | "txt" | "email" | null;
  readonly bundleMethod: "ubiquitous" | "optimal" | "force" | null;
  readonly certificateAuthority: string | null;
  readonly validationRecords: readonly CloudflareCustomHostnameSslValidationRecord[];
  readonly dcvDelegationRecords: readonly CloudflareCustomHostnameSslValidationRecord[];
}

export interface CloudflareCustomHostnameReceipt extends CloudflareCustomHostnameTarget {
  readonly customHostnameId: string;
  readonly status: CloudflareCustomHostnameStatus;
  readonly providerCreatedAt: string | null;
  readonly ownershipVerification: Readonly<{
    readonly type: "txt";
    readonly name: string;
    readonly value: string;
  }> | null;
  readonly ownershipVerificationHttp: Readonly<{
    readonly httpUrl: string;
    readonly httpBody: string;
  }> | null;
  readonly verificationErrors: readonly string[];
  readonly ssl: CloudflareCustomHostnameSslReceipt;
  readonly ready: boolean;
  readonly dnsRecords: readonly CloudflareCustomHostnameDnsRecord[];
  readonly observedAt: Date;
}

export type CloudflareCustomHostnameObservation =
  | Readonly<{ state: "absent"; hostname: string }>
  | Readonly<{ state: "found" } & CloudflareCustomHostnameReceipt>;

export class CloudflareCustomHostnameInputError extends Error {
  public readonly code = "cloudflare_custom_hostname_input_invalid" as const;

  public constructor() {
    super("Cloudflare custom hostname input is invalid");
    this.name = "CloudflareCustomHostnameInputError";
  }
}

export class CloudflareCustomHostnameContractError extends Error {
  public readonly code = "cloudflare_custom_hostname_contract_invalid" as const;

  public constructor() {
    super("Cloudflare custom hostname response is invalid");
    this.name = "CloudflareCustomHostnameContractError";
  }
}

export class CloudflareCustomHostnameRejectedError extends Error {
  public readonly code = "cloudflare_custom_hostname_request_rejected" as const;

  public constructor() {
    super("Cloudflare custom hostname request was rejected");
    this.name = "CloudflareCustomHostnameRejectedError";
  }
}

export class CloudflareCustomHostnameUncertainError extends Error {
  public readonly code = "cloudflare_custom_hostname_result_uncertain" as const;

  public constructor() {
    super("Cloudflare custom hostname result is uncertain");
    this.name = "CloudflareCustomHostnameUncertainError";
  }
}

export class CloudflareCustomHostnameReceiptMismatchError extends Error {
  public readonly code = "cloudflare_custom_hostname_receipt_mismatch" as const;

  public constructor() {
    super("Cloudflare custom hostname receipt does not match provider state");
    this.name = "CloudflareCustomHostnameReceiptMismatchError";
  }
}

export function createCloudflareCustomHostnameProvider(dependencies: {
  readonly zoneId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}) {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());
  const baseUrl = `${API_ORIGIN}/zones/${dependencies.zoneId}/custom_hostnames`;
  const request = (url: string, init: RequestInit): Promise<Response> =>
    Reflect.apply(dependencies.fetch, globalThis, [
      url,
      {
        ...init,
        headers: { authorization: `Bearer ${dependencies.apiToken}`, ...init.headers },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      },
    ]);

  async function observeHostname(
    target: CloudflareCustomHostnameTarget,
  ): Promise<CloudflareCustomHostnameObservation> {
    validateTarget(target);
    const values: unknown[] = [];
    let totalPages: number | null = null;
    let totalCount: number | null = null;
    for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
      let response: Response;
      try {
        response = await request(
          `${baseUrl}?${new URLSearchParams({
            "hostname.exact": target.hostname,
            page: String(page),
            per_page: String(PAGE_SIZE),
          }).toString()}`,
          { method: "GET" },
        );
      } catch {
        throw new CloudflareCustomHostnameUncertainError();
      }
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        throw new CloudflareCustomHostnameRejectedError();
      }
      if (!response.ok) {
        await discardBody(response);
        throw new CloudflareCustomHostnameUncertainError();
      }
      const parsed = await readPage(response, page);
      totalPages ??= parsed.totalPages;
      totalCount ??= parsed.totalCount;
      if (parsed.totalPages !== totalPages || parsed.totalCount !== totalCount) {
        throw new CloudflareCustomHostnameContractError();
      }
      values.push(...parsed.result);
      if (parsed.totalPages === 0) {
        return Object.freeze({ state: "absent" as const, hostname: target.hostname });
      }
      if (page === parsed.totalPages) {
        if (values.length !== parsed.totalCount) {
          throw new CloudflareCustomHostnameContractError();
        }
        const matches = values
          .map((value) => parseHostname(value, target, canonicalNow(now)))
          .filter((value) => value.hostname === target.hostname);
        if (matches.length === 0) {
          return Object.freeze({ state: "absent" as const, hostname: target.hostname });
        }
        if (matches.length !== 1) throw new CloudflareCustomHostnameContractError();
        const match = matches[0];
        if (match === undefined) throw new CloudflareCustomHostnameContractError();
        return Object.freeze({ state: "found" as const, ...match });
      }
    }
    throw new CloudflareCustomHostnameContractError();
  }

  async function createHostname(target: CloudflareCustomHostnameTarget): Promise<
    Readonly<{
      outcome: "created" | "existing" | "recovered";
      receipt: CloudflareCustomHostnameReceipt;
    }>
  > {
    validateTarget(target);
    const before = await observeHostname(target);
    if (before.state === "found") {
      return Object.freeze({ outcome: "existing" as const, receipt: withoutState(before) });
    }

    let created: CloudflareCustomHostnameReceipt | null = null;
    let rejected = false;
    let conflicted = false;
    try {
      const response = await request(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hostname: target.hostname,
          ssl: { method: "http", type: "dv", wildcard: false },
        }),
      });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        if (response.status === 409) conflicted = true;
        else rejected = true;
      } else {
        created = parseHostname(await readSuccessfulEnvelope(response), target, canonicalNow(now));
      }
    } catch {
      // The exact hostname readback below is the only recovery after an ambiguous mutation.
    }
    if (rejected) throw new CloudflareCustomHostnameRejectedError();

    try {
      const observed = await observeHostname(target);
      if (observed.state === "found") {
        const receipt = withoutState(observed);
        if (created !== null && created.customHostnameId !== receipt.customHostnameId) {
          throw new CloudflareCustomHostnameUncertainError();
        }
        return Object.freeze({
          outcome: created === null ? ("recovered" as const) : ("created" as const),
          receipt,
        });
      }
    } catch {
      // The public error stays redacted and does not expose provider response details.
    }
    if (conflicted) throw new CloudflareCustomHostnameRejectedError();
    throw new CloudflareCustomHostnameUncertainError();
  }

  async function deleteHostname(expected: CloudflareCustomHostnameReceipt): Promise<
    Readonly<{
      outcome: "deleted" | "absent";
      customHostnameId: string;
      hostname: string;
      observedAt: Date;
    }>
  > {
    validateReceipt(expected);
    const target = Object.freeze({
      hostname: expected.hostname,
      customerCnameTarget: expected.customerCnameTarget,
    });
    const before = await observeHostname(target);
    if (before.state === "absent") {
      return absenceReceipt(expected, "absent", canonicalNow(now));
    }
    if (before.customHostnameId !== expected.customHostnameId) {
      throw new CloudflareCustomHostnameReceiptMismatchError();
    }

    let rejected = false;
    try {
      const response = await request(
        `${baseUrl}/${providerCustomHostnameId(expected.customHostnameId)}`,
        {
          method: "DELETE",
        },
      );
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        rejected = true;
      } else {
        await readDeleteResult(response, expected.customHostnameId);
      }
    } catch {
      // The exact hostname readback below is the only recovery after an ambiguous mutation.
    }

    try {
      const observed = await observeHostname(target);
      if (observed.state === "absent") {
        return absenceReceipt(expected, "deleted", canonicalNow(now));
      }
    } catch {
      // The public error stays redacted and does not expose provider response details.
    }
    if (rejected) throw new CloudflareCustomHostnameRejectedError();
    throw new CloudflareCustomHostnameUncertainError();
  }

  return Object.freeze({ observeHostname, createHostname, deleteHostname });
}

function parseHostname(
  value: unknown,
  target: CloudflareCustomHostnameTarget,
  observedAt: Date,
): CloudflareCustomHostnameReceipt {
  const hostname = record(value);
  const customHostnameId = parseCustomHostnameProviderId(hostname["id"]);
  if (
    customHostnameId === null ||
    hostname["hostname"] !== target.hostname ||
    typeof hostname["status"] !== "string" ||
    !HOSTNAME_STATUSES.has(hostname["status"])
  ) {
    throw new CloudflareCustomHostnameContractError();
  }

  const providerCreatedAt = parseProviderTimestamp(hostname["created_at"]);
  const ssl = parseSsl(hostname["ssl"]);
  const ownershipVerification = parseOwnershipVerification(hostname["ownership_verification"]);
  const ownershipVerificationHttp = parseOwnershipVerificationHttp(
    hostname["ownership_verification_http"],
  );
  const verificationErrors = parseVerificationErrors(hostname["verification_errors"]);
  const status = hostname["status"] as CloudflareCustomHostnameStatus;

  return Object.freeze({
    customHostnameId,
    ...target,
    status,
    providerCreatedAt,
    ownershipVerification,
    ownershipVerificationHttp,
    verificationErrors,
    ssl,
    ready: hostnameReady(status, providerCreatedAt, ssl),
    dnsRecords: buildDnsRecords(target, ownershipVerification, ssl),
    observedAt,
  });
}

function buildDnsRecords(
  target: CloudflareCustomHostnameTarget,
  ownershipVerification: CloudflareCustomHostnameReceipt["ownershipVerification"],
  ssl: CloudflareCustomHostnameSslReceipt,
): readonly CloudflareCustomHostnameDnsRecord[] {
  const dnsRecords: CloudflareCustomHostnameDnsRecord[] = [
    Object.freeze({
      purpose: "traffic" as const,
      type: "CNAME" as const,
      name: target.hostname,
      content: target.customerCnameTarget,
    }),
  ];
  if (ownershipVerification !== null) {
    dnsRecords.push(
      Object.freeze({
        purpose: "ownership" as const,
        type: "TXT" as const,
        name: ownershipVerification.name,
        content: ownershipVerification.value,
      }),
    );
  }
  appendValidationFacts(dnsRecords, ssl.validationRecords, ssl.method);
  const unique = new Map(
    dnsRecords.map((item) => [
      `${item.purpose}\t${item.type}\t${item.name}\t${item.content}`,
      item,
    ]),
  );
  return Object.freeze([...unique.values()]);
}

function hostnameReady(
  status: CloudflareCustomHostnameStatus,
  providerCreatedAt: string | null,
  ssl: CloudflareCustomHostnameSslReceipt,
): boolean {
  return (
    status === "active" &&
    providerCreatedAt !== null &&
    ssl.status === "active" &&
    ssl.sslId !== null &&
    ssl.type === "dv" &&
    ssl.method !== null &&
    ssl.bundleMethod !== null &&
    ssl.certificateAuthority !== null
  );
}

function appendValidationFacts(
  target: CloudflareCustomHostnameDnsRecord[],
  records: readonly CloudflareCustomHostnameSslValidationRecord[],
  method: "http" | "txt" | "email" | null,
): void {
  for (const recordValue of records) {
    if ((recordValue.cname === undefined) !== (recordValue.cnameTarget === undefined)) {
      throw new CloudflareCustomHostnameContractError();
    }
    if ((recordValue.txtName === undefined) !== (recordValue.txtValue === undefined)) {
      throw new CloudflareCustomHostnameContractError();
    }
    if (
      method === "txt" &&
      recordValue.txtName !== undefined &&
      recordValue.txtValue !== undefined
    ) {
      target.push(
        Object.freeze({
          purpose: "ssl" as const,
          type: "TXT" as const,
          name: recordValue.txtName,
          content: recordValue.txtValue,
        }),
      );
    }
  }
}

function parseSsl(value: unknown): CloudflareCustomHostnameSslReceipt {
  if (value === undefined || value === null) {
    return Object.freeze({
      sslId: null,
      status: null,
      type: null,
      method: null,
      bundleMethod: null,
      certificateAuthority: null,
      validationRecords: Object.freeze([]),
      dcvDelegationRecords: Object.freeze([]),
    });
  }
  const input = record(value);
  const sslId = input["id"] ?? null;
  const status = input["status"] ?? null;
  const type = input["type"] ?? null;
  const method = input["method"] ?? null;
  const bundleMethod = input["bundle_method"] ?? null;
  const certificateAuthority = input["certificate_authority"] ?? null;
  if (
    (sslId !== null &&
      (typeof sslId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(sslId))) ||
    (status !== null && (typeof status !== "string" || !SSL_STATUSES.has(status))) ||
    (type !== null && type !== "dv") ||
    (method !== null && method !== "http" && method !== "txt" && method !== "email") ||
    (bundleMethod !== null &&
      bundleMethod !== "ubiquitous" &&
      bundleMethod !== "optimal" &&
      bundleMethod !== "force") ||
    (certificateAuthority !== null && !validBoundedText(certificateAuthority, 64))
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze({
    sslId,
    status: status as CloudflareCustomHostnameSslStatus | null,
    type: type as "dv" | null,
    method: method as "http" | "txt" | "email" | null,
    bundleMethod: bundleMethod as "ubiquitous" | "optimal" | "force" | null,
    certificateAuthority: certificateAuthority as string | null,
    validationRecords: parseValidationRecords(input["validation_records"]),
    dcvDelegationRecords: parseValidationRecords(input["dcv_delegation_records"]),
  });
}

function parseOwnershipVerification(
  value: unknown,
): CloudflareCustomHostnameReceipt["ownershipVerification"] {
  if (value === undefined || value === null) return null;
  const parsed = record(value);
  if (
    parsed["type"] !== "txt" ||
    !validDnsName(parsed["name"]) ||
    !validBoundedText(parsed["value"], 2048)
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze({ type: "txt" as const, name: parsed["name"], value: parsed["value"] });
}

function parseOwnershipVerificationHttp(
  value: unknown,
): CloudflareCustomHostnameReceipt["ownershipVerificationHttp"] {
  if (value === undefined || value === null) return null;
  const parsed = record(value);
  if (!validHttpUrl(parsed["http_url"]) || !validBoundedText(parsed["http_body"], 8192)) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze({ httpUrl: parsed["http_url"], httpBody: parsed["http_body"] });
}

function parseVerificationErrors(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((item) => !validBoundedText(item, 2048))) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze([...value] as string[]);
}

function parseValidationRecords(
  value: unknown,
): readonly CloudflareCustomHostnameSslValidationRecord[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze(
    value.map((item) => {
      const input = record(item);
      const output: {
        status?: string;
        cname?: string;
        cnameTarget?: string;
        httpBody?: string;
        httpUrl?: string;
        txtName?: string;
        txtValue?: string;
        wildcard?: boolean;
      } = {};
      if (input["status"] !== undefined) {
        if (!validBoundedText(input["status"], 64)) {
          throw new CloudflareCustomHostnameContractError();
        }
        output.status = input["status"];
      }
      if (input["cname"] !== undefined) {
        if (!validDnsName(input["cname"])) throw new CloudflareCustomHostnameContractError();
        output.cname = input["cname"];
      }
      if (input["cname_target"] !== undefined) {
        if (!validDomain(input["cname_target"])) {
          throw new CloudflareCustomHostnameContractError();
        }
        output.cnameTarget = input["cname_target"];
      }
      if (input["http_body"] !== undefined) {
        if (!validBoundedText(input["http_body"], 8192)) {
          throw new CloudflareCustomHostnameContractError();
        }
        output.httpBody = input["http_body"];
      }
      if (input["http_url"] !== undefined) {
        if (!validHttpUrl(input["http_url"])) throw new CloudflareCustomHostnameContractError();
        output.httpUrl = input["http_url"];
      }
      if (input["txt_name"] !== undefined) {
        if (!validDnsName(input["txt_name"])) throw new CloudflareCustomHostnameContractError();
        output.txtName = input["txt_name"];
      }
      if (input["txt_value"] !== undefined) {
        if (!validBoundedText(input["txt_value"], 8192)) {
          throw new CloudflareCustomHostnameContractError();
        }
        output.txtValue = input["txt_value"];
      }
      if (input["wildcard"] !== undefined) {
        if (typeof input["wildcard"] !== "boolean") {
          throw new CloudflareCustomHostnameContractError();
        }
        output.wildcard = input["wildcard"];
      }
      return Object.freeze(output);
    }),
  );
}

async function readPage(
  response: Response,
  expectedPage: number,
): Promise<Readonly<{ result: readonly unknown[]; totalCount: number; totalPages: number }>> {
  const envelope = record(await readJson(response));
  const result = envelope["result"];
  const info = record(envelope["result_info"]);
  const zeroResultPage =
    Array.isArray(result) &&
    result.length === 0 &&
    Object.is(info["count"], 0) &&
    info["page"] === 1 &&
    Object.is(info["total_count"], 0) &&
    Object.is(info["total_pages"], 0);
  if (
    response.status !== 200 ||
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !Array.isArray(result) ||
    info["count"] !== result.length ||
    info["page"] !== expectedPage ||
    !positiveInteger(info["per_page"]) ||
    Number(info["per_page"]) > PAGE_SIZE ||
    !nonNegativeInteger(info["total_count"]) ||
    (!positiveInteger(info["total_pages"]) && !zeroResultPage) ||
    (!zeroResultPage && Number(info["total_pages"]) > MAXIMUM_PAGES) ||
    (!zeroResultPage && expectedPage > Number(info["total_pages"]))
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
  return Object.freeze({
    result: Object.freeze(result),
    totalCount: Number(info["total_count"]),
    totalPages: Number(info["total_pages"]),
  });
}

async function readSuccessfulEnvelope(response: Response): Promise<unknown> {
  const envelope = record(await readJson(response));
  if (
    response.status !== 200 ||
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !("result" in envelope)
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
  return envelope["result"];
}

async function readDeleteResult(response: Response, expectedId: string): Promise<void> {
  const result = record(await readJson(response));
  if (
    response.status !== 200 ||
    Object.keys(result).length !== 1 ||
    parseCustomHostnameProviderId(result["id"]) !== expectedId
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
}

function parseCustomHostnameProviderId(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value)
    ? value.replaceAll("-", "")
    : null;
}

function providerCustomHostnameId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new CloudflareCustomHostnameContractError();
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(
    16,
    20,
  )}-${value.slice(20)}`;
}

async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw new CloudflareCustomHostnameContractError();
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES) {
    throw new CloudflareCustomHostnameContractError();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CloudflareCustomHostnameContractError();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redacted provider result is unchanged when cancellation fails.
  }
}

function withoutState(
  value: Readonly<{ state: "found" } & CloudflareCustomHostnameReceipt>,
): CloudflareCustomHostnameReceipt {
  return Object.freeze({
    customHostnameId: value.customHostnameId,
    hostname: value.hostname,
    customerCnameTarget: value.customerCnameTarget,
    status: value.status,
    providerCreatedAt: value.providerCreatedAt,
    ownershipVerification: value.ownershipVerification,
    ownershipVerificationHttp: value.ownershipVerificationHttp,
    verificationErrors: value.verificationErrors,
    ssl: value.ssl,
    ready: value.ready,
    dnsRecords: value.dnsRecords,
    observedAt: value.observedAt,
  });
}

function absenceReceipt(
  expected: CloudflareCustomHostnameReceipt,
  outcome: "deleted" | "absent",
  observedAt: Date,
) {
  return Object.freeze({
    outcome,
    customHostnameId: expected.customHostnameId,
    hostname: expected.hostname,
    observedAt,
  });
}

function validateDependencies(value: unknown): asserts value is {
  zoneId: string;
  apiToken: string;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
} {
  if (
    !isRecord(value) ||
    typeof value["zoneId"] !== "string" ||
    !ID_PATTERN.test(value["zoneId"]) ||
    typeof value["apiToken"] !== "string" ||
    value["apiToken"].length < 20 ||
    typeof value["fetch"] !== "function" ||
    (value["now"] !== undefined && typeof value["now"] !== "function")
  ) {
    throw new CloudflareCustomHostnameInputError();
  }
}

function validateTarget(value: CloudflareCustomHostnameTarget): void {
  if (
    !isRecord(value) ||
    typeof value["hostname"] !== "string" ||
    !DOMAIN_PATTERN.test(value["hostname"]) ||
    typeof value["customerCnameTarget"] !== "string" ||
    !DOMAIN_PATTERN.test(value["customerCnameTarget"])
  ) {
    throw new CloudflareCustomHostnameInputError();
  }
}

function validateReceipt(value: CloudflareCustomHostnameReceipt): void {
  validateTarget(value);
  if (
    !ID_PATTERN.test(value.customHostnameId) ||
    !HOSTNAME_STATUSES.has(value.status) ||
    (value.providerCreatedAt !== null && !validTimestamp(value.providerCreatedAt)) ||
    (value.ownershipVerification !== null &&
      (value.ownershipVerification.type !== "txt" ||
        !validDnsName(value.ownershipVerification.name) ||
        !validBoundedText(value.ownershipVerification.value, 2048))) ||
    (value.ownershipVerificationHttp !== null &&
      (!validHttpUrl(value.ownershipVerificationHttp.httpUrl) ||
        !validBoundedText(value.ownershipVerificationHttp.httpBody, 8192))) ||
    !Array.isArray(value.verificationErrors) ||
    value.verificationErrors.some((item) => !validBoundedText(item, 2048)) ||
    !isRecord(value.ssl) ||
    (value.ssl.sslId !== null &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.ssl.sslId)) ||
    (value.ssl.status !== null && !SSL_STATUSES.has(value.ssl.status)) ||
    (value.ssl.type !== null && value.ssl.type !== "dv") ||
    (value.ssl.method !== null &&
      value.ssl.method !== "http" &&
      value.ssl.method !== "txt" &&
      value.ssl.method !== "email") ||
    (value.ssl.bundleMethod !== null &&
      value.ssl.bundleMethod !== "ubiquitous" &&
      value.ssl.bundleMethod !== "optimal" &&
      value.ssl.bundleMethod !== "force") ||
    (value.ssl.certificateAuthority !== null &&
      !validBoundedText(value.ssl.certificateAuthority, 64)) ||
    !Array.isArray(value.ssl.validationRecords) ||
    !Array.isArray(value.ssl.dcvDelegationRecords) ||
    value.ssl.validationRecords.some((record) => !validValidationReceiptRecord(record)) ||
    value.ssl.dcvDelegationRecords.some((record) => !validValidationReceiptRecord(record)) ||
    typeof value.ready !== "boolean" ||
    !Array.isArray(value.dnsRecords) ||
    !(value.observedAt instanceof Date) ||
    !Number.isFinite(value.observedAt.getTime())
  ) {
    throw new CloudflareCustomHostnameInputError();
  }
  try {
    const expectedDnsRecords = buildDnsRecords(value, value.ownershipVerification, value.ssl);
    if (
      value.ready !== hostnameReady(value.status, value.providerCreatedAt, value.ssl) ||
      !sameDnsRecords(value.dnsRecords, expectedDnsRecords)
    ) {
      throw new CloudflareCustomHostnameInputError();
    }
  } catch {
    throw new CloudflareCustomHostnameInputError();
  }
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CloudflareCustomHostnameContractError();
  }
  return new Date(value.getTime());
}

function validDnsName(value: unknown): value is string {
  return typeof value === "string" && DNS_NAME_PATTERN.test(value);
}

function validDomain(value: unknown): value is string {
  return typeof value === "string" && DOMAIN_PATTERN.test(value);
}

function validBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function parseProviderTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CloudflareCustomHostnameContractError();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new CloudflareCustomHostnameContractError();
  return new Date(milliseconds).toISOString();
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validValidationReceiptRecord(value: CloudflareCustomHostnameSslValidationRecord): boolean {
  return (
    isRecord(value) &&
    (value["status"] === undefined || validBoundedText(value["status"], 64)) &&
    (value["cname"] === undefined || validDnsName(value["cname"])) &&
    (value["cnameTarget"] === undefined || validDomain(value["cnameTarget"])) &&
    (value["httpBody"] === undefined || validBoundedText(value["httpBody"], 8192)) &&
    (value["httpUrl"] === undefined || validHttpUrl(value["httpUrl"])) &&
    (value["txtName"] === undefined || validDnsName(value["txtName"])) &&
    (value["txtValue"] === undefined || validBoundedText(value["txtValue"], 8192)) &&
    (value["wildcard"] === undefined || typeof value["wildcard"] === "boolean")
  );
}

function sameDnsRecords(
  left: readonly CloudflareCustomHostnameDnsRecord[],
  right: readonly CloudflareCustomHostnameDnsRecord[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.purpose === right[index]?.purpose &&
        item.type === right[index]?.type &&
        item.name === right[index]?.name &&
        item.content === right[index]?.content,
    )
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CloudflareCustomHostnameContractError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
