/* global AbortSignal, Headers, Response, URL */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  compareVersions,
  comparePublicChannels,
  observePublicChannels,
  requireCurrentChannels,
} from "../scripts/check-public-channels.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const SOURCE = "e3068bd04a2f752770f0f29a88f902b97e4b451c";
const DOCS_HEAD = "cc84e21bbded6a67a0759ff7266d9054aa1c7a33";
const WEB_HEAD = "759c79c4153fb00796f7607ce33402f3d2b40f1b";
const MIRROR_HEAD = "0123456789abcdef0123456789abcdef01234567";
const INTEGRITY = "sha512-fixture";
const PACKAGES = ["cli", "mcp", "sdk", "runtime", "auth"].map((x) => `@amerged/ohmyhost-${x}`);

function healthyObservation(version = "0.1.21") {
  const skills = {
    "ohmyhost-get-started": "a".repeat(64),
    "ohmyhost-deploy-github": "b".repeat(64),
  };
  return {
    site: {
      release: { version, manifestUrl: `https://ohmyho.st/releases/${version}/manifest.json` },
      manifest: { version, sourceCommit: SOURCE },
      skills: { ...skills },
      catalog: "c".repeat(64),
    },
    released: { catalog: "c".repeat(64) },
    npm: Object.fromEntries(
      PACKAGES.map((name) => [name, { version, license: "Apache-2.0", integrity: INTEGRITY }]),
    ),
    docs: {
      commit: DOCS_HEAD,
      release: { version, dirty: false },
      skills: { ...skills },
      catalog: "c".repeat(64),
    },
    web: {
      commit: WEB_HEAD,
      release: { version, manifestUrl: `https://ohmyho.st/releases/${version}/manifest.json` },
      skills: { ...skills },
      catalog: "c".repeat(64),
    },
    mcpRepository: {
      commit: MIRROR_HEAD,
      release: { version, sourceCommit: SOURCE, integrity: INTEGRITY },
    },
  };
}

const statusOf = (report, channel) => report.channels.find((item) => item.channel === channel);
const failing = (report) =>
  report.channels.filter(({ status }) => status !== "ok").map(({ channel }) => channel);

test("channel comparison names every public surface that differs from the live release", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("0.1.9", "0.1.10"), -1);
  assert.equal(compareVersions("0.1.21", "0.1.21"), 0);
  assert.throws(() => compareVersions("0.1", "0.1.21"), /Cannot compare/u);

  const healthy = comparePublicChannels(healthyObservation());
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.live, { version: "0.1.21", sourceCommit: SOURCE });
  assert.equal(healthy.channels.length, 14);
  assert.deepEqual(failing(healthy), []);
  assert.equal(statusOf(healthy, "docs").commit, DOCS_HEAD);

  const cases = [
    [
      "npm behind",
      (o) => (o.npm["@amerged/ohmyhost-cli"].version = "0.1.20"),
      { "npm:@amerged/ohmyhost-cli": "behind" },
    ],
    [
      "npm licence",
      (o) => (o.npm["@amerged/ohmyhost-auth"].license = "MIT"),
      { "npm:@amerged/ohmyhost-auth": "mismatch" },
    ],
    [
      "docs ahead",
      (o) => (o.docs.release.version = "0.1.22"),
      { docs: "ahead", "skills:docs": "ahead", "catalog:docs": "ahead" },
    ],
    ["docs dirty", (o) => (o.docs.release.dirty = true), { docs: "mismatch" }],
    [
      "docs skill differs",
      (o) => (o.docs.skills["ohmyhost-get-started"] = "d".repeat(64)),
      { "skills:docs": "mismatch" },
    ],
    [
      "docs behind with an old skill",
      (o) => {
        o.docs.release.version = "0.1.20";
        o.docs.skills["ohmyhost-get-started"] = "d".repeat(64);
      },
      { docs: "behind", "skills:docs": "behind", "catalog:docs": "behind" },
    ],
    [
      "web skill missing and extra",
      (o) => {
        delete o.web.skills["ohmyhost-deploy-github"];
        o.web.skills["ohmyhost-extra"] = "e".repeat(64);
      },
      { "skills:web": "mismatch" },
    ],
    ["web catalog", (o) => (o.web.catalog = "f".repeat(64)), { "catalog:web": "mismatch" }],
    [
      "web manifest",
      (o) => (o.web.release.manifestUrl = "https://ohmyho.st/releases/0.1.20/manifest.json"),
      { web: "mismatch" },
    ],
    [
      "mirror missing",
      (o) => {
        o.mcpRepository.commit = { unreachable: "HTTP 401" };
        o.mcpRepository.release = { unreachable: "HTTP 401" };
      },
      { "mcp-repository": "unreachable" },
    ],
    [
      "mirror integrity",
      (o) => (o.mcpRepository.release.integrity = "sha512-other"),
      { "mcp-repository": "mismatch" },
    ],
    [
      "mirror source commit",
      (o) => (o.mcpRepository.release.sourceCommit = "f".repeat(40)),
      { "mcp-repository": "mismatch" },
    ],
    [
      "web unreachable",
      (o) => {
        o.web.release = { unreachable: "timeout" };
        o.web.skills = { unreachable: "timeout" };
        o.web.catalog = { unreachable: "timeout" };
      },
      { web: "unreachable", "skills:web": "unreachable", "catalog:web": "unreachable" },
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const observation = healthyObservation();
    mutate(observation);
    const report = comparePublicChannels(observation);
    assert.equal(report.ok, false, name);
    assert.deepEqual(
      Object.fromEntries(
        report.channels
          .filter(({ status }) => status !== "ok")
          .map(({ channel, status }) => [channel, status]),
      ),
      expected,
      name,
    );
  }
  const skill = healthyObservation();
  skill.docs.skills["ohmyhost-get-started"] = "d".repeat(64);
  assert.deepEqual(statusOf(comparePublicChannels(skill), "skills:docs").detail, [
    "ohmyhost-get-started",
  ]);
  const web = healthyObservation();
  delete web.web.skills["ohmyhost-deploy-github"];
  web.web.skills["ohmyhost-extra"] = "e".repeat(64);
  assert.deepEqual(statusOf(comparePublicChannels(web), "skills:web").detail, [
    "ohmyhost-deploy-github",
    "ohmyhost-extra",
  ]);
  const behind = healthyObservation("0.1.10");
  behind.npm["@amerged/ohmyhost-sdk"].version = "0.1.9";
  assert.equal(
    statusOf(comparePublicChannels(behind), "npm:@amerged/ohmyhost-sdk").status,
    "behind",
  );

  const unreadable = healthyObservation();
  unreadable.site.release = { unreachable: "HTTP 503" };
  assert.deepEqual(comparePublicChannels(unreadable), {
    ok: false,
    live: null,
    channels: [
      {
        channel: "site",
        status: "unreachable",
        expected: "one consistent live release",
        observed: "HTTP 503",
      },
    ],
  });
  const inconsistent = healthyObservation();
  inconsistent.site.manifest.version = "0.1.20";
  const report = comparePublicChannels(inconsistent);
  assert.equal(report.live, null);
  assert.deepEqual(failing(report), ["site"]);
});

const skillText = "---\nname: ohmyhost-get-started\n---\n# Start\n";
const catalog = {
  transport: "stdio",
  command: "ohmyhost-mcp",
  tools: [{ name: "identity_get" }],
};
const advertise = (sha) =>
  `001e# service=git-upload-pack\n0000015b${sha} HEAD\0multi_ack side-band-64k\n003f${sha} refs/heads/main\n0000`;
const base = () => ({
  "https://ohmyho.st/client-release.json": JSON.stringify({
    version: "0.1.21",
    manifest_url: "https://ohmyho.st/releases/0.1.21/manifest.json",
  }),
  "https://ohmyho.st/releases/0.1.21/manifest.json": JSON.stringify({
    version: "0.1.21",
    source_commit: SOURCE,
  }),
  "https://ohmyho.st/mcp-tools.json": JSON.stringify(catalog),
  "https://ohmyho.st/releases/0.1.21/mcp-tools.json": JSON.stringify(catalog),
  "https://ohmyho.st/.well-known/agent-skills/index.json": JSON.stringify({
    skills: [{ name: "ohmyhost-get-started", description: "Start", url: "unused" }],
  }),
  "https://ohmyho.st/skills/ohmyhost-get-started/SKILL.md": skillText,
  ...Object.fromEntries(
    PACKAGES.map((name) => [
      `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
      JSON.stringify({
        name,
        version: "0.1.21",
        license: "Apache-2.0",
        dist: { integrity: INTEGRITY },
      }),
    ]),
  ),
  "https://github.com/amerged-org/ohmyhost-docs.git/info/refs?service=git-upload-pack":
    advertise(DOCS_HEAD),
  "https://github.com/amerged-org/ohmyhost-web.git/info/refs?service=git-upload-pack":
    advertise(WEB_HEAD),
  "https://github.com/amerged-org/ohmyhost-mcp.git/info/refs?service=git-upload-pack":
    advertise(MIRROR_HEAD),
  [`https://raw.githubusercontent.com/amerged-org/ohmyhost-docs/${DOCS_HEAD}/generated-content.json`]:
    JSON.stringify({ source_commit: SOURCE, source_dirty: false, release: "0.1.21", files: [] }),
  [`https://raw.githubusercontent.com/amerged-org/ohmyhost-docs/${DOCS_HEAD}/mcp-tools.json`]: `${JSON.stringify(catalog, null, 2)}\n`,
  [`https://raw.githubusercontent.com/amerged-org/ohmyhost-docs/${DOCS_HEAD}/skills/ohmyhost-get-started/SKILL.md`]:
    skillText,
  [`https://raw.githubusercontent.com/amerged-org/ohmyhost-web/${WEB_HEAD}/platform-inputs.json`]:
    JSON.stringify({
      clientRelease: {
        version: "0.1.21",
        manifestUrl: "https://ohmyho.st/releases/0.1.21/manifest.json",
      },
      skills: [
        { skillName: "ohmyhost-get-started", relativePath: "SKILL.md", text: skillText },
        {
          skillName: "ohmyhost-get-started",
          relativePath: "references/harness-setup.md",
          text: "# Harness\n",
        },
      ],
      mcpTools: catalog,
    }),
  [`https://raw.githubusercontent.com/amerged-org/ohmyhost-mcp/${MIRROR_HEAD}/release.json`]:
    JSON.stringify({
      version: "0.1.21",
      sourceCommit: SOURCE,
      npm: { name: "@amerged/ohmyhost-mcp", integrity: INTEGRITY },
    }),
});
const serve = (routes, requests) => async (url, init) => {
  requests.push({ url, init });
  const body = routes[url];
  if (body instanceof Error) throw body;
  if (typeof body === "number") return new Response("", { status: body });
  return body === undefined ? new Response("", { status: 404 }) : new Response(body);
};

test("observation reads commit-pinned public sources without credentials and marks failures unreachable", async () => {
  const requests = [];
  const observation = await observePublicChannels({ fetch: serve(base(), requests) });
  const report = comparePublicChannels(observation);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(
    observation.site.skills["ohmyhost-get-started"],
    createHash("sha256").update(skillText).digest("hex"),
  );
  for (const { url, init } of requests) {
    assert.ok(
      [
        "https://ohmyho.st",
        "https://registry.npmjs.org",
        "https://github.com",
        "https://raw.githubusercontent.com",
      ].includes(new URL(url).origin),
      url,
    );
    if (url.startsWith("https://raw.githubusercontent.com/"))
      assert.match(url, new RegExp(`/(${DOCS_HEAD}|${WEB_HEAD}|${MIRROR_HEAD})/`, "u"));
    assert.doesNotMatch(url, /\/main\//u);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
  }

  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const broken = {
    ...base(),
    [`https://raw.githubusercontent.com/amerged-org/ohmyhost-web/${WEB_HEAD}/platform-inputs.json`]:
      timeout,
    "https://registry.npmjs.org/@amerged%2Fohmyhost-runtime/latest": 503,
    "https://github.com/amerged-org/ohmyhost-mcp.git/info/refs?service=git-upload-pack": 401,
    [`https://raw.githubusercontent.com/amerged-org/ohmyhost-docs/${DOCS_HEAD}/generated-content.json`]:
      "not json",
  };
  const failed = comparePublicChannels(await observePublicChannels({ fetch: serve(broken, []) }));
  assert.deepEqual(
    Object.fromEntries(
      failed.channels
        .filter(({ status }) => status !== "ok")
        .map(({ channel, status, observed }) => [channel, [status, observed]]),
    ),
    {
      "npm:@amerged/ohmyhost-runtime": ["unreachable", "HTTP 503"],
      docs: ["unreachable", "invalid JSON"],
      web: ["unreachable", "timeout"],
      "mcp-repository": ["unreachable", "HTTP 401"],
      "skills:docs": ["unreachable", "invalid JSON"],
      "skills:web": ["unreachable", "timeout"],
      "catalog:docs": ["unreachable", "invalid JSON"],
      "catalog:web": ["unreachable", "timeout"],
    },
  );
});

test("a new client release is prepared only while every public channel carries the live release", async () => {
  const healthy = comparePublicChannels(healthyObservation());
  assert.deepEqual(requireCurrentChannels(healthy, "0.1.22"), {
    version: "0.1.21",
    sourceCommit: SOURCE,
  });
  assert.throws(
    () => requireCurrentChannels(healthy, "0.1.21"),
    /Client 0\.1\.21 is not newer than the live release 0\.1\.21/u,
  );
  assert.throws(
    () => requireCurrentChannels(healthy, "0.1.20"),
    /not newer than the live release/u,
  );

  const lagging = healthyObservation();
  lagging.docs.release.version = "0.1.20";
  lagging.mcpRepository.commit = { unreachable: "HTTP 401" };
  lagging.mcpRepository.release = { unreachable: "HTTP 401" };
  assert.throws(
    () => requireCurrentChannels(comparePublicChannels(lagging), "0.1.22"),
    (error) =>
      /docs behind \("0\.1\.20"\)/u.test(error.message) &&
      /mcp-repository unreachable \("HTTP 401"\)/u.test(error.message) &&
      /pnpm public-clients:check before preparing 0\.1\.22/u.test(error.message),
  );
  const unreadable = healthyObservation();
  unreadable.site.release = { unreachable: "timeout" };
  assert.throws(
    () => requireCurrentChannels(comparePublicChannels(unreadable), "0.1.22"),
    /live client release cannot be read/u,
  );

  const script = await readFile(
    resolve(repositoryRoot, "scripts/prepare-public-client-release.mjs"),
    "utf8",
  );
  const inspected = script.indexOf("inspectReleaseRepository(");
  const gated = script.indexOf("requireCurrentChannels(");
  const staged = script.indexOf("mkdtemp(");
  assert.ok(inspected > 0 && gated > inspected && staged > gated, "the gate precedes staging");
});

test("a client release that predates its catalog file is baselined by the public site catalog, and a failed read is not", async () => {
  const routes = base();
  delete routes["https://ohmyho.st/releases/0.1.21/mcp-tools.json"];
  const observation = await observePublicChannels({ fetch: serve(routes, []) });
  const report = comparePublicChannels(observation);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(observation.released.catalog, observation.site.catalog);
  const broken = base();
  broken["https://ohmyho.st/releases/0.1.21/mcp-tools.json"] = new Error("network down");
  const failed = comparePublicChannels(await observePublicChannels({ fetch: serve(broken, []) }));
  assert.equal(statusOf(failed, "catalog:site").status, "unreachable");
});

test("the website and docs catalogs are compared with the catalog the client release published", () => {
  const observation = healthyObservation();
  // The website serves a catalog that matches the live site but not the released client: it must be named.
  observation.released.catalog = "d".repeat(64);
  const report = comparePublicChannels(observation);
  assert.equal(report.ok, false);
  assert.equal(statusOf(report, "catalog:web").status, "mismatch");
  assert.equal(statusOf(report, "catalog:docs").status, "mismatch");
  assert.equal(statusOf(report, "catalog:site").status, "mismatch");
  assert.equal(statusOf(report, "catalog:web").expected, undefined);
});
