#!/usr/bin/env node
/* global AbortSignal, process */
/**
 * Reads every public channel of the client release without credentials and reports whether each
 * one carries the release that ohmyho.st serves: the site, the five npm packages, the docs and
 * website repositories, the MCP source mirror, and the Skills and tool catalog they publish.
 * GitHub files are read at the commit its public ref advertisement names, because raw files under
 * a branch name are cached for five minutes.
 *
 *   node scripts/check-public-channels.mjs
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SITE = "https://ohmyho.st";
const REGISTRY = "https://registry.npmjs.org";
const NPM_PACKAGES = ["cli", "mcp", "sdk", "runtime", "auth"].map(
  (suffix) => `@amerged/ohmyhost-${suffix}`,
);
const REPOSITORIES = { docs: "ohmyhost-docs", web: "ohmyhost-web", mcpRepository: "ohmyhost-mcp" };
const VERSION = /^\d+\.\d+\.\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

const unreachable = (reason) => ({ unreachable: reason });
const isUnreachable = (value) =>
  value !== null && typeof value === "object" && typeof value.unreachable === "string";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const catalogDigest = (catalog) => sha256(JSON.stringify(catalog));

export function compareVersions(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right))
    throw new Error(`Cannot compare release versions ${left} and ${right}`);
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export async function observePublicChannels({ fetch = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const read = async (url) => {
    try {
      const response = await fetch(url, {
        headers: { accept: "*/*", "user-agent": "ohmyhost-public-channel-check" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return unreachable(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      return unreachable(error?.name === "TimeoutError" ? "timeout" : "network error");
    }
  };
  const readJson = async (url) => {
    const text = await read(url);
    if (isUnreachable(text)) return text;
    try {
      return JSON.parse(text);
    } catch {
      return unreachable("invalid JSON");
    }
  };
  const head = async (repository) => {
    const text = await read(
      `https://github.com/amerged-org/${repository}.git/info/refs?service=git-upload-pack`,
    );
    if (isUnreachable(text)) return text;
    return /([0-9a-f]{40}) refs\/heads\/main\n/u.exec(text)?.[1] ?? unreachable("no main branch");
  };
  const raw = (repository, commit, path) =>
    `https://raw.githubusercontent.com/amerged-org/${repository}/${commit}/${path}`;

  const [release, liveCatalog, skillIndex, npmRecords, heads] = await Promise.all([
    readJson(`${SITE}/client-release.json`),
    readJson(`${SITE}/mcp-tools.json`),
    readJson(`${SITE}/.well-known/agent-skills/index.json`),
    Promise.all(
      NPM_PACKAGES.map((name) => readJson(`${REGISTRY}/${name.replace("/", "%2F")}/latest`)),
    ),
    Promise.all(Object.values(REPOSITORIES).map(head)),
  ]);
  const [docsCommit, webCommit, mirrorCommit] = heads;
  const names = isUnreachable(skillIndex)
    ? []
    : (skillIndex.skills ?? [])
        .map((skill) => skill.name)
        .filter((name) => typeof name === "string");
  const atCommit = (commit, reader) => (isUnreachable(commit) ? commit : reader(commit));
  const [manifest, liveSkills, docsGenerated, docsCatalog, docsSkills, webInputs, mirrorRelease] =
    await Promise.all([
      isUnreachable(release) || typeof release.manifest_url !== "string"
        ? unreachable("no manifest URL")
        : readJson(release.manifest_url),
      Promise.all(names.map((name) => read(`${SITE}/skills/${name}/SKILL.md`))),
      atCommit(docsCommit, (commit) =>
        readJson(raw(REPOSITORIES.docs, commit, "generated-content.json")),
      ),
      atCommit(docsCommit, (commit) => readJson(raw(REPOSITORIES.docs, commit, "mcp-tools.json"))),
      Promise.all(
        names.map((name) =>
          atCommit(docsCommit, (commit) =>
            read(raw(REPOSITORIES.docs, commit, `skills/${name}/SKILL.md`)),
          ),
        ),
      ),
      atCommit(webCommit, (commit) =>
        readJson(raw("ohmyhost-web", commit, "platform-inputs.json")),
      ),
      atCommit(mirrorCommit, (commit) => readJson(raw("ohmyhost-mcp", commit, "release.json"))),
    ]);

  const digests = (texts) =>
    Object.fromEntries(
      names.map((name, index) => [
        name,
        isUnreachable(texts[index]) ? texts[index] : sha256(texts[index]),
      ]),
    );
  const webSkills = isUnreachable(webInputs)
    ? webInputs
    : Object.fromEntries(
        (webInputs.skills ?? [])
          .filter((skill) => skill.relativePath === "SKILL.md")
          .map((skill) => [skill.skillName, sha256(skill.text)]),
      );
  // The catalog the released client shipped is the baseline: the site and the website and docs must equal it.
  const releasedCatalog =
    isUnreachable(release) || typeof release.version !== "string"
      ? unreachable("no client release")
      : await read(`${SITE}/releases/${release.version}/mcp-tools.json`).then((text) =>
          isUnreachable(text)
            ? text
            : (() => {
                try {
                  return JSON.parse(text);
                } catch {
                  return unreachable("invalid JSON");
                }
              })(),
        );
  // A release that predates its catalog file is baselined by the public site catalog it serves; a failed read is not.
  const baseline =
    isUnreachable(releasedCatalog) && releasedCatalog.unreachable === "HTTP 404"
      ? liveCatalog
      : releasedCatalog;
  return {
    released: {
      catalog: isUnreachable(baseline) ? baseline : catalogDigest(baseline),
    },
    site: {
      release: isUnreachable(release)
        ? release
        : { version: release.version, manifestUrl: release.manifest_url },
      manifest: isUnreachable(manifest)
        ? manifest
        : { version: manifest.version, sourceCommit: manifest.source_commit },
      skills: isUnreachable(skillIndex) ? skillIndex : digests(liveSkills),
      catalog: isUnreachable(liveCatalog) ? liveCatalog : catalogDigest(liveCatalog),
    },
    npm: Object.fromEntries(
      NPM_PACKAGES.map((name, index) => {
        const record = npmRecords[index];
        return [
          name,
          isUnreachable(record)
            ? record
            : {
                version: record.version,
                license: record.license,
                integrity: record.dist?.integrity,
              },
        ];
      }),
    ),
    docs: {
      commit: docsCommit,
      release: isUnreachable(docsGenerated)
        ? docsGenerated
        : { version: docsGenerated.release, dirty: docsGenerated.source_dirty },
      skills: isUnreachable(docsCommit) ? docsCommit : digests(docsSkills),
      catalog: isUnreachable(docsCatalog) ? docsCatalog : catalogDigest(docsCatalog),
    },
    web: {
      commit: webCommit,
      release: isUnreachable(webInputs)
        ? webInputs
        : {
            version: webInputs.clientRelease?.version,
            manifestUrl: webInputs.clientRelease?.manifestUrl,
          },
      skills: webSkills,
      catalog: isUnreachable(webInputs) ? webInputs : catalogDigest(webInputs.mcpTools),
    },
    mcpRepository: {
      commit: mirrorCommit,
      release: isUnreachable(mirrorRelease)
        ? mirrorRelease
        : {
            version: mirrorRelease.version,
            sourceCommit: mirrorRelease.sourceCommit,
            integrity: mirrorRelease.npm?.integrity,
          },
    },
  };
}

export function comparePublicChannels(observation) {
  const { release, manifest } = observation.site;
  const site = (status, observed) => ({
    ok: false,
    live: null,
    channels: [{ channel: "site", status, expected: "one consistent live release", observed }],
  });
  if (isUnreachable(release)) return site("unreachable", release.unreachable);
  if (isUnreachable(manifest)) return site("unreachable", manifest.unreachable);
  if (
    typeof release.version !== "string" ||
    !VERSION.test(release.version) ||
    release.manifestUrl !== `${SITE}/releases/${release.version}/manifest.json` ||
    manifest.version !== release.version ||
    typeof manifest.sourceCommit !== "string" ||
    !COMMIT.test(manifest.sourceCommit)
  )
    return site("mismatch", { release, manifest });

  const live = { version: release.version, sourceCommit: manifest.sourceCommit };
  const channels = [
    { channel: "site", status: "ok", expected: live.version, observed: live.version },
  ];
  const direction = (version) =>
    typeof version === "string" && VERSION.test(version)
      ? ["behind", "ok", "ahead"][compareVersions(version, live.version) + 1]
      : "mismatch";
  const versioned = (channel, value, extra, commit) => {
    if (isUnreachable(value))
      return {
        channel,
        status: "unreachable",
        expected: live.version,
        observed: value.unreachable,
      };
    const status = direction(value.version);
    const problem = status === "ok" ? extra(value) : null;
    return {
      channel,
      status: problem ? "mismatch" : status,
      expected: live.version,
      observed: problem ?? value.version,
      ...(commit && !isUnreachable(commit) ? { commit } : {}),
    };
  };
  // Skills and the catalog follow their repository's release: a lagging release lags them too.
  const content = (channel, versionChannel, expected, observed, compare) => {
    if (versionChannel.status === "unreachable")
      return { channel, status: "unreachable", observed: versionChannel.observed };
    const missing = [expected, observed].find(isUnreachable);
    if (missing) return { channel, status: "unreachable", observed: missing.unreachable };
    if (versionChannel.status === "behind" || versionChannel.status === "ahead")
      return { channel, status: versionChannel.status };
    const differing = compare(expected, observed);
    return differing.length === 0
      ? { channel, status: "ok" }
      : { channel, status: "mismatch", detail: differing };
  };
  const skillDifferences = (expected, observed) =>
    [...new Set([...Object.keys(expected), ...Object.keys(observed)])]
      .filter((name) => expected[name] !== observed[name])
      .sort();
  const digestDifference = (expected, observed) => (expected === observed ? [] : ["catalog"]);

  for (const [name, record] of Object.entries(observation.npm))
    channels.push(
      versioned(`npm:${name}`, record, (value) =>
        value.license === "Apache-2.0" ? null : `license ${value.license}`,
      ),
    );
  const docs = versioned(
    "docs",
    observation.docs.release,
    (value) => (value.dirty === false ? null : "generated from a dirty tree"),
    observation.docs.commit,
  );
  const web = versioned(
    "web",
    observation.web.release,
    (value) =>
      value.manifestUrl === `${SITE}/releases/${live.version}/manifest.json`
        ? null
        : `manifest ${value.manifestUrl}`,
    observation.web.commit,
  );
  const mcpNpm = observation.npm["@amerged/ohmyhost-mcp"];
  const mirror = versioned(
    "mcp-repository",
    observation.mcpRepository.release,
    (value) => {
      if (value.sourceCommit !== live.sourceCommit) return `source commit ${value.sourceCommit}`;
      if (
        !isUnreachable(mcpNpm) &&
        mcpNpm.version === live.version &&
        mcpNpm.integrity !== value.integrity
      )
        return "integrity differs from npm";
      return null;
    },
    observation.mcpRepository.commit,
  );
  channels.push(
    docs,
    web,
    mirror,
    content(
      "skills:docs",
      docs,
      observation.site.skills,
      observation.docs.skills,
      skillDifferences,
    ),
    content("skills:web", web, observation.site.skills, observation.web.skills, skillDifferences),
    content(
      "catalog:site",
      channels[0],
      observation.released.catalog,
      observation.site.catalog,
      digestDifference,
    ),
    content(
      "catalog:docs",
      docs,
      observation.released.catalog,
      observation.docs.catalog,
      digestDifference,
    ),
    content(
      "catalog:web",
      web,
      observation.released.catalog,
      observation.web.catalog,
      digestDifference,
    ),
  );
  return { ok: channels.every(({ status }) => status === "ok"), live, channels };
}

export function requireCurrentChannels(report, version) {
  if (report.live === null)
    throw new Error(
      "The live client release cannot be read; run pnpm public-clients:check and retry",
    );
  if (compareVersions(version, report.live.version) <= 0)
    throw new Error(
      `Client ${version} is not newer than the live release ${report.live.version}; choose the next patch version`,
    );
  if (!report.ok) {
    const lagging = report.channels
      .filter(({ status }) => status !== "ok")
      .map(({ channel, status, observed }) =>
        observed === undefined
          ? `${channel} ${status}`
          : `${channel} ${status} (${JSON.stringify(observed)})`,
      );
    throw new Error(
      `Public channels do not all carry the live client release ${report.live.version}: ${lagging.join(", ")}. Bring them to ${report.live.version} and run pnpm public-clients:check before preparing ${version}`,
    );
  }
  return report.live;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("usage: check-public-channels.mjs");
  const report = comparePublicChannels(await observePublicChannels());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
