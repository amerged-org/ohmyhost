import { createHmac } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runChargeOrg } from "../../control-store/src/catalog/credit/index.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { createControlStore } from "../../control-store/src/store.js";
import { activateTestCore, migrate } from "../../control-store/test/support/control-d1.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { seedOrganization } from "../../control-store/test/support/seed.js";
import { createStripeFixture, type Row } from "./stripe-fixture.js";

// The same Worker code as billing-worker.test.ts, but bundled the way it is deployed and talking to the Core over genuine
// Worker-to-Worker RPC, with signed webhook intake in front of the same Core.
interface Runtime {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(input: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}
let runtime: Runtime,
  db: D1Database,
  store: ReturnType<typeof createControlStore>,
  worker: Awaited<ReturnType<Runtime["getWorker"]>>,
  ingress: typeof worker;
const ACCOUNT = "acct_worker_billing",
  SECRET = "whsec_billing_worker_fixture",
  stripe = createStripeFixture(ACCOUNT);
const at = () => new Date().toISOString();
const bundle = async (contents: string, directory: URL) => {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(directory), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers"],
    write: false,
    logLevel: "error",
    plugins: [
      {
        name: "runtime-traps",
        setup(builder) {
          builder.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
            const name = args.path.replace(/^node:/u, "");
            if (!builtinModules.includes(name) && !builtinModules.includes(`node:${name}`)) return;
            return args.kind === "require-call"
              ? { path: name, namespace: "built-in" }
              : { path: `node:${name}`, external: true };
          });
          builder.onLoad({ filter: /.*/, namespace: "built-in" }, (args) => ({
            contents: `import value from ${JSON.stringify(`node:${args.path}`)};module.exports=value;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]?.text ?? "";
};
const BILLING = `
import actual from './src/worker-main.ts';
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname==='/fixture/rpc'){try{return Response.json(await env.CONTROL_RUNTIME[request.headers.get('method')](await request.json()));}catch(error){return Response.json({error:String(error.message)},{status:503});}}
 const fixture=url.searchParams.get('fixture');url.search='';let bindings=env;
 if(fixture==='missing')bindings={...env,CONTROL_RUNTIME:undefined};
 if(fixture==='raw')bindings={...env,CONTROL_CORE:{}};
 if(fixture==='wrong')bindings={...env,CONTROL_RUNTIME:env.WRONG_RUNTIME};
 return actual.fetch(new Request(url,request),bindings);
}};`;
const CORE = `
export {BillingRuntime,WebhookIngressRuntime,ControlRuntime} from './src/worker-main.ts';
export default {fetch(){return new Response('private')}};`;
beforeAll(async () => {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json"),
    { Miniflare, convertV4MiniflareOptions } = createRequire(
      createRequire(manifest).resolve("wrangler/package.json"),
    )("miniflare") as {
      Miniflare: new (options: unknown) => Runtime;
      convertV4MiniflareOptions(options: unknown): unknown;
    };
  const [control, billing, hook] = await Promise.all([
    bundle(CORE, new URL("../../control-store/", import.meta.url)),
    bundle(BILLING, new URL("../", import.meta.url)),
    bundle(
      `export {default} from './src/worker-main.ts';`,
      new URL("../../webhook-ingress/", import.meta.url),
    ),
  ]);
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "control",
          modules: true,
          script: control,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_CORE: "core" },
        },
        {
          name: "billing",
          modules: true,
          script: billing,
          compatibilityDate: "2026-09-07",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: {
            CONTROL_RUNTIME: { name: "control", entrypoint: "BillingRuntime" },
            WRONG_RUNTIME: { name: "control", entrypoint: "ControlRuntime" },
          },
          bindings: {
            STRIPE_SECRET_KEY: "sk_test_billing_worker_fixture",
            STRIPE_ACCOUNT_ID: ACCOUNT,
            STRIPE_MODE: "test",
            STRIPE_PAID_PRICE_ID: "price_paid",
            STRIPE_TOPUP_PRICE_ID: "price_topup",
            STRIPE_PORTAL_CONFIGURATION_ID: "bpc_fixture",
            BILLING_RETURN_ORIGIN: "https://dev.app.ohmyho.st",
          },
          outboundService: stripe.request,
        },
        {
          name: "ingress",
          modules: true,
          script: hook,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: {
            CONTROL_RUNTIME: { name: "control", entrypoint: "WebhookIngressRuntime" },
          },
          bindings: {
            STRIPE_WEBHOOK_SECRET: SECRET,
            STRIPE_ACCOUNT_ID: ACCOUNT,
            STRIPE_MODE: "test",
          },
        },
      ],
    }),
  );
  db = (await runtime.getD1Database("CONTROL_CORE", "control")) as D1Database;
  await migrate(db, "core");
  await activateTestCore(db);
  store = createControlStore({ CONTROL_CORE: db });
  worker = await runtime.getWorker("billing");
  ingress = await runtime.getWorker("ingress");
}, 120000);
afterAll(async () => runtime?.dispose());
const rows = async (sql: string, ...values: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all<Row>()
  ).results;
const post = (path: string, input: unknown = {}, fixture = "") =>
  worker.fetch(`https://billing.internal${path}${fixture ? `?fixture=${fixture}` : ""}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
async function sign(event: Row) {
  stripe.events.set(String(event["id"]), event);
  const body = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000),
    signature = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  return ingress.fetch("https://ingress.test/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body,
  });
}
it("runs the actual Billing Worker through named real Core RPC for a paid plan, a top-up, a refund and globally signed intake", async () => {
  const org = await seedOrganization(store, 2, 0);
  const paid = await post("/checkouts", {
    organizationId: org,
    actorId: "user:owner",
    idempotencyKey: "rpc-paid",
    offer: "paid",
    packs: 1,
  });
  expect(paid.status).toBe(201);
  expect(await paid.json()).toMatchObject({
    payment_confirmed: true,
    credited_micros: "1000000000",
    revoked_micros: "0",
  });
  const top = await post("/checkouts", {
    organizationId: org,
    actorId: "user:owner",
    idempotencyKey: "rpc-topup",
    offer: "topup",
    packs: 1,
  });
  expect(top.status).toBe(201);
  const topup = (await top.json()) as Row,
    id = String(topup["checkout_id"]),
    pi = `pi_${id}`;
  stripe.refunds.set(pi, [
    { id: `re_${id}`, payment_intent: pi, currency: "usd", amount: 500, status: "succeeded" },
  ]);
  const reversed = await post("/checkout-status", { organizationId: org, checkoutId: id });
  expect(reversed.status).toBe(200);
  expect(await reversed.json()).toMatchObject({
    credited_micros: "1000000000",
    revoked_micros: "500000000",
  });
  expect((await post("/portal", { organizationId: org })).status).toBe(200);
  const session = stripe.sessions.get(`cs_${id}`);
  if (!session) throw new Error("session missing");
  const event = {
    id: `evt_${id}`,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    account: ACCOUNT,
    data: { object: session },
  };
  expect((await sign(event)).status).toBe(200);
  expect(await (await sign(event)).json()).toEqual({ accepted: true, duplicate: true });
  expect(
    await rows(
      "SELECT organization_id,state FROM webhook_inbox WHERE external_event_id=?",
      `${ACCOUNT}/test/evt_${id}`,
    ),
  ).toEqual([{ organization_id: null, state: "pending" }]);
  const batch = await post("/sync-webhooks");
  expect(batch.status).toBe(200);
  expect(await batch.json()).toMatchObject({ acknowledged: 1, failed: 0 });
  expect(
    await rows(
      "SELECT state FROM webhook_inbox WHERE external_event_id=?",
      `${ACCOUNT}/test/evt_${id}`,
    ),
  ).toEqual([{ state: "acknowledged" }]);
  expect(
    await rows(
      "SELECT key, amount_micros, reversed_micros FROM credit_grant WHERE organization_id=? ORDER BY key",
      org,
    ),
  ).toEqual([
    expect.objectContaining({ amount_micros: 1_000_000_000 }),
    expect.objectContaining({ amount_micros: 1_000_000_000, reversed_micros: 500_000_000 }),
  ]);
}, 30_000);

it("runs an automatic recharge through the same RPC", async () => {
  const org = await seedOrganization(store, 2, 0);
  await makePaid(db, org, undefined, at(), "manual");
  const configured = await post("/recharge-configure", {
    organizationId: org,
    actorId: "user:owner",
    idempotencyKey: "rpc-enable",
    enabled: true,
    monthlyLimitMinor: 3000,
    consent: "off_session_v1",
    revision: 0,
  });
  expect(configured.status).toBe(200);
  expect(await configured.json()).toMatchObject({ status: "on", enabled: true });
  await runChargeOrg(db, {
    organizationId: org,
    key: `spend:${org}`,
    amountMicros: 950_000_000,
    now: at(),
  });
  expect(await (await post("/sync-recharge")).json()).toEqual({ processed: 1, failed: 0 });
  expect(stripe.pays.get(org)).toBe(1);
  expect(
    await rows(
      "SELECT key, paid_minor FROM credit_grant WHERE organization_id=? AND key LIKE 'recharge:%'",
      org,
    ),
  ).toEqual([expect.objectContaining({ paid_minor: 1000 })]);
}, 30_000);

it("fails closed before provider IO for a missing or foreign Control authority and exposes no generic SQL, grant or maintenance RPC", async () => {
  const before = stripe.state.calls;
  for (const fixture of ["missing", "raw", "wrong"]) {
    const result = await post("/sync-recharge", {}, fixture);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ code: "billing_unavailable" });
  }
  expect(stripe.state.calls).toBe(before);
  for (const method of [
    "grantCredits",
    "executeSql",
    "claimInboxEvent",
    "purgeCommandLog",
    "recordInboxEvent",
    "applyWorkosOrganizationSnapshot",
    "observeStripePayment",
    "prepareStripeCheckout",
  ]) {
    const result = await worker.fetch("https://fixture/fixture/rpc", {
      method: "POST",
      headers: { method },
      body: "{}",
    });
    expect(result.status).toBe(503);
  }
  expect(
    (await worker.fetch("https://public.test/sync-recharge", { method: "POST", body: "{}" }))
      .status,
  ).toBe(404);
});
