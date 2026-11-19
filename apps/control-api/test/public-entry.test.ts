import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicEntryCommands } from "../../control-store/src/catalog/public-entry/commands.js";
import {
  PUBLIC_INTAKE_CAPS,
  publicEntryExpiry,
} from "../../control-store/src/catalog/public-entry/entry.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { createD1PublicEntry } from "../src/d1-public-entry.js";
import { createPublicEntry, handlePublicEntry, type PublicEntryPort } from "../src/public-entry.js";
import { sourceBucket } from "../src/public-entry-source.js";

const NOW = new Date("2026-10-30T10:00:00.123Z");
const clock = { now: () => NOW };
const voter = "11111111-1111-4111-8111-111111111111";
const contact = {
  name: " Reader ",
  email: " Reader@Example.com ",
  company: "",
  message: " Please provide the requested information. ",
  idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const vote = {
  feature: "eu",
  choice: "up",
  idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

let control: TestControl;
let port: PublicEntryPort;
beforeAll(async () => {
  control = await createTestControl();
  const context = { directory: control.core, router: new SharedCoreRouter(control.core) };
  const commands = createPublicEntryCommands((fn) => (input) => fn(context, input));
  port = createD1PublicEntry(commands.entry, clock);
}, 60_000);
afterAll(async () => control.dispose(), 60_000);

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  to: PublicEntryPort = port,
  at: { now(): Date } = clock,
) =>
  handlePublicEntry(
    new Request(`https://app.ohmyho.st${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://ohmyho.st",
        "x-ohmyho-voter": voter,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    to,
    at,
  );
const get = (path: string, headers: Record<string, string> = { "x-ohmyho-voter": voter }) =>
  handlePublicEntry(new Request(`https://app.ohmyho.st${path}`, { headers }), port);
const problem = async (response: Response) => {
  const body = (await response.json()) as { code: string; status: number; retryable: boolean };
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return { status: response.status, code: body.code, retryable: body.retryable };
};

describe("public entry over the Core", () => {
  it(
    "stores a normalised contact request once and refuses a changed replay",
    { timeout: 60_000 },
    async () => {
      const accepted = await post("/v1/contact-requests", contact);
      expect(accepted.status).toBe(202);
      expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect(await accepted.json()).toEqual({ accepted: true });
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            "Reader",
            "reader@example.com",
            "",
            "Please provide the requested information.",
          ]),
        )
        .digest("hex");
      expect(
        await control.core
          .prepare(
            "SELECT lower(hex(payload_sha256)) digest,email,created_at FROM contact_requests",
          )
          .first(),
      ).toMatchObject({ digest, email: "reader@example.com" });
      expect((await post("/v1/contact-requests", contact)).status).toBe(202);
      expect(
        await problem(await post("/v1/contact-requests", { ...contact, message: "changed" })),
      ).toEqual({
        status: 409,
        code: "idempotency_key_reused",
        retryable: false,
      });
    },
  );

  it(
    "records a browser's vote, projects it back for that browser only and refuses a reused key",
    { timeout: 60_000 },
    async () => {
      const accepted = await post("/v1/site/feature-interests", vote);
      expect(accepted.status).toBe(202);
      const projection = [
        { feature: "eu", choice: "up" },
        { feature: "iso27001", choice: null },
        { feature: "soc2", choice: null },
      ];
      expect(await accepted.json()).toEqual({ accepted: true, votes: projection });
      const own = await get("/v1/site/feature-interests");
      expect(own.status).toBe(200);
      expect(await own.json()).toEqual({ votes: projection });
      const upper = await get("/v1/site/feature-interests", {
        "x-ohmyho-voter": voter.toUpperCase(),
      });
      expect(await upper.json()).toEqual({ votes: projection });
      const stranger = await get("/v1/site/feature-interests", {
        "x-ohmyho-voter": "22222222-2222-4222-8222-222222222222",
      });
      expect((await stranger.json()) as { votes: { choice: unknown }[] }).toEqual({
        votes: projection.map(({ feature }) => ({ feature, choice: null })),
      });
      expect((await post("/v1/site/feature-interests", vote)).status).toBe(202);
      expect(
        await problem(await post("/v1/site/feature-interests", { ...vote, choice: "down" })),
      ).toMatchObject({
        status: 409,
        code: "idempotency_key_reused",
      });
      const withdrawn = await post("/v1/site/feature-interests", {
        ...vote,
        choice: null,
        idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      });
      expect(((await withdrawn.json()) as { votes: unknown[] }).votes).toContainEqual({
        feature: "eu",
        choice: null,
      });
    },
  );

  it(
    "serves the aggregate statistics with the clock's observation time",
    { timeout: 60_000 },
    async () => {
      const response = await get("/v1/site/stats", {});
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deploys_7d: 0, observed_at: NOW.toISOString() });
    },
  );

  it(
    "answers unsupported methods with the status and code the contract documents, under the caller's request id",
    { timeout: 60_000 },
    async () => {
      const contract = JSON.parse(
        await readFile(
          new URL("../../../packages/contracts/generated/openapi.json", import.meta.url),
          "utf8",
        ),
      ) as {
        paths: Record<string, { "x-ohmyhost-other-methods"?: { status: number; code: string } }>;
        components: { schemas: { ProblemDetails: { properties: { code: { enum: string[] } } } } };
      };
      const codes = contract.components.schemas.ProblemDetails.properties.code.enum;
      const attempts: [string, string, Record<string, string>][] = [
        ["/v1/contact-requests", "GET", {}],
        ["/v1/contact-requests", "PUT", {}],
        ["/v1/site/feature-interests", "DELETE", { "x-ohmyho-voter": voter }],
        ["/v1/site/stats", "POST", {}],
      ];
      for (const [path, method, headers] of attempts) {
        const documented = contract.paths[path]?.["x-ohmyhost-other-methods"];
        expect(documented, `${method} ${path} is documented`).toBeDefined();
        const response = await handlePublicEntry(
          new Request(`https://app.ohmyho.st${path}`, {
            method,
            headers: { "x-request-id": "req_idn21_probe", ...headers },
          }),
          port,
        );
        const body = (await response.json()) as { code: string; request_id: string };
        expect({ status: response.status, code: body.code }).toEqual({
          status: documented?.status,
          code: documented?.code,
        });
        expect(codes).toContain(body.code);
        expect(response.headers.get("x-request-id")).toBe("req_idn21_probe");
        expect(body.request_id).toBe("req_idn21_probe");
      }
    },
  );

  it("rejects malformed requests before touching the Core", { timeout: 60_000 }, async () => {
    const rows = async (table: string) =>
      (await control.core.prepare(`SELECT count(*) n FROM ${table}`).first<{ n: number }>())?.n;
    const before = [await rows("contact_requests"), await rows("beta_feature_interests")];
    const refused = async (response: Response, status: number, code: string) =>
      expect(await problem(response)).toMatchObject({ status, code });
    await refused(await get("/v1/site/contact"), 404, "resource_not_found");
    await refused(await post("/v1/site/contact", contact), 404, "resource_not_found");
    await refused(await get("/v1/site/unknown"), 404, "resource_not_found");
    await refused(await get("/v1/site/feature-interests", {}), 400, "invalid_request");
    await refused(
      await get("/v1/site/feature-interests", { "x-ohmyho-voter": "not-a-uuid" }),
      400,
      "invalid_request",
    );
    await refused(await get("/v1/site/feature-interests?x=1"), 400, "invalid_request");
    await refused(await get("/v1/contact-requests"), 405, "invalid_request");
    await refused(
      await post("/v1/site/feature-interests", vote, { origin: "https://evil.example" }),
      403,
      "forbidden",
    );
    await refused(
      await post("/v1/site/feature-interests", vote, { "content-type": "text/plain" }),
      400,
      "invalid_request",
    );
    await refused(
      await post("/v1/site/feature-interests", vote, { "content-length": "2049" }),
      413,
      "payload_too_large",
    );
    await refused(
      await post("/v1/site/feature-interests", "x".repeat(2049)),
      413,
      "payload_too_large",
    );
    await refused(await post("/v1/site/feature-interests", "{not json"), 400, "invalid_request");
    await refused(await post("/v1/site/feature-interests", "[]"), 400, "invalid_request");
    await refused(
      await handlePublicEntry(
        new Request("https://app.ohmyho.st/v1/site/feature-interests", {
          method: "POST",
          headers: { "content-type": "application/json", "x-ohmyho-voter": voter },
        }),
        port,
      ),
      400,
      "invalid_request",
    );
    for (const bad of [
      { ...vote, feature: "other" },
      { ...vote, choice: "maybe" },
      { ...vote, idempotency_key: "short" },
      { ...vote, extra: true },
    ])
      await refused(await post("/v1/site/feature-interests", bad), 400, "invalid_request");
    for (const bad of [
      { ...contact, extra: true },
      { ...contact, name: "" },
      { ...contact, name: "n".repeat(121) },
      { ...contact, email: "not-an-email" },
      { ...contact, message: "bad\0byte" },
      { ...contact, message: "m".repeat(8001) },
      { ...contact, company: "c".repeat(201) },
      { ...contact, idempotency_key: "short" },
      { ...contact, name: 7 },
    ])
      await refused(await post("/v1/contact-requests", bad), 400, "invalid_request");
    await refused(
      await post(
        "/v1/contact-requests",
        { ...contact, idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
        { "content-length": "32769" },
      ),
      413,
      "payload_too_large",
    );
    expect([await rows("contact_requests"), await rows("beta_feature_interests")]).toEqual(before);
  });
});

describe("public entry without a working port", () => {
  it("answers a refusal with the request id in its header and body, echoing a valid caller id", async () => {
    // Every other control-api problem names its request in X-Request-Id; a public refusal must do the same
    // so that a customer's report can be traced to the log line.
    const echoed = await get("/v1/site/contact", { "x-request-id": "caller-request-1" });
    expect(echoed.headers.get("x-request-id")).toBe("caller-request-1");
    expect(await echoed.json()).toMatchObject({ request_id: "caller-request-1" });
    const generated = await get("/v1/site/contact", {});
    const header = generated.headers.get("x-request-id");
    expect(header).toMatch(/^req_[0-9a-f-]{36}$/u);
    expect(await generated.json()).toMatchObject({ request_id: header });
  });

  it("answers service unavailable and marks it retryable", async () => {
    const request = () => new Request("https://app.ohmyho.st/v1/site/stats");
    expect(await problem(await handlePublicEntry(request()))).toEqual({
      status: 503,
      code: "service_unavailable",
      retryable: true,
    });
    const failing = createD1PublicEntry(
      {
        recordPublicContact: async () => true,
        recordPublicFeatureVote: async () => true,
        readPublicFeatureVotes: async () => [],
        readPublicStats: async () => {
          throw new Error("private canary");
        },
      },
      clock,
    );
    const response = await handlePublicEntry(request(), failing);
    expect(await problem(response)).toMatchObject({ status: 503, code: "service_unavailable" });
  });

  it("refuses a persistence projection or aggregate that breaks the public contract", async () => {
    const persistence = {
      contact: async () => true,
      vote: async () => true,
      votes: async () => [{ feature: "other", choice: "up" }],
      stats: async () => -1,
    };
    const entry = createPublicEntry(persistence, clock);
    await expect(entry.votes(voter)).rejects.toThrow("Invalid feature vote projection");
    await expect(
      createPublicEntry(
        { ...persistence, votes: async () => [{ feature: "eu", choice: "sideways" }] },
        clock,
      ).votes(voter),
    ).rejects.toThrow("Invalid feature vote projection");
    await expect(entry.stats()).rejects.toThrow("Invalid public aggregate");
  });
});

describe("public entry at its intake budget", () => {
  it("serves each source from its own share, answers a spent day with 429 and a spent total with 503, and logs the cap", async () => {
    const own = await createTestControl(),
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const context = { directory: own.core, router: new SharedCoreRouter(own.core) },
        entry = createD1PublicEntry(
          createPublicEntryCommands((fn) => (input) => fn(context, input)).entry,
          clock,
        ),
        { contact: caps, vote: voteCaps } = PUBLIC_INTAKE_CAPS,
        key = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        stamp = NOW.toISOString().replace("Z", "000Z"),
        // The address is in the header only; rows left by an earlier flood of one bucket are written directly.
        send = (path: string, body: unknown, ip: string) =>
          post(path, body, { "cf-connecting-ip": ip }, entry),
        fill = (table: "contact_requests" | "beta_feature_interests", rows: number, ip: string) =>
          own.core
            .prepare(
              `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1)
${
  table === "contact_requests"
    ? `INSERT INTO contact_requests(request_id,payload_sha256,name,email,company,message,created_at,expires_at,source_bucket)
SELECT printf('ffffffff-0000-4000-8000-%012d',i),zeroblob(32),'Filler','filler@example.com','','x',?2,?3,?4 FROM n`
    : `INSERT INTO beta_feature_interests(idempotency_key,feature,created_at,voter_sha256,choice,position,expires_at,source_bucket)
SELECT printf('ffffffff-0000-4000-8000-%012d',i),'eu',?2,zeroblob(32),'up',i,?3,?4 FROM n`
}`,
            )
            .bind(rows, stamp, publicEntryExpiry(stamp), sourceBucket(ip))
            .run(),
        floodIp = (n: number) => `2001:db8:1:2::${n.toString(16)}`,
        otherIp = "2001:db8:1:3::1",
        fullIp = "2001:db8:9:9::1",
        allocator = () =>
          own.core.prepare("SELECT last_value,is_called FROM beta_feature_vote_allocator").first();
      // The bucket is a byte of a digest of the address; an IPv6 address counts by its /64 in any spelling.
      expect(sourceBucket("2001:db8:1:2::1")).toBe(sourceBucket("2001:0DB8:0001:0002:ffff:0:0:7"));
      expect(sourceBucket("2001:db8:1:2::1")).not.toBe(sourceBucket(otherIp));
      // An IPv4-mapped address is the IPv4 address it carries, in any spelling; two mapped addresses differ.
      expect(sourceBucket("::ffff:192.0.2.1")).toBe(sourceBucket("192.0.2.1"));
      expect(sourceBucket("::FFFF:c000:201")).toBe(sourceBucket("192.0.2.1"));
      expect(sourceBucket("::ffff:192.0.2.1")).not.toBe(sourceBucket("::ffff:192.0.2.2"));
      expect(sourceBucket("203.0.113.007")).toBe(sourceBucket("203.0.113.7"));
      for (const address of ["203.0.113.7", "::", "2001:db8::"])
        expect(sourceBucket(address)).toBeLessThan(256);
      // Nothing usable gives no bucket, never a shared one.
      for (const unusable of [
        null,
        "",
        "unknown",
        "1.2.3",
        "1.2.3.256",
        "1.2.3.4.5",
        "1::2::3",
        "12345::1",
        "1:2:3:4:5:6:7:8:9",
        "::1.2.3",
        "::1.2.3.999",
        "a:b::c:d:e:f:1:2",
      ])
        expect(sourceBucket(unusable)).toBeNull();
      // One source floods its bucket: its next request is a retryable 429 until the next UTC day, logged once as a fixed line.
      for (let n = 1; n <= caps.bucketDay; n++)
        expect(
          (await send("/v1/contact-requests", { ...contact, idempotency_key: key(n) }, floodIp(n)))
            .status,
        ).toBe(202);
      const refused = await send(
        "/v1/contact-requests",
        { ...contact, idempotency_key: key(900) },
        floodIp(99),
      );
      expect(await problem(refused.clone())).toEqual({
        status: 429,
        code: "rate_limited",
        retryable: true,
      });
      expect(refused.headers.get("retry-after")).toBe("50400");
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: "warn",
          service: "control-api",
          code: "public_intake_day_full",
          route: "contact",
        }),
      );
      // Another source is served; a stored request replays from the flooding source; a changed payload conflicts.
      expect(
        (await send("/v1/contact-requests", { ...contact, idempotency_key: key(901) }, otherIp))
          .status,
      ).toBe(202);
      expect(
        (await send("/v1/contact-requests", { ...contact, idempotency_key: key(1) }, floodIp(5)))
          .status,
      ).toBe(202);
      expect(
        await problem(
          await send(
            "/v1/contact-requests",
            { ...contact, idempotency_key: key(1), message: "x" },
            floodIp(5),
          ),
        ),
      ).toEqual({ status: 409, code: "idempotency_key_reused", retryable: false });
      // Only the bucket is stored, never the address.
      expect(
        await own.core
          .prepare("SELECT source_bucket FROM contact_requests WHERE request_id=?")
          .bind(key(901))
          .first(),
      ).toEqual({ source_bucket: sourceBucket(otherIp) });
      // A source whose live rows reach its share of the total is a 503 with a day's retry hint: capacity returns only with retention.
      await fill("contact_requests", caps.bucketTotal, fullIp);
      const full = await send(
        "/v1/contact-requests",
        { ...contact, idempotency_key: key(902) },
        fullIp,
      );
      expect(await full.clone().json()).toMatchObject({
        status: 503,
        code: "service_unavailable",
        retryable: true,
        retry_after_seconds: 86_400,
        detail: expect.stringContaining("capacity"),
      });
      expect(full.headers.get("retry-after")).toBe("86400");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"code":"public_intake_total_full"'),
      );
      expect(
        (await send("/v1/contact-requests", { ...contact, idempotency_key: key(903) }, otherIp))
          .status,
      ).toBe(202);
      // Without a usable address a request is served from the pool alone (beyond one bucket's share), is stored with
      // the marker and writes one fixed line a minute, never the address.
      const later = { now: () => new Date(NOW.getTime() + 3_600_000) },
        lines = () =>
          warn.mock.calls.filter(([line]) => String(line).includes("public_intake_source_missing"));
      for (let n = 0; n <= caps.bucketDay; n++)
        expect(
          (
            await post(
              "/v1/contact-requests",
              { ...contact, idempotency_key: key(950 + n) },
              n % 2 === 0 ? {} : { "cf-connecting-ip": "not-an-address" },
              entry,
              later,
            )
          ).status,
        ).toBe(202);
      expect(lines()).toEqual([
        [
          JSON.stringify({
            level: "warn",
            service: "control-api",
            code: "public_intake_source_missing",
            route: "contact",
          }),
        ],
      ]);
      await post("/v1/contact-requests", { ...contact, idempotency_key: key(970) }, {}, entry, {
        now: () => new Date(later.now().getTime() + 61_000),
      });
      expect(lines()).toHaveLength(2);
      expect(
        await own.core
          .prepare("SELECT source_bucket FROM contact_requests WHERE request_id=?")
          .bind(key(950))
          .first(),
      ).toEqual({ source_bucket: -2 });
      // Votes use the same shares, and a refused vote never reaches the shared allocator.
      expect((await send("/v1/site/feature-interests", vote, otherIp)).status).toBe(202);
      await fill("beta_feature_interests", voteCaps.bucketDay, floodIp(1));
      const before = await allocator();
      const spent = await send(
        "/v1/site/feature-interests",
        { ...vote, idempotency_key: key(904) },
        floodIp(1),
      );
      expect(await problem(spent)).toEqual({ status: 429, code: "rate_limited", retryable: true });
      expect(await allocator()).toEqual(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"route":"feature-interests"'));
    } finally {
      warn.mockRestore();
      await own.dispose();
    }
  }, 240_000);
});
