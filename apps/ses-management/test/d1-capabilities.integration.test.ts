import { readFile } from "node:fs/promises";
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
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import { seedReadyMailDomain } from "../../control-store/test/support/mail-domain.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
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
  if (!file) throw new Error("Missing capability Worker bundle");
  return file.text;
}
it("runs the original provider capability writer through actual production Core RPC, retains ambiguous leases and refuses wrong/partial authority before credentials/provider", async () => {
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
    },
    coreScript = await readFile(
      new URL("../../control-store/dist/worker-bundle/worker-main.js", import.meta.url),
      "utf8",
    ),
    workerScript = await bundle(`import {WorkerEntrypoint} from "cloudflare:workers";
import {createD1WorkspaceMailCapabilityPersistence,syncWorkspaceMailCapabilities} from "./packages/database/src/index.ts";
import {createResendProvider} from "./packages/provider-resend/src/index.ts";
import {invokeD1ResendManagement} from "./apps/ses-management/src/d1-management-dispatch.ts";
let calls=[],keyReads=0;
export class LostCapabilityReply extends WorkerEntrypoint{read(input){return this.env.CAP.read(input)}async claim(input){await this.env.CAP.claim(input);throw Error("transport reply lost")}confirm(input){return this.env.CAP.confirm(input)}release(input){return this.env.CAP.release(input)}}
export class MalformedCapabilityReply extends WorkerEntrypoint{read(){return {bad:true}}claim(){throw Error("must not reach claim")}confirm(){throw Error("must not reach confirm")}release(){throw Error("must not reach release")}}
export default{async fetch(request,env){const path=new URL(request.url).pathname;if(path==="/diagnostic")return Response.json({calls,keyReads});const input=await request.json(),mode=request.headers.get("x-fixture-mode")??"normal";
if(path==="/partial"){const actual={RUNTIME_CONFIGURATION_STATE:"configured",MAIL_CAPABILITY_RUNTIME:env.CAP};Object.defineProperty(actual,"RESEND_API_KEY",{get(){keyReads++;throw Error("KEY_FORBIDDEN")}});try{await invokeD1ResendManagement(actual,"get",input);return new Response("unexpected",{status:500})}catch{return new Response("refused",{status:503})}}
try{const raw=mode==="wrong"?env.WRONG:mode==="malformed"?env.BAD:mode==="lost"?env.LOST:env.CAP,persistence=await createD1WorkspaceMailCapabilityPersistence(raw);
const provider=createResendProvider({apiKey:"re_fixture_capability",fetch:async(url,init)=>{calls.push({url:String(url),method:init.method,body:JSON.parse(init.body),authorization:init.headers.authorization});if(mode==="provider-unknown")return Response.json({message:"uncertain"},{status:500});return Response.json({id:"provider_fixture"})}});
return Response.json(await syncWorkspaceMailCapabilities({persistence,provider,organizationId:input.organizationId,domainId:input.domainId,leaseToken:input.leaseToken,now:()=>new Date(input.now)}));}catch(error){return Response.json({code:error.message},{status:503})}}};`),
    common = {
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
            name: "caller",
            script: workerScript,
            serviceBindings: {
              CAP: { name: "core", entrypoint: "MailCapabilityRuntime" },
              WRONG: { name: "core", entrypoint: "MailSendRuntime" },
              LOST: { name: "caller", entrypoint: "LostCapabilityReply" },
              BAD: { name: "caller", entrypoint: "MalformedCapabilityReply" },
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
      project = await seedProject(control),
      f = await seedReadyMailDomain(control, project),
      caller = await mf.getWorker("caller"),
      input = {
        organizationId: f.scope.organizationId,
        domainId: f.domainId,
        leaseToken: newUlid(),
        now: new Date().toISOString(),
      },
      run = (mode: string, body = input, path = "/sync") =>
        caller.fetch(`https://mail.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-fixture-mode": mode },
          body: JSON.stringify(body),
        });
    expect((await run("normal")).status).toBe(200);
    expect(await (await caller.fetch("https://mail.test/diagnostic")).json()).toMatchObject({
      calls: [
        {
          method: "PATCH",
          body: { capabilities: { sending: "enabled", receiving: "enabled" } },
          authorization: "Bearer re_fixture_capability",
        },
      ],
      keyReads: 0,
    });
    for (const mode of ["wrong", "malformed"]) expect((await run(mode)).status).toBe(503);
    const unknown = { ...input, leaseToken: newUlid() };
    expect((await run("provider-unknown", unknown)).status).toBe(503);
    expect(
      (
        await db
          .prepare(
            "SELECT capabilities_lease_token token FROM workspace_mail_domains WHERE domain_id=?",
          )
          .bind(f.domainId)
          .first()
      )?.["token"],
    ).toBe(unknown.leaseToken);
    await db
      .prepare(
        "UPDATE workspace_mail_domains SET capabilities_lease_token=NULL,capabilities_lease_until=NULL WHERE domain_id=?",
      )
      .bind(f.domainId)
      .run();
    const lost = { ...input, leaseToken: newUlid() };
    expect((await run("lost", lost)).status).toBe(503);
    expect(
      (
        await db
          .prepare(
            "SELECT capabilities_lease_token token FROM workspace_mail_domains WHERE domain_id=?",
          )
          .bind(f.domainId)
          .first()
      )?.["token"],
    ).toBe(lost.leaseToken);
    // A caller that binds only one of the Core capabilities is refused before any credential is read.
    expect(
      (
        await run(
          "partial",
          {
            ...input,
            projectId: f.scope.projectId,
            environmentId: f.scope.environmentId,
          } as typeof input,
          "/partial",
        )
      ).status,
    ).toBe(503);
    const diagnostic = (await (await caller.fetch("https://mail.test/diagnostic")).json()) as {
      calls: unknown[];
      keyReads: number;
    };
    expect(diagnostic.calls).toHaveLength(2); // one settled request and one original ambiguous provider attempt; no invented retry
    expect(diagnostic).toMatchObject({ keyReads: 0 });
  } finally {
    await mf.dispose();
  }
}, 240000);
