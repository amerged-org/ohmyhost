import { describe, expect, it, vi } from "vitest";

import {
  CloudflareCustomerDnsConflictError,
  CloudflareCustomerDnsProviderError,
  CloudflareCustomerDnsProvider,
  CloudflareCustomerDnsReceiptMismatchError,
  CloudflareCustomerDnsRejectedError,
  CloudflareCustomerDnsUncertainError,
  createCloudflareCustomerAuthorizationUrl,
  createCloudflarePlatformDomainProvider,
  type CloudflareCustomerDnsRecord,
  type CloudflareDesiredDnsRecord,
} from "./customer-dns-oauth.js";

const CLIENT_ID = "client_1234567890";
const REDIRECT_URI = "https://app.ohmyho.st/oauth/cloudflare/callback";
const STATE = "01ARZ3NDEKTSV4RRFFQ69G5FAV.0123456789abcdef0123456789abcdef";
const TOKEN = "customer-oauth-access-token";
const REFRESH_TOKEN = "customer-oauth-refresh-token";
const ZONE_ID = "b818216abd5a7b9517036f566b1f0879";
const ACCOUNT_ID = "a".repeat(32);

const records = [
  {
    type: "NS",
    name: "mail.example.com",
    content: "ns-1.example.net",
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  },
  {
    type: "NS",
    name: "mail.example.com",
    content: "ns-2.example.net",
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  },
  {
    type: "NS",
    name: "mail.example.com",
    content: "ns-3.example.net",
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  },
  {
    type: "NS",
    name: "mail.example.com",
    content: "ns-4.example.net",
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  },
] as const satisfies readonly CloudflareDesiredDnsRecord[];

function envelope(
  result: unknown,
  options: Readonly<{
    page?: number;
    totalPages?: number;
    totalCount?: number;
    status?: number;
  }> = {},
) {
  const page = options.page ?? 1;
  const totalPages = options.totalPages ?? 1;
  const totalCount = options.totalCount ?? (Array.isArray(result) ? result.length : 1);
  return new Response(
    JSON.stringify({
      success: (options.status ?? 200) < 400,
      errors: [],
      messages: [],
      result,
      ...(Array.isArray(result)
        ? {
            result_info: {
              count: result.length,
              page,
              per_page: 50,
              total_count: totalCount,
              total_pages: totalPages,
            },
          }
        : {}),
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function tokenResponse(
  accessToken = TOKEN,
  refreshToken = REFRESH_TOKEN,
  scope = "dns.write zone.read offline_access",
  tokenType = "Bearer",
) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: tokenType,
      expires_in: 3600,
      scope,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function observedRecords(): readonly CloudflareCustomerDnsRecord[] {
  return records.map((record, index) => ({
    id: `${index + 1}`.repeat(32),
    ...record,
    proxied: false,
  }));
}

describe("Cloudflare customer DNS OAuth", () => {
  it("creates one exact shared DNS wildcard and replays without another mutation", async () => {
    const input = {
      zoneId: ZONE_ID,
      zoneName: "omh.st",
      hostname: "*.dev.check.omh.st" as const,
      target: "dev.check.omh.st" as const,
    };
    const record = {
      id: "c".repeat(32),
      type: "CNAME",
      name: input.hostname,
      content: input.target,
      proxied: true,
      ttl: 1,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(record))
      .mockResolvedValueOnce(envelope([record]))
      .mockResolvedValueOnce(envelope([record]));
    const provider = createCloudflarePlatformDomainProvider({
      zoneId: ZONE_ID,
      zoneName: input.zoneName,
      apiToken: "platform-domain-token-value",
      fetch,
    });
    await expect(provider.ensureGatewayWildcard(input)).resolves.toEqual({
      recordId: record.id,
      outcome: "created",
    });
    await expect(provider.ensureGatewayWildcard(input)).resolves.toEqual({
      recordId: record.id,
      outcome: "existing",
    });
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
    await expect(
      createCloudflarePlatformDomainProvider({
        zoneId: ZONE_ID,
        zoneName: input.zoneName,
        apiToken: "platform-domain-token-value",
        fetch: async () => envelope([{ ...record, content: "attacker.example" }]),
      }).ensureGatewayWildcard(input),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsProviderError);
  });
  it("creates the exact minimum-scope confidential authorization URL", () => {
    const url = new URL(
      createCloudflareCustomerAuthorizationUrl({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        state: STATE,
      }),
    );

    expect(`${url.origin}${url.pathname}`).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "dns.write zone.read offline_access",
      state: STATE,
    });
    expect(() =>
      createCloudflareCustomerAuthorizationUrl({
        clientId: CLIENT_ID,
        redirectUri: "http://localhost/callback",
        state: STATE,
      }),
    ).toThrow("Cloudflare OAuth authorization input is invalid");
  });

  it("exchanges, refreshes, and revokes refresh authority with client_secret_basic", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        tokenResponse(TOKEN, REFRESH_TOKEN, "dns.write zone.read offline_access", "bearer"),
      )
      .mockResolvedValueOnce(
        tokenResponse(
          "rotated-access-token",
          "rotated-refresh-token",
          "offline_access zone.read dns.write",
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const provider = providerWith(fetch);

    await expect(provider.exchangeAuthorizationCode("authorization-code-1")).resolves.toEqual({
      accessToken: TOKEN,
      refreshToken: REFRESH_TOKEN,
      tokenType: "Bearer",
      expiresInSeconds: 3600,
      scopes: ["dns.write", "zone.read"],
    });
    await expect(provider.refreshAccessToken(REFRESH_TOKEN)).resolves.toMatchObject({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
    });
    await expect(provider.revokeRefreshToken("rotated-refresh-token")).resolves.toBeUndefined();

    const exchange = fetch.mock.calls[0];
    const refresh = fetch.mock.calls[1];
    expect(new Headers(exchange?.[1]?.headers).get("authorization")).toMatch(/^Basic /u);
    expect(String(exchange?.[1]?.body)).toBe(
      `code=authorization-code-1&grant_type=authorization_code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
    );
    expect(String(refresh?.[1]?.body)).toBe(
      `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}`,
    );
    expect(String(fetch.mock.calls[2]?.[1]?.body)).toBe(
      "token=rotated-refresh-token&token_type_hint=refresh_token",
    );
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("server-only-client-secret");
  });

  it("keeps OAuth redirects manual when the Workers runtime rejects redirect error mode", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.redirect === "error") throw new TypeError("Workers fetch rejected redirect mode");
      expect(init?.redirect).toBe("manual");
      return tokenResponse(TOKEN, REFRESH_TOKEN, "dns.write zone.read offline_access", "bearer");
    });

    await expect(
      providerWith(fetch).exchangeAuthorizationCode("authorization-code-1"),
    ).resolves.toEqual({
      accessToken: TOKEN,
      refreshToken: REFRESH_TOKEN,
      tokenType: "Bearer",
      expiresInSeconds: 3600,
      scopes: ["dns.write", "zone.read"],
    });

    const redirecting = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/token" },
      });
    });
    await expect(
      providerWith(redirecting).exchangeAuthorizationCode("authorization-code-1"),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);
  });

  it("reads back refresh-token revocation without treating another OAuth error as absence", async () => {
    const revoked = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: "invalid_grant", error_description: "The refresh token is invalid." },
          { status: 400 },
        ),
      );
    await expect(providerWith(revoked).observeRefreshToken(REFRESH_TOKEN)).resolves.toEqual({
      state: "revoked",
    });

    const active = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(tokenResponse("readback-access-token", "readback-refresh-token"));
    await expect(providerWith(active).observeRefreshToken(REFRESH_TOKEN)).resolves.toMatchObject({
      state: "active",
      tokens: {
        accessToken: "readback-access-token",
        refreshToken: "readback-refresh-token",
      },
    });

    const rejected = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid_client" }, { status: 400 }));
    await expect(providerWith(rejected).observeRefreshToken(REFRESH_TOKEN)).rejects.toBeInstanceOf(
      CloudflareCustomerDnsRejectedError,
    );
  });

  it("observes an exact active zone across every declared page", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([], { page: 1, totalPages: 2, totalCount: 1 }))
      .mockResolvedValueOnce(
        envelope(
          [{ id: ZONE_ID, name: "example.com", status: "active", account: { id: ACCOUNT_ID } }],
          { page: 2, totalPages: 2, totalCount: 1 },
        ),
      );

    await expect(providerWith(fetch).observeZone(TOKEN, "example.com")).resolves.toEqual({
      state: "found",
      zoneId: ZONE_ID,
      zoneName: "example.com",
      accountId: ACCOUNT_ID,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("name=example.com");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("page=2");

    const desired = [
      {
        type: "CNAME" as const,
        name: "app.example.com",
        content: "example.com",
        ttl: 1,
        proxied: true,
        comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:domains:v1",
      },
    ];
    const observed = [{ id: "c".repeat(32), ...desired[0] }];
    const platformFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope({ posts: observed }))
      .mockResolvedValueOnce(envelope(observed));
    const platform = createCloudflarePlatformDomainProvider({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      apiToken: "platform-domain-token-value",
      fetch: platformFetch,
    });
    const wildcardProvider = createCloudflarePlatformDomainProvider({
      zoneId: ZONE_ID,
      zoneName: "omh.st",
      apiToken: "platform-domain-token-value",
      fetch: async () =>
        envelope([
          {
            id: "c".repeat(32),
            type: "CNAME",
            name: "*.dev.check.omh.st",
            content: "dev.check.omh.st",
            proxied: true,
            ttl: 1,
          },
        ]),
    });
    await expect(
      wildcardProvider.observeGatewayWildcard({
        zoneId: ZONE_ID,
        zoneName: "omh.st",
        hostname: "*.dev.check.omh.st",
        target: "dev.check.omh.st",
      }),
    ).resolves.toEqual({ recordId: "c".repeat(32) });
    await expect(
      platform.reconcileRecords({ zoneId: ZONE_ID, zoneName: "example.com", records: desired }),
    ).resolves.toEqual({ status: "applied", records: observed });
    expect(new Headers(platformFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer platform-domain-token-value",
    );
    expect(() =>
      platform.reconcileRecords({
        zoneId: ZONE_ID,
        zoneName: "attacker.example",
        records: desired,
      }),
    ).toThrow("platform domain request is invalid");
    expect(platformFetch).toHaveBeenCalledTimes(3);

    const freeRecord = {
      type: "CNAME",
      name: "app.example.com",
      content: "dev.check.omh.st",
      ttl: 1,
      proxied: true,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:domains:v1",
    } as const satisfies CloudflareDesiredDnsRecord;
    const freeDesired = [freeRecord];
    const legacyFreeRecord = {
      ...freeRecord,
      id: "d".repeat(32),
      content: "customers.poc.aixyte.com",
    };
    const legacyFree = [legacyFreeRecord];
    const migrationFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(legacyFree));
    const migratingPlatform = createCloudflarePlatformDomainProvider({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      apiToken: "platform-domain-token-value",
      fetch: migrationFetch,
    });
    await expect(
      migratingPlatform.reconcileRecords({
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: freeDesired,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
    expect(migrationFetch).toHaveBeenCalledOnce();
  });

  it("applies four exact multi-value NS records in one batch and paginates readback", async () => {
    const observed = observedRecords();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope({ deletes: [], patches: [], puts: [], posts: observed }))
      .mockResolvedValueOnce(
        envelope(observed.slice(0, 2), { page: 1, totalPages: 2, totalCount: 4 }),
      )
      .mockResolvedValueOnce(
        envelope(observed.slice(2), { page: 2, totalPages: 2, totalCount: 4 }),
      );

    await expect(
      providerWith(fetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).resolves.toEqual({ status: "applied", records: observed });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      posts: records,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("name.exact=mail.example.com");
    expect(String(fetch.mock.calls[3]?.[0])).toContain("page=2");
  });

  it("replaces only explicitly authorized Paid web records while preserving apex mail and completing verification", async () => {
    const traffic = {
      type: "CNAME" as const,
      name: "example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:paid-traffic:v1",
    };
    const ownership = {
      type: "TXT" as const,
      name: "_cf-custom-hostname.example.com",
      content: "ownership-value",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:paid-ownership:v1",
    };
    const mail = [
      {
        id: "1".repeat(32),
        type: "MX",
        name: "example.com",
        content: "mail.example.net",
        priority: 10,
        ttl: 3600,
        proxied: false,
        comment: "customer mail",
      },
      {
        id: "2".repeat(32),
        type: "TXT",
        name: "example.com",
        content: "v=spf1 include:mail.example.net ~all",
        ttl: 3600,
        proxied: false,
        comment: null,
      },
      {
        id: "3".repeat(32),
        type: "CAA",
        name: "example.com",
        content: '0 issue "letsencrypt.org"',
        ttl: 3600,
        proxied: false,
        comment: null,
      },
    ];
    const scenarios = [
      [],
      [
        {
          id: "a".repeat(32),
          type: "A",
          name: "example.com",
          content: "192.0.2.1",
          ttl: 1,
          proxied: true,
          comment: null,
        },
        {
          id: "b".repeat(32),
          type: "AAAA",
          name: "example.com",
          content: "2001:db8::1",
          ttl: 300,
          proxied: false,
          comment: null,
        },
      ],
      [
        {
          ...traffic,
          id: "c".repeat(32),
          content: "old.example.net",
          ttl: 1,
          proxied: true,
          comment: "previous website",
        },
      ],
      [{ ...traffic, id: "c".repeat(32), comment: null }],
      [{ ...traffic, id: "c".repeat(32), comment: undefined }],
      [{ ...traffic, id: "c".repeat(32) }],
    ];
    for (const web of scenarios)
      for (const responseMode of ["ok", "lost", "malformed"]) {
        let state: Record<string, unknown>[] = [...mail, ...web];
        let sequence = 100;
        const batches: Record<string, Record<string, unknown>[]>[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
          if (init?.method === "POST") {
            const batch = JSON.parse(String(init.body)) as Record<
              string,
              Record<string, unknown>[]
            >;
            batches.push(batch);
            state = state.filter(
              (record) => !batch["deletes"]?.some((item) => item["id"] === record["id"]),
            );
            state = state.map((record) => ({
              ...record,
              ...batch["patches"]?.find((item) => item["id"] === record["id"]),
            }));
            state.push(
              ...(batch["posts"] ?? []).map((record) => ({
                ...record,
                id: (++sequence).toString(16).padStart(32, "0"),
              })),
            );
            if (responseMode === "lost") throw new Error("Lost batch response");
            return responseMode === "malformed" ? new Response("not-json") : envelope({});
          }
          const name = new URL(String(url)).searchParams.get("name.exact");
          return envelope(state.filter((record) => record["name"] === name));
        });
        const provider = providerWith(fetch);
        const input = { zoneId: ZONE_ID, zoneName: "example.com", records: [traffic, ownership] };
        const options = { replaceTrafficHostname: "example.com" };
        await expect(provider.reconcileRecords(TOKEN, input, options)).resolves.toMatchObject({
          status: "applied",
        });
        expect(state.filter((record) => mail.some((item) => item.id === record["id"]))).toEqual(
          mail,
        );
        expect(state.filter((record) => ["A", "AAAA"].includes(String(record["type"])))).toEqual(
          [],
        );
        expect(state.filter((record) => record["type"] === "CNAME")).toEqual([
          expect.objectContaining(traffic),
        ]);
        expect(batches).toHaveLength(1);
        const batch = batches[0];
        expect(batch?.["deletes"] ?? []).toEqual(
          web
            .filter((record) => record.type === "A" || record.type === "AAAA")
            .map((record) => ({ id: record.id })),
        );
        expect((batch?.["posts"] ?? []).some((record) => record["name"] === ownership.name)).toBe(
          true,
        );
        for (const list of Object.values(batch ?? {}))
          for (const record of list)
            expect(mail.some((item) => item.id === record["id"])).toBe(false);
        await expect(provider.reconcileRecords(TOKEN, input, options)).resolves.toMatchObject({
          status: "replayed",
        });
        expect(batches).toHaveLength(1);
        // Domain deletion observes the already-owned records without replacement authority.
        const cleanup = await provider.reconcileRecords(TOKEN, input, { observeOnly: true });
        expect(batches).toHaveLength(1);
        await expect(
          provider.deleteRecords(TOKEN, { ...input, records: cleanup.records }),
        ).resolves.toMatchObject({ status: "deleted" });
        expect(state).toEqual(mail);
      }
  });

  it("observes owned records for deletion without adopting recreated CNAMEs or creating missing records", async () => {
    const traffic = {
      type: "CNAME" as const,
      name: "example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:paid-traffic:v1",
    };
    const ownership = {
      type: "TXT" as const,
      name: "_cf-custom-hostname.example.com",
      content: "ownership-value",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:paid-ownership:v1",
    };
    const input = { zoneId: ZONE_ID, zoneName: "example.com", records: [traffic, ownership] };
    for (const comment of [null, undefined]) {
      const recreated = { ...traffic, id: "d".repeat(32), comment };
      const mail = {
        id: "e".repeat(32),
        type: "MX",
        name: "example.com",
        content: "mail.example.net",
        priority: 10,
        ttl: 300,
        proxied: false,
        comment,
      };
      const owned = { ...ownership, id: "f".repeat(32) };
      let state: Record<string, unknown>[] = [recreated, mail, owned];
      const batches: unknown[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (init?.method === "POST") {
          const batch = JSON.parse(String(init.body));
          batches.push(batch);
          expect(batch).toEqual({ deletes: [{ id: owned.id }] });
          state = state.filter((record) => record["id"] !== owned.id);
          throw new Error("Deletion response lost");
        }
        const name = new URL(String(url)).searchParams.get("name.exact");
        return envelope(state.filter((record) => record["name"] === name));
      });
      const provider = providerWith(fetch);
      const observation = await provider.reconcileRecords(TOKEN, input, {
        observeOnly: true,
        adoptExactTrafficCname: true,
        preserveUnrelatedMailRecords: true,
      });
      expect(observation.records).toEqual([owned]);
      expect(batches).toEqual([]);
      await expect(
        provider.deleteRecords(TOKEN, { ...input, records: observation.records }),
      ).resolves.toMatchObject({ status: "deleted" });
      expect(state).toEqual([recreated, mail]);
      await expect(provider.reconcileRecords(TOKEN, input, { observeOnly: true })).resolves.toEqual(
        { status: "replayed", records: [] },
      );
      expect(batches).toHaveLength(1);
    }
    for (const comment of [42, false, {}]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(envelope([{ ...traffic, id: "a".repeat(32), comment }]));
      await expect(
        providerWith(fetch).reconcileRecords(TOKEN, input, { observeOnly: true }),
      ).rejects.toBeInstanceOf(CloudflareCustomerDnsProviderError);
      expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    }
    for (const rows of [
      [{ ...traffic, id: "a".repeat(32), content: "changed.example.net" }],
      [
        { ...traffic, id: "a".repeat(32) },
        { ...traffic, id: "b".repeat(32) },
      ],
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
        envelope(
          rows.filter(
            (record) => record.name === new URL(String(url)).searchParams.get("name.exact"),
          ),
        ),
      );
      await expect(
        providerWith(fetch).reconcileRecords(TOKEN, input, { observeOnly: true }),
      ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
      expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    }
    // Multiple ACME TXT values at one name retain the same ownership marker.
    const validation = [ownership, { ...ownership, content: "second-ownership-value" }];
    const observed = validation.map((record, index) => ({
      ...record,
      id: String(index + 1).repeat(32),
    }));
    const multiple = vi.fn<typeof globalThis.fetch>().mockResolvedValue(envelope(observed));
    await expect(
      providerWith(multiple).reconcileRecords(
        TOKEN,
        { ...input, records: validation },
        { observeOnly: true },
      ),
    ).resolves.toEqual({ status: "replayed", records: observed });
    expect(multiple).toHaveBeenCalledOnce();
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      providerWith(fetch).reconcileRecords(TOKEN, input, {
        observeOnly: true,
        replaceTrafficHostname: traffic.name,
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Paid traffic replacement scoped and rejects ambiguous or changed readback", async () => {
    const traffic = {
      type: "CNAME" as const,
      name: "example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:paid-traffic:v1",
    };
    const input = { zoneId: ZONE_ID, zoneName: "example.com", records: [traffic] };
    const mail = {
      id: "a".repeat(32),
      type: "MX",
      name: "example.com",
      content: "mail.example.net",
      priority: 10,
      ttl: 300,
      proxied: false,
      comment: null,
    };
    const old = { ...traffic, id: "b".repeat(32), content: "old.example.net", comment: null };
    for (const scenario of [
      { rows: [mail, old], options: {} },
      { rows: [mail, old], options: { replaceTrafficHostname: "other.example.com" } },
      { rows: [mail, { ...old, type: "NS" }], options: { replaceTrafficHostname: "example.com" } },
      {
        rows: [mail, { ...old, comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAW:paid-traffic:v1" }],
        options: { replaceTrafficHostname: "example.com" },
      },
      {
        rows: [old, { ...old, id: "c".repeat(32) }],
        options: { replaceTrafficHostname: "example.com" },
      },
      {
        rows: [old, { ...old, id: "c".repeat(32), type: "A", content: "192.0.2.1" }],
        options: { replaceTrafficHostname: "example.com" },
      },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(envelope(scenario.rows));
      await expect(
        providerWith(fetch).reconcileRecords(TOKEN, input, scenario.options),
      ).rejects.toThrow();
      expect(fetch.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
    }
    for (const invalid of [
      { ...traffic, comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1" },
      { ...traffic, proxied: true, ttl: 1 },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        providerWith(fetch).reconcileRecords(
          TOKEN,
          { ...input, records: [invalid] },
          { replaceTrafficHostname: "example.com" },
        ),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    }
    for (const after of [
      [
        { ...old, ...traffic },
        { ...mail, content: "changed.example.net" },
      ],
      [{ ...old, ...traffic, id: "c".repeat(32) }, mail],
      [{ ...old, ...traffic }],
      [
        { ...old, ...traffic },
        mail,
        { ...old, id: "d".repeat(32), type: "A", content: "192.0.2.1" },
      ],
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(envelope([mail, old]))
        .mockRejectedValueOnce(new Error("Lost response"))
        .mockResolvedValueOnce(envelope(after));
      await expect(
        providerWith(fetch).reconcileRecords(TOKEN, input, {
          replaceTrafficHostname: "example.com",
        }),
      ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });

  it("creates and replays an exact proxied traffic CNAME with Auto TTL", async () => {
    const desired = [
      {
        type: "CNAME" as const,
        name: "app.example.com",
        content: "customers.poc.aixyte.com",
        ttl: 1,
        proxied: true,
        comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:traffic:v1",
      },
    ];
    const observed = [{ id: "a".repeat(32), ...desired[0] }];
    const create = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope({ deletes: [], patches: [], puts: [], posts: observed }))
      .mockResolvedValueOnce(envelope(observed));

    await expect(
      providerWith(create).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: desired,
      }),
    ).resolves.toEqual({ status: "applied", records: observed });
    expect(JSON.parse(String(create.mock.calls[1]?.[1]?.body))).toEqual({ posts: desired });

    const replay = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(observed));
    await expect(
      providerWith(replay).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: desired,
      }),
    ).resolves.toEqual({ status: "replayed", records: observed });
    expect(replay).toHaveBeenCalledOnce();
  });

  it("adopts only an exact customer-set CNAME and recovers ambiguous responses", async () => {
    const desired = {
      type: "CNAME" as const,
      name: "app.example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:traffic:v1",
    };
    const manual = { ...desired, id: "a".repeat(32), comment: null };
    const patched = { ...desired, id: manual.id };
    for (const mutationResponse of [
      () => Promise.resolve(new Response("malformed", { status: 200 })),
      () => Promise.reject(new Error("lost PATCH response")),
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(envelope([manual]))
        .mockImplementationOnce(mutationResponse)
        .mockResolvedValueOnce(envelope([patched]));

      await expect(
        providerWith(fetch).reconcileRecords(
          TOKEN,
          { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
          { adoptExactTrafficCname: true },
        ),
      ).resolves.toEqual({ status: "applied", records: [patched] });
      expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
        patches: [{ id: manual.id, ...desired }],
      });
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }

    const foreignDrift = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([{ ...manual, ttl: 120 }]));
    await expect(
      providerWith(foreignDrift).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [desired],
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
    expect(foreignDrift).toHaveBeenCalledOnce();

    const free = { ...desired, ttl: 1, proxied: true };
    const legacy = { ...desired, id: manual.id };
    const retired = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([legacy]));
    await expect(
      providerWith(retired).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [free],
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
    expect(retired).toHaveBeenCalledOnce();
  });

  it("does not accept a replacement provider ID after adopting the bound customer record", async () => {
    const desired = {
      type: "CNAME" as const,
      name: "app.example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:traffic:v1",
    };
    const manual = { ...desired, id: "a".repeat(32), comment: null };
    const replacement = { ...desired, id: "b".repeat(32) };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([manual]))
      .mockResolvedValueOnce(envelope({ patches: [{ id: manual.id, ...desired }] }))
      .mockResolvedValueOnce(envelope([replacement]));

    await expect(
      providerWith(fetch).reconcileRecords(
        TOKEN,
        { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
        { adoptExactTrafficCname: true },
      ),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not accept the patched provider ID when it moves to another desired record", async () => {
    const traffic = {
      type: "CNAME" as const,
      name: "app.example.com",
      content: "customers.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:traffic:v1",
    };
    const mail = {
      type: "NS" as const,
      name: "mail.example.com",
      content: "ns-1.example.net",
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
    };
    const manual = { ...traffic, id: "a".repeat(32), comment: null };
    const currentMail = { ...mail, id: "c".repeat(32) };
    const replacementTraffic = { ...traffic, id: "b".repeat(32) };
    const reassignedMail = { ...mail, id: manual.id };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([manual]))
      .mockResolvedValueOnce(envelope([currentMail]))
      .mockResolvedValueOnce(envelope({ patches: [{ id: manual.id, ...traffic }] }))
      .mockResolvedValueOnce(envelope([replacementTraffic]))
      .mockResolvedValueOnce(envelope([reassignedMail]));

    await expect(
      providerWith(fetch).reconcileRecords(
        TOKEN,
        { zoneId: ZONE_ID, zoneName: "example.com", records: [traffic, mail] },
        { adoptExactTrafficCname: true },
      ),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects simultaneous legacy and exact traffic identities before mutation", async () => {
    const desired = {
      type: "CNAME" as const,
      name: "app.example.com",
      content: "customers.poc.aixyte.com",
      ttl: 1,
      proxied: true,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:traffic:v1",
    };
    const legacy = { ...desired, id: "a".repeat(32), ttl: 300, proxied: false };
    const exact = { ...desired, id: "b".repeat(32) };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([legacy, exact]));

    await expect(
      providerWith(fetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [desired],
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("replays exact NS records but rejects a foreign fifth value before mutation", async () => {
    const observed = observedRecords();
    const replayFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(observed));
    await expect(
      providerWith(replayFetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).resolves.toEqual({ status: "replayed", records: observed });
    expect(replayFetch).toHaveBeenCalledOnce();

    const conflictFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      envelope([
        ...observed,
        {
          id: "f".repeat(32),
          ...records[0],
          content: "attacker.example.net",
          comment: null,
          proxied: false,
        },
      ]),
    );
    await expect(
      providerWith(conflictFetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
    expect(conflictFetch).toHaveBeenCalledOnce();
  });

  it("resolves a lost create response through exact readback and never retries the mutation", async () => {
    const observed = observedRecords();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockRejectedValueOnce(new Error("lost response containing a secret"))
      .mockResolvedValueOnce(envelope(observed));

    await expect(
      providerWith(fetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).resolves.toEqual({ status: "applied", records: observed });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    const conflictFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 409 }))
      .mockResolvedValueOnce(envelope(observed));
    await expect(
      providerWith(conflictFetch).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const unresolvedConflict = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 409 }))
      .mockResolvedValueOnce(envelope([]));
    await expect(
      providerWith(unresolvedConflict).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsRejectedError);
    expect(
      unresolvedConflict.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("returns typed redacted uncertainty when create readback cannot prove the exact set", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(new Response("malformed", { status: 200 }))
      .mockResolvedValueOnce(envelope([]));

    const error = await providerWith(fetch)
      .reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CloudflareCustomerDnsUncertainError);
    expect(error).toMatchObject({ code: "cloudflare_customer_dns_result_uncertain" });
    expect(JSON.stringify(error)).not.toContain("malformed");
  });

  it("deletes only receipt-bound record IDs in one batch and proves their absence", async () => {
    const observed = observedRecords();
    const foreign = {
      id: "f".repeat(32),
      ...records[0],
      content: "customer-ns.example.net",
      comment: null,
      proxied: false,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([...observed, foreign]))
      .mockResolvedValueOnce(
        envelope({
          deletes: observed.map((record) => ({ id: record.id })),
          patches: [],
          puts: [],
          posts: [],
        }),
      )
      .mockResolvedValueOnce(envelope([foreign]));

    await expect(
      createCloudflarePlatformDomainProvider({
        zoneId: ZONE_ID,
        zoneName: "example.com",
        apiToken: TOKEN,
        fetch,
      }).deleteRecords({
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [...observed].reverse(),
      }),
    ).resolves.toEqual({
      status: "deleted",
      recordIds: observed.map((record) => record.id),
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      deletes: observed.map((record) => ({ id: record.id })),
    });
    class ReadOnlyDnsHttp {
      calls = 0;
      constructor(readonly current: readonly CloudflareCustomerDnsRecord[]) {}
      fetch: typeof globalThis.fetch = async (request, init) => {
        expect(init?.method).toBe("GET");
        expect(new URL(String(request)).pathname).toBe(`/client/v4/zones/${ZONE_ID}/dns_records`);
        this.calls++;
        return envelope(this.current);
      };
    }
    for (const current of [
      observed.map((record, i) => ({ ...record, id: (i + 10).toString(16).repeat(32) })),
      observed.map((record, i) =>
        i === 0 ? record : { ...record, id: (i + 10).toString(16).repeat(32) },
      ),
    ]) {
      const transport = new ReadOnlyDnsHttp(current);
      await expect(
        providerWith(transport.fetch).deleteRecords(TOKEN, {
          zoneId: ZONE_ID,
          zoneName: "example.com",
          records: observed,
        }),
      ).rejects.toBeInstanceOf(CloudflareCustomerDnsReceiptMismatchError);
      expect(transport.calls).toBeGreaterThan(0);
    }
    const alreadyDeleted = new ReadOnlyDnsHttp([]);
    await expect(
      providerWith(alreadyDeleted.fetch).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).resolves.toEqual({ status: "replayed", recordIds: observed.map((record) => record.id) });
    expect(alreadyDeleted.calls).toBe(1);
    class AbortedDnsHttp {
      aborted = false;
      fetch: typeof globalThis.fetch = async (_request, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Request signal is required");
          signal.addEventListener(
            "abort",
            () => {
              this.aborted = true;
              reject(new Error("private-transport-canary"));
            },
            { once: true },
          );
        });
    }
    const hanging = new AbortedDnsHttp();
    const timed = new CloudflareCustomerDnsProvider({
      clientId: CLIENT_ID,
      clientSecret: "server-only-client-secret",
      redirectUri: REDIRECT_URI,
      fetch: hanging.fetch,
      timeoutMilliseconds: 100,
    });
    await expect(timed.observeZone(TOKEN, "example.com")).rejects.toBeInstanceOf(
      CloudflareCustomerDnsProviderError,
    );
    expect(hanging.aborted).toBe(true);
  });

  it("proves delete after a lost response and reports uncertainty while a receipt ID remains", async () => {
    const observed = observedRecords();
    const resolvedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(observed))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(envelope([]));
    await expect(
      providerWith(resolvedFetch).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).resolves.toMatchObject({ status: "deleted" });

    const uncertainFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(observed))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(envelope([observed[0]]));
    await expect(
      providerWith(uncertainFetch).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);

    const recreated = observed.map((record, index) => ({
      ...record,
      id: `${index + 5}`.repeat(32),
    }));
    const recreatedFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(observed))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(envelope(recreated));
    await expect(
      providerWith(recreatedFetch).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsUncertainError);
  });

  it("rejects definitive provider denial and receipt drift without mutating a second time", async () => {
    const denied = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 403 }));
    await expect(
      providerWith(denied).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsRejectedError);

    const observed = observedRecords();
    const partial = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope(observed.slice(1)))
      .mockResolvedValueOnce(
        envelope({
          deletes: observed.slice(1).map((record) => ({ id: record.id })),
          patches: [],
          puts: [],
          posts: [],
        }),
      )
      .mockResolvedValueOnce(envelope([]));
    await expect(
      providerWith(partial).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).resolves.toMatchObject({ status: "deleted" });
    expect(partial).toHaveBeenCalledTimes(3);

    const driftedState = [
      { ...observed[0], content: "attacker.example.net" },
      ...observed.slice(1),
    ];
    const drifted = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope(driftedState));
    await expect(
      providerWith(drifted).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: observed,
      }),
    ).rejects.toBeInstanceOf(CloudflareCustomerDnsReceiptMismatchError);
    expect(drifted).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid input, malformed pagination, and uncertain token revocation", async () => {
    const platformWarning = {
      ...records[0],
      id: "a".repeat(32),
      comment: "ohmyhost:platform:mail-warning:v1",
    };
    await expect(
      providerWith(vi.fn().mockResolvedValue(envelope([]))).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [platformWarning],
      }),
    ).resolves.toMatchObject({ status: "replayed", recordIds: [platformWarning.id] });
    await expect(
      providerWith(vi.fn()).deleteRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [{ ...platformWarning, comment: "ohmyhost:platform:arbitrary:v1" }],
      }),
    ).rejects.toThrow("Cloudflare customer DNS input is invalid");
    await expect(
      providerWith(vi.fn()).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [{ ...records[0], name: "mail.attacker.test" }],
      }),
    ).rejects.toThrow("Cloudflare customer DNS input is invalid");
    await expect(
      providerWith(vi.fn()).reconcileRecords(TOKEN, {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        records: [
          {
            type: "CNAME",
            name: "mixed.example.com",
            content: "target.example.net",
            ttl: 60,
            proxied: false,
            comment: records[0].comment,
          },
          {
            type: "TXT",
            name: "mixed.example.com",
            content: "conflict",
            ttl: 60,
            proxied: false,
            comment: records[0].comment,
          },
        ],
      }),
    ).rejects.toThrow("Cloudflare customer DNS input is invalid");

    const malformedPage = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [],
          result_info: null,
        }),
        { status: 200 },
      ),
    );
    await expect(providerWith(malformedPage).observeZone(TOKEN, "example.com")).rejects.toThrow(
      "Cloudflare customer DNS provider request failed",
    );

    const revoke = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("secret"));
    await expect(providerWith(revoke).revokeRefreshToken(REFRESH_TOKEN)).rejects.toBeInstanceOf(
      CloudflareCustomerDnsUncertainError,
    );
    await expect(providerWith(vi.fn()).observeZone("short", "example.com")).rejects.toThrow(
      "Cloudflare OAuth access token is invalid",
    );
  });
});

function providerWith(fetch: typeof globalThis.fetch) {
  return new CloudflareCustomerDnsProvider({
    clientId: CLIENT_ID,
    clientSecret: "server-only-client-secret",
    redirectUri: REDIRECT_URI,
    fetch,
    timeoutMilliseconds: 1_000,
  });
}

it("preserves MX priority through create, readback, replay and deletion", async () => {
  const desired = [
    {
      type: "MX" as const,
      name: "mail.example.com",
      content: "inbound.resend.com",
      priority: 10,
      ttl: 300,
      proxied: false,
      comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
    },
  ];
  const observed = [{ id: "a".repeat(32), ...(desired[0] as CloudflareDesiredDnsRecord) }];
  const create = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope([]))
    .mockResolvedValueOnce(envelope({ posts: observed }))
    .mockResolvedValueOnce(envelope(observed));
  expect(
    await providerWith(create).reconcileRecords(TOKEN, {
      zoneId: ZONE_ID,
      zoneName: "example.com",
      records: desired,
    }),
  ).toEqual({ status: "applied", records: observed });
  expect(JSON.parse(String(create.mock.calls[1]?.[1]?.body))).toEqual({ posts: desired });
  const drift = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope([{ ...observed[0], priority: 20 }]));
  await expect(
    providerWith(drift).reconcileRecords(TOKEN, {
      zoneId: ZONE_ID,
      zoneName: "example.com",
      records: desired,
    }),
  ).rejects.toThrow();
  const removal = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope(observed))
    .mockResolvedValueOnce(envelope({ deletes: observed }))
    .mockResolvedValueOnce(envelope([]));
  expect(
    await providerWith(removal).deleteRecords(TOKEN, {
      zoneId: ZONE_ID,
      zoneName: "example.com",
      records: observed,
    }),
  ).toMatchObject({ status: "deleted" });
});

it("adds mail MX alongside existing web A and TXT records but refuses competing mailbox MX", async () => {
  const desired: CloudflareDesiredDnsRecord = {
    type: "MX",
    name: "example.com",
    content: "inbound.resend.com",
    priority: 10,
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  };
  const existing = [
    {
      id: "b".repeat(32),
      type: "A",
      name: "example.com",
      content: "1.1.1.1",
      ttl: 300,
      proxied: true,
      comment: null,
    },
    {
      id: "c".repeat(32),
      type: "TXT",
      name: "example.com",
      content: "v=spf1 include:existing.example ~all",
      ttl: 300,
      proxied: false,
      comment: null,
    },
  ];
  const receipt = { id: "a".repeat(32), ...desired };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope(existing))
    .mockResolvedValueOnce(envelope({ posts: [receipt] }))
    .mockResolvedValueOnce(envelope([...existing, receipt]));
  expect(
    await providerWith(fetch).reconcileRecords(
      TOKEN,
      { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
      { preserveUnrelatedMailRecords: true },
    ),
  ).toEqual({ status: "applied", records: [receipt] });
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ posts: [desired] });
  const competing = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      envelope([{ ...receipt, id: "d".repeat(32), content: "mx.existing.example", comment: null }]),
    );
  await expect(
    providerWith(competing).reconcileRecords(
      TOKEN,
      { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
      { preserveUnrelatedMailRecords: true },
    ),
  ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
  expect(competing).toHaveBeenCalledTimes(1);
});

it("preserves an unrelated TXT while refusing to add a second SPF policy at the same name", async () => {
  const desired: CloudflareDesiredDnsRecord = {
    type: "TXT",
    name: "example.com",
    content: "v=spf1 include:resend.com ~all",
    ttl: 300,
    proxied: false,
    comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:mail:v1",
  };
  const unrelated = {
    id: "b".repeat(32),
    type: "TXT",
    name: "example.com",
    content: "google-site-verification=fixture",
    ttl: 300,
    proxied: false,
    comment: null,
  };
  const receipt = { id: "a".repeat(32), ...desired };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(envelope([unrelated]))
    .mockResolvedValueOnce(envelope({ posts: [receipt] }))
    .mockResolvedValueOnce(envelope([unrelated, receipt]));
  await expect(
    providerWith(fetch).reconcileRecords(
      TOKEN,
      { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
      { preserveUnrelatedMailRecords: true },
    ),
  ).resolves.toEqual({ status: "applied", records: [receipt] });
  const conflicting = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      envelope([{ ...unrelated, content: "v=spf1 include:foreign.example ~all" }]),
    );
  await expect(
    providerWith(conflicting).reconcileRecords(
      TOKEN,
      { zoneId: ZONE_ID, zoneName: "example.com", records: [desired] },
      { preserveUnrelatedMailRecords: true },
    ),
  ).rejects.toBeInstanceOf(CloudflareCustomerDnsConflictError);
  expect(conflicting).toHaveBeenCalledTimes(1);
});
