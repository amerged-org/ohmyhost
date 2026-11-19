/**
 * The Cloudflare provider boundary of the shipped Worker: the OAuth/DNS provider class and the SaaS, platform
 * and route providers are replaced by stateless fakes that still issue one HTTP request per operation through the
 * fetch the Worker gave them, so the Worker's own request hooks (lease renewal, `workerFetch`) run for real.
 */
export const providerLog: string[] = [];

const tokens = (n: number) => ({
  accessToken: `fixture-access-token-${n}`,
  refreshToken: `fixture-refresh-token-${n}`,
  tokenType: "Bearer" as const,
  expiresInSeconds: 3600,
  scopes: ["dns.write", "zone.read"] as ["dns.write", "zone.read"],
});
let refreshes = 0;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
async function request(fetcher: Fetcher, operation: string) {
  providerLog.push(operation);
  await fetcher(`https://cloudflare.fixture.invalid/${operation}`, { method: "POST" });
}

export class FakeCustomerDnsProvider {
  readonly #fetch: Fetcher;
  constructor(configuration: { fetch: Fetcher }) {
    this.#fetch = configuration.fetch;
  }
  async exchangeAuthorizationCode() {
    await request(this.#fetch, "exchange-code");
    return tokens(0);
  }
  async observeZone(_token: string, zone: string) {
    await request(this.#fetch, "observe-zone");
    return {
      state: "found" as const,
      zoneId: "d".repeat(32),
      zoneName: zone,
      accountId: "e".repeat(32),
    };
  }
  async observeRefreshToken() {
    await request(this.#fetch, "observe-refresh-token");
    return { state: "active" as const, tokens: tokens(++refreshes) };
  }
  async refreshAccessToken() {
    await request(this.#fetch, "refresh-access-token");
    return tokens(++refreshes);
  }
  async reconcileRecords(_token: string, input: { records: readonly object[] }) {
    await request(this.#fetch, "reconcile-records");
    return { status: "applied" as const, records: input.records };
  }
  async deleteRecords(_token: string, input: { records: readonly { id: string }[] }) {
    await request(this.#fetch, "delete-records");
    return { status: "deleted" as const, recordIds: input.records.map(({ id }) => id) };
  }
  async revokeRefreshToken(token: string) {
    await request(this.#fetch, `revoke:${token}`);
  }
}

export function fakePlatformDomains(configuration: { fetch: Fetcher }) {
  return {
    observeGatewayWildcard: async () => {
      await request(configuration.fetch, "observe-wildcard");
      return { recordId: "9".repeat(32) };
    },
    reconcileRecords: async (input: { records: readonly object[] }) => {
      await request(configuration.fetch, "platform-reconcile");
      return { status: "applied" as const, records: input.records };
    },
    deleteRecords: async (input: { records: readonly { id: string }[] }) => {
      await request(configuration.fetch, "platform-delete-records");
      return { status: "deleted" as const, recordIds: input.records.map(({ id }) => id) };
    },
  };
}

export function fakeRoutes(configuration: { fetch: Fetcher }) {
  return {
    createRoute: async () => {
      throw new Error("not used");
    },
    retargetRoute: async () => {
      throw new Error("not used");
    },
    observeRoute: async () => {
      throw new Error("not used");
    },
    observePlatformWildcardRoute: async () => {
      throw new Error("not used");
    },
    deleteRoute: async (receipt: { routeId: string; pattern: string }) => {
      await request(configuration.fetch, "delete-route");
      return {
        outcome: "deleted" as const,
        routeId: receipt.routeId,
        pattern: receipt.pattern,
        observedAt: new Date(),
      };
    },
  };
}

export function fakeCustomHostnames(configuration: { fetch: Fetcher }) {
  const unused = async () => {
    throw new Error("not used");
  };
  return {
    createHostname: unused,
    observeHostname: unused,
    deleteHostname: async () => {
      await request(configuration.fetch, "delete-hostname");
    },
  };
}
