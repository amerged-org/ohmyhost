/* global Response, TextDecoder, URL, Headers, Request */
import {
  allowedEdit,
  authorized,
  createId,
  parseControl,
  previewId,
  signId,
  validateCreate,
  verifyId,
} from "./protocol.mjs";
import { readQaInventory } from "./qa-inventory.mjs";

const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (value, status = 200) => Response.json(value, { status, headers: noStore });
const missing = () => new Response("Not found", { status: 404, headers: noStore });

async function body(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 70_000) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  const domain = env.SPIKE_PREVIEW_DOMAIN;
  const secret = env.SPIKE_CONTROL_TOKEN;
  if (url.protocol !== "https:" || typeof domain !== "string") return missing();
  if (url.pathname === "/__spike/activity") {
    const label = previewId(url.hostname, domain);
    if (
      request.method !== "POST" ||
      !label ||
      !(await verifyId(label, secret)) ||
      request.headers.get("origin") !== url.origin ||
      request.headers.get("sec-fetch-site") !== "same-origin" ||
      request.headers.get("x-spike-activity") !== "1"
    )
      return missing();
    try {
      return json(await env.SANDBOX.getByName(label.slice(0, 32)).activity());
    } catch {
      return json({ error: "operation_failed" }, 500);
    }
  }
  if (url.pathname === "/__spike" || url.pathname.startsWith("/__spike/")) {
    if (url.hostname !== `control.${domain}`) return missing();
    if (!(await authorized(request.headers.get("authorization"), secret)))
      return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/__spike/qa-inventory" && request.method === "GET") {
      try {
        return json(await readQaInventory(env));
      } catch {
        return json({ error: "qa_inventory_unavailable" }, 503);
      }
    }
    const route = parseControl(url.pathname);
    if (!route) return missing();
    try {
      const limiter = env.SPIKE_LIMIT.getByName("development");
      if (route.action === "lease" && request.method === "GET")
        return json(await limiter.current());
      if (route.action === "create") {
        if (request.method !== "POST") return missing();
        const input = validateCreate(await body(request));
        if (!input) return json({ error: "invalid_request" }, 400);
        const id = createId();
        if (!(await limiter.claim(id))) return json({ error: "session_limit" }, 409);
        await env.SANDBOX.getByName(id).initialize(input);
        const label = await signId(id, secret);
        return json({ id, url: `https://${label}.${domain}/` }, 201);
      }
      if (!/^[a-f0-9]{32}$/.test(route.id)) return missing();
      const stub = env.SANDBOX.getByName(route.id);
      if (route.action === "mail-permit") {
        if (request.method === "GET")
          return json(await env.QA_MAIL_PRIVATE.status({ sessionId: route.id }));
        if (request.method === "POST") return env.QA_MAIL_PRIVATE.arm(request, route.id);
        return missing();
      }
      if (route.action === "status" && request.method === "GET") {
        const status = await stub.status();
        // The Containers API uses the 64-hex Durable Object ID, not the 32-hex session name.
        const containerInstanceId = env.SANDBOX.idFromName(route.id).toString();
        if (!/^[a-f0-9]{64}$/u.test(containerInstanceId)) throw new Error("instance_id_invalid");
        return json({ ...status, containerInstanceId });
      }
      if (route.action === "setup" && request.method === "POST") return json(await stub.setup());
      if (route.action === "backup" && request.method === "POST") return json(await stub.backup());
      if (route.action === "stop" && request.method === "POST") return json(await stub.stop());
      if (route.action === "delete" && request.method === "DELETE") {
        const result = await stub.cleanup();
        await limiter.release(route.id);
        return json(result);
      }
      if (route.action === "edit" && request.method === "POST") {
        const edit = await body(request);
        if (
          !edit ||
          Object.keys(edit).some((key) => !["path", "content"].includes(key)) ||
          !allowedEdit(edit.path, edit.content)
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        return json(await stub.edit(edit));
      }
      return missing();
    } catch {
      // Provider errors and process output may contain private data. The status records only the phase.
      return json({ error: "operation_failed" }, 500);
    }
  }
  const label = previewId(url.hostname, domain);
  if (!label || !(await verifyId(label, secret))) return missing();
  const headers = new Headers(request.headers);
  for (const name of headers.keys())
    if (name.toLowerCase().startsWith("x-spike-")) headers.delete(name);
  return env.SANDBOX.getByName(label.slice(0, 32)).fetch(new Request(request, { headers }));
}
