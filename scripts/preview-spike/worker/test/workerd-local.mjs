/* global process, Buffer, URL, setTimeout, console */
import assert from "node:assert/strict";
import https from "node:https";
import { readFile } from "node:fs/promises";

// Public, fixed local-only value. It is accepted solely by the loopback Wrangler process.
const token = "synthetic-local-token-not-a-real-secret";
const domain = "preview.dev.omh.st";
const control = `control.${domain}`;
const kind = process.env.SPIKE_LOCAL_FIXTURE ?? "next-edge";
const idleMode = process.env.SPIKE_LOCAL_IDLE_MODE ?? "product";
if (!["next-edge", "react-vite"].includes(kind)) throw new Error("local_fixture_invalid");
if (!["product", "sdk"].includes(idleMode)) throw new Error("local_idle_mode_invalid");
const editPath = kind === "next-edge" ? "src/app/page.tsx" : "src/main.tsx";
let id;

function request(host, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: 8891,
        servername: host,
        path,
        method,
        rejectUnauthorized: false,
        headers: { host, ...(text ? { "content-type": "application/json" } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.setTimeout(240_000, () => req.destroy(new Error("local_request_timeout")));
    req.on("error", reject);
    if (text) req.write(text);
    req.end();
  });
}

async function controlRequest(path, options = {}) {
  const response = await request(control, path, {
    ...options,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(
    response.status >= 200 && response.status < 300,
    `${path} returned ${response.status}: ${response.text.slice(0, 300)}`,
  );
  return JSON.parse(response.text);
}

try {
  assert.equal(await controlRequest("/__spike/lease"), null);
  const created = await controlRequest("/__spike/sessions", {
    method: "POST",
    body: {
      fixture: kind,
      instance: "standard-1",
      inactivityMs: 5_000,
      cacheMode: "seeded",
      idleMode,
    },
  });
  id = created.id;
  const base = `/__spike/sessions/${id}`;
  const initial = await controlRequest(`${base}/setup`, { method: "POST" });
  assert.equal(initial.ready, true);
  assert.equal(initial.coldProof.restored, false);
  assert.ok(initial.backup?.size > 0);
  const fixture = await readFile(
    new URL(`../build-context/fixtures/cloudflare-preview/${kind}/${editPath}`, import.meta.url),
    "utf8",
  );
  const modified = fixture.replace("Preview notes", "Local restore proof");
  assert.notEqual(fixture, modified);
  await controlRequest(`${base}/edit`, {
    method: "POST",
    body: { path: editPath, content: modified },
  });
  await controlRequest(`${base}/stop`, { method: "POST" });
  const host = new URL(created.url).hostname;
  const activity = await request(host, "/__spike/activity", {
    method: "POST",
    headers: {
      origin: `https://${host}`,
      "sec-fetch-site": "same-origin",
      "x-spike-activity": "1",
    },
  });
  assert.equal(activity.status, 200);
  assert.equal(JSON.parse(activity.text).woke, true);
  const page = await request(host, kind === "next-edge" ? "/" : `/${editPath}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Local restore proof/);
  // DO inactivity can begin later than the last HTTP response. Do not poll it during the wait.
  const idleWaitMs = idleMode === "sdk" ? 45_000 : 8_000;
  const idleWaitStarted = Date.now();
  await new Promise((resolve) => setTimeout(resolve, idleWaitMs));
  const idleWaitElapsedMs = Date.now() - idleWaitStarted;
  const slept = await controlRequest(`${base}/status`);
  assert.equal(
    slept.running,
    false,
    `container still running after ${idleWaitElapsedMs}ms with ${idleMode} inactivity`,
  );
  if (idleMode === "product") assert.equal(slept.lastStopReason, "idle");
  else assert.equal(slept.observedProviderStop, true);
  const again = await request(host, "/__spike/activity", {
    method: "POST",
    headers: {
      origin: `https://${host}`,
      "sec-fetch-site": "same-origin",
      "x-spike-activity": "1",
    },
  });
  assert.equal(again.status, 200);
  const restoredPage = await request(host, kind === "next-edge" ? "/" : `/${editPath}`);
  assert.match(restoredPage.text, /Local restore proof/);
  const deleted = await controlRequest(base, { method: "DELETE" });
  assert.equal(deleted.destroyed, true);
  id = undefined;
  assert.equal(await controlRequest("/__spike/lease"), null);
  console.log(
    `Local Workerd/R2/container checkpoint, edit, stop, idle and restore passed (${kind}, ${idleMode}, waited ${idleWaitElapsedMs}ms)`,
  );
} finally {
  if (id) await controlRequest(`/__spike/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}
