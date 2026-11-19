/* global URL, setTimeout, Buffer, process, Response, fetch, Request */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createSharedGatewayWorker } from "../../../wfp-dispatch/dist/shared-gateway.js";
const localRequire = createRequire(new URL("../../package.json", import.meta.url));
const wranglerRequire = createRequire(localRequire.resolve("wrangler/package.json"));
const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare/package.json"));
const { Miniflare, convertV4MiniflareOptions } = miniflareRequire("miniflare");
const { WebSocketServer } = miniflareRequire("ws");
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
const execFile = promisify(execFileCallback);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coreMethods = [
  "resolveTokenHash",
  "authorizeRuntime",
  "getCleanupState",
  "recordStopped",
  "recordState",
  "recordAppliedSource",
  "recordBackup",
  "renewActivity",
  "reserveUsage",
  "closeUsage",
  "listBackupCleanup",
  "acknowledgeBackupCleanup",
  "claimExpiredBackup",
  "listCleanupCandidates",
  "claimScopeCleanup",
  "finishScopeCleanup",
  "resumeSuspended",
  "listPendingSources",
  "acknowledgeSource",
];
const bridgeSource = `import { WorkerEntrypoint } from 'cloudflare:workers';
function revive(value){if(Array.isArray(value))return value.map(revive);if(value&&typeof value==='object'){if(Object.keys(value).length===1&&typeof value.__w41bytes==='string'){const s=atob(value.__w41bytes);return Uint8Array.from(s,c=>c.charCodeAt(0))}for(const k of Object.keys(value))value[k]=revive(value[k]);}return value;}
async function call(env,service,method,input){const r=await env.NODE_BRIDGE.fetch('http://local.bridge/rpc',{method:'POST',body:JSON.stringify({service,method,input})});const result=await r.json();if(!result.ok)throw new Error(result.error||'local_bridge_failure');return revive(result.value);}
export class CoreBridge extends WorkerEntrypoint {${coreMethods.map((m) => `${m}(input){return call(this.env,'core','${m}',input);}`).join("")}}
export class SourceBridge extends WorkerEntrypoint {previewDiff(input){return call(this.env,'source','previewDiff',input)}}
export class SecretsBridge extends WorkerEntrypoint {readCustomerVariables(){return {}}}
export class ReporterBridge extends WorkerEntrypoint {}
export default {async fetch(request,env){const {method,input}=await request.json();if(!['wake','sourceChanged','fence'].includes(method))return new Response(null,{status:404});try{await env.EXECUTION[method](input);return Response.json({ok:true})}catch{return Response.json({ok:false,error:'execution_failed'},{status:500})}}};`;
function serialize(_key, value) {
  if (value instanceof Uint8Array) return { __w41bytes: Buffer.from(value).toString("base64") };
  if (value && value.type === "Buffer" && Array.isArray(value.data))
    return { __w41bytes: Buffer.from(value.data).toString("base64") };
  return value;
}

/** Actual bundled Worker + PreviewSandbox DO + SDK/R2 on local workerd. Core/source
 * methods cross a test-only RPC bridge to the real local D1/Git/SourceFetcher objects. */
export async function startLocalPreview({ core, source }) {
  if (process.env.PREVIEW_LOCAL_HMR !== "1") throw new Error("local_preview_fixture_only");
  const directory = await mkdtemp(path.join(tmpdir(), "omh-preview-workerd-"));
  let activeMiniflare;
  try {
    const dockerContext = process.env.PREVIEW_LOCAL_DOCKER_CONTEXT ?? "desktop-linux";
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(dockerContext))
      throw new Error("local_docker_context_invalid");
    const socket = (
      await execFile("docker", [
        "context",
        "inspect",
        dockerContext,
        "--format",
        "{{.Endpoints.docker.Host}}",
      ])
    ).stdout.trim();
    if (!socket.startsWith("unix://")) throw new Error("local_docker_socket_invalid");
    await execFile("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=preview.dev.omh.st",
      "-addext",
      "subjectAltName=DNS:*.preview.dev.omh.st",
      "-keyout",
      path.join(directory, "fixture.key"),
      "-out",
      path.join(directory, "fixture.crt"),
    ]);
    const observedErrors = [],
      events = [];
    const nodeBridge = async (request) => {
      try {
        const { service, method, input } = await request.json();
        if (
          !(service === "core" && coreMethods.includes(method)) &&
          !(service === "source" && method === "previewDiff")
        )
          throw new Error("local_bridge_refused");
        events.push(`${service}.${method}`);
        const object = service === "core" ? core : service === "source" ? source : null;
        if (!object || typeof object[method] !== "function")
          throw new Error(`local_missing_${service}_${method}`);
        const value = await object[method](input);
        return new Response(JSON.stringify({ ok: true, value }, serialize), {
          headers: { "content-type": "application/json" },
        });
      } catch {
        const message = "local_bridge_failure";
        observedErrors.push(message);
        return new Response(JSON.stringify({ ok: false, error: message }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
    };
    const mfOptions = convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      containerEngine: { localDocker: { socketPath: socket } },
      workers: [
        {
          name: "preview",
          compatibilityDate: "2026-11-11",
          compatibilityFlags: ["nodejs_compat"],
          modules: true,
          scriptPath: fileURLToPath(
            new URL("../../dist/worker-bundle/worker-main.js", import.meta.url),
          ),
          durableObjects: {
            PREVIEW_CONTAINERS: {
              className: "PreviewSandbox",
              useSQLite: true,
              container: {
                images: [{ name: "preview", image: "ohmyho-preview-runtime-native:local" }],
              },
            },
          },
          r2Buckets: ["BACKUP_BUCKET"],
          outboundService: async (request) => {
            const url = new URL(request.url);
            if (
              url.hostname === "api.cloudflare.com" &&
              url.pathname.endsWith("/containers/applications")
            )
              return Response.json({
                success: true,
                result: [
                  {
                    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    account_id: "00000000000000000000000000000000",
                    name: "ohmyho-live-preview-poc-private-fullstack",
                    scheduling_policy: "durable_object",
                    durable_objects: { namespace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
                  },
                ],
                result_info: {},
              });
            if (["registry.npmjs.org", "registry.yarnpkg.com"].includes(url.hostname))
              return fetch(request);
            return new Response(null, { status: 403 });
          },
          bindings: {
            PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
            CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
            CLOUDFLARE_PREVIEW_USAGE_TOKEN: "synthetic-local-only",
            PREVIEW_CONTAINER_APPLICATION_NAME: "ohmyho-live-preview-poc-private-fullstack",
          },
          serviceBindings: {
            PREVIEW_AUTHORITY: { name: "bridge", entrypoint: "CoreBridge" },
            PREVIEW_SOURCE: { name: "bridge", entrypoint: "SourceBridge" },
            PREVIEW_RUNTIME_SECRETS: { name: "bridge", entrypoint: "SecretsBridge" },
            PREVIEW_USAGE_REPORTER: { name: "bridge", entrypoint: "ReporterBridge" },
          },
        },
        {
          name: "bridge",
          compatibilityDate: "2026-11-11",
          compatibilityFlags: ["nodejs_compat"],
          modules: [{ type: "ESModule", path: "bridge.mjs", contents: bridgeSource }],
          serviceBindings: {
            NODE_BRIDGE: nodeBridge,
            EXECUTION: { name: "preview", entrypoint: "PreviewExecution" },
          },
        },
      ],
    });
    mfOptions.handleUncaughtError = (error) =>
      observedErrors.push(`workerd:${error?.name || "error"}`);
    const mf = new Miniflare(mfOptions);
    activeMiniflare = mf;
    await mf.ready;
    const bridge = await mf.getWorker("bridge");
    let origin = null,
      previewId = null;
    async function invoke(method, input) {
      const response = await bridge.fetch("http://local.bridge/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, input }),
      });
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error || "local_execution_failed");
    }
    const execution = {
      async wake(input) {
        events.push("wake_called");
        origin = input.publicOrigin;
        previewId = input.previewId;
        try {
          await invoke("wake", input);
          events.push("wake_returned");
        } catch (error) {
          observedErrors.push("wake:failed");
          throw error;
        }
      },
      async sourceChanged(input) {
        try {
          await invoke("sourceChanged", input);
        } catch (error) {
          observedErrors.push("source:failed");
          throw error;
        }
      },
      async fence(input) {
        await invoke("fence", input);
      },
    };
    const gateway = createSharedGatewayWorker();
    const dispatch = async (url, init = {}) =>
      gateway.fetch(new Request(url, init), {
        PREVIEW_HOST_SUFFIX: "preview.dev.omh.st",
        PREVIEW_RUNTIME: {
          fetch: async (request) => {
            try {
              const body = ["GET", "HEAD"].includes(request.method)
                ? undefined
                : new Uint8Array(await request.arrayBuffer());
              return await mf.dispatchFetch(request.url, {
                method: request.method,
                headers: Object.fromEntries(request.headers),
                redirect: "manual",
                ...(body ? { body } : {}),
              });
            } catch (error) {
              observedErrors.push("ingress:failed");
              throw error;
            }
          },
        },
      });
    const connections = new Set();
    const server = https.createServer(
      {
        key: await readFile(path.join(directory, "fixture.key")),
        cert: await readFile(path.join(directory, "fixture.crt")),
      },
      async (req, res) => {
        try {
          const url = `https://${req.headers.host}${req.url}`;
          const body = ["GET", "HEAD"].includes(req.method) ? undefined : Readable.toWeb(req);
          const init = {
            method: req.method,
            headers: req.headers,
            redirect: "manual",
            ...(body ? { body, duplex: "half" } : {}),
          };
          const response = await dispatch(url, init);
          const headers = Object.fromEntries(response.headers.entries());
          res.writeHead(response.status, headers);
          if (response.body) Readable.fromWeb(response.body).pipe(res);
          else res.end();
        } catch {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        }
      },
    );
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", async (req, socket, head) => {
      try {
        const response = await dispatch(`https://${req.headers.host}${req.url}`, {
          headers: req.headers,
        });
        const upstream = response.webSocket;
        if (response.status !== 101 || !upstream) {
          socket.destroy();
          return;
        }
        upstream.accept();
        wss.handleUpgrade(req, socket, head, (client) => {
          connections.add(client);
          client.on("close", () => connections.delete(client));
          client.on("message", (data) => {
            try {
              upstream.send(data);
            } catch {
              client.close();
            }
          });
          client.on("close", () => {
            try {
              upstream.close();
            } catch {
              // The upstream socket may already be closed.
            }
          });
          client.on("error", () => {
            try {
              upstream.close(1011);
            } catch {
              // The upstream socket may already be closed.
            }
          });
          upstream.addEventListener("message", (event) => {
            if (client.readyState === 1) client.send(event.data);
          });
          upstream.addEventListener("close", () => client.close());
          upstream.addEventListener("error", () => client.close());
        });
      } catch {
        socket.destroy();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    return {
      execution,
      async actorIdentity() {
        if (!previewId) throw new Error("local_preview_not_started");
        const scope = await core.getCleanupState({ previewId });
        const namespace = await mf.getDurableObjectNamespace("PREVIEW_CONTAINERS", "preview");
        const actorId = await namespace.idFromName(previewId).toString();
        if (!/^[a-f0-9]{64}$/.test(actorId)) throw new Error("local_actor_id_invalid");
        const { stdout } = await execFile("docker", [
          "--context",
          dockerContext,
          "ps",
          "--filter",
          `name=workerd-preview-PreviewSandbox-${actorId}`,
          "--format",
          "{{.ID}} {{.Names}}",
        ]);
        const name = `workerd-preview-PreviewSandbox-${actorId}`;
        const rows = stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter((parts) => parts[1] === name);
        if (!scope || rows.length !== 1 || !/^[a-f0-9]{12,64}$/.test(rows[0][0]))
          throw new Error("local_container_identity_unavailable");
        return { runtimeGeneration: scope.runtimeGeneration, actorId, containerId: rows[0][0] };
      },
      get browserUrl() {
        return origin;
      },
      chromiumFlags: [
        `--host-resolver-rules=MAP *.preview.dev.omh.st 127.0.0.1:${port}`,
        "--proxy-server=direct://",
        "--proxy-bypass-list=*",
        "--ignore-certificate-errors",
      ],
      async waitReady(timeout = 120000) {
        const deadline = Date.now() + timeout;
        let last = "not-requested";
        while (Date.now() < deadline) {
          if (observedErrors.some((x) => x.startsWith("wake:")))
            throw new Error(
              `local_workerd_wake_failed:${observedErrors.slice(-3).join("|")};events=${events.slice(-12).join(",")}`,
            );
          if (origin) {
            try {
              const r = await mf.dispatchFetch(`${origin}/__ohmyhost/preview/status`);
              last = String(r.status);
              if (!r.ok) await r.body?.cancel();
              if (r.ok) {
                const x = await r.json();
                last += `/${x.state}/${x.phase || "none"}/${x.failure || "none"}`;
                if (x.state === "ready") return;
                // A token lookup can straddle reserveUsage's generation advance; its
                // fail-closed status has no failedAt and is not a terminal session failure.
                if (x.failure && x.failedAt)
                  throw new Error(`local_phase_${x.failure}/${x.failedAt}`);
              }
            } catch (error) {
              if (String(error?.message || "").startsWith("local_phase_"))
                throw new Error(
                  `${error.message};events=${events.slice(-12).join(",")};errors=${observedErrors.slice(-3).join("|")}`,
                );
              last = `error/${error?.name || "unknown"}`;
            }
          } else if (Date.now() > deadline - timeout + 5000)
            throw new Error(`local_workerd_wake_not_called;events=${events.slice(-12).join(",")}`);
          await pause(200);
        }
        throw new Error(
          `local_workerd_preview_not_ready:${last};events=${events.slice(-12).join(",")};errors=${observedErrors.slice(-3).join("|")}`,
        );
      },
      async stop() {
        for (const connection of connections) connection.terminate();
        wss.close();
        const serverClosed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await Promise.race([serverClosed, pause(3000)]);
        let actorId = null;
        if (previewId) {
          try {
            const ns = await mf.getDurableObjectNamespace("PREVIEW_CONTAINERS", "preview");
            actorId = await ns.idFromName(previewId).toString();
          } catch {
            // The local actor may already have been disposed.
          }
        }
        await Promise.race([mf.dispose(), pause(5000)]);
        if (actorId && /^[a-f0-9]{64}$/.test(actorId)) {
          try {
            const { stdout } = await execFile("docker", [
              "--context",
              dockerContext,
              "ps",
              "-aq",
              "--filter",
              `name=workerd-preview-PreviewSandbox-${actorId}`,
            ]);
            for (const id of stdout
              .trim()
              .split(/\s+/)
              .filter((x) => /^[a-f0-9]{12,64}$/.test(x)))
              await execFile("docker", ["--context", dockerContext, "rm", "-f", id]);
          } catch {
            // Local Docker cleanup is best effort after the fixture has stopped.
          }
        }
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (activeMiniflare) await Promise.race([activeMiniflare.dispose(), pause(5000)]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
