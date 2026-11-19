import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import process from "node:process";
import test from "node:test";

import {
  EXPECTED,
  inspectInventory,
  inspectManifest,
  parseManifestJsonc,
  planCleanup,
} from "./operator.mjs";
import { runtimeProvenance } from "../worker/provenance.mjs";

const now = Date.parse("2026-11-14T22:00:00.000Z");
const iso = (offset) => new Date(now + offset).toISOString();
const repo = `registry.cloudflare.com/${EXPECTED.accountId}/spike-test-image`;
const digest = `sha256:${"a".repeat(64)}`;
const manifest = () => ({
  $schema: "./node_modules/wrangler/config-schema.json",
  name: EXPECTED.workerName,
  account_id: EXPECTED.accountId,
  main: "./index.mjs",
  compatibility_date: "2026-11-14",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  version_metadata: { binding: "CF_VERSION_METADATA" },
  vars: { SPIKE_PREVIEW_DOMAIN: "preview.dev.omh.st", SPIKE_QA_ENABLED: "development" },
  services: [
    {
      binding: "QA_DEV_ACCESS",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "DevAccessRuntime",
    },
    {
      binding: "QA_CREDIT",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "GatewayCreditRuntime",
    },
    {
      binding: "QA_DATABASE_AUTHORITY",
      service: "ohmyho-control-store-poc-private-fullstack",
      entrypoint: "PreviewQaDatabaseAuthority",
    },
    {
      binding: "QA_SCOPED_DATABASE",
      service: "ohmyho-project-database-development-eu",
      entrypoint: "ProjectDatabaseQa",
    },
    {
      binding: "QA_STABLE_PREVIEW_MANAGEMENT",
      service: "ohmyho-preview-spike-auth-development",
      entrypoint: "QaStablePreviewManagement",
    },
    {
      binding: "QA_STABLE_PREVIEW_AUTHORITY",
      service: "ohmyho-preview-spike-auth-development",
      entrypoint: "QaStablePreviewAuthority",
    },
    {
      binding: "QA_NATIVE_STABLE_PREVIEW",
      service: "ohmyho-native-auth-development-eu",
      entrypoint: "NativePreviewService",
    },
    {
      binding: "QA_MAIL_PRIVATE",
      service: "ohmyho-preview-spike-mail-development",
      entrypoint: "QaMailPrivate",
    },
  ],
  routes: [{ pattern: EXPECTED.routePattern, zone_id: EXPECTED.zoneId }],
  r2_buckets: [{ binding: "BACKUP_BUCKET", bucket_name: EXPECTED.bucketName }],
  durable_objects: {
    bindings: [
      { name: "SANDBOX", class_name: "PreviewSpike" },
      { name: "SPIKE_LIMIT", class_name: "SpikeLimit" },
    ],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PreviewSpike", "SpikeLimit"] }],
  containers: [
    {
      name: EXPECTED.containerName,
      class_name: "PreviewSpike",
      scheduling_policy: "durable_object",
      images: { fixture: { dockerfile: "./Dockerfile", build_context: "./build-context" } },
    },
  ],
});
const snapshot = (offset = -30_000) => ({
  accountId: EXPECTED.accountId,
  environment: "development",
  zoneId: EXPECTED.zoneId,
  observedAt: iso(offset),
  complete: {
    workers: true,
    containers: true,
    buckets: true,
    routes: true,
    dns: true,
    images: true,
  },
  workers: [],
  containers: [],
  buckets: [],
  routes: [],
  dns: [],
  images: [],
});
const created = (offset = -20_000) => {
  const state = snapshot(offset);
  state.workers.push({ name: EXPECTED.workerName, tag: "b".repeat(32) });
  state.containers.push({
    name: EXPECTED.containerName,
    id: "12345678-1234-4234-8234-123456789abc",
    image: { repository: repo, digest },
  });
  state.buckets.push({
    name: EXPECTED.bucketName,
    creationDate: iso(-35_000),
    jurisdiction: "default",
  });
  state.routes.push({
    id: "c".repeat(32),
    pattern: EXPECTED.routePattern,
    script: EXPECTED.workerName,
  });
  state.dns.push({
    id: "d".repeat(32),
    name: EXPECTED.dnsName,
    type: "A",
    content: "192.0.2.1",
    proxied: true,
  });
  state.images.push({ repository: repo, digest });
  return state;
};
const journal = (receipt) => ({
  runId: "11111111-1111-4111-8111-111111111111",
  events: [
    ["worker", receipt.workers[0]],
    ["container", receipt.containers[0]],
    ["bucket", receipt.buckets[0]],
    ["route", receipt.routes[0]],
    ["dns", receipt.dns[0]],
    ["image", receipt.images[0]],
  ].map(([kind, identity], index) => ({
    kind,
    intentId: `0000000${index + 1}-0000-4000-8000-000000000000`,
    intentAt: iso(-55_000),
    startedAt: iso(-50_000),
    completedAt: iso(-25_000),
    outcome: "created",
    identity: JSON.parse(JSON.stringify(identity)),
  })),
});
const fail = (fn, code) =>
  assert.throws(fn, (error) => error.message === code && !error.message.includes("DO_NOT_PRINT"));

test("preflight pins Development and refuses incomplete, stale, or conflicting inventory", async (t) => {
  assert.deepEqual(inspectManifest(manifest()), {
    scopeConsistent: true,
    sourceRevision: null,
    sourceRevisionVerified: false,
    deployable: false,
  });
  const actualText = readFileSync(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8");
  assert.deepEqual(inspectManifest(parseManifestJsonc(actualText)), {
    scopeConsistent: true,
    sourceRevision: null,
    sourceRevisionVerified: false,
    deployable: false,
  });
  assert.deepEqual(
    parseManifestJsonc(
      '/* before */ {"url":"https://example.test/a/*literal*/", // comment\n "values":[1,2,],}',
    ),
    { url: "https://example.test/a/*literal*/", values: [1, 2] },
  );
  const slash = String.fromCharCode(92);
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":1,,"b":2}',
    '{"a":0x10}',
    '{"a":- 1}',
    '{"a":1e999}',
    '{"a":"' + slash + 'v"}',
    '{"a":"' + slash + 'x61"}',
    '{"a":"' + slash + 'u{61}"}',
    '{"a":true /* unclosed',
    '{"__proto__":{"x":1}}',
  ]) {
    assert.throws(() => parseManifestJsonc(source));
  }
  for (const mutate of [
    (m) => delete m.account_id,
    (m) => (m.account_id = "f".repeat(32)),
    (m) => (m.routes[0].zone_id = "e".repeat(32)),
    (m) => (m.workers_dev = true),
    (m) => (m.containers[0].name = "production"),
    (m) => (m.env = { production: {} }),
    (m) => delete m.version_metadata,
    (m) => (m.version_metadata.binding = "WRONG_BINDING"),
    (m) => (m.version_metadata.extra = "unexpected"),
    (m) => (m.vars.OTHER_VARIABLE = "unexpected"),
    (m) => delete m.vars.SPIKE_QA_ENABLED,
    (m) => (m.vars.SPIKE_QA_ENABLED = "production"),
    (m) => delete m.services,
    (m) => m.services.pop(),
    (m) => m.services.push({ binding: "UNREVIEWED", service: "unexpected", entrypoint: "Other" }),
    (m) => (m.SPIKE_SOURCE_REVISION = "a".repeat(40)),
  ]) {
    const value = manifest();
    mutate(value);
    assert.throws(() => inspectManifest(value));
  }
  for (let index = 0; index < manifest().services.length; index++)
    for (const key of ["binding", "service", "entrypoint"]) {
      const invalid = manifest();
      invalid.services[index][key] = "unexpected";
      assert.throws(() => inspectManifest(invalid));
    }
  const pinned = manifest();
  pinned.vars.SPIKE_SOURCE_REVISION = "a".repeat(40);
  const expectedPinned = {
    scopeConsistent: true,
    sourceRevision: "a".repeat(40),
    sourceRevisionVerified: false,
    deployable: false,
  };
  assert.deepEqual(inspectManifest(pinned), expectedPinned);
  assert.deepEqual(inspectManifest(parseManifestJsonc(JSON.stringify(pinned))), expectedPinned);
  assert.equal(runtimeProvenance({}, null, "react-vite").sourceRevision, null);
  assert.equal(
    runtimeProvenance({ SPIKE_SOURCE_REVISION: "bad" }, null, "react-vite").sourceRevision,
    null,
  );
  assert.equal(
    runtimeProvenance({ SPIKE_SOURCE_REVISION: "a".repeat(40) }, null, "react-vite").sourceRevision,
    "a".repeat(40),
  );
  for (const value of [null, "", "a".repeat(39), "A".repeat(40), "0".repeat(40), 42]) {
    const invalid = manifest();
    invalid.vars.SPIKE_SOURCE_REVISION = value;
    assert.throws(() => inspectManifest(invalid));
  }
  const clean = inspectInventory(snapshot(), now);
  assert.equal(clean.scopeConsistent, true);
  assert.equal(clean.expectedNamesAvailable, true);
  assert.equal(clean.deployable, false);
  assert.equal(clean.providerIdentityVerified, false);

  for (const [label, mutate, code] of [
    ["foreign account", (s) => (s.accountId = "f".repeat(32)), "scope_mismatch"],
    ["production", (s) => (s.environment = "production"), "scope_mismatch"],
    ["foreign zone", (s) => (s.zoneId = "e".repeat(32)), "scope_mismatch"],
    ["unknown credentials", (s) => (s.token = "DO_NOT_PRINT"), "invalid_input"],
    [
      "non-string name",
      (s) => s.workers.push({ name: null, tag: "a".repeat(32) }),
      "invalid_input",
    ],
    [
      "duplicate exact DNS",
      (s) => {
        s.dns.push({ ...created().dns[0] }, { ...created().dns[0], id: "e".repeat(32) });
      },
      "ambiguous_inventory",
    ],
    ["stale read", (s) => (s.observedAt = iso(-600_001)), "stale_inventory"],
    ["future read", (s) => (s.observedAt = iso(31_000)), "stale_inventory"],
    ["incomplete DNS", (s) => (s.complete.dns = false), "incomplete_inventory"],
  ]) {
    await t.test(label, () => {
      const state = snapshot();
      mutate(state);
      fail(() => inspectInventory(state, now), code);
    });
  }

  const occupied = created();
  const result = inspectInventory(occupied, now);
  assert.equal(result.expectedNamesAvailable, false);
  assert.deepEqual(result.conflicts, ["worker", "container", "bucket", "route", "dns"]);
  occupied.routes[0].pattern = `https://${EXPECTED.routePattern}`;
  assert.ok(inspectInventory(occupied, now).conflicts.includes("route"));

  const metadataOnly = snapshot();
  metadataOnly.dns.push({
    id: "f".repeat(32),
    name: EXPECTED.dnsName,
    type: "TXT",
    content: null,
    proxied: false,
  });
  metadataOnly.routes.push({ id: "e".repeat(32), pattern: EXPECTED.routePattern, script: null });
  assert.deepEqual(inspectInventory(metadataOnly, now).conflicts, ["route", "dns"]);
});

test("cleanup plan is non-executable and binds recorded creations to current exact identities", async (t) => {
  const baseline = snapshot(-60_000);
  const receipt = created(-20_000);
  const current = created(-10_000);
  const creationJournal = journal(receipt);
  current.workers[0] = { tag: "b".repeat(32), name: EXPECTED.workerName };
  const plan = planCleanup({ baseline, receipt, current, creationJournal }, now);
  assert.equal(plan.executable, false);
  assert.equal(plan.providerIdentityVerified, false);
  assert.ok(plan.requires.includes("verify_own_create_attribution"));
  assert.ok(plan.resources.every((entry) => entry.status.startsWith("blocked_")));
  assert.deepEqual(
    plan.resources.map((entry) => entry.kind),
    ["route", "dns", "container", "worker", "image", "bucket"],
  );
  const find = (kind) => plan.resources.find((entry) => entry.kind === kind);
  assert.equal(find("route").guard.id, "c".repeat(32));
  assert.equal(find("container").guard.id, "12345678-1234-4234-8234-123456789abc");
  assert.equal(find("worker").guard.tag, "b".repeat(32));
  assert.equal(find("image").guard.digest, digest);
  assert.equal(find("bucket").status, "blocked_no_stable_provider_id");

  for (const [label, mutate, code] of [
    [
      "replaced container",
      (b, r, c) => (c.containers[0].id = "ffffffff-ffff-4fff-8fff-ffffffffffff"),
      "identity_changed",
    ],
    ["replaced worker", (b, r, c) => (c.workers[0].tag = "e".repeat(32)), "identity_changed"],
    ["replaced route", (b, r, c) => (c.routes[0].id = "e".repeat(32)), "identity_changed"],
    ["modified DNS", (b, r, c) => (c.dns[0].content = "192.0.2.2"), "identity_changed"],
    [
      "recreated bucket",
      (b, r, c) => (c.buckets[0].creationDate = iso(-24_000)),
      "identity_changed",
    ],
    ["missing current Worker", (b, r, c) => (c.workers = []), "identity_changed"],
    ["missing creation receipt", (b, r) => (r.workers = []), "creation_receipt_incomplete"],
    [
      "missing worker tag",
      (b, r, c) => {
        r.workers[0].tag = null;
        c.workers[0].tag = null;
      },
      "creation_receipt_incomplete",
    ],
    [
      "missing bucket creation date",
      (b, r, c) => {
        r.buckets[0].creationDate = null;
        c.buckets[0].creationDate = null;
      },
      "creation_receipt_incomplete",
    ],
    ["nested credential", (b, r, c) => (c.workers[0].token = "DO_NOT_PRINT"), "invalid_input"],
    [
      "replaced image",
      (b, r, c) => (c.images[0].digest = `sha256:${"f".repeat(64)}`),
      "identity_changed",
    ],
    ["pre-existing bucket", (b) => b.buckets.push({ ...rBucket() }), "baseline_not_empty"],
    [
      "pre-existing image",
      (b) => b.images.push({ repository: repo, digest }),
      "baseline_not_empty",
    ],
    ["foreign receipt account", (b, r) => (r.accountId = "f".repeat(32)), "scope_mismatch"],
    ["incomplete current list", (b, r, c) => (c.complete.images = false), "incomplete_inventory"],
    ["wrong ordering", (b) => (b.observedAt = iso(-5_000)), "invalid_chronology"],
    ["stale baseline", (b) => (b.observedAt = iso(-660_001)), "stale_baseline"],
    [
      "bucket predates baseline",
      (b, r, c, j) => {
        const date = iso(-70_000);
        r.buckets[0].creationDate = date;
        c.buckets[0].creationDate = date;
        j.events.find((event) => event.kind === "bucket").identity.creationDate = date;
      },
      "invalid_create_timeline",
    ],
    [
      "bucket after response",
      (b, r, c, j) => {
        const date = iso(-24_000);
        r.buckets[0].creationDate = date;
        c.buckets[0].creationDate = date;
        j.events.find((event) => event.kind === "bucket").identity.creationDate = date;
      },
      "invalid_create_timeline",
    ],
    ["missing create event", (b, r, c, j) => j.events.pop(), "invalid_create_timeline"],
    [
      "duplicate create event",
      (b, r, c, j) => {
        j.events[0] = j.events[1];
      },
      "invalid_create_timeline",
    ],
    [
      "create intent after submission",
      (b, r, c, j) => {
        j.events[0].intentAt = iso(-40_000);
      },
      "invalid_create_timeline",
    ],
    [
      "create response after receipt",
      (b, r, c, j) => {
        j.events[0].completedAt = iso(-19_000);
      },
      "invalid_create_timeline",
    ],
    [
      "foreign created identity",
      (b, r, c, j) => {
        j.events[0].identity.tag = "f".repeat(32);
      },
      "invalid_create_timeline",
    ],
  ]) {
    await t.test(label, () => {
      const b = JSON.parse(JSON.stringify(baseline));
      const r = JSON.parse(JSON.stringify(receipt));
      const c = JSON.parse(JSON.stringify(current));
      const j = JSON.parse(JSON.stringify(creationJournal));
      mutate(b, r, c, j);
      fail(
        () => planCleanup({ baseline: b, receipt: r, current: c, creationJournal: j }, now),
        code,
      );
    });
  }

  function rBucket() {
    return receipt.buckets[0];
  }
});

test("CLI accepts only a fixed operation and never echoes malformed input", () => {
  const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
  const actualText = readFileSync(new URL("../worker/wrangler.jsonc", import.meta.url), "utf8");
  const actualResult = spawnSync(process.execPath, [cli, "manifest"], {
    input: actualText,
    encoding: "utf8",
  });
  assert.equal(actualResult.status, 0);
  assert.deepEqual(JSON.parse(actualResult.stdout), {
    scopeConsistent: true,
    sourceRevision: null,
    sourceRevisionVerified: false,
    deployable: false,
  });
  assert.equal(actualResult.stderr, "");

  const duplicate = spawnSync(process.execPath, [cli, "manifest"], {
    input: '{"account_id":"DO_NOT_PRINT","account_id":"also_hidden"}',
    encoding: "utf8",
  });
  assert.notEqual(duplicate.status, 0);
  assert.equal(duplicate.stdout.includes("DO_NOT_PRINT"), false);
  assert.equal(duplicate.stderr.includes("DO_NOT_PRINT"), false);
  const unknown = spawnSync(process.execPath, [cli, "DO_NOT_PRINT"], {
    input: JSON.stringify({ token: "DO_NOT_PRINT" }),
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout.includes("DO_NOT_PRINT"), false);
  assert.equal(unknown.stderr.includes("DO_NOT_PRINT"), false);

  const malformed = spawnSync(process.execPath, [cli, "preflight"], {
    input: '{"token":"DO_NOT_PRINT"',
    encoding: "utf8",
  });
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.stdout.includes("DO_NOT_PRINT"), false);
  assert.equal(malformed.stderr.includes("DO_NOT_PRINT"), false);

  const leak = snapshot();
  leak.observedAt = new Date().toISOString();
  leak.token = "DO_NOT_PRINT";
  const rejected = spawnSync(process.execPath, [cli, "preflight"], {
    input: JSON.stringify(leak),
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout.includes("DO_NOT_PRINT"), false);
  assert.equal(rejected.stderr.includes("DO_NOT_PRINT"), false);

  const valid = snapshot();
  valid.observedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [cli, "preflight"], {
    input: JSON.stringify(valid),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).deployable, false);
  assert.equal(result.stderr, "");
});
