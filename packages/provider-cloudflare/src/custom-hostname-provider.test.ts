import { describe, expect, it, vi } from "vitest";

import {
  CloudflareCustomHostnameContractError,
  CloudflareCustomHostnameReceiptMismatchError,
  CloudflareCustomHostnameRejectedError,
  CloudflareCustomHostnameUncertainError,
  createCloudflareCustomHostnameProvider,
  type CloudflareCustomHostnameReceipt,
  type CloudflareCustomHostnameTarget,
} from "./custom-hostname-provider.js";
import {
  CloudflareCustomerDnsProvider,
  type CloudflareDesiredDnsRecord,
} from "./customer-dns-oauth.js";

const ZONE_ID = "b818216abd5a7b9517036f566b1f0879";
const HOSTNAME_PROVIDER_ID = "0542a4b1-673d-4486-ae13-6036ef941193";
const HOSTNAME_ID = "0542a4b1673d4486ae136036ef941193";
const SSL_ID = "0d89c70d-ad9f-4843-b99f-6cc0252067e9";
const target = {
  hostname: "app.poc.aixyte.com",
  customerCnameTarget: "customers.poc.aixyte.com",
} as const satisfies CloudflareCustomHostnameTarget;

const pendingHostname = {
  id: HOSTNAME_PROVIDER_ID,
  hostname: target.hostname,
  created_at: "2026-08-29T09:58:00.000Z",
  status: "pending",
  ownership_verification: {
    name: `_cf-custom-hostname.${target.hostname}`,
    type: "txt",
    value: "ownership-value",
  },
  ownership_verification_http: {
    http_url: `http://${target.hostname}/.well-known/cf-custom-hostname-challenge/value`,
    http_body: "ownership-http-value",
  },
  verification_errors: [],
  ssl: {
    id: SSL_ID,
    status: "pending_validation",
    type: "dv",
    method: "txt",
    bundle_method: "ubiquitous",
    certificate_authority: "google",
    validation_records: [
      {
        cname: `_acme-challenge.${target.hostname}`,
        cname_target: "dcv.cloudflare.com",
        txt_name: `_acme-challenge.${target.hostname}`,
        txt_value: "ssl-txt-value",
        http_body: "ssl-http-value",
        http_url: `http://${target.hostname}/.well-known/pki-validation/value.txt`,
        status: "pending",
        wildcard: false,
      },
    ],
    dcv_delegation_records: [
      {
        cname: `_acme-challenge.${target.hostname}`,
        cname_target: "dcv.cloudflare.com",
        status: "pending",
      },
    ],
  },
};

const activeHostname = {
  ...pendingHostname,
  status: "active",
  ssl: { ...pendingHostname.ssl, status: "active" },
};

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
  return Response.json(
    {
      success: (options.status ?? 200) < 400,
      errors: [],
      messages: [],
      result,
      ...(Array.isArray(result)
        ? {
            result_info: {
              count: result.length,
              page,
              per_page: 1000,
              total_count: options.totalCount ?? result.length,
              total_pages: options.totalPages ?? 1,
            },
          }
        : {}),
    },
    { status: options.status ?? 200 },
  );
}

function provider(fetch: typeof globalThis.fetch) {
  return createCloudflareCustomHostnameProvider({
    zoneId: ZONE_ID,
    apiToken: "token-" + "x".repeat(32),
    fetch,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });
}

describe("Cloudflare custom hostname provider", () => {
  it("observes the exact active hostname across all pages and returns only DNS facts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([], { page: 1, totalPages: 2, totalCount: 1 }))
      .mockResolvedValueOnce(envelope([activeHostname], { page: 2, totalPages: 2, totalCount: 1 }));

    const result = await provider(fetch).observeHostname(target);
    expect(result).toEqual({
      state: "found",
      customHostnameId: HOSTNAME_ID,
      ...target,
      status: "active",
      providerCreatedAt: "2026-08-29T09:58:00.000Z",
      ownershipVerification: {
        type: "txt",
        name: `_cf-custom-hostname.${target.hostname}`,
        value: "ownership-value",
      },
      ownershipVerificationHttp: {
        httpUrl: `http://${target.hostname}/.well-known/cf-custom-hostname-challenge/value`,
        httpBody: "ownership-http-value",
      },
      verificationErrors: [],
      ssl: {
        sslId: SSL_ID,
        status: "active",
        type: "dv",
        method: "txt",
        bundleMethod: "ubiquitous",
        certificateAuthority: "google",
        validationRecords: [
          {
            cname: `_acme-challenge.${target.hostname}`,
            cnameTarget: "dcv.cloudflare.com",
            httpBody: "ssl-http-value",
            httpUrl: `http://${target.hostname}/.well-known/pki-validation/value.txt`,
            status: "pending",
            txtName: `_acme-challenge.${target.hostname}`,
            txtValue: "ssl-txt-value",
            wildcard: false,
          },
        ],
        dcvDelegationRecords: [
          {
            cname: `_acme-challenge.${target.hostname}`,
            cnameTarget: "dcv.cloudflare.com",
            status: "pending",
          },
        ],
      },
      ready: true,
      dnsRecords: [
        {
          purpose: "traffic",
          type: "CNAME",
          name: target.hostname,
          content: target.customerCnameTarget,
        },
        {
          purpose: "ownership",
          type: "TXT",
          name: `_cf-custom-hostname.${target.hostname}`,
          content: "ownership-value",
        },
        {
          purpose: "ssl",
          type: "TXT",
          name: `_acme-challenge.${target.hostname}`,
          content: "ssl-txt-value",
        },
      ],
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain("hostname.exact=app.poc.aixyte.com");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("page=2");
    expect(JSON.stringify(result)).not.toContain("custom_key");
    const wallStart = Date.now();
    const observed = await createCloudflareCustomHostnameProvider({
      zoneId: ZONE_ID,
      apiToken: "token-" + "x".repeat(32),
      fetch: async () => envelope([activeHostname]),
    }).observeHostname(target);
    expect(observed.state).toBe("found");
    if (observed.state !== "found") throw new Error("Expected exact hostname observation");
    expect(observed.observedAt.getTime()).toBeGreaterThanOrEqual(wallStart);
    expect(observed.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(observed.ready).toBe(true);
  });

  it("emits one DNS-compatible TXT strategy that customer DNS accepts without CNAME coexistence", async () => {
    const customFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([pendingHostname]));
    const observed = await provider(customFetch).observeHostname(target);
    if (observed.state !== "found") throw new Error("expected custom hostname receipt");
    const desired = observed.dnsRecords.map(
      (record) =>
        ({
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: 60,
          proxied: false,
          comment: "ohmyhost:01ARZ3NDEKTSV4RRFFQ69G5FAV:domain:v1",
        }) satisfies CloudflareDesiredDnsRecord,
    );
    for (const cname of desired.filter((record) => record.type === "CNAME")) {
      expect(desired.filter((record) => record.name === cname.name)).toHaveLength(1);
    }

    const receipts = desired.map((record, index) => ({
      id: `${index + 1}`.repeat(32),
      ...record,
      proxied: false as const,
    }));
    const dnsFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const name = new URL(String(input)).searchParams.get("name.exact");
      const result = receipts.filter((record) => record.name === name);
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result,
        result_info: {
          count: result.length,
          page: 1,
          per_page: 50,
          total_count: result.length,
          total_pages: 1,
        },
      });
    });
    const dns = new CloudflareCustomerDnsProvider({
      clientId: "client_1234567890",
      clientSecret: "server-only-client-secret",
      redirectUri: "https://app.ohmyho.st/oauth/cloudflare/callback",
      fetch: dnsFetch,
      timeoutMilliseconds: 1_000,
    });
    await expect(
      dns.reconcileRecords("customer-oauth-access-token", {
        zoneId: ZONE_ID,
        zoneName: "aixyte.com",
        records: desired,
      }),
    ).resolves.toMatchObject({
      status: "replayed",
      records: [...receipts].sort((left, right) => {
        const leftKey = `${left.name}\t${left.type}\t${left.content}`;
        const rightKey = `${right.name}\t${right.type}\t${right.content}`;
        return leftKey.localeCompare(rightKey);
      }),
    });
  });

  it("requests HTTP validation for CNAME-only onboarding and confirms the exact identity", async () => {
    const httpPendingHostname = {
      ...pendingHostname,
      ssl: { ...pendingHostname.ssl, method: "http" },
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(httpPendingHostname))
      .mockResolvedValueOnce(envelope([httpPendingHostname]));

    const result = await provider(fetch).createHostname(target);
    expect(result).toMatchObject({
      outcome: "created",
      receipt: {
        customHostnameId: HOSTNAME_ID,
        status: "pending",
        ssl: { status: "pending_validation", method: "http" },
        ready: false,
      },
    });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      hostname: target.hostname,
      ssl: { method: "http", type: "dv", wildcard: false },
    });
    expect(result.receipt.dnsRecords.some((record) => record.purpose === "ssl")).toBe(false);
  });

  it("treats Cloudflare's exact empty page as absence before creating a hostname", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([], { page: 1, totalCount: 0, totalPages: 0 }))
      .mockResolvedValueOnce(envelope(pendingHostname))
      .mockResolvedValueOnce(envelope([pendingHostname]));

    await expect(provider(fetch).createHostname(target)).resolves.toMatchObject({
      outcome: "created",
      receipt: { customHostnameId: HOSTNAME_ID },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("keeps schema-valid pending provider metadata nullable until Cloudflare materializes SSL", async () => {
    const partial = {
      id: HOSTNAME_PROVIDER_ID,
      hostname: target.hostname,
      status: "pending",
      ownership_verification: pendingHostname.ownership_verification,
      verification_errors: ["Ownership TXT record has not propagated yet"],
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([partial]));
    await expect(provider(fetch).observeHostname(target)).resolves.toMatchObject({
      state: "found",
      customHostnameId: HOSTNAME_ID,
      status: "pending",
      providerCreatedAt: null,
      ready: false,
      verificationErrors: ["Ownership TXT record has not propagated yet"],
      ssl: {
        sslId: null,
        status: null,
        type: null,
        method: null,
        bundleMethod: null,
        certificateAuthority: null,
        validationRecords: [],
        dcvDelegationRecords: [],
      },
    });
    await expect(
      provider(
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            envelope([{ ...partial, verification_errors: ["Expected text", { unsafe: true }] }]),
          ),
      ).observeHostname(target),
    ).rejects.toBeInstanceOf(CloudflareCustomHostnameContractError);
  });

  it("replays an existing hostname and recovers a lost create response by readback", async () => {
    const existingFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([pendingHostname]));
    await expect(provider(existingFetch).createHostname(target)).resolves.toMatchObject({
      outcome: "existing",
      receipt: { customHostnameId: HOSTNAME_ID },
    });
    expect(existingFetch).toHaveBeenCalledOnce();

    const recoveredFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(envelope([pendingHostname]));
    await expect(provider(recoveredFetch).createHostname(target)).resolves.toMatchObject({
      outcome: "recovered",
      receipt: { customHostnameId: HOSTNAME_ID },
    });
    expect(recoveredFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

    const conflictFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 409 }))
      .mockResolvedValueOnce(envelope([pendingHostname]));
    await expect(provider(conflictFetch).createHostname(target)).resolves.toMatchObject({
      outcome: "recovered",
      receipt: { customHostnameId: HOSTNAME_ID },
    });

    const unresolvedConflict = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 409 }))
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(unresolvedConflict).createHostname(target)).rejects.toBeInstanceOf(
      CloudflareCustomHostnameRejectedError,
    );
    expect(
      unresolvedConflict.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("deletes the exact receipt ID, proves absence, and replays absence", async () => {
    const receipt = await receiptFrom(activeHostname);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([activeHostname]))
      .mockResolvedValueOnce(Response.json({ id: HOSTNAME_PROVIDER_ID }))
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(fetch).deleteHostname(receipt)).resolves.toEqual({
      outcome: "deleted",
      customHostnameId: HOSTNAME_ID,
      hostname: target.hostname,
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
    });
    expect(
      String(fetch.mock.calls[1]?.[0]).endsWith(`/custom_hostnames/${HOSTNAME_PROVIDER_ID}`),
    ).toBe(true);

    const replayFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([]));
    await expect(provider(replayFetch).deleteHostname(receipt)).resolves.toMatchObject({
      outcome: "absent",
    });
  });

  it("recovers lost delete only when readback proves absence", async () => {
    const receipt = await receiptFrom(activeHostname);
    const recovered = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([activeHostname]))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(envelope([]));
    await expect(provider(recovered).deleteHostname(receipt)).resolves.toMatchObject({
      outcome: "deleted",
    });

    const uncertain = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([activeHostname]))
      .mockResolvedValueOnce(new Response("malformed", { status: 200 }))
      .mockResolvedValueOnce(envelope([activeHostname]));
    await expect(provider(uncertain).deleteHostname(receipt)).rejects.toBeInstanceOf(
      CloudflareCustomHostnameUncertainError,
    );
  });

  it("fails closed on receipt drift, duplicate identity, malformed facts, and invalid input", async () => {
    const receipt = await receiptFrom(activeHostname);
    const drifted = { ...activeHostname, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    await expect(
      provider(
        vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([drifted])),
      ).deleteHostname(receipt),
    ).rejects.toBeInstanceOf(CloudflareCustomHostnameReceiptMismatchError);

    await expect(
      provider(
        vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(envelope([activeHostname, activeHostname])),
      ).observeHostname(target),
    ).rejects.toBeInstanceOf(CloudflareCustomHostnameContractError);

    for (const invalidEmptyPage of [
      envelope([], { totalCount: 1, totalPages: 0 }),
      envelope([pendingHostname], { totalCount: 0, totalPages: 0 }),
      envelope([pendingHostname], { totalCount: 1, totalPages: 0 }),
      envelope([], { page: 2, totalCount: 0, totalPages: 0 }),
    ]) {
      await expect(
        provider(
          vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(invalidEmptyPage),
        ).observeHostname(target),
      ).rejects.toBeInstanceOf(CloudflareCustomHostnameContractError);
    }

    await expect(
      provider(
        vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
          envelope([
            {
              ...pendingHostname,
              ssl: { ...pendingHostname.ssl, status: "unknown_status" },
            },
          ]),
        ),
      ).observeHostname(target),
    ).rejects.toBeInstanceOf(CloudflareCustomHostnameContractError);

    expect(() =>
      createCloudflareCustomHostnameProvider({
        zoneId: "invalid",
        apiToken: "short",
        fetch: globalThis.fetch,
      }),
    ).toThrow("Cloudflare custom hostname input is invalid");

    await expect(provider(vi.fn()).deleteHostname({ ...receipt, ready: false })).rejects.toThrow(
      "Cloudflare custom hostname input is invalid",
    );
    const firstDnsRecord = receipt.dnsRecords[0];
    if (firstDnsRecord === undefined) throw new Error("expected DNS receipt");
    await expect(
      provider(vi.fn()).deleteHostname({
        ...receipt,
        dnsRecords: [{ ...firstDnsRecord, content: "attacker.example.com" }],
      }),
    ).rejects.toThrow("Cloudflare custom hostname input is invalid");
  });

  it("returns a definitive typed rejection for a denied create", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(envelope([]))
      .mockResolvedValueOnce(envelope(null, { status: 403 }));
    await expect(provider(fetch).createHostname(target)).rejects.toBeInstanceOf(
      CloudflareCustomHostnameRejectedError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("classifies observe denial separately from transport and server uncertainty", async () => {
    await expect(
      provider(
        vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([], { status: 403 })),
      ).observeHostname(target),
    ).rejects.toBeInstanceOf(CloudflareCustomHostnameRejectedError);
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([], { status: 503 })),
      vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error("transport")),
    ]) {
      await expect(provider(fetch).observeHostname(target)).rejects.toBeInstanceOf(
        CloudflareCustomHostnameUncertainError,
      );
    }
  });
});

async function receiptFrom(value: unknown): Promise<CloudflareCustomHostnameReceipt> {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(envelope([value]));
  const observed = await provider(fetch).observeHostname(target);
  if (observed.state !== "found") throw new Error("test receipt is absent");
  return observed;
}
