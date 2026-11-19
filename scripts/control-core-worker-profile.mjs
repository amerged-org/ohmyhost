import { normalizeNativeAuthLaunchPolicy } from "./control-core-native-auth-policy.mjs";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

export const CONTROL_CORE_WORKER_PROFILES = Object.freeze({
  development: "ohmyho-control-store-poc-private-fullstack",
  production: "ohmyho-control-store-production",
});
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const fail = () => {
  throw new Error("CONTROL_CORE_DEPLOYMENT_UNVERIFIED");
};

/** Compile only the fixed checked-in Core profile; runtime resource IDs never choose executable source. */
export async function controlCoreWorkerConfiguration({
  repositoryRoot,
  sourceCommit,
  environment,
  accountId,
  databaseId,
  databaseName,
  nativeAuthLaunchPolicy,
}) {
  if (
    !Object.hasOwn(CONTROL_CORE_WORKER_PROFILES, environment) ||
    !/^[a-f0-9]{40}$/u.test(sourceCommit ?? "") ||
    !/^[a-f0-9]{32}$/u.test(accountId ?? "") ||
    !UUID.test(databaseId ?? "") ||
    typeof databaseName !== "string" ||
    (databaseName !== `ohmyho-control-core-${environment}` &&
      (!databaseName.startsWith(`ohmyho-control-core-${environment}-`) ||
        !UUID.test(databaseName.slice(`ohmyho-control-core-${environment}-`.length))))
  )
    fail();
  const bytes = await readFile(join(repositoryRoot, "apps/control-store/wrangler.jsonc"));
  const parsed = ts.parseConfigFileTextToJson("control-core-profile.jsonc", bytes.toString("utf8"));
  if (parsed.error !== undefined) fail();
  const template = parsed.config;
  const allowed = [
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "observability",
    "d1_databases",
  ];
  if (
    !template ||
    Object.keys(template).some((key) => !allowed.includes(key)) ||
    template.name !== "ohmyho-control-store" ||
    template.main !== "src/worker-main.ts" ||
    template.workers_dev !== false ||
    template.preview_urls !== false ||
    !isDeepStrictEqual(template.compatibility_flags, ["nodejs_compat"]) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(template.compatibility_date ?? "") ||
    !isDeepStrictEqual(template.observability, { enabled: false }) ||
    !isDeepStrictEqual(template.d1_databases, [
      {
        binding: "CONTROL_CORE",
        database_name: "ohmyho-control-core",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations/core",
      },
    ])
  )
    fail();
  const configuration = {
    name: CONTROL_CORE_WORKER_PROFILES[environment],
    account_id: accountId,
    main: join(repositoryRoot, "apps/control-store/src/worker-main.ts"),
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false },
    routes: [],
    triggers: { crons: [] },
    d1_databases: [
      {
        binding: "CONTROL_CORE",
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: join(repositoryRoot, "apps/control-store/migrations/core"),
      },
    ],
    vars: {
      CONTROL_CORE_DATABASE_ID: databaseId,
      CONTROL_PLATFORM_ENVIRONMENT: environment,
      CONTROL_CORE_RELEASE_SOURCE: sourceCommit,
      CONTROL_NATIVE_AUTH_LAUNCH_POLICY: JSON.stringify(
        normalizeNativeAuthLaunchPolicy(nativeAuthLaunchPolicy),
      ),
    },
    version_metadata: { binding: "CF_VERSION_METADATA" },
  };
  await access(configuration.main);
  return { configuration, sourceTemplateSha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Standalone Core creation cannot activate a launch policy without a reviewed train. */
export function assertControlCoreStandaloneLaunchPolicy(value) {
  if (value !== '{"mode":"disabled"}') fail();
}

/** Used by the ACTUAL normal release path before provider I/O and by completed replay, not only by a packet reader. */
export async function assertControlCoreWorkerConfiguration({
  configuration,
  repositoryRoot,
  sourceCommit,
  standalone = false,
}) {
  const environment = Object.keys(CONTROL_CORE_WORKER_PROFILES).find(
    (key) => CONTROL_CORE_WORKER_PROFILES[key] === configuration?.name,
  );
  if (environment === undefined) return false;
  if (standalone)
    assertControlCoreStandaloneLaunchPolicy(configuration.vars?.CONTROL_NATIVE_AUTH_LAUNCH_POLICY);
  const db = configuration.d1_databases?.[0];
  let nativeAuthLaunchPolicy;
  try {
    nativeAuthLaunchPolicy = JSON.parse(configuration.vars?.CONTROL_NATIVE_AUTH_LAUNCH_POLICY);
    if (
      JSON.stringify(normalizeNativeAuthLaunchPolicy(nativeAuthLaunchPolicy)) !==
      configuration.vars.CONTROL_NATIVE_AUTH_LAUNCH_POLICY
    )
      fail();
  } catch {
    fail();
  }
  const expected = await controlCoreWorkerConfiguration({
    repositoryRoot,
    sourceCommit,
    environment,
    accountId: configuration.account_id,
    databaseId: db?.database_id,
    databaseName: db?.database_name,
    nativeAuthLaunchPolicy,
  });
  if (!isDeepStrictEqual(configuration, expected.configuration)) fail();
  return true;
}
