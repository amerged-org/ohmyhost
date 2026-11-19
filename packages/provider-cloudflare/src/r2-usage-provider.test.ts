import { describe, expect, it } from "vitest";
import { createR2UsageProvider } from "./r2-usage-provider.js";

const accountId = "a".repeat(32);
const bucketName = "ohmyho-01j00000000000000000000001-01j00000000000000000000002";
const input = {
  bucketName,
  jurisdiction: "us" as const,
  from: "2026-09-08T00:00:00.000Z",
  to: "2026-09-09T00:00:00.000Z",
};

describe("R2 provider measurements", () => {
  it("reads daily storage peaks and successful object operations with explicit sampling", async () => {
    const provider = new UsageHttpFixture();
    const reader = createR2UsageProvider({
      accountId,
      apiToken: "private-test-token-value",
      fetch: provider.fetch,
    });
    expect(await reader.readUsage(input)).toEqual([
      {
        meter: "r2.storage.observed",
        unit: "byte_peak_day",
        from: input.from,
        to: input.to,
        quantity: "1000",
        exact: false,
      },
      {
        meter: "r2.class_a",
        unit: "request",
        from: input.from,
        to: "2026-09-08T01:00:00.000Z",
        quantity: "4",
        exact: true,
      },
      {
        meter: "r2.class_b",
        unit: "request",
        from: input.from,
        to: "2026-09-08T01:00:00.000Z",
        quantity: "12",
        exact: false,
      },
    ]);
    expect(provider.body.variables["bucket"]).toBe(`us_${bucketName}`);
    expect(provider.body.query).toContain("confidence(level: 0.99)");
    expect(provider.body.query).not.toContain("private-test-token-value");
    expect(provider.request?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(provider.request?.redirect).toBe("manual");
    provider.invalid = "foreign";
    await expect(reader.readUsage(input)).rejects.toThrow("R2 usage response is invalid");
    provider.invalid = "errors";
    await expect(reader.readUsage(input)).rejects.toThrow("R2 usage response is invalid");
    provider.invalid = "large";
    await expect(reader.readUsage(input)).rejects.toThrow("R2 usage response is too large");
    await expect(reader.readUsage({ ...input, bucketName: "platform-backups" })).rejects.toThrow(
      "R2 usage input is invalid",
    );
    expect(() =>
      createR2UsageProvider({ accountId: "foreign", apiToken: "private", fetch: provider.fetch }),
    ).toThrow("R2 usage input is invalid");
  });
});

class UsageHttpFixture {
  request?: Request;
  body: { query: string; variables: Record<string, string> } = { query: "", variables: {} };
  invalid: "foreign" | "errors" | "large" | null = null;
  readonly fetch: typeof globalThis.fetch;
  constructor() {
    const respond = this.respond.bind(this);
    this.fetch = async function (this: typeof globalThis, url, init) {
      expect(this === globalThis).toBe(true);
      return respond(url, init);
    };
  }
  async respond(
    url: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> {
    this.request = new Request(url, init);
    this.body = await this.request.json();
    if (this.invalid === "large") return new Response("x".repeat(4 * 1024 * 1024 + 1));
    const name = this.invalid === "foreign" ? "foreign" : `us_${bucketName}`;
    const operations = [
      ["PutObject", 4, 4, 4, 4],
      ["GetObject", 12, 10, 9, 15],
      ["DeleteObject", 7, 7, 7, 7],
    ].map(([actionType, requests, sampleSize, lower, upper]) => ({
      dimensions: {
        bucketName: name,
        datetimeHour: "2026-09-08T00:00:00Z",
        actionType,
        actionStatus: "success",
        storageClass: "Standard",
      },
      sum: { requests },
      confidence: { sum: { requests: { estimate: requests, sampleSize, lower, upper } } },
    }));
    return Response.json({
      errors: this.invalid === "errors" ? [{ message: "private-provider-detail" }] : null,
      data: {
        viewer: {
          accounts: [
            {
              storage: [
                {
                  dimensions: { bucketName: name, date: "2026-09-08", storageClass: "Standard" },
                  max: { payloadSize: 1000 },
                },
              ],
              operations,
            },
          ],
        },
      },
    });
  }
}
