/* global Request, Response */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import probeWorker from "../.github/scripts/phase1-workos-capability-probe.mjs";
import { prepareWorkosCapabilityProbe } from "../scripts/prepare-workos-capability-probe.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("local probe forwards only the fixed capability RPC over the private service binding", async () => {
  const calls = [];
  const response = await probeWorker.fetch(
    new Request("http://127.0.0.1:8787/probe", { method: "POST" }),
    {
      WORKOS_MANAGEMENT: {
        fetch: async (request) => {
          calls.push({
            url: request.url,
            method: request.method,
            body: await request.json(),
          });
          return new Response('{"ok":true}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-ohmyhost-management-artifact-sha256": "a".repeat(64),
              "x-ohmyhost-cloudflare-version-id": "095f00a7-23a7-43b7-a227-e4c97cab5f22",
              "x-ohmyhost-cloudflare-version-tag": "a".repeat(64),
              "set-cookie": "must-not-forward=true",
            },
          });
        },
      },
    },
  );

  assert.deepEqual(calls, [
    {
      url: "https://workos-management.internal/rpc",
      method: "POST",
      body: {
        method: "capabilities.probe_read_only",
        requestId: "capability-producer",
        payload: {},
      },
    },
  ]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-ohmyhost-management-artifact-sha256"), "a".repeat(64));
  assert.equal(
    response.headers.get("x-ohmyhost-cloudflare-version-id"),
    "095f00a7-23a7-43b7-a227-e4c97cab5f22",
  );
  assert.equal(response.headers.get("x-ohmyhost-cloudflare-version-tag"), "a".repeat(64));
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), '{"ok":true}');
});

test("probe configuration is private, local, and binds only the named remote service", async () => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-workos-probe-"));
  roots.push(root);
  const output = join(root, "probe");
  await prepareWorkosCapabilityProbe({
    repositoryRoot,
    output,
    service: "ohmyhost-workos-management-sandbox",
  });

  const configuration = JSON.parse(await readFile(join(output, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(configuration.services, [
    {
      binding: "WORKOS_MANAGEMENT",
      service: "ohmyhost-workos-management-sandbox",
      remote: true,
    },
  ]);
  assert.equal(configuration.workers_dev, false);
  assert.equal(configuration.preview_urls, false);
  assert.equal(configuration.routes, undefined);
  assert.equal(configuration.main, "phase1-workos-capability-probe.mjs");
  assert.equal(
    await readFile(join(output, configuration.main), "utf8"),
    await readFile(
      join(repositoryRoot, ".github/scripts/phase1-workos-capability-probe.mjs"),
      "utf8",
    ),
  );

  await assert.rejects(
    prepareWorkosCapabilityProbe({
      repositoryRoot,
      output: join(root, "bad"),
      service: "../../attacker",
    }),
    /INVALID_WORKOS_MANAGEMENT_SERVICE/u,
  );
});

test("public CI excludes the privileged WorkOS capability producer", async () => {
  const workflows = join(repositoryRoot, ".github/workflows");
  const names = (await readdir(workflows)).filter((name) => /\.ya?ml$/u.test(name));
  assert.ok(names.includes("ci.yml"));
  assert.equal(names.includes("phase1-workos-capabilities.yml"), false);
  for (const name of names) {
    const workflow = await readFile(join(workflows, name), "utf8");
    assert.equal(
      /phase1-workos-sandbox|auth-preflight:capabilities:producer|CLOUDFLARE_API_TOKEN|WORKOS_MANAGEMENT_CREDENTIAL|WORKOS_CONNECT_CLIENT_SECRET|WORKOS_API_KEY/u.test(
        workflow,
      ),
      false,
      name,
    );
  }
});
