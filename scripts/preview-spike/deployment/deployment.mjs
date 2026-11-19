/* global AbortSignal, structuredClone */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  buildWorkerPackages,
  inspectReleaseRepository,
  parseJsonc,
  requireCoreSchemaHead,
  requireVerifiedCommit,
  verifyDeclaredVersionBindings,
  workerReleaseIdentity,
} from "../../platform-release.mjs";
import { controlCoreWorkerConfiguration } from "../../control-core-worker-profile.mjs";
import { assertControlCoreResourceIdentity } from "../../control-core-train.mjs";
import { buildQaNativeRuntimeConfig } from "../auth/native-config.mjs";
import { validateQaManifest } from "../capabilities/config.mjs";
import { QA_PROJECTS } from "../worker/qa-inventory.mjs";
import { isOverlappingRoute } from "./control-target.mjs";
export { isOverlappingRoute } from "./control-target.mjs";

export const ACCOUNT = "00000000000000000000000000000001";
export const ZONE = "0000000000000000000000000000000b";
export const SPIKE = "ohmyho-preview-spike-development";
export const AUTH = "ohmyho-preview-spike-auth-development";
export const MAIL = "ohmyho-preview-spike-mail-development";
export const CORE = "ohmyho-control-store-poc-private-fullstack";
export const GATEWAY = "ohmyho-mail-gateway-poc-private-fullstack";
export const NATIVE = "ohmyho-native-auth-development-eu";
export const DATABASE = "ohmyho-project-database-development-eu";
export const CUSTODY = "ohmyho-runtime-secret-delivery-poc-private-fullstack";
export const BUCKET = "ohmyho-preview-spike-backups-development";
const ROUTE = "*.preview.dev.omh.st/*";
const DNS = "*.preview.dev.omh.st";
const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const RESOURCE_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const SHA = /^[a-f0-9]{40}$/u;
const hash = (value) => createHash("sha256").update(value).digest("hex");
class DeploymentError extends Error {
  constructor(code, reason) {
    super(code);
    this.code = code;
    this.reason = reason;
  }
}
const fail = (code) => {
  throw new DeploymentError(code);
};
export function safeDiagnostic(error) {
  if (!(error instanceof DeploymentError)) return "development_deployment_unverified";
  return error.reason === undefined ? error.code : `${error.code}: ${error.reason}`;
}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const json = (value) => JSON.stringify(value);
const execFileAsync = promisify(execFile);

export function assertZonePreflight({
  account,
  zone,
  certificates,
  routes,
  dns,
  now = Date.now(),
}) {
  if (
    account?.id !== ACCOUNT ||
    zone?.id !== ZONE ||
    zone?.name !== "omh.st" ||
    zone.account?.id !== ACCOUNT
  )
    fail("provider_scope_mismatch");
  if (
    !Array.isArray(certificates) ||
    !certificates.some(
      (pack) =>
        pack.status === "active" &&
        Array.isArray(pack.hosts) &&
        pack.hosts.includes(DNS) &&
        Array.isArray(pack.certificates) &&
        pack.certificates.some(
          (cert) =>
            cert.status === "active" &&
            Number.isFinite(Date.parse(cert.expires_on)) &&
            Date.parse(cert.expires_on) > now,
        ),
    )
  )
    fail("wildcard_certificate_unavailable");
  if (!Array.isArray(routes) || routes.some((route) => isOverlappingRoute(route?.pattern)))
    fail("preview_route_conflict");
  if (!Array.isArray(dns) || dns.some((record) => record?.name?.toLowerCase() === DNS))
    fail("preview_dns_conflict");
}

export function validateScopeManifest(input) {
  const value = validateQaManifest(input);
  if (
    value.projects.some(
      (item, index) =>
        item.projectId !== QA_PROJECTS[index].projectId ||
        item.fixture !== QA_PROJECTS[index].fixture,
    )
  )
    fail("qa_fixture_identity_mismatch");
  return value;
}

export function assertSharedBindingsPreserved(before, after, changedNames) {
  if (!Array.isArray(before) || !Array.isArray(after) || !Array.isArray(changedNames))
    fail("shared_bindings_unavailable");
  const names = new Set();
  for (const binding of before) {
    if (!object(binding) || typeof binding.name !== "string" || names.has(binding.name))
      fail("shared_bindings_unavailable");
    names.add(binding.name);
    const matching = after.filter((item) => item?.name === binding.name);
    if (
      matching.length !== 1 ||
      (!changedNames.includes(binding.name) && !isDeepStrictEqual(binding, matching[0]))
    )
      fail("shared_binding_changed");
  }
  if (new Set(after.map((item) => item?.name)).size !== after.length)
    fail("shared_bindings_unavailable");
}

export function assertSpikeImage(version) {
  const containers = version?.resources?.script_runtime?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) fail("spike_image_unverified");
  const item = containers[0],
    image = item?.images?.fixture;
  if (
    item.name !== SPIKE ||
    item.class_name !== "PreviewSpike" ||
    !object(item.images) ||
    Object.keys(item.images).length !== 1 ||
    typeof image !== "string" ||
    !new RegExp(
      `^registry\\.cloudflare\\.com/${ACCOUNT}/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$`,
      "u",
    ).test(image)
  )
    fail("spike_image_unverified");
  return image;
}

/** Provider errors, diagnostic bodies, credentials and non-selected response fields never leave here. */
export function provider({ token, fetch = globalThis.fetch }) {
  if (typeof token !== "string" || token.length < 1) fail("cloudflare_token_required");
  return async (path, { method = "GET", body, missing = false } = {}) => {
    let response, value;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: json(body) }),
      });
      value = await response.json();
    } catch {
      fail("cloudflare_request_unavailable");
    }
    if (
      missing &&
      response.status === 404 &&
      value?.success === false &&
      Array.isArray(value.errors) &&
      value.errors.length === 1 &&
      value.errors[0]?.code === 10007
    )
      return null;
    if (!response.ok || value?.success !== true || value.result === undefined)
      fail("cloudflare_request_failed");
    return value;
  };
}

async function numberedPages(read, path, perPage = 100) {
  const result = [];
  for (let page = 1; page <= 1000; page += 1) {
    const response = await read(
      `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=${perPage}`,
    );
    if (!Array.isArray(response.result)) fail("provider_inventory_unavailable");
    result.push(...response.result);
    const info = response.result_info;
    if (!info) {
      if (page === 1 && response.result.length < perPage) return result;
      fail("provider_inventory_unavailable");
    }
    if (!Number.isInteger(info.total_pages) || info.total_pages < 0 || info.page !== page)
      fail("provider_inventory_unavailable");
    if (page >= info.total_pages) return result;
  }
  fail("provider_inventory_unavailable");
}

async function cursorPages(read, path, type) {
  const result = [],
    seen = new Set();
  let cursor = null;
  for (let page = 0; page < 1000; page += 1) {
    const key = type === "bucket" ? "cursor" : "page_token";
    const response = await read(
      cursor === null
        ? path
        : `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(cursor)}`,
    );
    const items = type === "bucket" ? response.result?.buckets : response.result;
    if (!Array.isArray(items)) fail("provider_inventory_unavailable");
    result.push(...items);
    const next =
      type === "bucket" ? response.result_info?.cursor : response.result_info?.next_page_token;
    if (next === undefined || next === null || next === "") return result;
    if (typeof next !== "string" || seen.has(next)) fail("provider_inventory_unavailable");
    seen.add(next);
    cursor = next;
  }
  fail("provider_inventory_unavailable");
}

async function deployment(read, name) {
  const response = await read(`/accounts/${ACCOUNT}/workers/scripts/${name}/deployments`, {
    missing: true,
  });
  if (response === null) return null;
  const current = response.result?.deployments?.[0],
    versions = current?.versions;
  if (
    !RESOURCE_ID.test(current?.id ?? "") ||
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    !UUID.test(versions[0]?.version_id ?? "") ||
    versions[0].percentage !== 100
  )
    fail("worker_deployment_unavailable");
  return { deploymentId: current.id, versionId: versions[0].version_id };
}

async function version(read, name, versionId) {
  const value = (await read(`/accounts/${ACCOUNT}/workers/scripts/${name}/versions/${versionId}`))
    .result;
  if (value?.id !== versionId || !Array.isArray(value?.resources?.bindings))
    fail("worker_version_unavailable");
  return value;
}

async function schedules(read, name) {
  const value = (await read(`/accounts/${ACCOUNT}/workers/scripts/${name}/schedules`)).result
    ?.schedules;
  if (!Array.isArray(value) || value.some((item) => typeof item?.cron !== "string"))
    fail("worker_schedules_unavailable");
  return value.map((item) => item.cron).sort();
}

async function allRoutes(read) {
  // This endpoint is documented as a single page, unlike DNS and certificate packs.
  const response = await read(`/zones/${ZONE}/workers/routes`);
  if (!Array.isArray(response.result)) fail("provider_inventory_unavailable");
  return response.result;
}

async function zoneInventory(read) {
  const [account, zone, certificates, routes, dns] = await Promise.all([
    read(`/accounts/${ACCOUNT}`),
    read(`/zones/${ZONE}`),
    numberedPages(read, `/zones/${ZONE}/ssl/certificate_packs`, 50),
    allRoutes(read),
    numberedPages(read, `/zones/${ZONE}/dns_records?name=${encodeURIComponent(DNS)}`),
  ]);
  return { account: account.result, zone: zone.result, certificates, routes, dns };
}

/** Validate the operator's append-only creation evidence; it is never a deletion grant. */
export function validateOwnedResources(records) {
  if (!Array.isArray(records) || records.length !== 8) fail("resource_receipt_invalid");
  const resources = {};
  for (let offset = 0; offset < records.length; offset += 4) {
    const [baseline, intentRecord, created, verified] = records.slice(offset, offset + 4);
    const kind = offset === 0 ? "bucket" : "dns",
      name = kind === "bucket" ? BUCKET : DNS;
    if (
      [baseline, intentRecord, created, verified].some(
        (item) =>
          item?.schemaVersion !== 1 ||
          item.accountId !== ACCOUNT ||
          item.zoneId !== ZONE ||
          item.kind !== kind ||
          item.name !== name ||
          typeof item.at !== "string" ||
          !Number.isFinite(Date.parse(item.at)),
      ) ||
      baseline.phase !== "baseline" ||
      baseline.present !== false ||
      intentRecord.phase !== "intent" ||
      created.phase !== "created" ||
      verified.phase !== "verified" ||
      !UUID.test(intentRecord.operationId ?? "") ||
      created.operationId !== intentRecord.operationId ||
      verified.operationId !== intentRecord.operationId ||
      !isDeepStrictEqual(created.resource, verified.resource) ||
      ![baseline, intentRecord, created, verified].every(
        (item, index, all) => index === 0 || Date.parse(all[index - 1].at) <= Date.parse(item.at),
      )
    )
      fail("resource_receipt_invalid");
    const resource = verified.resource;
    if (kind === "bucket") {
      if (
        !object(resource) ||
        resource.name !== BUCKET ||
        resource.location !== "WEUR" ||
        resource.jurisdiction !== "default" ||
        !Number.isFinite(Date.parse(resource.creation_date)) ||
        !isDeepStrictEqual(intentRecord.request, {
          name: BUCKET,
          locationHint: "weur",
          storageClass: "Standard",
        })
      )
        fail("resource_receipt_invalid");
    } else if (
      !object(resource) ||
      !/^[a-f0-9]{32}$/u.test(resource.id ?? "") ||
      resource.name !== DNS ||
      resource.type !== "A" ||
      resource.content !== "192.0.2.1" ||
      resource.proxied !== true ||
      resource.ttl !== 1 ||
      !Number.isFinite(Date.parse(resource.created_on)) ||
      typeof resource.comment !== "string" ||
      !isDeepStrictEqual(intentRecord.request, {
        type: "A",
        name: DNS,
        content: "192.0.2.1",
        proxied: true,
        ttl: 1,
        comment: resource.comment,
      })
    )
      fail("resource_receipt_invalid");
    resources[kind] = resource;
  }
  return resources;
}

function selectedFields(value, names) {
  return Object.fromEntries(names.map((name) => [name, value?.[name]]));
}

async function verifyOwnedResources(read, owned, observedDns) {
  const [bucketResponse, dnsResponse] = await Promise.all([
    read(`/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`),
    read(`/zones/${ZONE}/dns_records/${owned.dns.id}`),
  ]);
  const bucketFields = ["name", "creation_date", "location", "jurisdiction"];
  const dnsFields = ["id", "name", "type", "content", "proxied", "ttl", "created_on", "comment"];
  if (
    !isDeepStrictEqual(
      selectedFields(bucketResponse.result, bucketFields),
      selectedFields(owned.bucket, bucketFields),
    ) ||
    !isDeepStrictEqual(
      selectedFields(dnsResponse.result, dnsFields),
      selectedFields(owned.dns, dnsFields),
    ) ||
    !Array.isArray(observedDns) ||
    observedDns.filter((item) => item?.name?.toLowerCase() === DNS).length !== 1 ||
    !isDeepStrictEqual(
      selectedFields(
        observedDns.find((item) => item?.id === owned.dns.id),
        dnsFields,
      ),
      selectedFields(owned.dns, dnsFields),
    )
  )
    fail("owned_resource_readback_mismatch");
}

/** A fresh read-only inventory verifies the already-created bucket/DNS and absent new Workers. */
export async function baseline(read, owned, { sha, root, run }) {
  if (!SHA.test(sha ?? "") || typeof root !== "string" || typeof run !== "function")
    fail("live_worker_source_unverified");
  const [zone, buckets, applications, existing, shared] = await Promise.all([
    zoneInventory(read),
    cursorPages(read, `/accounts/${ACCOUNT}/r2/buckets`, "bucket"),
    cursorPages(read, `/accounts/${ACCOUNT}/containers/applications?name=${SPIKE}`, "application"),
    Promise.all([AUTH, MAIL, SPIKE].map((name) => deployment(read, name))),
    Promise.all([CORE, GATEWAY, NATIVE, DATABASE, CUSTODY].map((name) => deployment(read, name))),
  ]);
  assertZonePreflight({ ...zone, dns: [] });
  await verifyOwnedResources(read, owned, zone.dns);
  if (
    buckets.filter((item) => item?.name === BUCKET).length !== 1 ||
    applications.some((item) => item?.name === SPIKE) ||
    existing.some(Boolean) ||
    shared.some((item) => item === null)
  )
    fail("development_resource_conflict");
  const names = [CORE, GATEWAY, NATIVE, DATABASE, CUSTODY];
  const sharedVersions = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index],
      current = shared[index];
    const view = await version(read, name, current.versionId);
    const message = view.annotations?.["workers/message"];
    const matched =
      typeof message === "string"
        ? /^(?:source|origin\/main) ([0-9a-f]{40});/u.exec(message)
        : null;
    if (!matched) fail("live_worker_source_unverified");
    try {
      await run("git", ["merge-base", "--is-ancestor", matched[1], sha], { cwd: root });
    } catch {
      fail("live_worker_source_unverified");
    }
    exactDeployment(await deployment(read, name), current);
    sharedVersions[name] = { ...current, source: matched[1] };
  }
  return {
    accountId: ACCOUNT,
    zoneId: ZONE,
    observedAt: new Date().toISOString(),
    sharedVersions,
    owned: { bucket: owned.bucket, dns: owned.dns },
    absent: { workers: [AUTH, MAIL, SPIKE], container: SPIKE, route: ROUTE },
  };
}

/** The only inherited credential is the explicitly supplied Cloudflare token. */
export async function runCommand(
  command,
  args,
  { cwd = process.cwd(), token = process.env.CLOUDFLARE_API_TOKEN, emptyEnvFile, guardPath } = {},
) {
  if (
    typeof emptyEnvFile !== "string" ||
    !isAbsolute(emptyEnvFile) ||
    typeof guardPath !== "string" ||
    !isAbsolute(guardPath)
  )
    fail("wrangler_env_guard_unavailable");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(env, {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
    OHMYHO_G1_EMPTY_ENV_FILE: emptyEnvFile,
    NODE_OPTIONS: `--import=${pathToFileURL(guardPath).href}`,
  });
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    return result.stdout;
  } catch {
    fail("release_command_failed");
  }
}

async function privateJournal(path, root, create = false) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("journal_path_invalid");
  const parent = await realpath(dirname(path)),
    checkout = await realpath(root),
    rel = relative(checkout, parent);
  if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) fail("journal_path_invalid");
  const directory = await stat(parent);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    (process.getuid && directory.uid !== process.getuid())
  )
    fail("journal_path_invalid");
  const flags = create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size > 1024 * 1024
    )
      fail("journal_path_invalid");
    return create
      ? []
      : (await handle.readFile("utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

async function append(path, entry) {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      fail("journal_path_invalid");
    await handle.writeFile(`${json(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function intent(path, records, step, work) {
  if (records.some((item) => item.step === step)) fail("step_requires_reconciliation");
  const id = randomUUID(),
    startedAt = new Date().toISOString();
  await append(path, { step, id, state: "intent", at: startedAt });
  let result;
  try {
    result = await work();
  } catch (error) {
    throw new DeploymentError(
      "step_outcome_unverified_reconcile_journal",
      error instanceof DeploymentError ? error.code : undefined,
    );
  }
  await append(path, { step, id, state: "verified", at: new Date().toISOString(), result });
  return result;
}

async function writeConfiguration(path, config) {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function scopedSource(config, name, main) {
  if (
    !object(config) ||
    config.name !== name ||
    config.account_id !== ACCOUNT ||
    config.main !== main ||
    config.workers_dev !== false ||
    config.preview_urls !== false
  )
    fail("worker_profile_invalid");
  return structuredClone(config);
}

async function configAt(root, path) {
  return parseJsonc(await readFile(join(root, path), "utf8"));
}

async function fixedConfiguration(root, stage, sha) {
  const profile = {
    auth: ["scripts/preview-spike/auth/authority.wrangler.jsonc", AUTH, "authority.mjs"],
    "mail-bootstrap": ["scripts/preview-spike/mail/wrangler.bootstrap.jsonc", MAIL, "./worker.mjs"],
    "mail-final": ["scripts/preview-spike/mail/wrangler.jsonc", MAIL, "./worker.mjs"],
    spike: ["scripts/preview-spike/worker/wrangler.jsonc", SPIKE, "./index.mjs"],
    native: [
      "apps/native-auth-runtime/wrangler.development.eu.jsonc",
      NATIVE,
      "src/worker-main.ts",
    ],
    database: [
      "apps/project-database-runtime/wrangler.development.eu.jsonc",
      DATABASE,
      "src/worker-main.ts",
    ],
    gateway: ["apps/mail-gateway/wrangler.development.jsonc", GATEWAY, "src/resend-worker.ts"],
    custody: [
      "apps/runtime-secret-delivery/wrangler.development.jsonc",
      CUSTODY,
      "src/worker-main.ts",
    ],
  }[stage];
  if (!profile) fail("stage_invalid");
  const [path, name, main] = profile;
  let config = scopedSource(await configAt(root, path), name, main);
  if (stage === "native") config = buildQaNativeRuntimeConfig(config);
  if (stage === "custody") {
    const { buildQaMailCustodyConfig } = await import("../mail/custody-config.mjs");
    config = buildQaMailCustodyConfig(config);
  }
  if (stage === "gateway") {
    const { buildQaMailGatewayConfig } = await import("../mail/gateway-config.mjs");
    config = buildQaMailGatewayConfig(config);
  }
  const directory = dirname(join(root, path));
  config.main = resolve(directory, config.main);
  if (stage === "spike") {
    if (
      !SHA.test(sha) ||
      !isDeepStrictEqual(config.routes, [{ pattern: ROUTE, zone_id: ZONE }]) ||
      !isDeepStrictEqual(config.r2_buckets, [{ binding: "BACKUP_BUCKET", bucket_name: BUCKET }]) ||
      config.containers?.length !== 1 ||
      config.containers[0].name !== SPIKE ||
      config.containers[0].class_name !== "PreviewSpike" ||
      config.containers[0].scheduling_policy !== "durable_object" ||
      !isDeepStrictEqual(config.containers[0].images, {
        fixture: { dockerfile: "./Dockerfile", build_context: "./build-context" },
      })
    )
      fail("spike_profile_invalid");
    delete config.routes;
    config.vars.SPIKE_SOURCE_REVISION = sha;
    config.containers[0].images.fixture = {
      dockerfile: resolve(directory, "Dockerfile"),
      build_context: resolve(directory, "build-context"),
    };
  }
  return { config, name, path: join(root, path) };
}

/** The checked-out bytes must still be the gated commit at each write boundary. */
export async function assertExactCheckout({ root, sha, run }) {
  if (!SHA.test(sha ?? "")) fail("release_source_changed");
  const first = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
  });
  const after = await run("git", ["rev-parse", "HEAD"], { cwd: root });
  if (first.trim() !== sha || after.trim() !== sha || status.trim() !== "")
    fail("release_source_changed");
}

async function sourceGate(run, cwd) {
  const repository = await inspectReleaseRepository({ cwd, run });
  const ciRun = await requireVerifiedCommit({
    sha: repository.sha,
    ref: repository.branch ?? "main",
    run,
    existingOnly: true,
  });
  return { ...repository, ciRun };
}

async function identity(read) {
  const [account, zone] = await Promise.all([read(`/accounts/${ACCOUNT}`), read(`/zones/${ZONE}`)]);
  if (
    account.result?.id !== ACCOUNT ||
    zone.result?.id !== ZONE ||
    zone.result?.name !== "omh.st" ||
    zone.result?.account?.id !== ACCOUNT
  )
    fail("provider_scope_mismatch");
}

function receiptRoutes(routes, name) {
  if (!Array.isArray(routes)) fail("routes_unavailable");
  return routes
    .filter((item) => item?.script === name)
    .map(({ id, pattern, script }) => ({ id, pattern, script }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function sharedSnapshot(read, name) {
  const current = await deployment(read, name);
  if (current === null) fail("shared_worker_missing");
  const [view, cron, routes] = await Promise.all([
    version(read, name, current.versionId),
    schedules(read, name),
    allRoutes(read),
  ]);
  return { ...current, view, cron, routes: receiptRoutes(routes, name) };
}

function exactDeployment(current, expected) {
  if (current?.versionId !== expected.versionId || current?.deploymentId !== expected.deploymentId)
    fail("worker_changed_concurrently");
}

async function assertUnchangedIngress(read, name, before) {
  const [cron, routes] = await Promise.all([schedules(read, name), allRoutes(read)]);
  if (
    !isDeepStrictEqual(cron, before.cron) ||
    !isDeepStrictEqual(receiptRoutes(routes, name), before.routes)
  )
    fail("shared_ingress_changed");
}

function requiredSecretNames(stage, env) {
  let names = [];
  if (stage === "spike") names = ["SPIKE_CONTROL_TOKEN"];
  if (stage === "activate-gateway") names = ["QA_NATIVE_PREVIEW_MAIL_SCOPE"];
  if (stage === "activate-auth") names = ["SPIKE_QA_MANIFEST"];
  if (stage === "activate-database") names = ["QA_DATABASE_MANIFEST"];
  if (stage === "activate-spike") names = ["SPIKE_QA_MANIFEST"];
  if (stage === "mail-final") names = ["QA_MAIL_SCOPE", "QA_MAIL_OPERATOR_TOKEN"];
  const result = {};
  for (const name of names) {
    const value = env[name];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 32_768 ||
      value.includes("\0")
    )
      fail("qa_private_input_missing");
    result[name] = value;
  }
  if (Object.hasOwn(result, "SPIKE_CONTROL_TOKEN") && result.SPIKE_CONTROL_TOKEN.length < 32)
    fail("qa_private_input_invalid");
  if (
    Object.hasOwn(result, "QA_MAIL_OPERATOR_TOKEN") &&
    result.QA_MAIL_OPERATOR_TOKEN !== env.SPIKE_CONTROL_TOKEN
  )
    fail("qa_private_input_invalid");
  return result;
}

function requireStages(records, stage, sha) {
  const first = records[0];
  if (first?.step !== "baseline" || first?.state !== "verified" || first.result?.sha !== sha)
    fail("journal_source_mismatch");
  const dependencies = {
    core: [],
    custody: ["core"],
    auth: ["core"],
    "mail-bootstrap": ["auth", "custody"],
    gateway: ["auth"],
    native: ["gateway"],
    database: ["core"],
    spike: ["mail-bootstrap", "native", "database"],
    route: ["spike"],
    "activate-auth": ["route"],
    "activate-database": ["activate-auth"],
    "activate-spike": ["activate-database"],
    "activate-gateway": ["activate-spike"],
    "mail-final": ["activate-gateway"],
  }[stage];
  if (
    !dependencies ||
    dependencies.some(
      (step) => !records.some((item) => item.step === step && item.state === "verified"),
    )
  )
    fail("deployment_order_invalid");
  if (
    records.some(
      (item) =>
        item.state === "intent" &&
        !records.some(
          (other) => other.step === item.step && other.id === item.id && other.state === "verified",
        ),
    )
  )
    fail("step_requires_reconciliation");
}

async function privateScopeFromSpike(env, fetch) {
  const token = env.SPIKE_CONTROL_TOKEN;
  if (typeof token !== "string" || token.length < 32) fail("qa_private_input_missing");
  let response, value;
  try {
    response = await fetch("https://control.preview.dev.omh.st/__spike/qa-inventory", {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) fail("qa_inventory_unavailable");
    value = await response.json();
  } catch {
    fail("qa_inventory_unavailable");
  }
  return validateScopeManifest(value);
}

export function nativeScope(raw, manifest) {
  let scope;
  try {
    scope = JSON.parse(raw);
  } catch {
    fail("qa_native_mail_scope_invalid");
  }
  const selected = manifest.projects.find((item) => item.fixture === "next-native-auth");
  if (
    !object(scope) ||
    Object.keys(scope).sort().join(",") !==
      ["environmentId", "fixture", "organizationId", "platform", "projectId", "recipients"]
        .sort()
        .join(",") ||
    scope.platform !== "development" ||
    scope.fixture !== selected.fixture ||
    scope.organizationId !== selected.organizationId ||
    scope.projectId !== selected.projectId ||
    scope.environmentId !== selected.environmentId ||
    !Array.isArray(scope.recipients) ||
    scope.recipients.length < 2 ||
    scope.recipients.length > 8 ||
    scope.recipients.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 254 ||
        !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/u.test(value),
    ) ||
    new Set(scope.recipients.map((value) => value.toLowerCase())).size !== scope.recipients.length
  )
    fail("qa_native_mail_scope_invalid");
  return raw;
}

async function coreConfiguration({ root, sha, read, before }) {
  const bindings = before.view.resources.bindings;
  const core = bindings.filter((item) => item.name === "CONTROL_CORE" && item.type === "d1");
  const policy = bindings.filter(
    (item) => item.name === "CONTROL_NATIVE_AUTH_LAUNCH_POLICY" && item.type === "plain_text",
  );
  if (core.length !== 1 || policy.length !== 1 || !UUID.test(core[0].id ?? ""))
    fail("core_binding_unavailable");
  let nativeAuthLaunchPolicy;
  try {
    nativeAuthLaunchPolicy = JSON.parse(policy[0].text);
  } catch {
    fail("core_policy_unavailable");
  }
  const db = (await read(`/accounts/${ACCOUNT}/d1/database/${core[0].id}`)).result;
  assertControlCoreResourceIdentity(db, { databaseId: core[0].id, databaseName: db?.name });
  const { configuration } = await controlCoreWorkerConfiguration({
    repositoryRoot: root,
    sourceCommit: sha,
    environment: "development",
    accountId: ACCOUNT,
    databaseId: core[0].id,
    databaseName: db.name,
    nativeAuthLaunchPolicy,
  });
  // Existing Core may not hide a secret or extra service that the canonical release would remove.
  const declared = new Set([
    "CONTROL_CORE",
    ...Object.keys(configuration.vars),
    "CF_VERSION_METADATA",
  ]);
  if (bindings.some((item) => !declared.has(item.name)) || bindings.length !== declared.size)
    fail("core_profile_drift");
  verifyDeclaredVersionBindings(
    {
      d1_databases: configuration.d1_databases,
      vars: Object.fromEntries(
        Object.entries(configuration.vars).filter(
          ([name]) => name !== "CONTROL_CORE_RELEASE_SOURCE",
        ),
      ),
    },
    bindings,
  );
  return configuration;
}

async function imageApplication(read, view) {
  const image = assertSpikeImage(view);
  const namespace = view.resources.bindings.filter(
    (item) =>
      item.name === "SANDBOX" &&
      item.type === "durable_object_namespace" &&
      item.class_name === "PreviewSpike",
  );
  const apps = await cursorPages(
    read,
    `/accounts/${ACCOUNT}/containers/applications?name=${SPIKE}`,
    "application",
  );
  if (
    namespace.length !== 1 ||
    !/^[a-f0-9]{32}$/u.test(namespace[0].namespace_id ?? "") ||
    apps.length !== 1 ||
    apps[0].name !== SPIKE ||
    apps[0].account_id !== ACCOUNT ||
    apps[0].scheduling_policy !== "durable_object" ||
    apps[0].durable_objects?.namespace_id !== namespace[0].namespace_id ||
    !RESOURCE_ID.test(apps[0].id ?? "")
  )
    fail("spike_application_unverified");
  return { applicationId: apps[0].id, namespaceId: namespace[0].namespace_id, image };
}

export async function upload({ stage, root, sha, read, run, wrangler, env, directory, expected }) {
  const activation = stage.startsWith("activate-");
  const baseStage = activation ? stage.slice("activate-".length) : stage;
  const shared =
    ["core", "gateway", "native", "database", "custody"].includes(baseStage) ||
    activation ||
    stage === "mail-final";
  const name =
    baseStage === "core"
      ? CORE
      : baseStage === "auth"
        ? AUTH
        : baseStage === "spike"
          ? SPIKE
          : baseStage === "database"
            ? DATABASE
            : baseStage === "gateway"
              ? GATEWAY
              : baseStage === "native"
                ? NATIVE
                : baseStage === "custody"
                  ? CUSTODY
                  : MAIL;
  const before = shared ? await sharedSnapshot(read, name) : null;
  if (before) exactDeployment(before, expected);
  if (!shared && (await deployment(read, name)) !== null) fail("worker_creation_conflict");
  let config, configSource;
  if (stage === "core") {
    config = await coreConfiguration({ root, sha, read, before });
    configSource = join(root, "apps/control-store/wrangler.jsonc");
  } else {
    const profile = await fixedConfiguration(root, baseStage, sha);
    config = profile.config;
    configSource = profile.path;
  }
  if (["core", "gateway", "native", "database", "custody"].includes(baseStage))
    await buildWorkerPackages({ configPath: configSource, repositoryRoot: root, run });
  if (baseStage === "spike")
    await run("node", [join(root, "scripts/preview-spike/worker/prepare-context.mjs")], {
      cwd: root,
    });
  if (stage === "activate-spike") {
    const image = assertSpikeImage(before.view);
    config.containers[0].images.fixture = { image };
  }
  const secrets = requiredSecretNames(stage, env);
  const configPath = join(directory, "wrangler.json"),
    secretsPath = join(directory, "secrets.json");
  await writeConfiguration(configPath, config);
  if (Object.keys(secrets).length)
    await writeFile(secretsPath, json(secrets), { flag: "wx", mode: 0o600 });
  if (stage === "core")
    await requireCoreSchemaHead({
      configPath,
      sourceCommit: sha,
      repositoryRoot: root,
      run,
      wrangler,
    });
  if (before) {
    exactDeployment(await deployment(read, name), before);
    await assertUnchangedIngress(read, name, before);
  }
  const identity = workerReleaseIdentity({ sha, configuration: config });
  const tag = identity.tag,
    message = `${identity.message}; g1 ${stage}`;
  const common = ["--name", name, "--config", configPath];
  await assertExactCheckout({ root, sha, run });
  await run(
    wrangler,
    [
      ...(shared ? ["versions", "upload"] : ["deploy"]),
      "--tag",
      tag,
      "--message",
      message,
      ...(shared ? ["--keep-vars"] : []),
      ...(Object.keys(secrets).length ? ["--secrets-file", secretsPath] : []),
      ...common,
    ],
    { cwd: root },
  );
  await assertExactCheckout({ root, sha, run });
  const list = JSON.parse(
    await run(wrangler, ["versions", "list", "--json", ...common], { cwd: root }),
  );
  const matches = Array.isArray(list)
    ? list.filter(
        (item) =>
          item?.annotations?.["workers/tag"] === tag &&
          item?.annotations?.["workers/message"] === message,
      )
    : [];
  if (matches.length !== 1 || !UUID.test(matches[0].id ?? "")) fail("uploaded_version_unverified");
  const versionId = matches[0].id,
    view = await version(read, name, versionId);
  if (
    view.annotations?.["workers/tag"] !== tag ||
    view.annotations?.["workers/message"] !== message
  )
    fail("uploaded_version_unverified");
  verifyDeclaredVersionBindings(config, view.resources.bindings);
  for (const secret of Object.keys(secrets)) {
    const matches = view.resources.bindings.filter(
      (item) => item.name === secret && item.type === "secret_text",
    );
    if (matches.length !== 1) fail("secret_binding_unverified");
  }
  if (before) {
    const changed = stage === "core" ? ["CONTROL_CORE_RELEASE_SOURCE"] : [];
    assertSharedBindingsPreserved(before.view.resources.bindings, view.resources.bindings, changed);
    exactDeployment(await deployment(read, name), before);
    await assertUnchangedIngress(read, name, before);
    await assertExactCheckout({ root, sha, run });
    await run(
      wrangler,
      ["versions", "deploy", `${versionId}@100%`, "--yes", "--message", message, ...common],
      { cwd: root },
    );
  }
  await assertExactCheckout({ root, sha, run });
  const current = await deployment(read, name);
  if (current?.versionId !== versionId) fail("worker_deployment_unverified");
  if (before) await assertUnchangedIngress(read, name, before);
  const container = baseStage === "spike" ? await imageApplication(read, view) : undefined;
  if (stage === "activate-spike" && container.image !== assertSpikeImage(before.view))
    fail("spike_image_changed");
  return {
    worker: name,
    versionId,
    deploymentId: current.deploymentId,
    source: sha,
    tag,
    ...(before
      ? { previousVersionId: before.versionId, previousDeploymentId: before.deploymentId }
      : {}),
    ...(container ? { container } : {}),
  };
}

function mailScope(raw, manifest) {
  let scope;
  try {
    scope = JSON.parse(raw);
  } catch {
    fail("qa_mail_scope_invalid");
  }
  const selected = manifest.projects.find((item) => item.fixture === "next-app-mail");
  const keys = [
    "platform",
    "fixture",
    "organizationId",
    "projectId",
    "environmentId",
    "handle",
    "origin",
    "principalId",
    "devAccessEpoch",
    "recipient",
  ];
  if (
    !object(scope) ||
    Object.keys(scope).sort().join(",") !== keys.sort().join(",") ||
    scope.platform !== "development" ||
    [
      "fixture",
      "organizationId",
      "projectId",
      "environmentId",
      "handle",
      "origin",
      "principalId",
      "devAccessEpoch",
    ].some((name) => scope[name] !== selected[name]) ||
    typeof scope.recipient !== "string" ||
    scope.recipient.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/u.test(scope.recipient)
  )
    fail("qa_mail_scope_invalid");
  return raw;
}

/** Create only the absent fixed route after rechecking ownership, TLS and the active Worker. */
export async function createRoute(read, initial, expected) {
  const zone = await zoneInventory(read);
  assertZonePreflight({ ...zone, dns: [] });
  await verifyOwnedResources(read, initial.owned, zone.dns);
  const current = await deployment(read, SPIKE);
  if (
    current?.versionId !== expected?.versionId ||
    current?.deploymentId !== expected?.deploymentId
  )
    fail("worker_changed_concurrently");
  const created = (
    await read(`/zones/${ZONE}/workers/routes`, {
      method: "POST",
      body: { pattern: ROUTE, script: SPIKE },
    })
  ).result;
  if (
    !/^[a-f0-9]{32}$/u.test(created?.id ?? "") ||
    created.pattern !== ROUTE ||
    created.script !== SPIKE
  )
    fail("route_creation_unverified");
  const routes = await allRoutes(read);
  const matches = routes.filter((item) => isOverlappingRoute(item?.pattern));
  if (
    matches.length !== 1 ||
    matches[0].id !== created.id ||
    matches[0].pattern !== ROUTE ||
    matches[0].script !== SPIKE
  )
    fail("route_creation_unverified");
  return { routeId: created.id, pattern: ROUTE, worker: SPIKE };
}

/** Route receipts also name a Worker; only a version receipt can establish its predecessor. */
export function expectedWorkerDeployment(records, sharedVersions, target) {
  const last = [...records]
    .reverse()
    .find(
      (item) =>
        item.state === "verified" &&
        item.result?.worker === target &&
        item.result?.versionId !== undefined,
    )?.result;
  const expected = last ?? sharedVersions[target];
  if (
    expected !== undefined &&
    (!UUID.test(expected.versionId ?? "") || !RESOURCE_ID.test(expected.deploymentId ?? ""))
  )
    fail("worker_deployment_unavailable");
  return expected === undefined
    ? undefined
    : { versionId: expected.versionId, deploymentId: expected.deploymentId };
}

/** Recheck the authenticated control origin's route and active version before sending a secret. */
export async function verifyControlTarget(read, records) {
  const route = records.find((item) => item.step === "route" && item.state === "verified")?.result;
  const expected = expectedWorkerDeployment(records, {}, SPIKE);
  if (
    !route ||
    !/^[a-f0-9]{32}$/u.test(route.routeId ?? "") ||
    route.pattern !== ROUTE ||
    route.worker !== SPIKE ||
    expected === undefined
  )
    fail("control_target_unverified");
  const [routes, current] = await Promise.all([allRoutes(read), deployment(read, SPIKE)]);
  const matches = routes.filter((item) => isOverlappingRoute(item?.pattern));
  if (
    matches.length !== 1 ||
    matches[0].id !== route.routeId ||
    matches[0].pattern !== ROUTE ||
    matches[0].script !== SPIKE ||
    current?.deploymentId !== expected.deploymentId ||
    current?.versionId !== expected.versionId
  )
    fail("control_target_unverified");
}

/** One source/CI-gated Development action. The runner performs no outer retry or deletion. */
export async function execute(options) {
  const directory = await mkdtemp(join(tmpdir(), "ohmyho-g1-wrangler-env-"));
  await chmod(directory, 0o700);
  try {
    const emptyEnvFile = join(directory, "empty.env");
    await writeFile(emptyEnvFile, "", { flag: "wx", mode: 0o600 });
    const guardPath = resolve(
      options.cwd ?? process.cwd(),
      "scripts/preview-spike/deployment/wrangler-guard.mjs",
    );
    return await executeGuarded(options, { emptyEnvFile, guardPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executeGuarded(
  {
    stage,
    journalPath,
    resourcesPath,
    cwd = process.cwd(),
    env = process.env,
    fetch = globalThis.fetch,
  },
  guard,
) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || token.length === 0) fail("cloudflare_token_required");
  if (env.CLOUDFLARE_ACCOUNT_ID !== undefined && env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT)
    fail("provider_scope_mismatch");
  const run = (command, args, options = {}) =>
    runCommand(command, args, { ...options, ...guard, token });
  const repository = await sourceGate(run, cwd);
  const root = repository.repositoryRoot;
  const wrangler = join(root, "scripts/preview-spike/worker/node_modules/.bin/wrangler");
  if ((await run(wrangler, ["--version"], { cwd: root })).trim() !== "4.158.0")
    fail("wrangler_version_invalid");
  const read = provider({ token, fetch });
  await identity(read);
  if (typeof journalPath !== "string" || !isAbsolute(journalPath)) fail("journal_path_invalid");
  const lockPath = `${journalPath}.lock`;
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail("journal_locked");
  }
  try {
    if (stage === "baseline") {
      const owned = validateOwnedResources(await privateJournal(resourcesPath, root));
      await privateJournal(journalPath, root, true);
      const result = await baseline(read, owned, { sha: repository.sha, root, run });
      const record = {
        step: "baseline",
        state: "verified",
        at: new Date().toISOString(),
        result: { ...result, sha: repository.sha, ciRun: repository.ciRun },
      };
      await append(journalPath, record);
      return record.result;
    }
    const records = await privateJournal(journalPath, root);
    requireStages(records, stage, repository.sha);
    const initial = records[0].result;
    const dns = await numberedPages(
      read,
      `/zones/${ZONE}/dns_records?name=${encodeURIComponent(DNS)}`,
    );
    await verifyOwnedResources(read, initial.owned, dns);
    if (stage === "route") {
      return intent(journalPath, records, stage, async () => {
        const expected = records.find(
          (item) => item.step === "spike" && item.state === "verified",
        )?.result;
        return createRoute(read, initial, expected);
      });
    }
    const stages = [
      "core",
      "custody",
      "auth",
      "mail-bootstrap",
      "gateway",
      "native",
      "database",
      "spike",
      "activate-auth",
      "activate-database",
      "activate-spike",
      "activate-gateway",
      "mail-final",
    ];
    if (!stages.includes(stage)) fail("stage_invalid");
    const stageEnv = { ...env };
    let scopeHash;
    if (stage.startsWith("activate-") || stage === "mail-final") {
      await verifyControlTarget(read, records);
      const manifest = await privateScopeFromSpike(env, fetch);
      await verifyControlTarget(read, records);
      const serialized = json(manifest);
      scopeHash = hash(serialized);
      const prior = records.find(
        (item) => item.step === "activate-auth" && item.state === "verified",
      )?.result?.scopeHash;
      if (prior !== undefined && prior !== scopeHash) fail("qa_scope_changed");
      if (["activate-auth", "activate-spike"].includes(stage))
        stageEnv.SPIKE_QA_MANIFEST = serialized;
      if (stage === "activate-database") stageEnv.QA_DATABASE_MANIFEST = serialized;
      if (stage === "activate-gateway")
        stageEnv.QA_NATIVE_PREVIEW_MAIL_SCOPE = nativeScope(
          env.QA_NATIVE_PREVIEW_MAIL_SCOPE,
          manifest,
        );
      if (stage === "mail-final") stageEnv.QA_MAIL_SCOPE = mailScope(env.QA_MAIL_SCOPE, manifest);
    }
    const base = stage.startsWith("activate-") ? stage.slice(9) : stage;
    const target = {
      core: CORE,
      custody: CUSTODY,
      auth: AUTH,
      "mail-bootstrap": MAIL,
      "mail-final": MAIL,
      gateway: GATEWAY,
      native: NATIVE,
      database: DATABASE,
      spike: SPIKE,
    }[base];
    const expected = expectedWorkerDeployment(records, initial.sharedVersions, target);
    return await intent(journalPath, records, stage, async () => {
      const directory = await mkdtemp(join(tmpdir(), "ohmyho-preview-g1-"));
      await chmod(directory, 0o700);
      try {
        const result = await upload({
          stage,
          root,
          sha: repository.sha,
          read,
          run,
          wrangler,
          env: stageEnv,
          directory,
          expected,
        });
        return scopeHash === undefined ? result : { ...result, scopeHash };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
