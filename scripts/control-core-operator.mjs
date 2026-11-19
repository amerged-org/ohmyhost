#!/usr/bin/env node
/* global console, process */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openRemoteControlCoreTarget } from "./control-core-remote-target.mjs";
import {
  controlCoreCloudflareClient,
  observeControlCoreResource,
} from "./control-core-resource.mjs";
import { CONTROL_CORE_WORKER_PROFILES } from "./control-core-worker-profile.mjs";
import { prepareControlCoreDeployment } from "./prepare-control-core-deployment.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";
import { inspectReleaseRepository, requireVerifiedCommit } from "./platform-release.mjs";

const ACCOUNT = /^[a-f0-9]{32}$/u;
const usage =
  "usage: control-core-operator observe|migrate|upgrade --environment development|production [--custody <private-directory> --confirm <environment>]";

/** The fixed EU Core resource of one environment, exactly as the train manifest's `core` block names it. */
export async function observeFixedCore(
  { accountId, environment },
  { request = controlCoreCloudflareClient() } = {},
) {
  const database = await observeControlCoreResource({ accountId, environment }, request);
  if (database === null) throw new Error("The fixed Core database does not exist");
  return Object.freeze({
    environment,
    databaseName: database.name,
    databaseId: database.uuid,
    jurisdiction: database.jurisdiction,
    readReplication: database.read_replication.mode,
  });
}

/**
 * The certified remote binding of the fixed EU Core: the resource observed by exact name, the deployment packet of the
 * inspected commit, and the committed random challenge read back through the provider API. A Core that carries data, an
 * activation or another revision's schema receipt refuses here.
 */
export async function openFixedCoreTarget(
  { accountId, environment, custody, repositoryRoot, upgrade = false },
  {
    request = controlCoreCloudflareClient(),
    inspect = inspectRehearsalRepository,
    inspectRelease = inspectReleaseRepository,
    verifyCommit = requireVerifiedCommit,
    open = openRemoteControlCoreTarget,
    now = () => new Date(),
  } = {},
) {
  const checked = await inspectRelease({ cwd: repositoryRoot });
  await verifyCommit({ sha: checked.sha, existingOnly: true });
  const database = await observeControlCoreResource({ accountId, environment }, request);
  if (database === null) throw new Error("The fixed Core database does not exist");
  const session = `${environment}-${now().toISOString().replace(/[-:.]/gu, "")}`;
  const contract = await prepareControlCoreDeployment(
    {
      accountId,
      environment,
      creationId: randomUUID(),
      output: join(resolve(custody), `${session}-packet`),
      repositoryRoot,
      resourceObservation: { accountId, observedAt: now().toISOString(), database },
    },
    { inspect },
  );
  if (contract.sourceCommit !== checked.sha)
    throw new Error("Core packet differs from the verified release source");
  const rechecked = await inspectRelease({ cwd: repositoryRoot });
  if (checked.sha !== rechecked.sha || checked.branch !== rechecked.branch)
    throw new Error("Core release source changed before mutation");
  const target = await open(
    { contract, repositoryRoot, output: join(resolve(custody), `${session}-remote`), upgrade },
    { request, inspect },
  );
  return Object.assign(target, { accountId, databaseId: database.uuid });
}

/**
 * Applies the checked-in migrations of the inspected commit to the EMPTY fixed Core and certifies the remote
 * binding. The commit must be a clean, verified pushed release source, so the schema receipt names the exact revision; a Core that
 * already carries another receipt, any data or an activation refuses (a new commit needs a new empty Core).
 * `upgrade: true` is the forward-only path of an existing Core, activated or not: only migrations added since its
 * recorded schema head are applied (journaled per migration), then the new head and fingerprint are recorded.
 */
export async function migrateFixedCore(
  { accountId, environment, custody, repositoryRoot, upgrade = false },
  dependencies = {},
) {
  const target = await openFixedCoreTarget(
    { accountId, environment, custody, repositoryRoot, upgrade },
    dependencies,
  );
  try {
    const { results } = await target.db
      .prepare(
        "SELECT type, count(*) AS n FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf*' GROUP BY type ORDER BY type",
      )
      .all();
    return Object.freeze({
      environment,
      sourceCommit: target.proof.sourceCommit,
      schemaSha256: target.proof.schemaSha256,
      authorityActivation: target.proof.authorityActivation,
      ...(target.proof.schemaUpgrade === undefined
        ? {}
        : { schemaUpgrade: target.proof.schemaUpgrade }),
      objects: Object.fromEntries(results.map(({ type, n }) => [type, n])),
    });
  } finally {
    await target.dispose();
  }
}

export function parseOperatorArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!["--environment", "--custody", "--confirm"].includes(flag) || !value || flag in options)
      throw new Error(usage);
    options[flag] = value;
  }
  const environment = options["--environment"];
  if (
    !["observe", "migrate", "upgrade"].includes(command) ||
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) ||
    (command === "observe" && ("--custody" in options || "--confirm" in options)) ||
    (command !== "observe" && (!options["--custody"] || options["--confirm"] !== environment))
  )
    throw new Error(usage);
  return { command, environment, custody: options["--custody"] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, environment, custody } = parseOperatorArguments(process.argv.slice(2));
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!ACCOUNT.test(accountId ?? "")) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
    const result =
      command === "observe"
        ? await observeFixedCore({ accountId, environment })
        : await migrateFixedCore({
            accountId,
            environment,
            custody,
            upgrade: command === "upgrade",
            repositoryRoot: (await inspectRehearsalRepository({ cwd: process.cwd() }))
              .repositoryRoot,
          });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Provider bodies and credentials never reach the output: only fixed tool codes and the usage line.
    const message = String(error?.message ?? "");
    console.error(
      message === usage ||
        /^(?:CONTROL_CORE|TARGET)_[A-Z_]+$/u.test(message) ||
        message.startsWith("The fixed Core")
        ? message
        : "Core operator command failed",
    );
    process.exitCode = 1;
  }
}
