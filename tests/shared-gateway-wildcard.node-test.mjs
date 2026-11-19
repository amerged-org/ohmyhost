import assert from "node:assert/strict";
import test from "node:test";

import { runSharedGatewayWildcard } from "../scripts/shared-gateway-wildcard.mjs";

const token = "test-token-" + "a".repeat(20);
const record = {
  id: "c".repeat(32),
  type: "CNAME",
  name: "*.dev.check.omh.st",
  content: "dev.check.omh.st",
  ttl: 1,
  proxied: true,
};
const envelope = (result) =>
  globalThis.Response.json({ success: true, errors: [], messages: [], result });

test("prepares one shared DNS wildcard with exact provider readback", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (calls.length === 1) return envelope([]);
    if (calls.length === 2) return envelope(record);
    if (calls.length === 3) return envelope([record]);
    throw new Error("Unexpected provider request");
  };
  assert.deepEqual(
    await runSharedGatewayWildcard({
      mode: "prepare",
      environment: "development",
      dnsToken: token,
      fetch,
    }),
    { environment: "development", phase: "dns-prepared", outcome: "created" },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "POST", "GET"],
  );
  assert.ok(calls.every((call) => !call.url.includes(token)));
});

test("verifies DNS, route and HTTPS marker before declaring the gateway ready", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (calls.length === 1) return envelope([record]);
    if (calls.length === 2)
      return envelope([
        {
          id: "d".repeat(32),
          pattern: "*.dev.check.omh.st/*",
          script: "ohmyho-gateway-poc-private-fullstack",
        },
      ]);
    if (calls.length === 3)
      return new globalThis.Response(null, {
        status: 404,
        headers: { "x-ohmyhost-gateway": "shared-v1" },
      });
    throw new Error("Unexpected provider request");
  };
  assert.deepEqual(
    await runSharedGatewayWildcard({
      mode: "verify",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      fetch,
    }),
    {
      environment: "development",
      phase: "verified",
      accountId: "00000000000000000000000000000001",
    },
  );
  assert.match(calls[2].url, /^https:\/\/gateway-probe-[0-9a-f-]+\.dev\.check\.omh\.st\/$/u);
  assert.equal(calls[2].method, "GET");
  assert.ok(calls.every((call) => !call.url.includes(token)));
});

function routeProvider(initialScript, ingressStatus = 404, failRestore = false) {
  const id = "d".repeat(32);
  const pattern = "*.dev.check.omh.st/*";
  let script = initialScript;
  const calls = [];
  const fetch = async (url, options) => {
    const location = String(url);
    calls.push({ url: location, method: options.method });
    if (location.includes("/dns_records")) return envelope([record]);
    if (location.endsWith(`/workers/routes/${id}`)) {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        assert.equal(body.pattern, pattern);
        if (failRestore && body.script === "ohmyho-public-production")
          return new globalThis.Response(null, { status: 503 });
        script = body.script;
      }
      return envelope({ id, pattern, script });
    }
    if (location.endsWith("/workers/routes")) return envelope([{ id, pattern, script }]);
    if (location.startsWith("https://gateway-probe-"))
      return new globalThis.Response(null, {
        status: ingressStatus,
        headers: ingressStatus === 404 ? { "x-ohmyhost-gateway": "shared-v1" } : {},
      });
    throw new Error("Unexpected provider request");
  };
  return { id, calls, fetch, script: () => script };
}

test("activates only the exact existing wildcard route and proves HTTPS ingress", async () => {
  const provider = routeProvider("ohmyho-public-production");
  assert.deepEqual(
    await runSharedGatewayWildcard({
      mode: "activate",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: provider.id,
      fetch: provider.fetch,
    }),
    {
      environment: "development",
      phase: "activated",
      routeId: provider.id,
      outcome: "updated",
    },
  );
  assert.equal(provider.script(), "ohmyho-gateway-poc-private-fullstack");
  assert.equal(provider.calls.filter((call) => call.method === "PUT").length, 1);
  assert.ok(provider.calls.every((call) => !call.url.includes(token)));
});

test("restores the old wildcard script when the new HTTPS ingress fails", async () => {
  const provider = routeProvider("ohmyho-public-production", 503);
  await assert.rejects(
    runSharedGatewayWildcard({
      mode: "activate",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: provider.id,
      fetch: provider.fetch,
    }),
    /original route restored/u,
  );
  assert.equal(provider.script(), "ohmyho-public-production");
  assert.equal(provider.calls.filter((call) => call.method === "PUT").length, 2);
});

test("restores an activation whose provider readback was lost after the write", async () => {
  const provider = routeProvider("ohmyho-public-production");
  let activationWritten = false;
  let readbackLost = false;
  const fetch = async (url, options) => {
    const location = String(url);
    if (
      options.method === "PUT" &&
      JSON.parse(options.body).script === "ohmyho-gateway-poc-private-fullstack"
    )
      activationWritten = true;
    else if (
      activationWritten &&
      !readbackLost &&
      options.method === "GET" &&
      location.endsWith(`/workers/routes/${provider.id}`)
    ) {
      readbackLost = true;
      throw new Error("readback unavailable");
    }
    return provider.fetch(url, options);
  };
  await assert.rejects(
    runSharedGatewayWildcard({
      mode: "activate",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: provider.id,
      fetch,
    }),
    /original route retained or restored/u,
  );
  assert.equal(readbackLost, true);
  assert.equal(provider.script(), "ohmyho-public-production");
});

test("reports uncertainty when a failed activation cannot restore the old route", async () => {
  const provider = routeProvider("ohmyho-public-production", 503, true);
  await assert.rejects(
    runSharedGatewayWildcard({
      mode: "activate",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: provider.id,
      fetch: provider.fetch,
    }),
    /activation and restoration are uncertain/u,
  );
  assert.equal(provider.script(), "ohmyho-gateway-poc-private-fullstack");
});

test("explicit restoration is fenced to the reviewed route ID", async () => {
  const provider = routeProvider("ohmyho-gateway-poc-private-fullstack");
  await assert.rejects(
    runSharedGatewayWildcard({
      mode: "restore",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: "wrong-route",
      fetch: provider.fetch,
    }),
    /Exact wildcard route ID/u,
  );
  assert.deepEqual(
    await runSharedGatewayWildcard({
      mode: "restore",
      environment: "development",
      dnsToken: token,
      routeToken: token,
      routeId: provider.id,
      fetch: provider.fetch,
    }),
    {
      environment: "development",
      phase: "restored",
      routeId: provider.id,
      outcome: "updated",
    },
  );
  assert.equal(provider.script(), "ohmyho-public-production");
});
