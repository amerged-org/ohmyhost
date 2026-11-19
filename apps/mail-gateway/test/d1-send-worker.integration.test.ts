import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
const root = fileURLToPath(new URL("../../../", import.meta.url));
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
      js: 'import {createRequire as __mailRequire} from "node:module";const require=__mailRequire("/fixture.js");',
    },
    plugins: [
      {
        name: "builtins",
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
  const file = result.outputFiles[0];
  if (!file) throw new Error("Missing Worker bundle");
  return file.text;
}
it("sends through actual Gateway/Core named RPC with original cipher and financial hold, and rejects missing or wrong Core bindings before provider I/O", async () => {
  const require = createRequire(new URL("../../control-store/package.json", import.meta.url)),
    { Miniflare, convertV4MiniflareOptions } = createRequire(
      require.resolve("wrangler/package.json"),
    )("miniflare") as {
      convertV4MiniflareOptions(value: unknown): unknown;
      Miniflare: new (value: unknown) => {
        getD1Database(name: string, worker: string): Promise<unknown>;
        getWorker(
          name: string,
        ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
        dispose(): Promise<void>;
      };
    };
  const [coreScript, gatewayScript] = await Promise.all([
    bundle(
      'export {MailSendRuntime,MailInfrastructureRuntime,WebhookIngressRuntime} from "./apps/control-store/src/worker-main.ts";export default {fetch(){return new Response("private");}};',
    ),
    bundle(`import {sendResendRequest,InfrastructureAlertsService} from "./apps/mail-gateway/src/resend-worker.ts";
 let calls=0,scenario="accepted",expectedKey="",keys=[];globalThis.fetch=async(input,init)=>{const url=typeof input==="string"?input:input.url;if(url!=="https://api.resend.com/emails"||init.method!=="POST"||init.headers.authorization!=="Bearer "+expectedKey)throw Error("Unexpected external provider call");calls++;keys.push(init.headers["idempotency-key"]);if(scenario==="uncertain")return Response.json({message:"uncertain"},{status:500});if(scenario==="refused")return Response.json({message:"refused"},{status:422});return Response.json({id:"message_"+calls});};
 export default {async fetch(request,env,ctx){if(new URL(request.url).pathname==="/diagnostic")return Response.json({calls,keys});const mode=request.headers.get("x-fixture-mode"),actual={...env};if(mode==="missing-method")actual.MAIL_SEND_RUNTIME=env.WRONG_RUNTIME;if(mode==="missing-binding")actual.MAIL_SEND_RUNTIME=undefined;scenario=request.headers.get("x-fixture-provider")??"accepted";expectedKey=request.headers.get("x-fixture-key");if(new URL(request.url).pathname==="/infra"){if(mode==="missing-method")actual.MAIL_INFRASTRUCTURE_RUNTIME=env.WRONG_RUNTIME;if(mode==="missing-binding")actual.MAIL_INFRASTRUCTURE_RUNTIME=undefined;scenario="accepted";expectedKey="re_fixture_platform";return new InfrastructureAlertsService(ctx,actual).fetch(request);}return sendResendRequest(request,actual);}};`),
  ]);
  const common = {
      modules: true,
      compatibilityDate: "2026-08-24",
      compatibilityFlags: ["nodejs_compat"],
    },
    mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            ...common,
            name: "core",
            script: coreScript,
            d1Databases: { CONTROL_CORE: "mail-core" },
          },
          {
            ...common,
            name: "gateway",
            script: gatewayScript,
            bindings: {
              RUNTIME_CONFIGURATION_STATE: "configured",
              MAIL_DOMAIN_KEY_ENCRYPTION_KEY_BASE64: MAIL_FIXTURE_CIPHER,
              PGCF_CAPACITY_WEBHOOK_SECRET: "b".repeat(43),
              PGCF_CAPACITY_ALERT_RECIPIENT: "operator@example.net",
              RESEND_PLATFORM_WARNING_API_KEY: "re_fixture_platform",
              PLATFORM_ENVIRONMENT: "development",
            },
            serviceBindings: {
              MAIL_SEND_RUNTIME: { name: "core", entrypoint: "MailSendRuntime" },
              MAIL_INFRASTRUCTURE_RUNTIME: {
                name: "core",
                entrypoint: "MailInfrastructureRuntime",
              },
              WRONG_RUNTIME: { name: "core", entrypoint: "WebhookIngressRuntime" },
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
    };
    const f = await mailFixture(control);
    await fundMailFixture(control, f);
    const gateway = await mf.getWorker("gateway");
    const send = (key: string, mode = "d1", provider = "accepted", text = "private body") =>
      gateway.fetch("https://mail.test/v1/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${f.key}`,
          "idempotency-key": key,
          "content-type": "application/json",
          "x-fixture-mode": mode,
          "x-fixture-provider": provider,
          "x-fixture-key": f.providerKey,
        },
        body: JSON.stringify({
          project_id: f.scope.projectId,
          to: "recipient@example.net",
          subject: "private subject",
          text,
        }),
      });
    const first = await send("normal");
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as {
      state: string;
      request_id: string;
      message_id: string;
    };
    expect(accepted.state).toBe("accepted");
    expect(await (await send("normal")).json()).toEqual(accepted);
    expect((await send("normal", "d1", "accepted", "changed")).status).toBe(409);
    const pending = await send("uncertain", "d1", "uncertain");
    expect(pending.status).toBe(202);
    const unresolved = (await pending.json()) as { state: string; request_id: string };
    expect(unresolved.state).toBe("uncertain");
    const retried = (await (await send("uncertain")).json()) as {
      state: string;
      request_id: string;
    };
    expect(retried).toMatchObject({ state: "accepted", request_id: unresolved.request_id });
    expect((await send("refused", "d1", "refused")).status).toBe(502);
    for (const mode of ["missing-method", "missing-binding"])
      expect((await send(mode, mode)).status).toBe(503);
    const diagnostic = (await (await gateway.fetch("https://mail.test/diagnostic")).json()) as {
      calls: number;
      keys: string[];
    };
    expect(diagnostic).toMatchObject({ calls: 4 });
    expect(diagnostic.keys[1]).toBe(diagnostic.keys[2]);
    const alert = {
        version: 1,
        event_id: crypto.randomUUID(),
        kind: "regional_ram_warning",
        region_id: "eu-1",
        occurred_at: new Date().toISOString(),
        regional_ram_utilization_ppm: 750000,
        allocated_nodes: 3,
        max_nodes: 3,
      },
      infra = (mode = "d1") =>
        gateway.fetch("https://mail.test/infra", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"b".repeat(43)}`,
            "content-type": "application/json",
            "idempotency-key": alert.event_id,
            "x-fixture-mode": mode,
          },
          body: JSON.stringify(alert),
        });
    expect((await infra()).status).toBe(200);
    expect((await infra()).status).toBe(200);
    for (const mode of ["missing-method", "missing-binding"])
      expect((await infra(mode)).status).toBe(503);
    expect(await (await gateway.fetch("https://mail.test/diagnostic")).json()).toMatchObject({
      calls: 5,
    });
    const alertMetadata = JSON.stringify(
      (await db.prepare("SELECT * FROM infrastructure_alert_receipts").all()).results,
    );
    expect(alertMetadata).not.toContain("operator@example.net");
    expect(alertMetadata).not.toContain("re_fixture_platform");

    // Each claimed send is charged once at its claim; the refused one is given back.
    expect(
      await db.prepare("SELECT COUNT(*) n FROM credit_log WHERE key LIKE 'mail:%'").first(),
    ).toEqual({ n: 3 });
    expect(
      await db.prepare("SELECT COUNT(*) n FROM credit_log WHERE key LIKE 'mailrefund:%'").first(),
    ).toEqual({ n: 1 });
    const metadata = JSON.stringify(
      (await db.prepare("SELECT * FROM mail_send_requests").all()).results,
    );
    for (const secret of [
      "private body",
      "private subject",
      "recipient@example.net",
      f.providerKey,
      f.key,
    ])
      expect(metadata).not.toContain(secret);
  } finally {
    await mf.dispose();
  }
}, 240000);
