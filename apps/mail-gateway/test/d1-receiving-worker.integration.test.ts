import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import type { D1Database } from "../../control-store/src/d1-types.js";
import {
  migrate,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  mailFixture,
  fundMailFixture,
  MAIL_FIXTURE_CIPHER,
} from "../../control-store/test/mail/mail-fixture.js";
import { gatewayFixture } from "../../control-store/test/gateway/gateway-fixture.js";
import { ensureAccount } from "../../control-store/src/catalog/credit/index.js";
import { storedTimestamp } from "../../control-store/src/timestamps.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  secret = `whsec_${Buffer.alloc(32, 0x47).toString("base64")}`,
  signing = Buffer.alloc(32, 0x48).toString("base64");
async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
    banner: {
      js: 'import{createRequire as __mailRequire}from"node:module";const require=__mailRequire("/fixture.js");',
    },
    plugins: [
      {
        name: "real-rpc",
        setup(b) {
          b.onResolve({ filter: /^[a-z_][a-z0-9_/-]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  if (!result.outputFiles[0]) throw Error("Missing bundle");
  return result.outputFiles[0].text;
}

/** External DNS-provider HTTP only; the actual node:dns/public-target implementation remains in the Worker. */
async function dnsProvider(request: Request) {
  const url = new URL(request.url);
  if (
    !["cloudflare-dns.com", "1.1.1.1", "1.0.0.1"].includes(url.hostname) ||
    !url.pathname.includes("dns-query")
  )
    throw Error("External networking forbidden");
  const type = url.searchParams.get("type");
  return Response.json({
    Status: 0,
    Question: [
      { name: url.searchParams.get("name"), type: type === "AAAA" || type === "28" ? 28 : 1 },
    ],
    Answer: [
      {
        name: url.searchParams.get("name"),
        type: type === "AAAA" || type === "28" ? 28 : 1,
        TTL: 60,
        data: type === "AAAA" || type === "28" ? "2001:4860:4860::8888" : "8.8.8.8",
      },
    ],
  });
}

it("uses actual Gateway and signed ingress through named Core RPC, preserving one economic hold, atomic receipt and real receiving delivery", async () => {
  const require = createRequire(new URL("../../control-store/package.json", import.meta.url)),
    { Miniflare, convertV4MiniflareOptions } = createRequire(
      require.resolve("wrangler/package.json"),
    )("miniflare") as {
      convertV4MiniflareOptions(v: unknown): unknown;
      Miniflare: new (v: unknown) => {
        getD1Database(n: string, w: string): Promise<unknown>;
        getWorker(
          n: string,
        ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
        dispose(): Promise<void>;
      };
    },
    [coreScript, gatewayScript, ingressScript, customerScript, ownerScript] = await Promise.all([
      bundle(
        'export{MailSendRuntime,MailDeliveryRuntime,MailWarningRuntime,MailCapabilityRuntime,MailResendIngressRuntime,WebhookIngressRuntime}from"./apps/control-store/src/worker-main.ts";export default{fetch(){return new Response("private")}}',
      ),
      bundle(`import{sendResendRequest,ResendMailDeliveryService,syncResendMail}from"./apps/mail-gateway/src/resend-worker.ts";
let active,facts={},calls=0;const nativeFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof URL?input.href:typeof input==='string'?input:input.url);if(url.hostname==='cloudflare-dns.com'||url.hostname==='1.1.1.1')return nativeFetch(input,init);if(url.hostname==='receiver.example.com')return active.CUSTOMER.fetch(new Request(url,init));if(url.hostname==='inbound-cdn.resend.com')return new Response(new Uint8Array([65,66,67]));if(url.hostname!=='api.resend.com')throw Error('Unexpected provider');calls++;if(init?.method==='POST'&&url.pathname==='/emails'){const payload=JSON.parse(init.body),notice=payload.tags?.some(tag=>tag.name==='platform');return notice?Response.json({id:'warning_accepted'}):Response.json({message:'uncertain'},{status:500});}const id=url.pathname.split('/')[3];if(url.pathname.includes('/attachments/'))return Response.json({id:'attachment_1',size:3,download_url:'https://inbound-cdn.resend.com/file',expires_at:new Date(Date.now()+3600000).toISOString(),content_type:'text/plain',filename:'file.txt'});return Response.json({id,from:'sender@example.net',to:['chosen@'+facts.domain,'foreign@other.example'],subject:'transient subject',text:'transient text',html:null,message_id:'provider_message',attachments:[{id:'attachment_1',filename:'file.txt',content_type:'text/plain'}]});};
export default{async fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/fixture'){facts=await request.json();return new Response(null)}if(url.pathname==='/diagnostic')return Response.json({calls});const mode=request.headers.get('x-mode'),e={...env};if(mode==='wrong')e.MAIL_DELIVERY_RUNTIME=env.WRONG;active=e;if(url.pathname==='/sync')return Response.json(await syncResendMail(e));if(url.pathname.startsWith('/private/')){const service=new ResendMailDeliveryService(ctx,e),body=await request.json();try{return Response.json(await service.listMailMessages(body))}catch{return new Response(null,{status:503})}}return sendResendRequest(request,e);}};`),
      bundle(
        `import worker from"./apps/webhook-ingress/src/worker-main.ts";let lastError='';export default{async fetch(request,env){if(new URL(request.url).pathname==='/diagnostic')return Response.json({lastError});const e={...env},binding=env.RESEND_INGRESS_RUNTIME;e.RESEND_INGRESS_RUNTIME={readReceipt:async(input)=>{try{return await binding.readReceipt(input)}catch(error){lastError=error.message;throw error}},ingest:async(input)=>{try{return await binding.ingest(input)}catch(error){lastError=error.message;throw error}}};return worker.fetch(request,e)}};`,
      ),
      bundle(
        `import{createHmac}from'node:crypto';let secret='',seen=[];export default{async fetch(request){if(new URL(request.url).pathname==='/fixture'){secret=(await request.json()).secret;return new Response(null)}if(new URL(request.url).pathname==='/diagnostic')return Response.json(seen);const body=await request.text(),id=request.headers.get('webhook-id'),time=request.headers.get('webhook-timestamp'),expected='v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(id+'.'+time+'.'+body).digest('base64');if(request.headers.get('webhook-signature')!==expected)return new Response(null,{status:401});seen.push(JSON.parse(body).id);return new Response(null,{status:201})}};`,
      ),
      bundle(
        `import{WorkerEntrypoint}from'cloudflare:workers';let owner=null;export class Owners extends WorkerEntrypoint{resolve(scope){if(!owner||scope.organizationId!==owner.organizationId)throw Error('Unexpected owner scope');return{...scope,required:true,recipients:[{userId:owner.userId,email:'synthetic-owner@example.net'}]}}}export default{async fetch(request){owner=await request.json();return new Response(null)}};`,
      ),
    ]),
    common = {
      modules: true,
      compatibilityDate: "2026-08-24",
      compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
    },
    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            ...common,
            name: "core",
            script: coreScript,
            d1Databases: { CONTROL_CORE: "receiving-core" },
          },
          { ...common, name: "customer", script: customerScript },
          { ...common, name: "owners", script: ownerScript },
          {
            ...common,
            name: "gateway",
            script: gatewayScript,
            outboundService: dnsProvider,
            bindings: {
              RUNTIME_CONFIGURATION_STATE: "configured",
              RESEND_API_KEY: "re_fixture",
              RESEND_PLATFORM_WARNING_API_KEY: "re_fixture",
              PLATFORM_ENVIRONMENT: "development",
              MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_FIXTURE_CIPHER,
              MAIL_WEBHOOK_SIGNING_KEY: signing,
            },
            serviceBindings: {
              MAIL_SEND_RUNTIME: { name: "core", entrypoint: "MailSendRuntime" },
              MAIL_DELIVERY_RUNTIME: { name: "core", entrypoint: "MailDeliveryRuntime" },
              MAIL_WARNING_RUNTIME: { name: "core", entrypoint: "MailWarningRuntime" },
              MAIL_CAPABILITY_RUNTIME: { name: "core", entrypoint: "MailCapabilityRuntime" },
              WRONG: { name: "core", entrypoint: "WebhookIngressRuntime" },
              CUSTOMER: { name: "customer" },
              CREDIT_WARNING_RECIPIENTS: { name: "owners", entrypoint: "Owners" },
            },
          },
          {
            ...common,
            name: "ingress",
            script: ingressScript,
            bindings: { RESEND_WEBHOOK_SECRET: secret },
            serviceBindings: {
              RESEND_INGRESS_RUNTIME: { name: "core", entrypoint: "MailResendIngressRuntime" },
            },
          },
        ],
      }),
    );
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const control: TestControl = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db },
        dispose: async () => {},
      },
      f = await mailFixture(control);
    await fundMailFixture(control, f);
    const gateway = await mf.getWorker("gateway"),
      ingress = await mf.getWorker("ingress"),
      customer = await mf.getWorker("customer");
    await gateway.fetch("https://gateway/fixture", {
      method: "POST",
      body: JSON.stringify({ domain: f.domain }),
    });
    const { mailWebhookSecret } = await import("@ohmyhost/provider-resend");
    await customer.fetch("https://receiver.example.com/fixture", {
      method: "POST",
      body: JSON.stringify({ secret: mailWebhookSecret(signing, f.domainId) }),
    });
    const send = async (key: string) => {
        const response = await gateway.fetch("https://gateway/v1/send", {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.key}`,
            "idempotency-key": key,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project_id: f.scope.projectId,
            to: "fake@example.net",
            subject: "transient",
            text: "transient",
          }),
        });
        expect(response.status).toBe(202);
        return (await response.json()) as { request_id: string; state: string };
      },
      signed = async (id: string, type: string, data: Record<string, unknown>) => {
        const body = JSON.stringify({ type, created_at: f.now, data }),
          timestamp = String(Math.floor(Date.now() / 1000));
        return ingress.fetch("https://ingress/webhooks/resend", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": id,
            "svix-timestamp": timestamp,
            "svix-signature":
              "v1," +
              createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
                .update(`${id}.${timestamp}.${body}`)
                .digest("base64"),
          },
          body,
        });
      };
    const first = await send("uncertain-observed");
    expect(first.state).toBe("uncertain");
    const data = {
      email_id: "failed_but_charged",
      tags: { request_id: first.request_id, project_id: f.scope.projectId },
    };
    const observed = await signed("evt_observed", "email.failed", data);
    expect(
      observed.status,
      JSON.stringify(await (await ingress.fetch("https://ingress/diagnostic")).json()),
    ).toBe(200);
    expect((await signed("evt_observed", "email.failed", data)).status).toBe(200);
    const financial = await db
      .prepare(
        "SELECT r.state,(SELECT delta_micros FROM credit_log WHERE key='mail:'||r.request_id) charge,(SELECT COUNT(*) FROM credit_log WHERE key='mailrefund:'||r.request_id) refunds FROM mail_send_requests r WHERE r.request_id=?",
      )
      .bind(first.request_id)
      .first();
    // The provider event settles the request; the recipient was charged once at the claim and nothing is refunded.
    expect(financial).toEqual({ state: "accepted", charge: -180000, refunds: 0 });
    const late = await send("late-receipt");
    await db
      .prepare(
        "CREATE TRIGGER test_resend_receipt_final BEFORE INSERT ON resend_event_receipts WHEN NEW.event_id='evt_late' BEGIN SELECT RAISE(ABORT,'test_resend_receipt_final');END",
      )
      .run();
    const lateData = {
      email_id: "late_message",
      tags: { request_id: late.request_id, project_id: f.scope.projectId },
    };
    expect((await signed("evt_late", "email.failed", lateData)).status).toBe(503);
    expect(
      await db
        .prepare("SELECT state FROM mail_send_requests WHERE request_id=?")
        .bind(late.request_id)
        .first(),
    ).toEqual({ state: "uncertain" });
    await db.prepare("DROP TRIGGER test_resend_receipt_final").run();
    expect((await signed("evt_late", "email.failed", lateData)).status).toBe(200);
    expect((await signed("evt_complaint", "email.complained", data)).status).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT state FROM mail_reputation_states WHERE organization_id=? AND project_id=?",
        )
        .bind(f.scope.organizationId, f.scope.projectId)
        .first(),
    ).toEqual({ state: "suspended" });
    expect(
      await db
        .prepare("SELECT reputation_state FROM workspace_mail_domains WHERE domain_id=?")
        .bind(f.domainId)
        .first(),
    ).toEqual({ reputation_state: "suspended" });
    expect(
      (
        await signed("evt_receive", "email.received", {
          email_id: "received_wire_1",
          to: [`chosen@${f.domain}`, "foreign@other.example"],
          subject: "transient subject",
          text: "transient text",
        })
      ).status,
    ).toBe(200);
    const message = await db
      .prepare(
        "SELECT message_id FROM mail_received_messages WHERE provider_message_id='received_wire_1'",
      )
      .first<{ message_id: string }>();
    if (!message) throw Error("No received metadata");
    const path = `https://gateway/v1/projects/${f.scope.projectId}/environments/${f.scope.environmentId}/mail/messages/${message.message_id}`,
      content = await gateway.fetch(path, { headers: { authorization: `Bearer ${f.key}` } });
    expect(content.status).toBe(200);
    expect(await content.json()).toMatchObject({
      id: message.message_id,
      to: [`chosen@${f.domain}`],
      subject: "transient subject",
    });
    const attachment = await gateway.fetch(path + "/attachments/attachment_1", {
      headers: { authorization: `Bearer ${f.key}` },
    });
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe("ABC");
    const sync = await gateway.fetch("https://gateway/sync");
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({
      billing: { billed: 1, failed: 0 },
      delivery: { attempted: 1, failed: 0 },
      warnings: { periods: 0 },
    });
    expect(await (await customer.fetch("https://receiver.example.com/diagnostic")).json()).toEqual([
      message.message_id,
    ]);
    const warningTenant = await gatewayFixture(control);
    const warningOrg = warningTenant.project.organizationId,
      warningNow = new Date().toISOString(),
      ownerId = "user_notice_owner";
    await db
      .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
      .bind(warningOrg, storedTimestamp(warningNow))
      .run();
    await db.batch(ensureAccount(db, { organizationId: warningOrg, now: warningNow }).statements);
    await db
      .prepare(
        "UPDATE credit_account SET monthly_micros=0,monthly_ends_at='2099-01-01T00:00:00.000000Z',exhausted_at=? WHERE organization_id=?",
      )
      .bind(storedTimestamp(warningNow), warningOrg)
      .run();
    await (
      await mf.getWorker("owners")
    ).fetch("https://owners/fixture", {
      method: "POST",
      body: JSON.stringify({ organizationId: warningOrg, userId: ownerId }),
    });
    const notified = await gateway.fetch("https://gateway/sync");
    expect(notified.status).toBe(200);
    expect(await notified.json()).toMatchObject({
      warnings: { periods: 1, accepted: 1, unresolved: 0 },
    });
    // The episode is marked warned; the warning charges nothing.
    expect(
      await db
        .prepare(
          "SELECT warned_for_exhausted_at=exhausted_at warned FROM credit_account WHERE organization_id=?",
        )
        .bind(warningOrg)
        .first(),
    ).toEqual({ warned: 1 });
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM credit_log WHERE organization_id=?")
        .bind(warningOrg)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      ((await (await gateway.fetch("https://gateway/sync")).json()) as { warnings: unknown })
        .warnings,
    ).toMatchObject({ periods: 0 });
    expect(
      (
        await gateway.fetch(path, {
          headers: { authorization: `Bearer ${f.key}`, "x-mode": "wrong" },
        })
      ).status,
    ).toBe(503);
  } finally {
    await mf.dispose();
  }
}, 240000);
