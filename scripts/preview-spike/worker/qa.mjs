import { QA_FIXTURES, validateQaManifest } from "../capabilities/config.mjs";
import { readQaAuthScope } from "../auth/bridge.mjs";
import { signId } from "./protocol.mjs";
import { GUEST_MAIL_KEY, GUEST_ACCEPTANCE } from "../mail/adapter.mjs";
import { bounded } from "./deadline.mjs";

export function qaManifest(env) {
  if (env.SPIKE_QA_ENABLED !== "development") return null;
  if (typeof env.SPIKE_QA_MANIFEST !== "string" || env.SPIKE_QA_MANIFEST.length > 16_384)
    throw new Error("qa_manifest_unavailable");
  return validateQaManifest(JSON.parse(env.SPIKE_QA_MANIFEST));
}

export async function prepareQaSession(env, config, previewId) {
  const manifest = qaManifest(env);
  if (!manifest) return null;
  const scope = manifest.projects[QA_FIXTURES.indexOf(config.fixture)];
  if (!scope || !/^[a-f0-9]{32}$/.test(previewId)) throw new Error("qa_scope_unavailable");
  const label = await signId(previewId, env.SPIKE_CONTROL_TOKEN);
  const previewOrigin = `https://${label}.${env.SPIKE_PREVIEW_DOMAIN}`;
  if (config.fixture !== "next-native-auth") return { fixture: scope.fixture };
  if (typeof env.QA_STABLE_PREVIEW_MANAGEMENT?.create !== "function")
    throw new Error("qa_auth_management_unavailable");
  const raw = {
    platform: "development",
    fixture: scope.fixture,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    region: scope.region,
    handle: scope.handle,
    devOrigin: scope.origin,
    principalId: scope.principalId,
    devAccessEpoch: scope.devAccessEpoch,
    previewId,
    previewOrigin,
  };
  const result = await bounded(() => env.QA_STABLE_PREVIEW_MANAGEMENT.create(raw), 15_000);
  if (
    result?.previewId !== previewId ||
    !Number.isSafeInteger(result.authGeneration) ||
    result.authGeneration < 1
  )
    throw new Error("qa_auth_identity_unavailable");
  return {
    fixture: scope.fixture,
    authScope: readQaAuthScope({ ...raw, authGeneration: result.authGeneration }),
  };
}

export async function guestQaVariables(env, state) {
  if (!state.qa) return {};
  if (state.qa.fixture !== state.config.fixture || !qaManifest(env))
    throw new Error("qa_guest_scope_invalid");
  const flags = { SPIKE_QA_FIXTURE: state.config.fixture };
  if (state.config.fixture !== "next-app-mail") return flags;
  if (typeof env.QA_MAIL_PRIVATE?.configuration !== "function")
    throw new Error("qa_mail_unavailable");
  const value = await bounded(() => env.QA_MAIL_PRIVATE.configuration(), 15_000);
  const scope = qaManifest(env)?.projects.find((x) => x.fixture === "next-app-mail");
  const keys = [
    "OHMYHOST_MAIL_GATEWAY_URL",
    "OHMYHOST_MAIL_KEY",
    "OHMYHOST_PROJECT_ID",
    "PREVIEW_ACCEPTANCE_KEY",
    "PREVIEW_MAIL_RECIPIENT",
  ];
  if (
    !value ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",") ||
    value.OHMYHOST_MAIL_GATEWAY_URL !== "https://qa-mail.invalid" ||
    value.OHMYHOST_MAIL_KEY !== GUEST_MAIL_KEY ||
    value.PREVIEW_ACCEPTANCE_KEY !== GUEST_ACCEPTANCE ||
    !scope ||
    value.OHMYHOST_PROJECT_ID !== scope.projectId ||
    typeof value.PREVIEW_MAIL_RECIPIENT !== "string" ||
    value.PREVIEW_MAIL_RECIPIENT.length > 320 ||
    !/^[^\s@]+@[^\s@]+$/u.test(value.PREVIEW_MAIL_RECIPIENT) ||
    [...value.PREVIEW_MAIL_RECIPIENT].some((x) => x.codePointAt(0) < 32 || x.codePointAt(0) === 127)
  )
    throw new Error("qa_guest_configuration_invalid");
  return { ...flags, ...Object.fromEntries(keys.map((key) => [key, value[key]])) };
}

export async function readQaLease(env, sessionId, clock = () => Date.now()) {
  if (typeof sessionId !== "string" || !/^[a-f0-9]{32}$/.test(sessionId)) return null;
  const time = clock();
  if (!Number.isFinite(time)) return null;
  const lease = await bounded(() => env.SPIKE_LIMIT.getByName("development").current(), 15_000);
  const after = clock();
  return lease?.id === sessionId &&
    Number.isSafeInteger(lease.expiresAt) &&
    Number.isFinite(after) &&
    lease.expiresAt > after
    ? lease
    : null;
}

export async function readQaSession(
  env,
  input,
  fixture,
  generation,
  requireReady = false,
  clock = () => Date.now(),
) {
  if (
    !input ||
    Object.keys(input).join(",") !== "sessionId" ||
    typeof input.sessionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(input.sessionId)
  )
    return null;
  const lease = await readQaLease(env, input.sessionId, clock);
  if (!lease) return null;
  const state = await bounded(() => env.SANDBOX.getByName(input.sessionId).status(), 15_000);
  if (
    state?.config?.fixture !== fixture ||
    state.qa?.fixture !== fixture ||
    !state.running ||
    (requireReady && !state.ready) ||
    state.poisoned ||
    state.cleanupRequested ||
    !Number.isSafeInteger(state.generation) ||
    state.generation < 1
  )
    return null;
  if (generation !== undefined && state.generation !== generation) return null;
  const current = await readQaLease(env, input.sessionId, clock);
  if (!current || current.expiresAt !== lease.expiresAt || current.createdAt !== lease.createdAt)
    return null;
  return { sessionId: input.sessionId, generation: state.generation, expiresAt: lease.expiresAt };
}

export function readMailSession(env, input, clock = () => Date.now()) {
  return readQaSession(env, input, "next-app-mail", undefined, true, clock);
}

export async function revokeQaSession(env, state) {
  if (state?.qaAuthPending || state?.qa?.authScope) {
    const identity = state.qa?.authScope ?? { previewId: state.previewId, authGeneration: 1 };
    const management = env.QA_STABLE_PREVIEW_MANAGEMENT;
    if (
      typeof management?.retire !== "function" ||
      (await bounded(
        () =>
          management.retire({
            previewId: identity.previewId,
            authGeneration: identity.authGeneration,
          }),
        15_000,
      )) !== true
    )
      throw new Error("qa_auth_revoke_unconfirmed");
  }
  if (!state?.qa) return;
  if (state.config.fixture === "next-app-mail") {
    if (typeof env.QA_MAIL_PRIVATE?.cleanup !== "function")
      throw new Error("qa_mail_cleanup_unavailable");
    const result = await bounded(
      () =>
        env.QA_MAIL_PRIVATE.cleanup({ sessionId: state.previewId, generation: state.generation }),
      15_000,
    );
    if (result?.deleted !== true) throw new Error("qa_mail_cleanup_unconfirmed");
  }
}
