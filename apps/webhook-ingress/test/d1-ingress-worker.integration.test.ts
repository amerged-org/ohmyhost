import "../../control-store/src/cloudflare-workers.d.ts";
import { createHash, createHmac } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { newUlid } from "../../control-store/src/catalog/common.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { createControlStore } from "../../control-store/src/store.js";
import { migrate, activateTestCore } from "../../control-store/test/support/control-d1.js";
import { createD1WebhookInboxes, requireIngressRuntime } from "../src/d1-inbox.js";
import type { GithubWebhookInboxRecord } from "../src/index.js";
import { parseUlid } from "@ohmyhost/platform";

// Direct adapter replays use the same production entrypoint on the real D1 fixture for native V8 coverage.
// The independently bundled workerd path below retains the real cloudflare:workers base and service binding.
const entrypointState = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = entrypointState.env;
  },
}));

const SECRET = "fixture-global-ingress-secret";
const EXTRA_SECRET = "fixture-global-ingress-additional-secret";
const STRIPE_SECRET = "whsec_fixture-global-inbox";
const at = new Date().toISOString();
const bundle = async (contents: string, directory: URL) => {
  const output = await build({
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
        name: "node-built-ins",
        setup(builder) {
          builder.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
            const name = args.path.replace(/^node:/, "");
            if (!builtinModules.includes(name) && !builtinModules.includes(`node:${name}`)) return;
            return args.kind === "require-call"
              ? { path: name, namespace: "built-in" }
              : { path: `node:${name}`, external: true };
          });
          builder.onLoad({ filter: /.*/, namespace: "built-in" }, (args) => ({
            contents: `import value from ${JSON.stringify(`node:${args.path}`)}; module.exports=value;`,
            loader: "js",
          }));
        },
      },
    ],
  });
  return output.outputFiles[0]?.text ?? "";
};
interface Runtime {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(input: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}
const WORKER = `
import {createWorkosWebhookWorkerEntrypoint} from './src/worker-main.ts';
import {createUlidFactory,SystemEntropy} from '@ohmyhost/platform';
let lost=false;
const actual=createWorkosWebhookWorkerEntrypoint({
 clockFactory:()=>({now:()=>new Date(${JSON.stringify(at)})}),
 eventIdsFactory:clock=>createUlidFactory({clock,entropy:new SystemEntropy()}),
});
export default {async fetch(request,env){
 const url=new URL(request.url);
 const mode=url.searchParams.get('fixture'); url.search='';
 let bindings=env;
 if(mode==='missing') bindings={...env,CONTROL_RUNTIME:undefined};
 if(mode==='forbidden') bindings={...env,CONTROL_CORE:{}};
 if(mode==='malformed') bindings={...env,CONTROL_RUNTIME:{recordWorkosWebhook:async()=>null}};
 if(mode==='lost') bindings={...env,CONTROL_RUNTIME:{
  recordWorkosWebhook:async input=>{const result=await env.CONTROL_RUNTIME.recordWorkosWebhook(input);if(!lost){lost=true;throw new Error('response lost after commit');}return result;},
 }};
 return actual.fetch(new Request(url,request),bindings);
}};
`;
const request = (
  provider: string,
  body: string,
  fixture?: string,
  invalid = false,
  secret = SECRET,
): [string, RequestInit] => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "workos") {
    const timestamp = Date.parse(at);
    headers["workos-signature"] =
      `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  } else if (provider === "github") {
    headers["x-github-delivery"] = "123e4567-e89b-42d3-a456-426614174000";
    headers["x-github-event"] = "push";
    headers["x-hub-signature-256"] =
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  } else if (provider === "stripe") {
    const timestamp = Math.floor(Date.now() / 1000);
    headers["stripe-signature"] =
      `t=${timestamp},v1=${createHmac("sha256", STRIPE_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;
  }
  if (invalid)
    for (const key of Object.keys(headers).filter((key) => key.includes("signature")))
      headers[key] = "invalid";
  return [
    `https://ingress.test/webhooks/${provider}${fixture ? `?fixture=${fixture}` : ""}`,
    { method: "POST", headers, body },
  ];
};
const workos = (
  id: string,
  event = "organization.updated",
  data: Record<string, unknown> = { id: "org_global_ingress", name: "must-not-be-stored" },
) => JSON.stringify({ id, event, created_at: at, data });

it("runs signed actual ingress through the dedicated Core capability with global identity and atomic auth effects", async () => {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(
    createRequire(manifest).resolve("wrangler/package.json"),
  )("miniflare") as {
    Miniflare: new (options: unknown) => Runtime;
    convertV4MiniflareOptions(options: unknown): unknown;
  };
  const [control, consumer] = await Promise.all([
    bundle(
      `export {ControlRuntime,WebhookIngressRuntime,WorkosRuntime} from './src/worker-main.ts';export default {fetch(){return new Response('private')}}`,
      new URL("../../control-store/", import.meta.url),
    ),
    bundle(WORKER, new URL("../", import.meta.url)),
  ]);
  const runtime = new Miniflare(
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
          name: "ingress",
          modules: true,
          script: consumer,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: {
            CONTROL_RUNTIME: { name: "control", entrypoint: "WebhookIngressRuntime" },
          },
          bindings: {
            WORKOS_WEBHOOK_SECRET: SECRET,
            GITHUB_WEBHOOK_SECRET: SECRET,
            WORKOS_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([
              { secret: EXTRA_SECRET, expiresAt: new Date(Date.parse(at) + 60_000).toISOString() },
            ]),
            GITHUB_WEBHOOK_ADDITIONAL_SECRETS_JSON: JSON.stringify([
              { secret: EXTRA_SECRET, expiresAt: new Date(Date.parse(at) + 60_000).toISOString() },
            ]),
            STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
            STRIPE_ACCOUNT_ID: "acct_global",
            STRIPE_MODE: "test",
          },
        },
        {
          name: "ordinary",
          modules: true,
          script: `export default {async fetch(request,env){try{return Response.json(await env.CONTROL_RUNTIME[request.headers.get('method')](await request.json()))}catch(error){return Response.json({error:String(error.message)},{status:503})}}}`,
          compatibilityDate: "2026-08-24",
          serviceBindings: { CONTROL_RUNTIME: { name: "control", entrypoint: "ControlRuntime" } },
        },
      ],
    }),
  );
  try {
    const db = (await runtime.getD1Database("CONTROL_CORE", "control")) as D1Database;
    await migrate(db, "core");
    const unserved = await runtime.getWorker("ingress");
    expect(
      (await unserved.fetch(...request("workos", workos("evt_before_activation")))).status,
    ).toBe(503);
    expect((await db.prepare("SELECT 1 FROM webhook_inbox").all()).results).toEqual([]);
    await activateTestCore(db);
    const store = createControlStore({ CONTROL_CORE: db });
    const worker = await runtime.getWorker("ingress");
    const rows = async (sql: string, ...values: unknown[]) =>
      (
        await db
          .prepare(sql)
          .bind(...values)
          .all()
      ).results;
    const body = workos("evt_ingress");
    expect((await worker.fetch(...request("workos", body, undefined, true))).status).toBe(401);
    expect(await rows("SELECT 1 FROM webhook_inbox")).toEqual([]);
    for (const fixture of ["missing", "forbidden", "malformed"])
      expect((await worker.fetch(...request("workos", body, fixture))).status).toBe(503);
    expect((await worker.fetch(...request("resend", "{}"))).status).toBe(503);
    expect((await worker.fetch(...request("workos", body))).status).toBe(200);
    const duplicate = await worker.fetch(...request("workos", body));
    expect(await duplicate.json()).toEqual({ accepted: true, duplicate: true });
    const newKeyDuplicate = await worker.fetch(
      ...request("workos", body, undefined, false, EXTRA_SECRET),
    );
    expect(newKeyDuplicate.status).toBe(200);
    expect(await newKeyDuplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(
      (await worker.fetch(...request("workos", `${body}\n`, undefined, false, EXTRA_SECRET)))
        .status,
    ).toBe(409);
    expect(
      await rows(
        "SELECT 1 FROM webhook_inbox WHERE provider='workos' AND external_event_id='evt_ingress'",
      ),
    ).toHaveLength(1);
    expect(
      (
        await worker.fetch(
          ...request("workos", workos("evt_ingress", "organization.updated", { id: "org_other" })),
        )
      ).status,
    ).toBe(409);
    const auth = workos("evt_session", "session.revoked", {
      id: "session_ingress",
      user_id: "user_ingress",
      ip_address: "must-not-be-stored",
    });
    expect((await worker.fetch(...request("workos", auth, "lost"))).status).toBe(503);
    expect((await worker.fetch(...request("workos", auth))).status).toBe(200);
    expect(
      await rows(
        "SELECT state,attempt_count,max_attempts,organization_id FROM webhook_inbox WHERE external_event_id='evt_session'",
      ),
    ).toEqual([
      { state: "acknowledged", attempt_count: 0, max_attempts: 1, organization_id: null },
    ]);
    expect(
      await rows("SELECT resource_id FROM revocations WHERE source_event_id='evt_session'"),
    ).toEqual([{ resource_id: "session_ingress" }]);
    const barrier = workos("evt_membership", "organization_membership.updated", {
      id: "membership_ingress",
      organization_id: "org_global_ingress",
      user_id: "user_ingress",
      status: "active",
      role: { slug: "untrusted" },
    });
    expect((await worker.fetch(...request("workos", barrier))).status).toBe(200);
    expect(
      await rows(
        "SELECT source_event_id FROM pending_membership_barriers WHERE workos_organization_id='org_global_ingress'",
      ),
    ).toEqual([{ source_event_id: "evt_membership" }]);
    // A source-auth identity conflict rolls the new raw inbox fact back as well.
    const conflict = workos("evt_auth_conflict", "session.revoked", {
      id: "session_another",
      user_id: "user_ingress",
    });
    await store.identity.recordTerminalRevocation({
      kind: "session",
      sessionId: "session_reserved",
      workosUserId: "user_ingress",
      sourceEventId: "evt_auth_conflict",
      effectiveAt: at,
    });
    expect((await worker.fetch(...request("workos", conflict))).status).toBe(503);
    expect(
      await rows("SELECT 1 FROM webhook_inbox WHERE external_event_id='evt_auth_conflict'"),
    ).toEqual([]);
    const github = JSON.stringify({
      installation: { id: 123 },
      repository: { id: 456, full_name: "acme/widget" },
      ref: "refs/heads/main",
      deleted: false,
      before: "1".repeat(40),
      after: "2".repeat(40),
      sender: { token: "must-not-be-stored" },
    });
    expect((await worker.fetch(...request("github", github))).status).toBe(202);
    const githubDuplicate = await worker.fetch(
      ...request("github", github, undefined, false, EXTRA_SECRET),
    );
    expect(githubDuplicate.status).toBe(200);
    expect(await githubDuplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(
      (await worker.fetch(...request("github", `${github}\n`, undefined, false, EXTRA_SECRET)))
        .status,
    ).toBe(409);
    expect(await rows("SELECT 1 FROM webhook_inbox WHERE provider='github'")).toHaveLength(1);
    const stripe = JSON.stringify({
      id: "evt_stripe",
      type: "invoice.paid",
      livemode: false,
      account: "acct_global",
      data: { object: { id: "in_global", customer: "must-not-be-stored" } },
    });
    expect((await worker.fetch(...request("stripe", stripe))).status).toBe(200);
    const stripeDuplicate = JSON.stringify({
      id: "evt_stripe",
      type: "invoice.paid",
      livemode: false,
      account: "acct_global",
      data: { object: { id: "in_global", customer: "different-unpersisted-value" } },
    });
    expect(await (await worker.fetch(...request("stripe", stripeDuplicate))).json()).toEqual({
      accepted: true,
      duplicate: true,
    });
    const facts = await rows("SELECT * FROM webhook_inbox ORDER BY inbox_event_id");
    expect(facts).toHaveLength(5);
    expect(JSON.stringify(facts)).not.toContain("must-not-be-stored");
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(facts.every((row) => row["organization_id"] === null)).toBe(true);
    expect(await rows("SELECT 1 FROM organizations")).toEqual([]);
    expect(await rows("SELECT 1 FROM inbox_unrouted")).toEqual([]);
    const entry = await import("../../control-store/src/worker-main.js");
    entrypointState.env = { CONTROL_CORE: db };
    const localRuntime = new (entry.WebhookIngressRuntime as unknown as new () => InstanceType<
      typeof entry.WebhookIngressRuntime
    >)();
    const direct = createD1WebhookInboxes(requireIngressRuntime({ CONTROL_RUNTIME: localRuntime }));
    for (const row of facts) {
      const receivedAt = String(row["received_at"]).replace(/000Z$/u, "Z");
      const common = {
        inboxEventId: row["inbox_event_id"] as GithubWebhookInboxRecord["inboxEventId"],
        externalEventId: row["external_event_id"] as string,
        eventType: row["event_type"] as string,
        payload: JSON.parse(String(row["payload"])) as Record<string, unknown>,
        bodyDigest: Buffer.from(row["body_sha256"] as number[]),
        receivedAt,
        maxAttempts: row["max_attempts"] as number,
      };
      if (row["provider"] === "workos") {
        const projection =
          row["external_event_id"] === "evt_session"
            ? {
                kind: "session-revocation" as const,
                sessionId: "session_ingress",
                workosUserId: "user_ingress",
                sourceEventId: "evt_session",
                effectiveAt: at,
              }
            : row["external_event_id"] === "evt_membership"
              ? {
                  kind: "membership-barrier" as const,
                  workosOrganizationId: "org_global_ingress",
                  workosUserId: "user_ingress",
                  sourceEventId: "evt_membership",
                  eventCreatedAt: at,
                }
              : undefined;
        const record = {
          ...common,
          signatureTimestamp: String(row["signature_timestamp"]).replace(/000Z$/u, "Z"),
        };
        expect(await direct.workos.record(record, projection)).toBe("existing");
        await expect(
          direct.workos.record({ ...record, bodyDigest: new Uint8Array(32) }, projection),
        ).rejects.toMatchObject({ code: "webhook_event_identity_conflict" });
      } else if (row["provider"] === "github") {
        const record = { ...common, eventType: "push" as const };
        expect(await direct.github.record(record, new AbortController().signal)).toBe("existing");
        await expect(
          direct.github.record(
            { ...record, bodyDigest: new Uint8Array(32) },
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: "webhook_event_identity_conflict" });
      } else {
        const record = {
          inboxEventId: common.inboxEventId,
          event: JSON.parse(String(row["payload"])),
          receivedAt,
        };
        expect(await direct.stripe.record(record)).toBe("existing");
        await expect(
          direct.stripe.record({ ...record, event: { ...record.event, objectId: "other_object" } }),
        ).rejects.toThrow("stripe_inbox_identity_conflict");
      }
    }
    // Once mapped, ingress opens the exact membership barrier in the SAME batch as the global fact.
    const organizationId = newUlid();
    await store.identity.applyOrganizationSnapshot({
      organizationId,
      workosOrganizationId: "org_global_ingress",
      state: "active",
      snapshotDigest: "ab".repeat(32),
      snapshotFetchedAt: at,
      synchronizedAt: at,
      triggerEventId: "evt_snapshot",
      memberships: [],
      auditEventId: newUlid(),
    });
    const mapped = workos("evt_mapped_membership", "organization_membership.updated", {
      id: "membership_mapped",
      organization_id: "org_global_ingress",
      user_id: "user_mapped",
      status: "active",
    });
    expect((await worker.fetch(...request("workos", mapped))).status).toBe(200);
    expect(
      await rows(
        "SELECT source_event_id FROM workos_membership_sync_barriers WHERE organization_id=? AND workos_user_id='user_mapped'",
        organizationId,
      ),
    ).toEqual([{ source_event_id: "evt_mapped_membership" }]);
    expect(
      await direct.workos.record(
        {
          inboxEventId: parseUlid(newUlid()),
          externalEventId: "evt_mapped_membership",
          eventType: "organization_membership.updated",
          payload: {
            schemaVersion: "workos.organization-trigger.v1",
            workosOrganizationId: "org_global_ingress",
          },
          bodyDigest: createHash("sha256").update(mapped).digest(),
          receivedAt: at,
          signatureTimestamp: at,
          maxAttempts: 10,
        },
        {
          kind: "membership-barrier",
          workosOrganizationId: "org_global_ingress",
          workosUserId: "user_mapped",
          sourceEventId: "evt_mapped_membership",
          eventCreatedAt: at,
        },
      ),
    ).toBe("existing");
    const ambiguous = workos("evt_mapped_ambiguous", "organization_membership.updated", {
      id: "membership_ambiguous",
      organization_id: "org_global_ingress",
      user_id: "user_mapped",
      status: "active",
    });
    expect((await worker.fetch(...request("workos", ambiguous))).status).toBe(503);
    expect(
      await rows("SELECT 1 FROM webhook_inbox WHERE external_event_id='evt_mapped_ambiguous'"),
    ).toEqual([]);
    expect(
      (
        await worker.fetch(
          ...request("workos", workos("evt_user_deleted", "user.deleted", { id: "user_other" })),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          ...request(
            "workos",
            workos("evt_org_deleted", "organization.deleted", { id: "org_global_ingress" }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await rows(
        "SELECT kind FROM revocations WHERE source_event_id IN ('evt_user_deleted','evt_org_deleted') ORDER BY kind",
      ),
    ).toEqual([{ kind: "organization" }, { kind: "user" }]);
    // The ordinary capability cannot record globally or drain another scope by replaying a known token.
    const ordinary = await runtime.getWorker("ordinary");
    const call = (method: string, input: unknown) =>
      ordinary.fetch("https://ordinary.test/", {
        method: "POST",
        headers: { method },
        body: JSON.stringify(input),
      });
    expect((await call("recordInboxEvent", {})).status).toBe(503);
    expect(
      (
        await call("claimInboxEvent", {
          shardId: 0,
          provider: "workos",
          claimId: newUlid(),
          claimedAt: at,
          leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
        })
      ).status,
    ).toBe(503);
    expect(
      (await call("findExpiredFinalInboxClaim", { shardId: 0, provider: "workos", observedAt: at }))
        .status,
    ).toBe(503);
    // Routing metadata scopes the ordinary API; a known global claim token cannot reveal or mutate another org.
    const foreign = newUlid(),
      token = newUlid();
    const githubId = facts.find((row) => row["provider"] === "github")?.["inbox_event_id"];
    await db
      .prepare("UPDATE webhook_inbox SET organization_id=?1 WHERE inbox_event_id=?2")
      .bind(organizationId, githubId)
      .run();
    const scoped = {
      organizationId,
      provider: "github",
      claimId: token,
      claimedAt: at,
      leaseExpiresAt: new Date(Date.parse(at) + 60_000).toISOString(),
    };
    const held = await call("claimInboxEvent", scoped);
    expect(await held.json()).toMatchObject({ inboxEventId: githubId, attemptNumber: 1 });
    expect(
      await (await call("claimInboxEvent", { ...scoped, organizationId: foreign })).json(),
    ).toBeNull();
    expect(
      await (await call("claimInboxEvent", { ...scoped, provider: "workos" })).json(),
    ).toBeNull();
    expect(
      await rows(
        "SELECT attempt_count,claim_id FROM webhook_inbox WHERE inbox_event_id=?",
        githubId,
      ),
    ).toEqual([{ attempt_count: 1, claim_id: token }]);
    expect(
      await (
        await call("findExpiredFinalInboxClaim", {
          organizationId: foreign,
          provider: "github",
          observedAt: new Date(Date.parse(at) + 120_000).toISOString(),
        })
      ).json(),
    ).toBeNull();
    expect(createHash("sha256").update(github).digest("hex")).toBe(
      Buffer.from(
        facts.find((row) => row["provider"] === "github")?.["body_sha256"] as number[],
      ).toString("hex"),
    );
  } finally {
    await runtime.dispose();
  }
}, 120_000);
