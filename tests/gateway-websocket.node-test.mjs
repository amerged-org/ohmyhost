import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const project = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const origin = "https://calm-river-studio.dev.check.omh.st";
const clientOrigin = "https://browser.example.com";
const source = (name) =>
  fileURLToPath(new URL("../apps/wfp-dispatch/src/" + name, import.meta.url));
const browserSource = fileURLToPath(
  new URL("../packages/contracts/src/browser-capabilities.ts", import.meta.url),
);

async function gatewayHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-gateway-websocket-"));
  const gateway = await build({
    stdin: {
      contents: `import { createSharedGatewayWorker } from ${JSON.stringify(source("shared-gateway.ts"))};
        import { createProjectIsolatedGatewayWorker } from ${JSON.stringify(source("dispatch.ts"))};
        import { normalizeBrowserPolicy } from ${JSON.stringify(browserSource)};
        export default { async fetch(request, env) {
          const url=new URL(request.url), scope=url.searchParams.get("scope")??"shared", scenario=url.searchParams.get("scenario");
          const dev=scenario==="private-dev"; let dispatches=0;
          const target={organizationId:"01ARZ3NDEKTSV4RRFFQ69G5FAX",projectId:${JSON.stringify(project)},environmentId:"01ARZ3NDEKTSV4RRFFQ69G5FAY",environmentName:dev?"dev":"prod",handle:"calm-river-studio",hostname:new URL(${JSON.stringify(origin)}).hostname,publicOrigin:${JSON.stringify(origin)},targetDeploymentId:"01ARZ3NDEKTSV4RRFFQ69G5FAZ",targetScriptName:"p-01arz3ndektsv4rrffq69g5faw-prod-01arz3ndektsv4rrffq69g5faz",egressAllowedOrigins:[],devAccess:null,poweredBy:false,browserPolicy:normalizeBrowserPolicy({cors:{origins:[${JSON.stringify(clientOrigin)}],credentials:false}})};
          const dispatcher={get(script,args,options){
            if(options.limits.cpuMs!==50||options.limits.subRequests!==10||options.outbound.EGRESS_CONTEXT.projectId!==target.projectId)throw new Error("local_dispatch_scope_invalid");
            if(script!==(scope==="shared"?target.targetScriptName:"p-01arz3ndektsv4rrffq69g5faw-prod"))throw new Error("local_script_scope_invalid");
            return {async fetch(request){dispatches++;return env.CUSTOMER.fetch(request);}};
          }};
          let response;
          if(scope==="shared") response=await createSharedGatewayWorker({diagnosticSink:()=>{}}).fetch(request,{
            DISPATCHER:dispatcher,
            GATEWAY_ROUTING:{async resolve(input){return input.hostname===target.hostname?target:null;}},
            CREDIT_ADMISSION:{async read(input){
              if(input.projectId!==target.projectId||input.environmentId!==target.environmentId||input.organizationId!==target.organizationId)throw new Error("local_credit_scope_invalid");
              const now=new Date();return {organizationId:target.organizationId,projectId:target.projectId,environmentId:target.environmentId,allowed:scenario!=="credit-denied",paidAllowed:true,reason:scenario==="credit-denied"?"project_budget_exceeded":null,checkedAt:now.toISOString(),expiresAt:new Date(now.getTime()+900000).toISOString()};
            }},
            DEV_ACCESS:{async authorize(){return {authorized:false};},async redeem(){throw new Error("no_dev_redemption");}},
            DIAGNOSTIC_MARKER_SIGNING_KEY_BASE64:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
          });
          else response=await createProjectIsolatedGatewayWorker().fetch(request,{DISPATCHER:dispatcher,PROJECT_ID:target.projectId,PROJECT_HANDLE:target.handle,ENVIRONMENT_NAME:target.environmentName,PUBLIC_ORIGIN:target.publicOrigin});
          response.headers.set("x-local-dispatches",String(dispatches));return response;
        }};`,
      loader: "js",
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    },
    conditions: ["source"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
    write: false,
  });
  const customer = `export default {fetch(request){
    const url=new URL(request.url);
    if(url.searchParams.get("scenario")==="malformed")return new Response(null,{status:101});
    const headers=new Headers({upgrade:"websocket","x-app-proof":"preserved","x-ohmyhost-runtime":"edge-v1","access-control-allow-origin":${JSON.stringify(clientOrigin)},"access-control-allow-credentials":"true"});
    headers.append("set-cookie","app-session=host; Path=/; Secure; HttpOnly");
    headers.append("set-cookie","app-session=foreign; Domain=example.com; Path=/; Secure");
    headers.append("set-cookie","__Host-ohmyhost_dev_access=private; Path=/; Secure; HttpOnly");
    if(url.pathname==="/http"){headers.delete("upgrade");headers.set("content-type","text/plain; charset=utf-8");return new Response("ordinary UTF-8 ✓ response",{status:201,headers});}
    if(request.headers.get("origin")!==${JSON.stringify(clientOrigin)})return new Response("application origin denied",{status:403});
    const pair=new WebSocketPair();pair[1].accept();pair[1].addEventListener("message",event=>pair[1].send(event.data));
    pair[1].addEventListener("close",()=>{if(pair[1].readyState!==3)pair[1].close(1000,"closed");});
    return new Response(null,{status:101,headers,webSocket:pair[0]});
  }};`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: directory,
      cf: false,
      workers: [
        {
          name: "gateway",
          modules: [
            {
              type: "ESModule",
              path: join(directory, "gateway.mjs"),
              contents: gateway.outputFiles[0].text,
            },
          ],
          compatibilityDate: "2026-08-25",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { CUSTOMER: { name: "customer" } },
        },
        {
          name: "customer",
          modules: [
            { type: "ESModule", path: join(directory, "customer.mjs"), contents: customer },
          ],
          compatibilityDate: "2026-08-25",
        },
      ],
    }),
  );
  return {
    mf,
    async close() {
      await mf.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway_echo_timeout")), 2000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
  });
}
function securedHeaders(response, scope) {
  assert.equal(response.headers.get("x-app-proof"), "preserved");
  assert.equal(response.headers.get("x-ohmyhost-runtime"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.ok(response.headers.get("content-security-policy").includes("object-src 'none'"));
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    scope === "shared" ? clientOrigin : null,
  );
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
  assert.deepEqual(response.headers.getSetCookie(), ["app-session=host; Path=/; Secure; HttpOnly"]);
}
test("real Workerd preserves upgrade, echo and security headers through both gateway paths", async () => {
  const harness = await gatewayHarness();
  try {
    for (const scope of ["shared", "isolated"]) {
      const response = await harness.mf.dispatchFetch(origin + "/socket?scope=" + scope, {
        headers: { origin: clientOrigin, upgrade: "websocket" },
      });
      assert.equal(response.status, 101, scope);
      assert.ok(response.webSocket, scope);
      assert.equal(response.headers.get("upgrade"), "websocket");
      assert.equal(response.headers.get("x-local-dispatches"), "1");
      securedHeaders(response, scope);
      response.webSocket.accept();
      const message = nextMessage(response.webSocket);
      response.webSocket.send(scope + " real echo");
      assert.equal(await message, scope + " real echo");
      response.webSocket.close(1000, "proof_complete");
    }
  } finally {
    await harness.close();
  }
});
test("upgrades retain route, private Dev, credit and application authorization failures", async () => {
  const harness = await gatewayHarness();
  try {
    for (const scope of ["shared", "isolated"])
      for (const scenario of ["foreign-host", "private-dev", "malformed", "foreign-origin"]) {
        const host =
          scenario === "foreign-host"
            ? scope === "shared"
              ? "https://foreign.dev.check.omh.st"
              : "http://foreign.dev.check.omh.st"
            : origin;
        const response = await harness.mf.dispatchFetch(
          host + "/socket?scope=" + scope + "&scenario=" + scenario,
          {
            headers: {
              upgrade: "websocket",
              origin: scenario === "foreign-origin" ? "https://foreign.example.com" : clientOrigin,
            },
          },
        );
        assert.equal(
          response.status,
          scenario === "malformed"
            ? 502
            : scenario === "private-dev"
              ? 503
              : scenario === "foreign-origin"
                ? 403
                : 404,
          scope + " " + scenario,
        );
        assert.equal(response.webSocket, null);
        // The shared gateway refuses a foreign Origin on an upgrade before any dispatch.
        const refusedBeforeDispatch =
          ["foreign-host", "private-dev"].includes(scenario) ||
          (scope === "shared" && scenario === "foreign-origin");
        assert.equal(
          response.headers.get("x-local-dispatches"),
          refusedBeforeDispatch ? "0" : "1",
          scope + " " + scenario,
        );
      }
    const paused = await harness.mf.dispatchFetch(origin + "/socket?scenario=credit-denied", {
      headers: { origin: clientOrigin, upgrade: "websocket" },
    });
    assert.equal(paused.status, 402);
    assert.equal(paused.webSocket, null);
    assert.equal(paused.headers.get("x-local-dispatches"), "0");
  } finally {
    await harness.close();
  }
});
test("ordinary HTTP status, body, cookies and CORS retain both gateway contracts", async () => {
  const harness = await gatewayHarness();
  try {
    for (const scope of ["shared", "isolated"]) {
      const response = await harness.mf.dispatchFetch(origin + "/http?scope=" + scope, {
        headers: { origin: clientOrigin },
      });
      assert.equal(response.status, 201);
      assert.equal(response.webSocket, null);
      assert.equal(await response.text(), "ordinary UTF-8 ✓ response");
      securedHeaders(response, scope);
    }
  } finally {
    await harness.close();
  }
});
