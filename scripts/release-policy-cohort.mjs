/* global AbortSignal */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseJsonc } from "./platform-release.mjs";
import { releaseHash } from "./release-rehearsal-artifacts.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { CONTROL_CORE_CONFIG } from "./control-core-train.mjs";
import { createWorkerPresenceObserver } from "./release-worker-presence.mjs";

/**
 * The shared admission modules and independent egress declaration guards, including the build
 * runtime and every contract file its image copies. All policy consumers must enforce these bytes.
 */
export const POLICY_SOURCES = Object.freeze([
  "packages/contracts/src/framework-build-script.mjs",
  "packages/contracts/src/framework-admission.ts",
  "packages/contracts/src/framework-source-rules.ts",
  "packages/contracts/src/framework-family.ts",
  "packages/contracts/src/customer-auth-admission.ts",
  "packages/contracts/src/browser-capabilities.ts",
  "packages/contracts/src/egress-origin.ts",
  "packages/contracts/src/index.ts",
  "packages/platform/src/modules/frameworks/framework-plan.ts",
  "apps/build-runner/sandbox/build-runtime.mjs",
]);

/**
 * Checked-in configs of the Workers that enforce the policy; declared containers follow them. The shared
 * Core bundles the framework-admission and browser-capability modules, so it enforces the policy in both
 * environments; its template is environment-neutral, so its Worker name comes from the closed Core profile.
 */
export const POLICY_CONSUMER_CONFIGS = Object.freeze({
  development: Object.freeze([
    "apps/build-runner/wrangler.development.jsonc",
    "apps/source-fetcher/wrangler.development.jsonc",
    "apps/control-api/wrangler.jsonc",
    CONTROL_CORE_CONFIG,
  ]),
  production: Object.freeze([
    "apps/build-runner/wrangler.production.jsonc",
    "apps/source-fetcher/wrangler.production.jsonc",
    "apps/control-api/wrangler.production.jsonc",
    CONTROL_CORE_CONFIG,
  ]),
});

const TOOL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENVIRONMENTS = Object.freeze(["development", "production"]);
const SUFFIX = Object.freeze({ development: "-poc-private-fullstack", production: "-production" });
const UNKNOWN = "unknown";
const COMMIT = /^[a-f0-9]{40}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const WORKER = /^ohmyho(?:st)?-[a-z0-9-]+-(?:poc-private-fullstack|production)$/u;
const APPLICATION = /^[a-z0-9][a-z0-9-]{0,99}$/u;
// The release tools write these sources into Worker version messages and container rollouts.
const RELEASE_SOURCE = /^(?:source|origin\/main) ([a-f0-9]{40});/u;
const ROLLOUT_SOURCE = /^(?:source|origin\/main) ([a-f0-9]{40}); image (\S+)$/u;
const REFUSALS = Object.freeze({
  missing: (environment, names, workers) =>
    `Release policy cohort refused: ${environment} consumers ${names} differ from the release policy; add Worker steps for ${workers} to this train`,
  development: (environment, names, workers) =>
    `Release policy cohort refused: ${environment} consumers ${names} differ from the release policy; release ${workers} in development first`,
  incomplete: (environment, names) =>
    `Release policy cohort incomplete: ${environment} consumers ${names} still differ from the release policy after the steps; resume the original private state after readback`,
});

/** The one train refusal the CLI prints: a fixed sentence with Worker/application names only. */
export class PolicyCohortError extends Error {
  constructor(reason, environment, consumers) {
    const names = [...new Set(consumers.map(({ name }) => name))].sort();
    const workers = [...new Set(consumers.map(({ workerName }) => workerName))].sort();
    if (
      !Object.hasOwn(REFUSALS, reason) ||
      !ENVIRONMENTS.includes(environment) ||
      names.length === 0 ||
      [...names, ...workers].some((name) => !APPLICATION.test(name ?? ""))
    )
      throw new Error("Release policy cohort refusal is invalid");
    super(REFUSALS[reason](environment, names.join(", "), workers.join(", ")));
    this.name = "PolicyCohortError";
  }
}

/**
 * sha256 over the ordered [path, sha256] pairs of the policy sources at a commit, read from local
 * Git objects only: no fetch, credential or provider. Every source must be one regular file.
 */
export async function fingerprintAt({ sha, repositoryRoot, run }) {
  if (!COMMIT.test(sha ?? "")) throw new Error("Release policy commit is invalid");
  const git = (args) => run("git", args, { cwd: repositoryRoot, localOnly: true });
  const listed = (
    await git(["ls-tree", "-z", "--full-tree", `${sha}^{commit}`, "--", ...POLICY_SOURCES])
  )
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => /^(?:100644|100755) blob [a-f0-9]{40,64}\t(.+)$/su.exec(entry)?.[1]);
  if (
    listed.length !== POLICY_SOURCES.length ||
    POLICY_SOURCES.some((path) => !listed.includes(path))
  )
    throw new Error("Release policy source is not one regular file at the commit");
  const pairs = [];
  for (const path of POLICY_SOURCES)
    pairs.push([path, releaseHash(await git(["show", `${sha}:${path}`]))]);
  return releaseHash(JSON.stringify(pairs));
}

/** The policy consumers of one environment, derived from the checked-in Wrangler configs. */
export async function policyConsumers({ environment, repositoryRoot = TOOL_ROOT, accountId }) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error("Release policy environment is invalid");
  const consumers = [];
  for (const config of POLICY_CONSUMER_CONFIGS[environment]) {
    if (config === CONTROL_CORE_CONFIG) {
      consumers.push({
        workerName: CONTROL_CORE_WORKER_PROFILES[environment],
        config,
        accountId,
        containers: [],
        core: true,
      });
      continue;
    }
    let configuration;
    try {
      configuration = parseJsonc(await readFile(join(repositoryRoot, config), "utf8"));
    } catch {
      throw new Error("Release policy consumer configuration is unavailable");
    }
    const containers = configuration?.containers ?? [];
    if (
      !WORKER.test(configuration?.name ?? "") ||
      !configuration.name.endsWith(SUFFIX[environment]) ||
      !ACCOUNT.test(configuration.account_id ?? "") ||
      !Array.isArray(containers) ||
      containers.some(
        (container) =>
          container === null ||
          typeof container !== "object" ||
          !APPLICATION.test(container.name ?? ""),
      ) ||
      new Set(containers.map(({ name }) => name)).size !== containers.length
    )
      throw new Error("Release policy consumer configuration is invalid");
    consumers.push({
      workerName: configuration.name,
      config,
      accountId: configuration.account_id,
      containers: containers.map(({ name }) => name),
    });
  }
  return consumers;
}

/**
 * A step releases a policy consumer's configuration when it is that checked-in profile or a private derivation of it:
 * an ignored `.env.<label>.json` file beside it (same application directory, so the same code). A derivation exists
 * because a write stop pauses a Worker's crons, and the train refuses a declared cron list that differs from the live one.
 */
export const releasesPolicyConfig = (stepConfig, policyConfig) =>
  stepConfig === policyConfig ||
  (dirname(stepConfig) === dirname(policyConfig) &&
    /^\.env\.[A-Za-z0-9._-]+\.json$/u.test(basename(stepConfig)));

const covers = (manifest, { workerName, config }) =>
  manifest.steps.some(
    (step) =>
      step.kind === "worker" &&
      step.workerName === workerName &&
      releasesPolicyConfig(step.config, config),
  );

/**
 * A manifest step for a policy consumer must release that consumer's policy configuration; checked when the manifest is
 * built and prepared, so a mismatch fails there and never after a write stop has begun.
 */
export async function assertPolicyStepConfigs({ manifest, repositoryRoot = TOOL_ROOT }) {
  const consumers = await policyConsumers({
    environment: manifest.environment,
    repositoryRoot,
    accountId: manifest.accountId,
  });
  for (const step of manifest.steps) {
    if (step.kind !== "worker") continue;
    const consumer = consumers.find(({ workerName }) => workerName === step.workerName);
    if (consumer !== undefined && !releasesPolicyConfig(step.config, consumer.config))
      throw new Error(
        `Release policy consumer ${step.workerName} must release ${consumer.config} or a private .env derivation beside it`,
      );
  }
}

/**
 * Standalone releases skip rehearsal, approval and the cohort, so policy consumers refuse them. The Core
 * alone may be created standalone, which only the release itself can know (its Worker is absent).
 */
export async function requirePolicyTrain({ workerName, repositoryRoot = TOOL_ROOT }) {
  for (const environment of ENVIRONMENTS)
    for (const consumer of await policyConsumers({ environment, repositoryRoot }))
      if (consumer.workerName === workerName && consumer.core !== true)
        throw new Error(
          "Policy consumer Workers release only through release:train with an approved rehearsal",
        );
}

/**
 * GET-only Cloudflare readback with Wrangler's own login. The token stays in this closure and every
 * failure is a fixed sentence, because provider bodies and command output can hold credentials.
 */
export async function providerReader({ run, wrangler, fetch = globalThis.fetch, label }) {
  let credential;
  try {
    credential = JSON.parse(await run(wrangler, ["auth", "token", "--json"]));
  } catch {
    throw new Error(`Release ${label} readback credential is unavailable`);
  }
  if (
    !["api_token", "oauth"].includes(credential?.type) ||
    typeof credential.token !== "string" ||
    credential.token.length === 0
  )
    throw new Error(`Release ${label} readback credential is invalid`);
  return async (path, { paginated = false, completeList = false } = {}) => {
    if (paginated && completeList) throw new Error(`Release ${label} list contract is invalid`);
    const result = [];
    for (let page = 1; page <= 100; page += 1) {
      const query = paginated ? `${path.includes("?") ? "&" : "?"}page=${page}&per_page=100` : "";
      let response;
      try {
        response = await fetch(`https://api.cloudflare.com/client/v4${path}${query}`, {
          headers: { authorization: `Bearer ${credential.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error(`Release ${label} readback request is unavailable`);
      }
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.success !== true || value.result === undefined)
        throw new Error(`Release ${label} readback failed`);
      if (!paginated) {
        if (completeList) {
          const info = value.result_info;
          const optionalCount = (count) =>
            count === undefined || (Number.isSafeInteger(count) && count === value.result.length);
          if (
            !Array.isArray(value.result) ||
            (info !== undefined &&
              info !== null &&
              (typeof info !== "object" ||
                Array.isArray(info) ||
                Object.keys(info).some(
                  (key) =>
                    ![
                      "page",
                      "per_page",
                      "count",
                      "total_count",
                      "total_pages",
                      "cursor",
                      "cursors",
                    ].includes(key),
                ) ||
                !optionalCount(info.count) ||
                !optionalCount(info.total_count) ||
                (info.page !== undefined && info.page !== 1) ||
                (info.total_pages !== undefined &&
                  info.total_pages !== 1 &&
                  !(info.total_pages === 0 && value.result.length === 0)) ||
                (info.per_page !== undefined &&
                  (!Number.isSafeInteger(info.per_page) ||
                    info.per_page < 1 ||
                    value.result.length > info.per_page ||
                    (value.result.length === info.per_page &&
                      info.total_count === undefined &&
                      info.total_pages === undefined))) ||
                (info.cursor !== undefined && info.cursor !== null && info.cursor !== "") ||
                (info.cursors !== undefined &&
                  info.cursors !== null &&
                  (typeof info.cursors !== "object" ||
                    Array.isArray(info.cursors) ||
                    Object.keys(info.cursors).some((key) => !["before", "after"].includes(key)) ||
                    Object.values(info.cursors).some(
                      (cursor) => cursor !== null && cursor !== "",
                    )))))
          )
            throw new Error(`Release ${label} complete list is invalid or incomplete`);
        }
        return value.result;
      }
      if (!Array.isArray(value.result)) throw new Error(`Release ${label} list is invalid`);
      result.push(...value.result);
      const pages = value.result_info?.total_pages;
      if (
        pages !== undefined &&
        (!Number.isInteger(pages) ||
          pages < 0 ||
          pages > 100 ||
          (pages === 0 && value.result.length !== 0))
      )
        throw new Error(`Release ${label} pagination is invalid`);
      if (
        (pages !== undefined && page >= pages) ||
        (pages === undefined && value.result.length < 100)
      )
        return result;
    }
    throw new Error(`Release ${label} list exceeded its pagination bound`);
  };
}

/** The single version at 100% names its source commit; split or foreign deployments are unknown. */
async function liveWorkerPolicy({ read, accountId, workerName, fingerprint }) {
  const script = `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`;
  // The provider lists the deployment that serves traffic first.
  const deployments = (await read(`${script}/deployments`))?.deployments;
  const versions = Array.isArray(deployments) ? deployments[0]?.versions : undefined;
  if (
    !Array.isArray(versions) ||
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    !UUID.test(versions[0]?.version_id ?? "")
  )
    return UNKNOWN;
  const version = await read(`${script}/versions/${versions[0].version_id}`);
  const message = version?.annotations?.["workers/message"];
  const source =
    version?.id === versions[0].version_id && typeof message === "string"
      ? RELEASE_SOURCE.exec(message)
      : null;
  return source === null ? UNKNOWN : fingerprint(source[1]);
}

/** The completed rollout to the live version names its commit and the image the app runs. */
async function liveContainerPolicy({ read, accountId, application, fingerprint }) {
  const path = `/accounts/${accountId}/containers/applications`;
  const apps = await read(`${path}?name=${encodeURIComponent(application)}`);
  const listed = Array.isArray(apps) && apps.length === 1 ? apps[0] : null;
  if (listed?.name !== application || !UUID.test(listed.id ?? "")) return UNKNOWN;
  // The name-filtered LIST can retain a previous version/image after rollout completion. Use it
  // only for unique identity, then bind the authoritative GET to that same name and UUID.
  const app = await read(`${path}/${listed.id}`);
  if (
    app?.id !== listed.id ||
    app.name !== listed.name ||
    !Number.isSafeInteger(app.version) ||
    app.version < 1 ||
    typeof app.configuration?.image !== "string" ||
    !/^\S+$/u.test(app.configuration.image)
  )
    return UNKNOWN;
  const rollouts = await read(`${path}/${app.id}/rollouts`);
  const completed = Array.isArray(rollouts)
    ? rollouts.filter(
        (rollout) => rollout?.status === "completed" && rollout.target_version === app.version,
      )
    : [];
  const source =
    completed.length === 1 ? ROLLOUT_SOURCE.exec(completed[0].description ?? "") : null;
  return source !== null && source[2] === app.configuration?.image
    ? fingerprint(source[1])
    : UNKNOWN;
}

/**
 * Live policy of every consumer in the train's environment and, for Production, in Development:
 * the fingerprint at the commit that a Worker's version message or an application's completed
 * rollout to its live version names. Unknown values never equal a target.
 */
export async function observePolicyCohort({
  manifest,
  repositoryRoot,
  run,
  wrangler,
  fetch = globalThis.fetch,
}) {
  if (!ENVIRONMENTS.includes(manifest.environment))
    throw new Error("Release policy environment is invalid");
  const policySha256 = await fingerprintAt({ sha: manifest.sourceCommit, repositoryRoot, run });
  const read = await providerReader({ run, wrangler, fetch, label: "policy cohort" });
  const fingerprints = new Map([[manifest.sourceCommit, policySha256]]);
  const fingerprint = async (sha) => {
    // A commit missing from local history or lacking a source cannot prove its policy.
    if (!fingerprints.has(sha))
      fingerprints.set(sha, await fingerprintAt({ sha, repositoryRoot, run }).catch(() => UNKNOWN));
    return fingerprints.get(sha);
  };
  const consumers = [];
  let presence;
  for (const environment of manifest.environment === "production"
    ? ["production", "development"]
    : ["development"])
    for (const consumer of await policyConsumers({
      environment,
      repositoryRoot,
      accountId: manifest.accountId,
    })) {
      if (consumer.accountId !== manifest.accountId)
        throw new Error("Release policy consumer belongs to another Cloudflare account");
      const { workerName, config, accountId } = consumer;
      // A Core that does not exist yet has no stale policy; its creation is a separate gated step.
      if (consumer.core === true) {
        presence ??= await createWorkerPresenceObserver({ run, wrangler, fetch });
        if ((await presence({ accountId, workerName })).kind === "absent") continue;
      }
      const base = { environment, workerName, config, target: policySha256 };
      consumers.push({
        ...base,
        name: workerName,
        live: await liveWorkerPolicy({ read, accountId, workerName, fingerprint }),
      });
      for (const application of consumer.containers)
        consumers.push({
          ...base,
          name: application,
          live: await liveContainerPolicy({ read, accountId, application, fingerprint }),
        });
    }
  return { policySha256, consumers };
}

/**
 * Before any change, every consumer of the train's environment that differs from the release
 * policy must be released by a Worker step of this train (containers by their BuildRunner step),
 * and Production requires Development at the release policy already. After the steps, every
 * consumer of the environment must be at the release policy. Fingerprints decide, never Git
 * revisions: unrelated services at other revisions with identical policy bytes pass.
 */
export function requirePolicyCohort({ manifest, observation, phase }) {
  const differs = ({ live, target }) => live !== target;
  const own = observation.consumers.filter(
    ({ environment }) => environment === manifest.environment,
  );
  if (phase === "after") {
    const lagging = own.filter(differs);
    if (lagging.length > 0)
      throw new PolicyCohortError("incomplete", manifest.environment, lagging);
  } else {
    const development = observation.consumers.filter(
      (consumer) =>
        manifest.environment === "production" &&
        consumer.environment === "development" &&
        differs(consumer),
    );
    if (development.length > 0)
      throw new PolicyCohortError("development", "development", development);
    const missing = own.filter((consumer) => differs(consumer) && !covers(manifest, consumer));
    if (missing.length > 0) throw new PolicyCohortError("missing", manifest.environment, missing);
  }
  return {
    policySha256: observation.policySha256,
    consumers: own.map(({ name }) => name).sort(),
  };
}
