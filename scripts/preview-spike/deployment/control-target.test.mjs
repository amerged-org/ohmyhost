import test from "node:test";
import assert from "node:assert/strict";
import { assertControlTarget, isOverlappingRoute } from "./control-target.mjs";

const ACCOUNT = "00000000000000000000000000000001";
const ZONE = "0000000000000000000000000000000b";
const ROUTE_ID = "1".repeat(32);
const VERSION_ID = "9d84ff2b-a73a-4ab5-a467-f72de7837190";
const DEPLOYMENT_ID = "2".repeat(32);
const SPIKE = "ohmyho-preview-spike-development";
const ROUTE = "*.preview.dev.omh.st/*";

function fixture(changes = {}) {
  const seen = [];
  const route = { id: ROUTE_ID, pattern: ROUTE, script: SPIKE, ...changes.route };
  const account = { id: ACCOUNT, ...changes.account };
  const zone = { id: ZONE, name: "omh.st", account: { id: ACCOUNT }, ...changes.zone };
  const deployment = {
    id: DEPLOYMENT_ID,
    versions: [{ percentage: 100, version_id: VERSION_ID }],
    ...changes.deployment,
  };
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    if (url === "https://control.preview.dev.omh.st/__spike/lease")
      return { ok: true, status: 200, json: async () => ({}) };
    const path = url.split("/client/v4")[1];
    let result;
    if (path === `/accounts/${ACCOUNT}`) result = account;
    else if (path === `/zones/${ZONE}`) result = zone;
    else if (path === `/zones/${ZONE}/workers/routes`)
      result = [route, ...(changes.extraRoutes ?? [])];
    else if (path === `/accounts/${ACCOUNT}/workers/scripts/${SPIKE}/deployments`)
      result = { deployments: [deployment] };
    else throw new Error("unexpected test request");
    if (changes.rejectPath === path) throw new Error("sensitive-diagnostic-cannot-leak");
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  const pins = {
    accountId: ACCOUNT,
    zoneId: ZONE,
    routeId: ROUTE_ID,
    workerVersionId: VERSION_ID,
    deploymentId: DEPLOYMENT_ID,
    token: "synthetic-provider-token",
    fetcher,
  };
  async function protectedCall() {
    await assertControlTarget(pins);
    return fetcher("https://control.preview.dev.omh.st/__spike/lease", {
      headers: { authorization: "Bearer synthetic-control-token" },
    });
  }
  return { seen, pins, protectedCall };
}

test("fixed account, zone, route and active version are checked before the protected call", async () => {
  const good = fixture();
  await good.protectedCall();
  assert.equal(good.seen.length, 5);
  assert.ok(
    good.seen
      .slice(0, 4)
      .every(
        ({ url, options }) =>
          !url.includes("synthetic-provider-token") &&
          options.method === "GET" &&
          options.headers.authorization === "Bearer synthetic-provider-token",
      ),
  );
  assert.equal(good.seen.at(-1).url, "https://control.preview.dev.omh.st/__spike/lease");
  assert.equal(isOverlappingRoute("*.dev.omh.st/*"), true);
  assert.equal(isOverlappingRoute("*.other.dev.omh.st/*"), false);
});

test("retargeted or overlapping routes and changed or split deployments block the control request", async () => {
  for (const changes of [
    { route: { script: "another-worker" } },
    { route: { id: "3".repeat(32) } },
    { extraRoutes: [{ id: "4".repeat(32), pattern: "*.dev.omh.st/*", script: "other" }] },
    {
      deployment: {
        versions: [{ percentage: 100, version_id: "c8db4d7f-38e7-4339-af33-a2e2fedfc767" }],
      },
    },
    {
      deployment: {
        versions: [
          { percentage: 50, version_id: VERSION_ID },
          { percentage: 50, version_id: VERSION_ID },
        ],
      },
    },
    { deployment: { id: "5".repeat(32) } },
    { zone: { account: { id: "0".repeat(32) } } },
  ]) {
    const value = fixture(changes);
    await assert.rejects(value.protectedCall(), { message: "control_target_unverified" });
    assert.ok(
      value.seen.every(({ url }) => !url.startsWith("https://control.preview.dev.omh.st/")),
    );
  }
});

test("provider errors and invalid pins fail closed without exposing diagnostic text or credentials", async () => {
  const value = fixture({ rejectPath: `/zones/${ZONE}/workers/routes` });
  await assert.rejects(
    value.protectedCall(),
    (error) =>
      error.message === "control_target_unverified" &&
      !error.message.includes("sensitive") &&
      !error.message.includes("synthetic-provider-token"),
  );
  const invalid = fixture();
  invalid.pins.accountId = "0".repeat(32);
  await assert.rejects(invalid.protectedCall(), { message: "control_target_unverified" });
  assert.equal(invalid.seen.length, 0);
});
