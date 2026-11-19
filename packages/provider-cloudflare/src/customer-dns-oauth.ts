const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOCATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const REQUIRED_SCOPES = Object.freeze(["dns.write", "zone.read"] as const);
const AUTHORIZATION_SCOPES = Object.freeze([...REQUIRED_SCOPES, "offline_access"] as const);
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_PAGES = 100;
const PAGE_SIZE = 50;
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const DNS_NAME_PATTERN = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/u;
const ID_PATTERN = /^[a-f0-9]{32}$/u;
const OWNER_COMMENT_PATTERN =
  /^(?:ohmyhost:[0-7][0-9A-HJKMNP-TV-Z]{25}:[a-z0-9-]{1,32}:v1|ohmyhost:platform:mail-warning:v1)$/u;

export interface CloudflareOAuthAuthorizationInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}

export interface CloudflareCustomerDnsProviderConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMilliseconds: number;
}

export interface CloudflareCustomerOAuthTokenReceipt {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: "Bearer";
  readonly expiresInSeconds: number;
  readonly scopes: readonly ["dns.write", "zone.read"];
}

export type CloudflareRefreshTokenObservation =
  | Readonly<{ readonly state: "revoked" }>
  | Readonly<{
      readonly state: "active";
      readonly tokens: CloudflareCustomerOAuthTokenReceipt;
    }>;

export interface CloudflareCustomerZoneReceipt {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly accountId: string;
}

export type CloudflareCustomerZoneObservation =
  | Readonly<{ state: "absent"; zoneName: string }>
  | Readonly<{ state: "found" } & CloudflareCustomerZoneReceipt>;

export interface CloudflareDesiredDnsRecord {
  readonly type: "CNAME" | "NS" | "TXT" | "MX";
  readonly priority?: number;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly proxied: boolean;
  readonly comment: string;
}

export interface CloudflareCustomerDnsRecord extends CloudflareDesiredDnsRecord {
  readonly id: string;
}

export class CloudflareCustomerDnsProviderError extends Error {
  public readonly code = "cloudflare_customer_dns_request_failed" as const;

  public constructor() {
    super("Cloudflare customer DNS provider request failed");
    this.name = "CloudflareCustomerDnsProviderError";
  }
}

export class CloudflareCustomerDnsRejectedError extends Error {
  public readonly code = "cloudflare_customer_dns_request_rejected" as const;

  public constructor() {
    super("Cloudflare customer DNS provider request was rejected");
    this.name = "CloudflareCustomerDnsRejectedError";
  }
}

export class CloudflareCustomerDnsUncertainError extends Error {
  public readonly code = "cloudflare_customer_dns_result_uncertain" as const;

  public constructor() {
    super("Cloudflare customer DNS result is uncertain");
    this.name = "CloudflareCustomerDnsUncertainError";
  }
}

export class CloudflareCustomerDnsConflictError extends Error {
  public readonly code = "cloudflare_customer_dns_conflict" as const;

  public constructor() {
    super("Cloudflare customer DNS state conflicts with the requested record set");
    this.name = "CloudflareCustomerDnsConflictError";
  }
}

export class CloudflareCustomerDnsReceiptMismatchError extends Error {
  public readonly code = "cloudflare_customer_dns_receipt_mismatch" as const;

  public constructor() {
    super("Cloudflare customer DNS receipt does not match provider state");
    this.name = "CloudflareCustomerDnsReceiptMismatchError";
  }
}

export function createCloudflarePlatformDomainProvider(dependencies: {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
}) {
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies) ||
    !ID_PATTERN.test(String(dependencies.zoneId)) ||
    !DOMAIN_PATTERN.test(String(dependencies.zoneName)) ||
    typeof dependencies.apiToken !== "string" ||
    dependencies.apiToken.length < 16 ||
    typeof dependencies.fetch !== "function" ||
    (dependencies.timeoutMilliseconds !== undefined &&
      (!Number.isSafeInteger(dependencies.timeoutMilliseconds) ||
        dependencies.timeoutMilliseconds < 100 ||
        dependencies.timeoutMilliseconds > 30_000))
  ) {
    throw new TypeError("Cloudflare platform domain provider configuration is invalid");
  }
  const timeoutMilliseconds = dependencies.timeoutMilliseconds ?? 15_000;
  const dns = new CloudflareCustomerDnsProvider({
    // This adapter only exposes the DNS record methods below. These inert values are never sent
    // because the OAuth methods are deliberately not part of the platform provider contract.
    clientId: "platform-domain-dns",
    clientSecret: "platform-domain-dns-not-an-oauth-secret",
    redirectUri: "https://platform.invalid/cloudflare-oauth-disabled",
    fetch: dependencies.fetch,
    timeoutMilliseconds,
  });
  const requirePlatformZone = (input: { readonly zoneId: string; readonly zoneName: string }) => {
    if (input?.zoneId !== dependencies.zoneId || input.zoneName !== dependencies.zoneName) {
      throw new TypeError("Cloudflare platform domain request is invalid");
    }
  };
  type GatewayWildcard = {
    readonly zoneId: string;
    readonly zoneName: string;
    readonly hostname: "*.check.omh.st" | "*.dev.check.omh.st";
    readonly target: "check.omh.st" | "dev.check.omh.st";
  };
  async function lookupGatewayWildcard(
    input: GatewayWildcard,
  ): Promise<{ readonly recordId: string } | null> {
    requirePlatformZone(input);
    if (
      (input.hostname === "*.check.omh.st" && input.target !== "check.omh.st") ||
      (input.hostname === "*.dev.check.omh.st" && input.target !== "dev.check.omh.st")
    )
      throw new TypeError("Gateway wildcard identity is invalid");
    const url = `${API_ORIGIN}/zones/${input.zoneId}/dns_records?${new URLSearchParams({
      type: "CNAME",
      name: input.hostname,
      per_page: "2",
    }).toString()}`;
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        method: "GET",
        headers: bearer(dependencies.apiToken),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch {
      throw new CloudflareCustomerDnsProviderError();
    }
    const length = response.headers.get("content-length");
    if (!response.ok || (length !== null && Number(length) > 16_384))
      throw new CloudflareCustomerDnsProviderError();
    const text = await response.text();
    if (text.length > 16_384) throw new CloudflareCustomerDnsProviderError();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new CloudflareCustomerDnsProviderError();
    }
    const envelope = record(body);
    const rows = envelope["result"];
    if (envelope["success"] !== true || !Array.isArray(rows) || rows.length > 1)
      throw new CloudflareCustomerDnsProviderError();
    if (rows.length === 0) return null;
    const row = record(rows[0]);
    if (
      !ID_PATTERN.test(String(row["id"])) ||
      row["type"] !== "CNAME" ||
      row["name"] !== input.hostname ||
      row["content"] !== input.target ||
      row["proxied"] !== true ||
      row["ttl"] !== 1
    )
      throw new CloudflareCustomerDnsProviderError();
    return Object.freeze({ recordId: String(row["id"]) });
  }
  return Object.freeze({
    async observeGatewayWildcard(input: GatewayWildcard): Promise<{ readonly recordId: string }> {
      const present = await lookupGatewayWildcard(input);
      if (present === null) throw new CloudflareCustomerDnsProviderError();
      return present;
    },
    async ensureGatewayWildcard(
      input: GatewayWildcard,
    ): Promise<{ readonly recordId: string; readonly outcome: "existing" | "created" }> {
      const previous = await lookupGatewayWildcard(input);
      if (previous !== null) return Object.freeze({ ...previous, outcome: "existing" as const });
      let response: Response;
      try {
        response = await dependencies.fetch(`${API_ORIGIN}/zones/${input.zoneId}/dns_records`, {
          method: "POST",
          headers: { ...bearer(dependencies.apiToken), "content-type": "application/json" },
          body: JSON.stringify({
            type: "CNAME",
            name: input.hostname,
            content: input.target,
            proxied: true,
            ttl: 1,
            comment: "ohmyhost:platform:gateway-wildcard:v1",
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        throw new CloudflareCustomerDnsProviderError();
      }
      await response.body?.cancel();
      const observed = await lookupGatewayWildcard(input);
      if (observed === null) throw new CloudflareCustomerDnsProviderError();
      return Object.freeze({ ...observed, outcome: "created" as const });
    },
    reconcileRecords: (input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly records: readonly CloudflareDesiredDnsRecord[];
    }) => {
      requirePlatformZone(input);
      return dns.reconcileRecords(dependencies.apiToken, input);
    },
    deleteRecords: (input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly records: readonly CloudflareCustomerDnsRecord[];
    }) => {
      requirePlatformZone(input);
      return dns.deleteRecords(dependencies.apiToken, input);
    },
  });
}

export function createCloudflareCustomerAuthorizationUrl(
  input: CloudflareOAuthAuthorizationInput,
): string {
  if (
    !validClientId(input?.clientId) ||
    !validHttpsUrl(input?.redirectUri) ||
    typeof input?.state !== "string" ||
    input.state.length < 32 ||
    input.state.length > 256 ||
    !/^[A-Za-z0-9._~-]+$/u.test(input.state)
  ) {
    throw new TypeError("Cloudflare OAuth authorization input is invalid");
  }
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: AUTHORIZATION_SCOPES.join(" "),
    state: input.state,
  }).toString();
  return url.toString();
}

export class CloudflareCustomerDnsProvider {
  public constructor(private readonly config: CloudflareCustomerDnsProviderConfig) {
    if (
      !validClientId(config?.clientId) ||
      typeof config?.clientSecret !== "string" ||
      config.clientSecret.length < 16 ||
      !validHttpsUrl(config?.redirectUri) ||
      typeof config?.fetch !== "function" ||
      !Number.isSafeInteger(config?.timeoutMilliseconds) ||
      config.timeoutMilliseconds < 100 ||
      config.timeoutMilliseconds > 30_000
    ) {
      throw new TypeError("Cloudflare customer DNS provider configuration is invalid");
    }
  }

  public async exchangeAuthorizationCode(
    code: string,
  ): Promise<CloudflareCustomerOAuthTokenReceipt> {
    if (typeof code !== "string" || code.length < 8 || code.length > 2_048) {
      throw new TypeError("Cloudflare OAuth authorization code is invalid");
    }
    return this.requestToken(
      new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: this.config.redirectUri,
      }),
    );
  }

  public async refreshAccessToken(
    refreshToken: string,
  ): Promise<CloudflareCustomerOAuthTokenReceipt> {
    requireRefreshToken(refreshToken);
    return this.requestToken(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    );
  }

  public async revokeRefreshToken(refreshToken: string): Promise<void> {
    requireRefreshToken(refreshToken);
    let response: Response;
    try {
      response = await this.request(REVOCATION_ENDPOINT, {
        method: "POST",
        headers: this.confidentialFormHeaders(),
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
      });
    } catch {
      throw new CloudflareCustomerDnsUncertainError();
    }
    if (response.status >= 400 && response.status < 500) {
      await discardBody(response);
      throw new CloudflareCustomerDnsRejectedError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareCustomerDnsUncertainError();
    }
    await discardBody(response);
  }

  public async observeRefreshToken(
    refreshToken: string,
  ): Promise<CloudflareRefreshTokenObservation> {
    requireRefreshToken(refreshToken);
    let response: Response;
    try {
      response = await this.request(TOKEN_ENDPOINT, {
        method: "POST",
        headers: this.confidentialFormHeaders(),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
    } catch {
      throw new CloudflareCustomerDnsUncertainError();
    }
    if (response.status === 400) {
      let body: unknown;
      try {
        body = await responseJson(response);
      } catch {
        throw new CloudflareCustomerDnsUncertainError();
      }
      if (isInvalidGrant(body)) return Object.freeze({ state: "revoked" as const });
      throw new CloudflareCustomerDnsRejectedError();
    }
    if (response.status > 400 && response.status < 500) {
      await discardBody(response);
      throw new CloudflareCustomerDnsRejectedError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareCustomerDnsUncertainError();
    }
    try {
      return Object.freeze({
        state: "active" as const,
        tokens: parseTokenReceipt(await responseJson(response)),
      });
    } catch {
      throw new CloudflareCustomerDnsUncertainError();
    }
  }

  public async observeZone(
    accessToken: string,
    zoneName: string,
  ): Promise<CloudflareCustomerZoneObservation> {
    requireAccessToken(accessToken);
    if (!DOMAIN_PATTERN.test(zoneName)) throw invalidDnsInput();
    const zones = await this.readPages(
      (page) =>
        `${API_ORIGIN}/zones?${new URLSearchParams({
          match: "all",
          name: zoneName,
          page: String(page),
          per_page: String(PAGE_SIZE),
          status: "active",
        }).toString()}`,
      accessToken,
    );
    const matches = zones.map(parseZone).filter((zone) => zone.zoneName === zoneName);
    if (matches.length === 0) return Object.freeze({ state: "absent", zoneName });
    if (matches.length !== 1) throw new CloudflareCustomerDnsProviderError();
    const match = matches[0];
    if (match === undefined) throw new CloudflareCustomerDnsProviderError();
    return Object.freeze({ state: "found", ...match });
  }

  public async reconcileRecords(
    accessToken: string,
    input: Readonly<{
      zoneId: string;
      zoneName: string;
      records: readonly CloudflareDesiredDnsRecord[];
    }>,
    options: Readonly<{
      adoptExactTrafficCname?: boolean;
      preserveUnrelatedMailRecords?: boolean;
      /** Read current exact ownership only; never adopt, create or update records. */
      observeOnly?: boolean;
      /** Only the Paid-domain use case supplies this after its claim and scoped OAuth grant. */
      replaceTrafficHostname?: string;
    }> = {},
  ): Promise<
    Readonly<{
      status: "applied" | "replayed";
      records: readonly CloudflareCustomerDnsRecord[];
    }>
  > {
    requireAccessToken(accessToken);
    const desired = parseDesiredRecords(input);
    if (options.observeOnly === true) {
      if (options.replaceTrafficHostname !== undefined) throw invalidDnsInput();
      const current = await this.readZoneRecords(accessToken, input.zoneId, desired);
      if (
        current.some(
          (record) =>
            desired.some(
              (expected) => record.name === expected.name && record.comment === expected.comment,
            ) && !desired.some((expected) => sameRecord(record, expected)),
        )
      )
        throw new CloudflareCustomerDnsConflictError();
      const owned = exactRecords(current, desired);
      if (
        new Set(owned.map((record) => `${record.type}\t${record.name}\t${record.content}`)).size !==
        owned.length
      )
        throw new CloudflareCustomerDnsConflictError();
      return Object.freeze({ status: "replayed" as const, records: owned });
    }
    if (options.replaceTrafficHostname !== undefined) {
      const traffic = desired.find((item) => item.name === options.replaceTrafficHostname);
      if (
        traffic?.type !== "CNAME" ||
        traffic.proxied ||
        traffic.ttl !== 300 ||
        !/^ohmyhost:[0-7][0-9A-HJKMNP-TV-Z]{25}:paid-traffic:v1$/u.test(traffic.comment) ||
        desired.some((item) => item.comment.split(":")[1] !== traffic.comment.split(":")[1])
      )
        throw invalidDnsInput();
      return this.reconcilePaidTraffic(accessToken, input, desired, traffic);
    }
    const current = await this.readZoneRecords(accessToken, input.zoneId, desired);
    requireNoForeignRecords(current, desired, options, input.zoneName);
    const exactCurrent = exactRecords(current, desired);
    const adoptableTraffic = current.filter((candidate) =>
      desired.some((expected) => adoptableTrafficRecord(candidate, expected, options)),
    );
    const missing = desired.filter(
      (candidate) =>
        !exactCurrent.some((existing) => sameRecord(existing, candidate)) &&
        !adoptableTraffic.some((existing) => adoptableTrafficRecord(existing, candidate, options)),
    );
    if (missing.length === 0 && adoptableTraffic.length === 0) {
      return Object.freeze({ status: "replayed" as const, records: exactCurrent });
    }
    if (
      adoptableTraffic.length > 1 ||
      (adoptableTraffic.length > 0 && missing.length > 0) ||
      adoptableTraffic.some((record) =>
        exactCurrent.some(
          (exact) =>
            exact.type === record.type &&
            exact.name === record.name &&
            exact.content === record.content &&
            exact.comment === record.comment,
        ),
      )
    ) {
      throw new CloudflareCustomerDnsConflictError();
    }
    const recordToAdopt = adoptableTraffic[0] ?? null;
    const patchedRecordId = recordToAdopt?.id ?? null;
    const patchedDesiredRecord =
      recordToAdopt === null
        ? null
        : (desired.find((candidate) => adoptableTrafficRecord(recordToAdopt, candidate, options)) ??
          null);

    let rejected = false;
    let conflicted = false;
    try {
      const response = await this.request(`${API_ORIGIN}/zones/${input.zoneId}/dns_records/batch`, {
        method: "POST",
        headers: { ...bearer(accessToken), "content-type": "application/json" },
        body: JSON.stringify(
          adoptableTraffic.length === 1
            ? {
                patches: [{ id: patchedRecordId, ...patchedDesiredRecord }],
              }
            : { posts: missing },
        ),
      });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        if (response.status === 409) conflicted = true;
        else rejected = true;
      } else {
        await requireMutationEnvelope(response);
      }
    } catch {
      // A failed or malformed mutation response is resolved only by exact readback below.
    }
    if (rejected) throw new CloudflareCustomerDnsRejectedError();

    try {
      const observed = await this.readZoneRecords(accessToken, input.zoneId, desired);
      requireNoForeignRecords(observed, desired, options, input.zoneName);
      const exactObserved = exactRecords(observed, desired);
      if (
        exactObserved.length === desired.length &&
        (patchedRecordId === null ||
          (patchedDesiredRecord !== null &&
            exactObserved.some(
              (item) => item.id === patchedRecordId && sameRecord(item, patchedDesiredRecord),
            ))) &&
        desired.every((candidate) => exactObserved.some((item) => sameRecord(item, candidate)))
      ) {
        return Object.freeze({ status: "applied" as const, records: exactObserved });
      }
    } catch {
      // The public result remains a redacted uncertainty regardless of readback failure details.
    }
    if (conflicted) throw new CloudflareCustomerDnsRejectedError();
    throw new CloudflareCustomerDnsUncertainError();
  }

  private async reconcilePaidTraffic(
    accessToken: string,
    input: Readonly<{ zoneId: string; zoneName: string }>,
    desired: readonly CloudflareDesiredDnsRecord[],
    traffic: CloudflareDesiredDnsRecord,
  ): Promise<
    Readonly<{ status: "applied" | "replayed"; records: readonly CloudflareCustomerDnsRecord[] }>
  > {
    const current = await this.readZoneRecords(accessToken, input.zoneId, desired);
    const preserved = current.filter((record) =>
      preservedApexRecord(record, traffic, input.zoneName),
    );
    const web = current.filter(
      (record) => record.name === traffic.name && ["A", "AAAA", "CNAME"].includes(record.type),
    );
    const cnames = web.filter((record) => record.type === "CNAME");
    if (
      cnames.length > 1 ||
      (cnames.length === 1 && web.length > 1) ||
      web.some(
        (record) => record.comment?.startsWith("ohmyhost:") && record.comment !== traffic.comment,
      )
    )
      throw new CloudflareCustomerDnsConflictError();
    const permittedIds = new Set([...preserved, ...web].map((record) => record.id));
    requireNoForeignRecords(
      current.filter((record) => !permittedIds.has(record.id)),
      desired,
      {},
    );
    const exact = exactRecords(current, desired);
    const previousCname = cnames[0];
    const patches =
      previousCname !== undefined && !sameRecord(previousCname, traffic)
        ? [{ id: previousCname.id, ...traffic }]
        : [];
    const deletes = web
      .filter((record) => record.type !== "CNAME")
      .map((record) => ({ id: record.id }));
    const posts = desired.filter(
      (record) =>
        !exact.some((existing) => sameRecord(existing, record)) &&
        !(previousCname !== undefined && record === traffic),
    );
    if (deletes.length + patches.length + posts.length > 200)
      throw new CloudflareCustomerDnsConflictError();
    if (deletes.length + patches.length + posts.length === 0)
      return Object.freeze({ status: "replayed" as const, records: exact });

    // Cloudflare applies one database transaction in delete/patch/post order.
    // Propagation is not atomic, so only exact readback can complete the operation.
    let rejected = false;
    try {
      const response = await this.request(`${API_ORIGIN}/zones/${input.zoneId}/dns_records/batch`, {
        method: "POST",
        headers: { ...bearer(accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          ...(deletes.length ? { deletes } : {}),
          ...(patches.length ? { patches } : {}),
          ...(posts.length ? { posts } : {}),
        }),
      });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        rejected = true;
      } else await requireMutationEnvelope(response);
    } catch {
      // Lost or malformed responses are resolved by the same readback as ordinary writes.
    }
    try {
      const observed = await this.readZoneRecords(accessToken, input.zoneId, desired);
      requireNoForeignRecords(
        observed.filter((record) => !preservedApexRecord(record, traffic, input.zoneName)),
        desired,
        {},
      );
      const actual = exactRecords(observed, desired);
      if (
        actual.length === desired.length &&
        desired.every((record) => actual.some((entry) => sameRecord(entry, record))) &&
        deletes.every((record) => observed.every((entry) => entry.id !== record.id)) &&
        (previousCname === undefined ||
          actual.some((entry) => entry.id === previousCname.id && sameRecord(entry, traffic))) &&
        preserved.every((record) => observed.some((entry) => sameObservedRecord(entry, record)))
      )
        return Object.freeze({ status: "applied" as const, records: actual });
    } catch {
      // Never repeat an uncertain mutation inside the adapter.
    }
    if (rejected) throw new CloudflareCustomerDnsRejectedError();
    throw new CloudflareCustomerDnsUncertainError();
  }

  public async deleteRecords(
    accessToken: string,
    input: Readonly<{
      zoneId: string;
      zoneName: string;
      records: readonly CloudflareCustomerDnsRecord[];
    }>,
  ): Promise<Readonly<{ status: "deleted" | "replayed"; recordIds: readonly string[] }>> {
    requireAccessToken(accessToken);
    const expected = parseReceiptRecords(input);
    const desired = expected.map((record) =>
      Object.freeze({
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
        comment: record.comment,
        ...(record.type === "MX" ? { priority: Number(record.priority) } : {}),
      }),
    );
    const current = await this.readZoneRecords(accessToken, input.zoneId, desired);
    const currentById = new Map(current.map((record) => [record.id, record]));
    const present = expected.filter((receipt) => currentById.has(receipt.id));
    const missing = expected.filter((receipt) => !currentById.has(receipt.id));
    if (present.length === 0) {
      if (current.some((record) => expected.some((receipt) => sameRecord(record, receipt)))) {
        throw new CloudflareCustomerDnsReceiptMismatchError();
      }
      return Object.freeze({
        status: "replayed" as const,
        recordIds: Object.freeze(expected.map((record) => record.id)),
      });
    }
    if (current.some((record) => missing.some((receipt) => sameRecord(record, receipt)))) {
      throw new CloudflareCustomerDnsReceiptMismatchError();
    }
    if (
      present.some((receipt) => {
        const observed = currentById.get(receipt.id);
        return observed === undefined || !sameReceipt(observed, receipt);
      })
    ) {
      throw new CloudflareCustomerDnsReceiptMismatchError();
    }

    let rejected = false;
    try {
      const response = await this.request(`${API_ORIGIN}/zones/${input.zoneId}/dns_records/batch`, {
        method: "POST",
        headers: { ...bearer(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ deletes: present.map((record) => ({ id: record.id })) }),
      });
      if (response.status >= 400 && response.status < 500) {
        await discardBody(response);
        rejected = true;
      } else {
        await requireMutationEnvelope(response);
      }
    } catch {
      // A failed or malformed mutation response is resolved only by exact readback below.
    }

    try {
      const observed = await this.readZoneRecords(accessToken, input.zoneId, desired);
      const remainingIds = new Set(observed.map((record) => record.id));
      const sameOwnedIdentityRemains = observed.some((record) =>
        expected.some((receipt) => sameRecord(record, receipt)),
      );
      if (expected.every((record) => !remainingIds.has(record.id)) && !sameOwnedIdentityRemains) {
        return Object.freeze({
          status: "deleted" as const,
          recordIds: Object.freeze(expected.map((record) => record.id)),
        });
      }
    } catch {
      // The public result remains a redacted uncertainty regardless of readback failure details.
    }
    if (rejected) throw new CloudflareCustomerDnsRejectedError();
    throw new CloudflareCustomerDnsUncertainError();
  }

  private async requestToken(form: URLSearchParams): Promise<CloudflareCustomerOAuthTokenReceipt> {
    let response: Response;
    try {
      response = await this.request(TOKEN_ENDPOINT, {
        method: "POST",
        headers: this.confidentialFormHeaders(),
        body: form.toString(),
      });
    } catch {
      throw new CloudflareCustomerDnsUncertainError();
    }
    if (response.status >= 400 && response.status < 500) {
      await discardBody(response);
      throw new CloudflareCustomerDnsRejectedError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareCustomerDnsUncertainError();
    }
    try {
      return parseTokenReceipt(await responseJson(response));
    } catch {
      throw new CloudflareCustomerDnsUncertainError();
    }
  }

  private confidentialFormHeaders(): Readonly<Record<string, string>> {
    return Object.freeze({
      authorization: `Basic ${base64(`${this.config.clientId}:${this.config.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    });
  }

  private async readZoneRecords(
    accessToken: string,
    zoneId: string,
    desired: readonly CloudflareDesiredDnsRecord[],
  ): Promise<readonly ObservedDnsRecord[]> {
    const desiredNames = [...new Set(desired.map((item) => item.name))].sort();
    const records: ObservedDnsRecord[] = [];
    for (const name of desiredNames) {
      const values = await this.readPages(
        (page) =>
          `${API_ORIGIN}/zones/${zoneId}/dns_records?${new URLSearchParams({
            match: "all",
            "name.exact": name,
            page: String(page),
            per_page: String(PAGE_SIZE),
          }).toString()}`,
        accessToken,
      );
      records.push(...values.map(parseObservedRecord));
    }
    const ids = new Set<string>();
    if (records.some((record) => ids.size === ids.add(record.id).size)) {
      throw new CloudflareCustomerDnsProviderError();
    }
    return Object.freeze(records.sort(compareRecords));
  }

  private async readPages(
    pageUrl: (page: number) => string,
    accessToken: string,
  ): Promise<readonly unknown[]> {
    const values: unknown[] = [];
    let expectedTotalPages: number | null = null;
    let expectedTotalCount: number | null = null;
    for (let page = 1; page <= MAXIMUM_PAGES; page += 1) {
      const response = await this.readRequest(pageUrl(page), bearer(accessToken));
      const parsed = parsePage(await responseJson(response), page);
      expectedTotalPages ??= parsed.totalPages;
      expectedTotalCount ??= parsed.totalCount;
      if (
        parsed.totalPages !== expectedTotalPages ||
        parsed.totalCount !== expectedTotalCount ||
        page > parsed.totalPages
      ) {
        throw new CloudflareCustomerDnsProviderError();
      }
      values.push(...parsed.result);
      if (page === parsed.totalPages) {
        if (values.length !== parsed.totalCount) throw new CloudflareCustomerDnsProviderError();
        return Object.freeze(values);
      }
    }
    throw new CloudflareCustomerDnsProviderError();
  }

  private async readRequest(url: string, headers: HeadersInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(url, { method: "GET", headers });
    } catch {
      throw new CloudflareCustomerDnsProviderError();
    }
    if (response.status >= 400 && response.status < 500) {
      await discardBody(response);
      throw new CloudflareCustomerDnsRejectedError();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new CloudflareCustomerDnsProviderError();
    }
    return response;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMilliseconds);
    try {
      return await Reflect.apply(this.config.fetch, globalThis, [
        url,
        { ...init, redirect: "manual", signal: controller.signal },
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface ObservedDnsRecord {
  readonly id: string;
  readonly type: "CNAME" | "NS" | "TXT" | "MX" | "A" | "AAAA" | "CAA";
  readonly priority?: number;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly comment: string | null;
  readonly proxied: boolean;
}

function preservedApexRecord(
  record: ObservedDnsRecord,
  traffic: CloudflareDesiredDnsRecord,
  zoneName: string,
): boolean {
  // Cloudflare flattens apex CNAMEs; mail and certificate policy still belong to the customer.
  return (
    traffic.name === zoneName &&
    record.name === traffic.name &&
    ["MX", "TXT", "CAA"].includes(record.type)
  );
}

function sameObservedRecord(left: ObservedDnsRecord, right: ObservedDnsRecord): boolean {
  return (
    left.id === right.id &&
    left.type === right.type &&
    left.name === right.name &&
    left.content === right.content &&
    left.ttl === right.ttl &&
    left.proxied === right.proxied &&
    left.comment === right.comment &&
    left.priority === right.priority
  );
}

function parseDesiredRecords(input: {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly records: readonly CloudflareDesiredDnsRecord[];
}): readonly CloudflareDesiredDnsRecord[] {
  if (
    !ID_PATTERN.test(String(input?.zoneId)) ||
    !DOMAIN_PATTERN.test(String(input?.zoneName)) ||
    !Array.isArray(input?.records) ||
    input.records.length === 0 ||
    input.records.length > 32
  ) {
    throw invalidDnsInput();
  }
  const parsed = input.records.map((item) => {
    const name = String(item?.name);
    const content = String(item?.content);
    if (
      (item?.type !== "CNAME" &&
        item?.type !== "NS" &&
        item?.type !== "TXT" &&
        item?.type !== "MX") ||
      (item.type === "MX" &&
        (!Number.isInteger(item.priority) ||
          Number(item.priority) < 0 ||
          Number(item.priority) > 65535)) ||
      (item.type !== "MX" && item.priority !== undefined) ||
      !DNS_NAME_PATTERN.test(name) ||
      (name !== input.zoneName && !name.endsWith(`.${input.zoneName}`)) ||
      !Number.isSafeInteger(item.ttl) ||
      typeof item.proxied !== "boolean" ||
      (item.proxied
        ? item.type !== "CNAME" || item.ttl !== 1
        : item.ttl < 60 || item.ttl > 86_400) ||
      !OWNER_COMMENT_PATTERN.test(String(item.comment)) ||
      content.length === 0 ||
      content.length > 2_048 ||
      ((item.type === "CNAME" || item.type === "NS" || item.type === "MX") &&
        !DOMAIN_PATTERN.test(content))
    ) {
      throw invalidDnsInput();
    }
    return Object.freeze({
      type: item.type,
      name,
      content,
      ttl: item.ttl,
      proxied: item.proxied,
      comment: item.comment,
      ...(item.type === "MX" ? { priority: Number(item.priority) } : {}),
    });
  });
  parsed.sort(compareRecords);
  if (
    parsed.some((item, index) => {
      const previous = parsed[index - 1];
      return previous !== undefined && compareRecords(item, previous) === 0;
    }) ||
    parsed.some(
      (item) =>
        item.type === "CNAME" &&
        parsed.some((candidate) => candidate !== item && candidate.name === item.name),
    )
  ) {
    throw invalidDnsInput();
  }
  return Object.freeze(parsed);
}

function parseReceiptRecords(input: {
  readonly zoneId: string;
  readonly zoneName: string;
  readonly records: readonly CloudflareCustomerDnsRecord[];
}): readonly CloudflareCustomerDnsRecord[] {
  const desired = parseDesiredRecords(input);
  const ids = new Set<string>();
  const receipts = input.records.map((record) => {
    const desiredRecord = desired.find((candidate) => compareRecords(candidate, record) === 0);
    if (desiredRecord === undefined || !ID_PATTERN.test(String(record.id)) || ids.has(record.id)) {
      throw invalidDnsInput();
    }
    ids.add(record.id);
    return Object.freeze({ ...desiredRecord, id: record.id });
  });
  return Object.freeze(receipts.sort(compareRecords));
}

function parseObservedRecord(value: unknown): ObservedDnsRecord {
  const item = record(value);
  // Cloudflare's RecordResponse inherits optional `comment?: string` from its record type.
  const comment = item["comment"] === undefined ? null : item["comment"];
  if (
    !ID_PATTERN.test(String(item["id"])) ||
    (item["type"] !== "CNAME" &&
      item["type"] !== "NS" &&
      item["type"] !== "TXT" &&
      item["type"] !== "MX" &&
      item["type"] !== "A" &&
      item["type"] !== "AAAA" &&
      item["type"] !== "CAA") ||
    (item["type"] === "MX" &&
      (!Number.isInteger(item["priority"]) ||
        Number(item["priority"]) < 0 ||
        Number(item["priority"]) > 65535)) ||
    !DNS_NAME_PATTERN.test(String(item["name"])) ||
    typeof item["content"] !== "string" ||
    ((item["type"] === "CNAME" || item["type"] === "NS" || item["type"] === "MX") &&
      !DOMAIN_PATTERN.test(item["content"])) ||
    !Number.isSafeInteger(item["ttl"]) ||
    (typeof comment !== "string" && comment !== null) ||
    typeof item["proxied"] !== "boolean"
  ) {
    throw new CloudflareCustomerDnsProviderError();
  }
  return Object.freeze({
    id: String(item["id"]),
    type: item["type"],
    name: String(item["name"]),
    content: item["content"],
    ttl: Number(item["ttl"]),
    comment,
    ...(item["type"] === "MX" ? { priority: Number(item["priority"]) } : {}),
    proxied: item["proxied"],
  });
}

function parseZone(value: unknown): CloudflareCustomerZoneReceipt {
  const zone = record(value);
  const account = record(zone["account"]);
  if (
    !ID_PATTERN.test(String(zone["id"])) ||
    !DOMAIN_PATTERN.test(String(zone["name"])) ||
    zone["status"] !== "active" ||
    typeof account["id"] !== "string" ||
    !ID_PATTERN.test(account["id"])
  ) {
    throw new CloudflareCustomerDnsProviderError();
  }
  return Object.freeze({
    zoneId: String(zone["id"]),
    zoneName: String(zone["name"]),
    accountId: account["id"],
  });
}

function parseTokenReceipt(value: unknown): CloudflareCustomerOAuthTokenReceipt {
  const token = record(value);
  if (
    !hasOnlyKeys(token, ["access_token", "refresh_token", "token_type", "expires_in", "scope"]) ||
    typeof token["access_token"] !== "string" ||
    token["access_token"].length < 16 ||
    typeof token["refresh_token"] !== "string" ||
    token["refresh_token"].length < 16 ||
    typeof token["token_type"] !== "string" ||
    token["token_type"].toLowerCase() !== "bearer" ||
    !positiveInteger(token["expires_in"]) ||
    !validTokenScopes(token["scope"])
  ) {
    throw new CloudflareCustomerDnsProviderError();
  }
  return Object.freeze({
    accessToken: token["access_token"],
    refreshToken: token["refresh_token"],
    tokenType: "Bearer" as const,
    expiresInSeconds: token["expires_in"],
    scopes: REQUIRED_SCOPES,
  });
}

function isInvalidGrant(value: unknown): boolean {
  let error: Record<string, unknown>;
  try {
    error = record(value);
  } catch {
    return false;
  }
  return (
    hasOnlyKeys(error, ["error", "error_description", "error_uri"]) &&
    error["error"] === "invalid_grant" &&
    (error["error_description"] === undefined ||
      (typeof error["error_description"] === "string" &&
        error["error_description"].length <= 2_048)) &&
    (error["error_uri"] === undefined || validHttpsUrl(String(error["error_uri"])))
  );
}

function parsePage(
  value: unknown,
  expectedPage: number,
): Readonly<{ result: readonly unknown[]; totalCount: number; totalPages: number }> {
  const envelope = record(value);
  const info = record(envelope["result_info"]);
  const result = envelope["result"];
  if (
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !Array.isArray(result) ||
    info["count"] !== result.length ||
    info["page"] !== expectedPage ||
    !positiveInteger(info["per_page"]) ||
    Number(info["per_page"]) > PAGE_SIZE ||
    !nonNegativeInteger(info["total_count"]) ||
    !positiveInteger(info["total_pages"]) ||
    Number(info["total_pages"]) > MAXIMUM_PAGES ||
    expectedPage > Number(info["total_pages"])
  ) {
    throw new CloudflareCustomerDnsProviderError();
  }
  return Object.freeze({
    result: Object.freeze(result),
    totalCount: Number(info["total_count"]),
    totalPages: Number(info["total_pages"]),
  });
}

async function requireMutationEnvelope(response: Response): Promise<void> {
  if (!response.ok) throw new CloudflareCustomerDnsUncertainError();
  const envelope = record(await responseJson(response));
  if (
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !("result" in envelope)
  ) {
    throw new CloudflareCustomerDnsUncertainError();
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
  ) {
    throw new CloudflareCustomerDnsProviderError();
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAXIMUM_RESPONSE_BYTES) throw new CloudflareCustomerDnsProviderError();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CloudflareCustomerDnsProviderError();
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The redacted outcome does not depend on whether response cancellation succeeds.
  }
}

function requireNoForeignRecords(
  observed: readonly ObservedDnsRecord[],
  desired: readonly CloudflareDesiredDnsRecord[],
  options: Readonly<{
    adoptExactTrafficCname?: boolean;
    preserveUnrelatedMailRecords?: boolean;
  }>,
  zoneName?: string,
): void {
  const desiredNames = new Set(desired.map((record) => record.name));
  if (
    observed.some(
      (candidate) =>
        desiredNames.has(candidate.name) &&
        !preservableMailRecord(
          candidate,
          desired,
          options.preserveUnrelatedMailRecords === true,
          zoneName,
        ) &&
        !desired.some(
          (expected) =>
            sameRecord(candidate, expected) || adoptableTrafficRecord(candidate, expected, options),
        ),
    )
  ) {
    throw new CloudflareCustomerDnsConflictError();
  }
}

function preservableMailRecord(
  observed: ObservedDnsRecord,
  desired: readonly CloudflareDesiredDnsRecord[],
  enabled: boolean,
  zoneName?: string,
): boolean {
  if (!enabled) return false;
  const sameName = desired.filter((record) => record.name === observed.name);
  const traffic = sameName.find((record) => record.type === "CNAME");
  if (traffic !== undefined) {
    return (
      zoneName !== undefined &&
      /^ohmyhost:[0-7][0-9A-HJKMNP-TV-Z]{25}:paid-traffic:v1$/u.test(traffic.comment) &&
      preservedApexRecord(observed, traffic, zoneName)
    );
  }
  if (sameName.some((record) => record.type === "NS")) return false;
  if (observed.type === "A" || observed.type === "AAAA" || observed.type === "CAA") return true;
  if (observed.type !== "TXT") return false;
  const txt = sameName.filter((record) => record.type === "TXT");
  if (!txt.length) return true;
  return (
    txt.every((record) => record.content.replace(/^"/u, "").startsWith("v=spf1 ")) &&
    !observed.content.replace(/^"/u, "").startsWith("v=spf1 ")
  );
}

function exactRecords(
  observed: readonly ObservedDnsRecord[],
  desired: readonly CloudflareDesiredDnsRecord[],
): readonly CloudflareCustomerDnsRecord[] {
  return Object.freeze(
    observed
      .filter((candidate) => desired.some((expected) => sameRecord(candidate, expected)))
      .map((record) =>
        Object.freeze({
          id: record.id,
          type: record.type as CloudflareDesiredDnsRecord["type"],
          name: record.name,
          content: record.content,
          ttl: record.ttl,
          proxied: record.proxied,
          comment: String(record.comment),
          ...(record.type === "MX" ? { priority: Number(record.priority) } : {}),
        }),
      )
      .sort(compareRecords),
  );
}

function sameRecord(
  observed: ObservedDnsRecord | CloudflareCustomerDnsRecord,
  desired: CloudflareDesiredDnsRecord,
): boolean {
  return (
    observed.type === desired.type &&
    observed.name === desired.name &&
    observed.content === desired.content &&
    observed.ttl === desired.ttl &&
    observed.comment === desired.comment &&
    observed.proxied === desired.proxied &&
    observed.priority === desired.priority
  );
}

function adoptableTrafficRecord(
  observed: ObservedDnsRecord,
  desired: CloudflareDesiredDnsRecord,
  options: Readonly<{
    adoptExactTrafficCname?: boolean;
    preserveUnrelatedMailRecords?: boolean;
  }>,
): boolean {
  return (
    options.adoptExactTrafficCname === true &&
    desired.type === "CNAME" &&
    desired.proxied === false &&
    desired.ttl === 300 &&
    observed.type === desired.type &&
    observed.name === desired.name &&
    observed.content === desired.content &&
    observed.proxied === desired.proxied &&
    observed.ttl === desired.ttl &&
    observed.comment === null
  );
}

function sameReceipt(observed: ObservedDnsRecord, receipt: CloudflareCustomerDnsRecord): boolean {
  return observed.id === receipt.id && sameRecord(observed, receipt);
}

function compareRecords(
  left: Pick<ObservedDnsRecord, "name" | "type" | "content">,
  right: Pick<ObservedDnsRecord, "name" | "type" | "content">,
): number {
  const leftKey = `${left.name}\t${left.type}\t${left.content}`;
  const rightKey = `${right.name}\t${right.type}\t${right.content}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function bearer(accessToken: string): Readonly<Record<string, string>> {
  return Object.freeze({ authorization: `Bearer ${accessToken}` });
}

function requireAccessToken(value: string): void {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096) {
    throw new TypeError("Cloudflare OAuth access token is invalid");
  }
}

function requireRefreshToken(value: string): void {
  if (typeof value !== "string" || value.length < 16 || value.length > 4_096) {
    throw new TypeError("Cloudflare OAuth refresh token is invalid");
  }
}

function validClientId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._-]{8,256}$/u.test(value);
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
    );
  } catch {
    return false;
  }
}

function base64(value: string): string {
  return btoa(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CloudflareCustomerDnsProviderError();
  }
  return value as Record<string, unknown>;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validTokenScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const scopes = value.split(" ").filter((scope) => scope.length > 0);
  const unique = new Set(scopes);
  return (
    unique.size === scopes.length &&
    AUTHORIZATION_SCOPES.every((scope) => unique.has(scope)) &&
    scopes.every(
      (scope) =>
        REQUIRED_SCOPES.includes(scope as (typeof REQUIRED_SCOPES)[number]) ||
        scope === "offline_access",
    )
  );
}

function invalidDnsInput(): TypeError {
  return new TypeError("Cloudflare customer DNS input is invalid");
}
