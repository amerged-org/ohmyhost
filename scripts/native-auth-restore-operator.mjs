/* Private, interactive-session-only operator for the fixed RecoveryContainerService profiles. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import process from "node:process";
import { TextDecoder } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { controlCorePlatformProxy } from "./control-core-remote-target.mjs";

const ACCOUNT = "00000000000000000000000000000001";
const profiles = {
  development: {
    namespace: "poc-private-fullstack",
    service: "ohmyho-recovery-container-poc-private-fullstack",
    origin: "https://dev.app.ohmyho.st",
    client: "client_00000000000000000000000017",
    core: "ohmyho-control-store-poc-private-fullstack",
    native: "ohmyho-native-auth-development",
    preparation: "ohmyho-neon-management-poc-private-fullstack",
  },
  production: {
    namespace: "production",
    service: "ohmyho-recovery-container-production",
    origin: "https://app.ohmyho.st",
    client: "client_00000000000000000000000018",
    core: "ohmyho-control-store-production",
    native: "ohmyho-native-auth-production",
    preparation: "ohmyho-neon-management-production",
  },
};
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const fail = () => {
  throw new Error("NATIVE_RESTORE_UNVERIFIED");
};

function verifyBindings(bindings, profile) {
  if (!Array.isArray(bindings)) return false;
  const expected = [
    ["NATIVE_RESTORE_JOB_STORE", profile.core, "NativeAuthRestoreJobRuntime"],
    ["RECOVERY_CONTROL_STORE", profile.core, "RecoveryRuntime"],
    ...["US", "EU"].flatMap((region) => [
      [
        `NATIVE_RESTORE_ADMIN_${region}`,
        `${profile.native}-${region.toLowerCase()}`,
        "NativeAdminService",
      ],
      [
        `NATIVE_RESTORE_POLICY_${region}`,
        `${profile.native}-${region.toLowerCase()}`,
        "NativePolicyService",
      ],
      [
        `NATIVE_RESTORE_PREPARATION_${region}`,
        profile.preparation,
        "NativeAuthRestorePreparationService",
      ],
    ]),
  ];
  if (new Set(bindings.map((binding) => binding?.name)).size !== bindings.length) return false;
  const services = bindings.filter((binding) => binding?.type === "service");
  if (services.length !== expected.length) return false;
  for (const [name, service, entrypoint] of expected) {
    const binding = services.find((value) => value.name === name);
    if (
      !binding ||
      binding.service !== service ||
      binding.entrypoint !== entrypoint ||
      (binding.environment !== undefined && binding.environment !== "production")
    )
      return false;
  }
  const namespace = bindings.find((binding) => binding?.name === "RESOURCE_NAMESPACE");
  const sandbox = bindings.find((binding) => binding?.name === "RECOVERY_SANDBOX");
  const configuration = bindings.find((binding) => binding?.name === "RECOVERY_CONFIGURATION");
  return (
    namespace?.type === "plain_text" &&
    namespace.text === profile.namespace &&
    sandbox?.type === "durable_object_namespace" &&
    sandbox.class_name === "RecoverySandbox" &&
    (sandbox.script_name === undefined || sandbox.script_name === profile.service) &&
    typeof sandbox.namespace_id === "string" &&
    /^[a-f0-9]{32}$/u.test(sandbox.namespace_id) &&
    configuration?.type === "secret_text"
  );
}

export function parseOptions(args) {
  const o = { execute: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--execute") {
      if (o.execute) fail();
      o.execute = true;
      continue;
    }
    const names = {
      "--environment": "environment",
      "--account": "account",
      "--organization": "organizationId",
      "--project": "projectId",
      "--export": "exportOperationId",
      "--sha256": "archiveSha256",
      "--restore": "restoreId",
      "--claim": "claimId",
      "--rearm-claim": "rearmClaimId",
    };
    const name = names[key];
    if (!name || o[name] !== undefined || !args[i + 1]) fail();
    o[name] = args[++i];
  }
  if (
    !Object.hasOwn(profiles, o.environment ?? "") ||
    o.account !== ACCOUNT ||
    !["organizationId", "projectId", "exportOperationId", "restoreId"].every((k) =>
      ULID.test(o[k] ?? ""),
    ) ||
    !UUID.test(o.claimId ?? "") ||
    (o.rearmClaimId !== undefined &&
      (!UUID.test(o.rearmClaimId) || o.rearmClaimId === o.claimId)) ||
    !/^[a-f0-9]{64}$/u.test(o.archiveSha256 ?? "")
  )
    fail();
  return o;
}

// The same token is verified by Control /v1/me below. Decode only to reject all non-session
// and unfamiliar claims before using its authenticated actor; this is not signature verification.
export function inspectSession(token, profile) {
  if (
    typeof token !== "string" ||
    token.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
  )
    fail();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    fail();
  }
  const allowed = [
    "iss",
    "sub",
    "aud",
    "exp",
    "iat",
    "nbf",
    "jti",
    "client_id",
    "org_id",
    "sid",
    "role",
    "permissions",
    "roles",
    "auth_time",
  ];
  if (
    !claims ||
    Array.isArray(claims) ||
    typeof claims !== "object" ||
    Object.keys(claims).some((k) => !allowed.includes(k)) ||
    claims.iss !== `https://api.workos.com/user_management/${profile.client}` ||
    claims.client_id !== profile.client ||
    !/^user_[A-Za-z0-9_]{1,123}$/u.test(claims.sub ?? "") ||
    !/^session_[A-Za-z0-9_]{1,120}$/u.test(claims.sid ?? "") ||
    !/^org_[A-Za-z0-9_]{1,124}$/u.test(claims.org_id ?? "") ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= Date.now() / 1000 ||
    (claims.aud !== undefined && claims.aud !== profile.client) ||
    (claims.auth_time !== undefined &&
      (!Number.isSafeInteger(claims.auth_time) || claims.auth_time < 0)) ||
    (claims.roles !== undefined &&
      (!Array.isArray(claims.roles) ||
        claims.roles.length > 100 ||
        !claims.roles.every(
          (role) =>
            typeof role === "string" &&
            role.length > 0 &&
            role.length <= 256 &&
            !/\p{Cc}/u.test(role),
        ))) ||
    (claims.permissions !== undefined &&
      (!Array.isArray(claims.permissions) ||
        claims.permissions.length > 100 ||
        !claims.permissions.every(
          (permission) =>
            typeof permission === "string" && permission.length > 0 && permission.length <= 256,
        )))
  )
    fail();
  return claims.sub;
}

export async function perform(
  o,
  secrets,
  { fetcher = globalThis.fetch, openProxy = controlCorePlatformProxy, root = process.cwd() } = {},
) {
  const p = profiles[o.environment];
  if (!p || o.account !== ACCOUNT) fail();
  const user = inspectSession(secrets.session, p);
  const meResponse = await fetcher(`${p.origin}/v1/me`, {
    headers: { authorization: `Bearer ${secrets.session}` },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10000),
  });
  if (!meResponse.ok) fail();
  const me = await meResponse.json();
  if (
    me?.actor_id !== `user:${user}` ||
    !Array.isArray(me.organization_ids) ||
    !me.organization_ids.includes(o.organizationId)
  )
    fail();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (
    !token ||
    (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT)
  )
    fail();
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
  for (const [path, verify] of [
    ["/containers/me", (x) => x?.external_account_id === ACCOUNT],
    [`/workers/scripts/${p.service}/settings`, (x) => verifyBindings(x?.bindings, p)],
  ]) {
    const response = await fetcher(base + path, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10000),
    });
    if (!response.ok) fail();
    const body = await response.json();
    if (body?.success !== true || !verify(body.result)) fail();
  }
  const directory = await mkdtemp(join(tmpdir(), "omh-native-restore-"));
  let proxy;
  try {
    const configPath = join(directory, "wrangler.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "ohmyho-native-restore-operator",
        account_id: ACCOUNT,
        compatibility_date: "2026-09-14",
        workers_dev: false,
        preview_urls: false,
        services: [
          {
            binding: "RECOVERY",
            service: p.service,
            entrypoint: "RecoveryContainerService",
            remote: true,
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    proxy = await openProxy(root, {
      configPath,
      envFiles: [],
      persist: false,
      remoteBindings: true,
    });
    const service = proxy.env.RECOVERY;
    const readiness = await service.inspectNativeRestore();
    if (readiness?.status !== "ready" || readiness.namespace !== p.namespace) fail();
    if (!o.execute)
      return { status: "wiring_ready", environment: o.environment, namespace: p.namespace };
    const scope = {
      organizationId: o.organizationId,
      projectId: o.projectId,
      restoreId: o.restoreId,
      claimId: o.claimId,
      principalId: `user:${user}`,
      exportOperationId: o.exportOperationId,
      archiveSha256: o.archiveSha256,
    };
    const observation = await service.observeNativeRestore(scope);
    if (
      Object.keys(observation ?? {})
        .sort()
        .join(",") !== "claimId,restoreId,status" ||
      observation.restoreId !== o.restoreId ||
      observation.claimId !== o.claimId
    )
      fail();
    if (observation.status === "complete") return { status: "complete", restoreId: o.restoreId };
    let result;
    if (
      (observation.status === "resume-consumed" || observation.status === "resume-cleanup") &&
      o.rearmClaimId === undefined
    ) {
      result = await service.resumeNativeRestore({
        organizationId: o.organizationId,
        projectId: o.projectId,
        restoreId: o.restoreId,
        claimId: o.claimId,
      });
    } else if (
      ((observation.status === "absent" || observation.status === "resume-input") &&
        o.rearmClaimId === undefined) ||
      (observation.status === "rearm-input" && o.rearmClaimId !== undefined)
    ) {
      if (
        typeof secrets.passphrase !== "string" ||
        !secrets.passphrase.trim() ||
        Buffer.byteLength(secrets.passphrase) > 1024
      )
        fail();
      result = await service.invokeNativeRestore({
        ...scope,
        passphrase: secrets.passphrase,
        ...(observation.status === "rearm-input"
          ? { claimId: o.rearmClaimId, expectedPreviousClaimId: o.claimId }
          : {}),
      });
    } else fail(); // Active, unknown and unfamiliar states never authorize another dispatch.
    if (result?.status !== "complete" || result.restoreId !== o.restoreId) fail();
    return { status: "complete", restoreId: o.restoreId };
  } finally {
    if (proxy) await proxy.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readSecrets(input, execute) {
  const chunks = [];
  let length = 0,
    joined;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      length += bytes.byteLength;
      if (length > 20000) fail();
    }
    joined = Buffer.concat(chunks, length);
    const secrets = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    const keys = secrets && !Array.isArray(secrets) ? Object.keys(secrets).sort().join(",") : "";
    if (keys !== "session" && !(execute && keys === "passphrase,session")) fail();
    return secrets;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    joined?.fill(0);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const secrets = await readSecrets(process.stdin, options.execute);
  const result = await perform(options, secrets);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write('{"reason_code":"NATIVE_RESTORE_UNVERIFIED"}\n');
    process.exitCode = 1;
  }
}
