import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { siteRequestResponse } from "../../public-site/src/site-requests.js";
import { sourceBucket } from "../src/public-entry-source.js";
import { clientsFixture } from "./helpers/d1-clients-fixture.js";

// The Worker host binds env through its constructor; the Core's private entrypoints run unchanged in process.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, environment: unknown) {
      this.env = environment;
    }
  },
}));

let control: TestControl;
let binding: { fetch(request: Request): Promise<Response> };
beforeAll(async () => {
  control = await createTestControl();
  const f = await clientsFixture(control);
  // The public site reaches the production origin of the Control API through its service binding.
  binding = {
    fetch: (request) =>
      f.worker.fetch(
        request,
        { ...f.bindings, CONTROL_API_PUBLIC_ORIGIN: "https://app.ohmyho.st" } as never,
        { waitUntil: () => undefined },
      ),
  };
}, 60_000);
afterAll(async () => control.dispose());

const site = (path: string, init: RequestInit = {}) =>
  new Request(`https://ohmyho.st${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  site(path, {
    method: "POST",
    headers: { origin: "https://ohmyho.st", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

it("serves the public statistics, feature votes and contact form through the generated SDK from the real Control API over the Core", async () => {
  expect(await (await siteRequestResponse(site("/stats.json"), binding))?.json()).toMatchObject({
    deploys_7d: 0,
  });
  expect(await (await siteRequestResponse(site("/status.json"), binding))?.json()).toMatchObject({
    ok: false,
    components: expect.arrayContaining([{ name: "API and reporting", status: "operational" }]),
  });

  // A visitor is a cookie: the first read hands one out, a vote is kept for it and for no other visitor.
  const initial = await siteRequestResponse(site("/want"), binding);
  expect(initial?.status).toBe(200);
  expect(initial?.headers.get("set-cookie")).toMatch(
    /^__Host-omh_voter=[0-9a-f-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000$/u,
  );
  const cookie = initial?.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const vote = {
    feature: "eu",
    choice: "up",
    idempotency_key: "00000000-0000-4000-8000-000000000010",
  };
  const votes = {
    votes: [
      { feature: "eu", choice: "up" },
      { feature: "iso27001", choice: null },
      { feature: "soc2", choice: null },
    ],
  };
  const accepted = await siteRequestResponse(post("/want", vote, { cookie }), binding);
  expect(accepted?.status).toBe(202);
  expect(await accepted?.json()).toEqual({ accepted: true, ...votes });
  expect(
    await (await siteRequestResponse(site("/want", { headers: { cookie } }), binding))?.json(),
  ).toEqual(votes);
  expect(
    await (await siteRequestResponse(site("/want", { headers: { cookie: "" } }), binding))?.json(),
  ).toEqual({ votes: votes.votes.map((row) => ({ ...row, choice: null })) });

  // Refusals: no or forged visitor cookie, a foreign origin, an unknown field, a bad choice, a huge body.
  for (const forged of ["", "__Host-omh_voter=bad", `${cookie}; ${cookie}`]) {
    const denied = await siteRequestResponse(post("/want", vote, { cookie: forged }), binding);
    expect([denied?.status, await denied?.json()]).toEqual([
      409,
      { code: "voter_cookie_required" },
    ]);
  }
  for (const [request, status] of [
    [post("/want", { ...vote, voter_id: "forged" }, { cookie }), 400],
    [post("/want", { ...vote, choice: "invalid" }, { cookie }), 400],
    [post("/want", vote, { cookie, origin: "https://foreign.example" }), 403],
    [post("/want", { ...vote, feature: "x".repeat(2100) }, { cookie }), 413],
    [site("/stats.json", { method: "POST" }), 405],
  ] as const)
    expect((await siteRequestResponse(request, binding))?.status).toBe(status);

  // A contact request is accepted once per idempotency key and never echoed back.
  const contact = {
    name: "Website visitor",
    email: "visitor@example.invalid",
    company: "",
    message: "Please explain data retention.",
    idempotency_key: "00000000-0000-4000-8000-000000000020",
  };
  for (const [payload, status] of [
    [contact, 202],
    [contact, 202],
    [{ ...contact, message: "changed" }, 409],
    [{ ...contact, name: "" }, 400],
  ] as const) {
    const response = await siteRequestResponse(post("/v1/contact-requests", payload), binding);
    expect(response?.status).toBe(status);
    expect(await response?.text()).not.toContain(contact.email);
  }

  // The website forwards the visitor's address and the Control API stores only its bucket: none without an address,
  // and different buckets for different visitors.
  const stored = async (key: string) =>
    (
      await control.core
        .prepare("SELECT source_bucket FROM contact_requests WHERE request_id=?")
        .bind(key)
        .first<{ source_bucket: number }>()
    )?.source_bucket;
  expect(await stored(contact.idempotency_key)).toBe(-2);
  const keys = ["00000000-0000-4000-8000-000000000021", "00000000-0000-4000-8000-000000000022"];
  for (const [index, ip] of ["203.0.113.7", "203.0.113.8"].entries()) {
    const response = await siteRequestResponse(
      post(
        "/v1/contact-requests",
        { ...contact, idempotency_key: keys[index] },
        { "cf-connecting-ip": ip },
      ),
      binding,
    );
    expect(response?.status).toBe(202);
    expect(await stored(keys[index] as string)).toBe(sourceBucket(ip));
  }
  expect(await stored(keys[0] as string)).not.toBe(await stored(keys[1] as string));
}, 60_000);

it("answers a rate-limited or malformed Control API with a bounded public error", async () => {
  const limited = await siteRequestResponse(
    post(
      "/want",
      { feature: "eu", choice: "up", idempotency_key: "k" },
      { cookie: "__Host-omh_voter=00000000-0000-4000-8000-000000000001" },
    ),
    {
      fetch: async () =>
        Response.json(
          { status: 429, code: "rate_limited" },
          { status: 429, headers: { "retry-after": "37" } },
        ),
    },
  );
  expect([limited?.status, limited?.headers.get("retry-after")]).toEqual([429, "37"]);
  const malformed = await siteRequestResponse(site("/stats.json"), {
    fetch: async () => Response.json({ deploys_7d: "invalid", observed_at: "invalid" }),
  });
  expect([malformed?.status, await malformed?.json()]).toEqual([
    503,
    { code: "service_unavailable" },
  ]);
});
