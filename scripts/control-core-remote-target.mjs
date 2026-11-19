import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readPrivate, writeExclusive } from "./control-d1-artifacts.mjs";
import { canonical, sha256 } from "./control-d1-codec.mjs";
import {
  initializeUnservedTargetSchema,
  upgradeCoreSchema,
  schemaFingerprint,
} from "./control-d1-target.mjs";
import { assertControlCoreWorkerConfiguration } from "./control-core-worker-profile.mjs";
import {
  assertControlCoreResource,
  controlCoreCloudflareClient,
} from "./control-core-resource.mjs";
import { inspectRehearsalRepository } from "./release-rehearse.mjs";
import { requirePrivateReleaseDirectory } from "./release-rehearsal-artifacts.mjs";

const fail = () => {
  throw new Error("CONTROL_CORE_REMOTE_TARGET_UNVERIFIED");
};
const ATTESTATION = "omh.control-core.remote-target/v1";
export async function controlCorePlatformProxy(repositoryRoot, options) {
  // Use the exact locked Wrangler owned by the Core deployable, without loading its Worker program.
  const require = createRequire(join(repositoryRoot, "apps/control-store/package.json"));
  const api = await import(pathToFileURL(require.resolve("wrangler")).href);
  return api.getPlatformProxy(options);
}

/** Real remote D1 binding: no HTTP SQL Worker, local persistence, preview ID, env file or customer runtime credential. */
export async function openRemoteControlCoreTarget(
  { contract, repositoryRoot, output, upgrade = false },
  {
    request = controlCoreCloudflareClient(),
    getProxy = controlCorePlatformProxy,
    inspect = inspectRehearsalRepository,
  } = {},
) {
  const source = await inspect({ cwd: resolve(repositoryRoot) });
  if (
    contract?.schemaVersion !== 1 ||
    contract.kind !== "omh.control-core.deployment/v1" ||
    contract.accountId !== contract.configuration?.account_id ||
    source.sha !== contract.sourceCommit ||
    source.repositoryRoot !== contract.repositoryRoot ||
    resolve(source.repositoryRoot) !== resolve(repositoryRoot)
  )
    fail();
  if (
    !(await assertControlCoreWorkerConfiguration({
      configuration: contract.configuration,
      repositoryRoot: source.repositoryRoot,
      sourceCommit: source.sha,
      standalone: true,
    }))
  )
    fail();
  const binding = contract.configuration.d1_databases[0];
  const resource = await request({
    method: "GET",
    path: `/accounts/${contract.accountId}/d1/database/${binding.database_id}`,
  });
  assertControlCoreResource(resource.result, {
    environment: contract.environment,
    creationId: contract.creationId,
    databaseId: binding.database_id,
  });
  if (resource.result.name !== binding.database_name) fail();

  const directory = resolve(output);
  await requirePrivateReleaseDirectory(resolve(directory, ".."), source.repositoryRoot);
  await mkdir(directory, { mode: 0o700 }); // A session never overwrites a prior challenge/configuration.
  const configPath = join(directory, "operator-bindings.jsonc");
  await writeExclusive(
    configPath,
    JSON.stringify({
      name: "ohmyho-control-core-import-operator",
      account_id: contract.accountId,
      compatibility_date: contract.configuration.compatibility_date,
      d1_databases: [
        {
          binding: "CONTROL_CORE",
          database_name: binding.database_name,
          database_id: binding.database_id,
          remote: true,
        },
      ],
    }) + "\n",
  );
  const proxy = await getProxy(source.repositoryRoot, {
    configPath,
    envFiles: [],
    persist: false,
    remoteBindings: true,
  });
  try {
    const db = proxy.env?.CONTROL_CORE;
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") fail();
    // A forward upgrade may meet an activated Core; the first migration of a Core never does.
    const upgraded = upgrade
      ? await upgradeCoreSchema(db, source.repositoryRoot, { sourceCommit: source.sha })
      : null;
    const pin =
      upgraded?.pin ??
      (await initializeUnservedTargetSchema(db, source.repositoryRoot, {
        sourceCommit: source.sha,
      }));
    if (pin.revision !== source.sha) fail();
    if (
      !upgrade &&
      (await db.prepare("SELECT 1 FROM core_authority_activation LIMIT 1").first()) !== null
    )
      fail();
    const identity = {
      kind: ATTESTATION,
      accountId: contract.accountId,
      databaseId: binding.database_id,
      environment: contract.environment,
      creationId: contract.creationId,
      sourceCommit: source.sha,
      schemaSha256: await schemaFingerprint(db),
      nonce: randomUUID(),
    };
    const result = canonical(identity),
      digest = sha256(Buffer.from(result));
    const commandId = `control-d1.remote-attestation:v1:${identity.nonce}`;
    await writeExclusive(
      join(directory, "remote-challenge.json"),
      canonical({ commandId, identity, digest }) + "\n",
    );
    // SQL-clock state is not an identity proof. Persist an unpredictable challenge through the binding,
    // then read the same committed row through the independent provider API at the verified account/UUID.
    await db
      .prepare(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,?,?,?,?)",
      )
      .bind(commandId, ATTESTATION, digest, result, Date.now())
      .run();
    const sql = "SELECT name,digest,result FROM command_log WHERE command_id=?";
    const direct = await request({
      method: "POST",
      path: `/accounts/${contract.accountId}/d1/database/${binding.database_id}/query`,
      body: { sql, params: [commandId] },
    });
    const expected = { name: ATTESTATION, digest, result };
    if (
      !Array.isArray(direct.result) ||
      direct.result.length !== 1 ||
      direct.result[0]?.success !== true ||
      !isDeepStrictEqual(direct.result[0].results, [expected]) ||
      !isDeepStrictEqual(await db.prepare(sql).bind(commandId).first(), expected)
    )
      fail();
    // Re-read the exact private challenge file before certifying it, including its filesystem permissions.
    if (
      !isDeepStrictEqual(
        JSON.parse((await readPrivate(join(directory, "remote-challenge.json"))).toString("utf8")),
        { commandId, identity, digest },
      )
    )
      fail();
    const proof = {
      schemaVersion: 1,
      ...identity,
      kind: "omh.control-core.remote-binding-proof/v1",
      commandId,
      observedAt: new Date().toISOString(),
      authorityActivation: "not-certified",
      ...(upgraded === null ? {} : { schemaUpgrade: upgraded.applied }),
    };
    await writeExclusive(join(directory, "remote-binding-proof.json"), canonical(proof) + "\n");
    return { db, proof, dispose: () => proxy.dispose() };
  } catch (error) {
    await proxy.dispose();
    throw error;
  }
}
