import { isIP } from "node:net";

import ts from "typescript";

/**
 * Local-only comparison of normalized provider observations. This module never authenticates,
 * calls a provider, creates a resource, or executes a cleanup plan.
 */
export const EXPECTED = Object.freeze({
  accountId: "00000000000000000000000000000001",
  environment: "development",
  zoneId: "0000000000000000000000000000000b",
  workerName: "ohmyho-preview-spike-development",
  containerName: "ohmyho-preview-spike-development",
  bucketName: "ohmyho-preview-spike-backups-development",
  routePattern: "*.preview.dev.omh.st/*",
  dnsName: "*.preview.dev.omh.st",
});

const KINDS = ["workers", "containers", "buckets", "routes", "dns", "images"];
const ID = /^[a-f0-9]{32}$/u;
const CONTAINER_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REVISION = /^(?!0{40}$)[a-f0-9]{40}$/u;
const JSON_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const NAME = /^[a-z0-9][a-z0-9._/-]{0,254}$/u;
const HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FRESH_FOR_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 30 * 1000;
const MAX_RECORDS = 100_000;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

const fail = (code) => {
  throw new Error(code);
};

function keys(value, names) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...names].sort().join("\0")
  )
    fail("invalid_input");
}

function instant(value) {
  if (typeof value !== "string") fail("invalid_input");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail("invalid_input");
  return time;
}

function records(value, validate) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) fail("invalid_input");
  for (const entry of value) validate(entry);
}

function image(value) {
  keys(value, ["repository", "digest"]);
  const prefix = `registry.cloudflare.com/${EXPECTED.accountId}/`;
  if (
    typeof value.repository !== "string" ||
    !value.repository.startsWith(prefix) ||
    !matches(NAME, value.repository) ||
    value.repository.length <= prefix.length ||
    !matches(DIGEST, value.digest)
  )
    fail("invalid_input");
}

function readSnapshot(state) {
  keys(state, ["accountId", "environment", "zoneId", "observedAt", "complete", ...KINDS]);
  if (
    state.accountId !== EXPECTED.accountId ||
    state.environment !== EXPECTED.environment ||
    state.zoneId !== EXPECTED.zoneId
  )
    fail("scope_mismatch");
  const time = instant(state.observedAt);
  keys(state.complete, KINDS);
  if (KINDS.some((kind) => state.complete[kind] !== true)) fail("incomplete_inventory");

  records(state.workers, (entry) => {
    keys(entry, ["name", "tag"]);
    if (!matches(NAME, entry.name) || (entry.tag !== null && !matches(ID, entry.tag)))
      fail("invalid_input");
  });
  records(state.containers, (entry) => {
    keys(entry, ["name", "id", "image"]);
    if (!matches(NAME, entry.name) || (entry.id !== null && !matches(CONTAINER_ID, entry.id)))
      fail("invalid_input");
    image(entry.image);
  });
  records(state.buckets, (entry) => {
    keys(entry, ["name", "creationDate", "jurisdiction"]);
    if (
      !matches(NAME, entry.name) ||
      !(
        entry.jurisdiction === null ||
        ["default", "eu", "us", "fedramp", "fedramp-high"].includes(entry.jurisdiction)
      )
    )
      fail("invalid_input");
    if (entry.creationDate !== null) instant(entry.creationDate);
  });
  records(state.routes, (entry) => {
    keys(entry, ["id", "pattern", "script"]);
    if (
      !matches(ID, entry.id) ||
      typeof entry.pattern !== "string" ||
      entry.pattern.length > 300 ||
      !(entry.script === null || matches(NAME, entry.script))
    )
      fail("invalid_input");
  });
  records(state.dns, (entry) => {
    keys(entry, ["id", "name", "type", "content", "proxied"]);
    if (
      !matches(ID, entry.id) ||
      typeof entry.name !== "string" ||
      entry.name.length > 255 ||
      typeof entry.proxied !== "boolean" ||
      !matches(/^[A-Z][A-Z0-9-]{0,15}$/u, entry.type) ||
      !(
        (entry.content === null && entry.proxied === false) ||
        (typeof entry.content === "string" &&
          ((entry.type === "A" && isIP(entry.content) === 4) ||
            (entry.type === "AAAA" && isIP(entry.content) === 6) ||
            (entry.type === "CNAME" && matches(HOST, entry.content))))
      )
    )
      fail("invalid_input");
  });
  records(state.images, image);
  return time;
}

function fresh(time, now) {
  if (!Number.isFinite(now)) fail("invalid_input");
  if (time < now - FRESH_FOR_MS || time > now + FUTURE_SKEW_MS) fail("stale_inventory");
}

function unique(items) {
  if (items.length > 1) fail("ambiguous_inventory");
  return items[0] ?? null;
}

function selected(state) {
  const routePatterns = [
    EXPECTED.routePattern,
    `http://${EXPECTED.routePattern}`,
    `https://${EXPECTED.routePattern}`,
  ];
  return {
    worker: unique(state.workers.filter((item) => item.name === EXPECTED.workerName)),
    container: unique(state.containers.filter((item) => item.name === EXPECTED.containerName)),
    bucket: unique(state.buckets.filter((item) => item.name === EXPECTED.bucketName)),
    route: unique(state.routes.filter((item) => routePatterns.includes(item.pattern))),
    dns: unique(state.dns.filter((item) => item.name.toLowerCase() === EXPECTED.dnsName)),
  };
}

/**
 * Parse JSONC with TypeScript and reject ambiguous keys and invalid JSON string and number
 * tokens. TypeScript also accepts extra ECMAScript whitespace, so this is not strict JSONC
 * lexical validation. Diagnostics and input text are never returned in errors.
 */
export function parseManifestJsonc(source) {
  if (typeof source !== "string" || source.length > 8 * 1024 * 1024) fail("invalid_input");
  const document = ts.parseJsonText("manifest.jsonc", source);
  const parsed = ts.parseConfigFileTextToJson("manifest.jsonc", source);
  if (parsed.error || document.parseDiagnostics.length) fail("invalid_input");
  const stack = [document];
  while (stack.length) {
    const node = stack.pop();
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set();
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isStringLiteral(property.name) ||
          source[property.name.getStart(document)] !== '"'
        )
          fail("invalid_input");
        const name = property.name.text;
        if (names.has(name) || ["__proto__", "constructor", "prototype"].includes(name))
          fail("invalid_input");
        names.add(name);
      }
    }
    if (ts.isStringLiteral(node)) {
      try {
        const literal = node.getText(document);
        if (source[node.getStart(document)] !== '"' || JSON.parse(literal) !== node.text)
          fail("invalid_input");
      } catch {
        fail("invalid_input");
      }
    }
    if (ts.isNumericLiteral(node)) {
      const literal = node.getText(document);
      if (!matches(JSON_NUMBER, literal) || !Number.isFinite(Number(literal)))
        fail("invalid_input");
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const literal = node.getText(document);
      if (!literal.startsWith("-") || !matches(JSON_NUMBER, literal.slice(1)))
        fail("invalid_input");
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  const value = parsed.config;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid_input");
  return value;
}

/**
 * Check the local Wrangler manifest's fixed Development shape. It does not read or deploy it,
 * inspect the Worker source, or establish which account a live provider session can access.
 */
export function inspectManifest(manifest) {
  keys(manifest, [
    "$schema",
    "name",
    "account_id",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "version_metadata",
    "vars",
    "services",
    "routes",
    "r2_buckets",
    "durable_objects",
    "migrations",
    "containers",
  ]);
  if (typeof manifest.vars !== "object" || manifest.vars === null || Array.isArray(manifest.vars))
    fail("invalid_input");
  const hasRevision = Object.hasOwn(manifest.vars, "SPIKE_SOURCE_REVISION");
  const sourceRevision = hasRevision ? manifest.vars.SPIKE_SOURCE_REVISION : null;
  if (hasRevision && !matches(REVISION, sourceRevision)) fail("manifest_mismatch");
  const expected = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: EXPECTED.workerName,
    account_id: EXPECTED.accountId,
    main: "./index.mjs",
    compatibility_date: manifest.compatibility_date,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      SPIKE_PREVIEW_DOMAIN: "preview.dev.omh.st",
      SPIKE_QA_ENABLED: "development",
      ...(hasRevision ? { SPIKE_SOURCE_REVISION: sourceRevision } : {}),
    },
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
  };
  if (
    typeof manifest.compatibility_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(manifest.compatibility_date) ||
    manifest.compatibility_date < "2025-11-17" ||
    !Number.isFinite(Date.parse(manifest.compatibility_date)) ||
    new Date(manifest.compatibility_date).toISOString().slice(0, 10) !==
      manifest.compatibility_date ||
    !same(manifest, expected)
  )
    fail("manifest_mismatch");
  return {
    scopeConsistent: true,
    sourceRevision,
    sourceRevisionVerified: false,
    deployable: false,
  };
}

/** Check only the exact planned names. The caller's data is not provider identity proof. */
export function inspectInventory(state, now = Date.now()) {
  fresh(readSnapshot(state), now);
  const found = selected(state);
  const conflicts = Object.entries(found)
    .filter(([, value]) => value !== null)
    .map(([kind]) => kind);
  return {
    scopeConsistent: true,
    providerIdentityVerified: false,
    expectedNamesAvailable: conflicts.length === 0,
    conflicts,
    deployable: false,
    limitations: [
      "provider_readback_unverified",
      "registry_name_unknown",
      "overlapping_routes_unchecked",
    ],
  };
}

function same(left, right) {
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]))
  );
}

/**
 * Compare an absent-before snapshot with a post-create receipt and fresh post-create readback.
 * The result is a review aid, not executable deletion authority or proof of provider identity.
 */
export function planCleanup(input, now = Date.now()) {
  keys(input, ["baseline", "receipt", "current", "creationJournal"]);
  const baselineTime = readSnapshot(input.baseline);
  const receiptTime = readSnapshot(input.receipt);
  const currentTime = readSnapshot(input.current);
  fresh(currentTime, now);
  if (baselineTime >= receiptTime || receiptTime > currentTime) fail("invalid_chronology");

  const before = selected(input.baseline);
  const made = selected(input.receipt);
  const current = selected(input.current);
  if (Object.values(before).some((entry) => entry !== null)) fail("baseline_not_empty");
  if (Object.values(made).some((entry) => entry === null)) fail("creation_receipt_incomplete");

  for (const kind of Object.keys(made)) {
    if (current[kind] === null || !same(made[kind], current[kind])) fail("identity_changed");
  }
  if (
    made.worker.tag === null ||
    made.container.id === null ||
    made.bucket.creationDate === null ||
    made.bucket.jurisdiction === null ||
    made.route.script !== EXPECTED.workerName ||
    made.route.pattern !== EXPECTED.routePattern ||
    made.dns.content === null ||
    !made.dns.proxied
  )
    fail("creation_receipt_incomplete");

  const target = made.container.image;
  if (input.baseline.images.some((item) => item.repository === target.repository))
    fail("baseline_not_empty");
  const receiptImage = unique(input.receipt.images.filter((item) => same(item, target)));
  const currentImage = unique(input.current.images.filter((item) => same(item, target)));
  if (!receiptImage || !currentImage) fail("identity_changed");

  const journal = input.creationJournal;
  keys(journal, ["runId", "events"]);
  if (!matches(CONTAINER_ID, journal.runId) || !Array.isArray(journal.events))
    fail("invalid_create_timeline");
  const identities = { ...made, image: target };
  const kinds = Object.keys(identities);
  if (journal.events.length !== kinds.length) fail("invalid_create_timeline");
  const seen = new Set();
  for (const event of journal.events) {
    keys(event, [
      "kind",
      "intentId",
      "intentAt",
      "startedAt",
      "completedAt",
      "outcome",
      "identity",
    ]);
    if (
      typeof event.kind !== "string" ||
      !Object.hasOwn(identities, event.kind) ||
      seen.has(event.kind) ||
      !matches(CONTAINER_ID, event.intentId) ||
      event.outcome !== "created" ||
      !same(event.identity, identities[event.kind])
    )
      fail("invalid_create_timeline");
    seen.add(event.kind);
    const intentAt = instant(event.intentAt);
    const startedAt = instant(event.startedAt);
    const completedAt = instant(event.completedAt);
    if (
      baselineTime >= intentAt ||
      intentAt > startedAt ||
      startedAt > completedAt ||
      completedAt > receiptTime
    )
      fail("invalid_create_timeline");
    if (startedAt - baselineTime > FRESH_FOR_MS) fail("stale_baseline");
    if (event.kind === "bucket") {
      const createdAt = instant(made.bucket.creationDate);
      if (createdAt <= baselineTime || createdAt < intentAt || createdAt > completedAt)
        fail("invalid_create_timeline");
    }
  }

  return {
    executable: false,
    providerIdentityVerified: false,
    requires: [
      "verify_own_create_attribution",
      "fresh_authenticated_readback",
      "confirm_no_shared_references",
      "review_provider_conditional_delete_support",
    ],
    resources: [
      { kind: "route", status: "blocked_unverified_create_attribution", guard: { ...made.route } },
      { kind: "dns", status: "blocked_unverified_create_attribution", guard: { ...made.dns } },
      {
        kind: "container",
        status: "blocked_unverified_create_attribution",
        guard: { name: made.container.name, id: made.container.id },
      },
      {
        kind: "worker",
        status: "blocked_unverified_create_attribution",
        guard: { name: made.worker.name, tag: made.worker.tag },
      },
      { kind: "image", status: "blocked_unverified_create_attribution", guard: { ...target } },
      {
        kind: "bucket",
        status: "blocked_no_stable_provider_id",
        guard: { ...made.bucket },
      },
    ],
  };
}
