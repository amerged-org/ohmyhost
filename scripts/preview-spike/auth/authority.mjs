/* global Response */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { readQaAuthScope } from "./bridge.mjs";
import { validateQaManifest } from "../capabilities/config.mjs";

const fail = () => new Error("qa_auth_unavailable");
const identity = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "authGeneration,previewId" ||
    typeof value.previewId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.previewId) ||
    !Number.isSafeInteger(value.authGeneration) ||
    value.authGeneration < 1 ||
    value.authGeneration > 2_147_483_647
  )
    throw fail();
  return { previewId: value.previewId, authGeneration: value.authGeneration };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function scopeForCreate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "authGeneration" in raw)
    throw fail();
  const checked = readQaAuthScope({ ...raw, authGeneration: 1 });
  const { authGeneration, ...scope } = checked;
  if (authGeneration !== 1) throw fail();
  return scope;
}
function assertManifest(env, scope) {
  if (typeof env.SPIKE_QA_MANIFEST !== "string" || env.SPIKE_QA_MANIFEST.length > 16_384)
    throw fail();
  const manifest = validateQaManifest(JSON.parse(env.SPIKE_QA_MANIFEST));
  const qa = manifest.projects.find((row) => row.fixture === scope.fixture);
  if (
    !qa ||
    qa.organizationId !== scope.organizationId ||
    qa.projectId !== scope.projectId ||
    qa.environmentId !== scope.environmentId ||
    qa.region !== scope.region ||
    qa.handle !== scope.handle ||
    qa.origin !== scope.devOrigin ||
    qa.principalId !== scope.principalId ||
    qa.devAccessEpoch !== scope.devAccessEpoch
  )
    throw fail();
}
function realmProjection(current, scope) {
  if (
    !current ||
    typeof current !== "object" ||
    current.organizationId !== scope.organizationId ||
    current.region !== scope.region ||
    !current.realm ||
    current.realm.projectId !== scope.projectId ||
    current.realm.environmentId !== scope.environmentId ||
    current.enabled !== true ||
    current.sourceCapable !== true ||
    current.paidAllowed !== true ||
    current.runtimeAllowed !== true ||
    !Number.isSafeInteger(current.revocationEpoch) ||
    current.revocationEpoch < 1 ||
    current.realm.realmGeneration !== current.revocationEpoch ||
    !Number.isSafeInteger(current.realm.configurationRevision) ||
    current.realm.configurationRevision < 1 ||
    typeof current.applicationName !== "string" ||
    current.applicationName.length < 1 ||
    current.applicationName.length > 128 ||
    !["open", "invite-only"].includes(current.signupPolicy) ||
    !Array.isArray(current.allowedRedirectPaths) ||
    current.allowedRedirectPaths.length < 1 ||
    current.allowedRedirectPaths.length > 32 ||
    current.allowedRedirectPaths.some((path) => typeof path !== "string") ||
    typeof current.resetPasswordPath !== "string" ||
    typeof current.invitationPath !== "string"
  )
    throw fail();
  return {
    organizationId: current.organizationId,
    realm: {
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      canonicalOrigin: scope.previewOrigin,
      realmGeneration: current.realm.realmGeneration,
      configurationRevision: current.realm.configurationRevision,
    },
    revocationEpoch: current.revocationEpoch,
    enabled: true,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: true,
    applicationName: current.applicationName,
    signupPolicy: current.signupPolicy,
    allowedRedirectPaths: current.allowedRedirectPaths,
    resetPasswordPath: current.resetPasswordPath,
    invitationPath: current.invitationPath,
    preview: { previewId: scope.previewId, authGeneration: scope.authGeneration },
  };
}
async function live(env, scope) {
  assertManifest(env, scope);
  const grant = {
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    handle: scope.handle,
    origin: scope.devOrigin,
    principalId: scope.principalId,
    devAccessEpoch: scope.devAccessEpoch,
  };
  const realm = { projectId: scope.projectId, environmentId: scope.environmentId };
  if ((await env.QA_DEV_ACCESS.authorizeDevAccessSession(grant)) !== true) throw fail();
  const first = realmProjection(await env.QA_REALM_AUTHORITY.resolve(realm), scope);
  if ((await env.QA_DEV_ACCESS.authorizeDevAccessSession(grant)) !== true) throw fail();
  const after = realmProjection(await env.QA_REALM_AUTHORITY.resolve(realm), scope);
  if (!same(first, after) || (await env.QA_DEV_ACCESS.authorizeDevAccessSession(grant)) !== true)
    throw fail();
  return after;
}
function publicAuthority(scope, authority) {
  return {
    platform: scope.platform,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    region: scope.region,
    previewId: scope.previewId,
    previewOrigin: scope.previewOrigin,
    authGeneration: scope.authGeneration,
    devAccessEpoch: scope.devAccessEpoch,
    revocationEpoch: authority.revocationEpoch,
    configurationRevision: authority.realm.configurationRevision,
    enabled: authority.enabled,
    sourceCapable: authority.sourceCapable,
    paidAllowed: authority.paidAllowed,
    runtimeAllowed: authority.runtimeAllowed,
  };
}
function stateStub(env, id) {
  return env.QA_PREVIEW_STATES.getByName(id);
}
async function resolve(env, raw) {
  const wanted = identity(raw);
  const stub = stateStub(env, wanted.previewId);
  const before = await stub.read(wanted);
  if (!before) throw fail();
  const scope = readQaAuthScope(before);
  const authority = await live(env, scope);
  const after = await stub.read(wanted);
  if (!same(before, after)) throw fail();
  return { scope, authority };
}

/** Private state of this throwaway Development Worker; never exposed to the guest. */
export class QaStablePreviewState extends DurableObject {
  async create(raw) {
    const scope = scopeForCreate(raw);
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get("state");
      if (existing) {
        if (existing.revoked || !same(existing.scope, scope)) throw fail();
        return { previewId: scope.previewId, authGeneration: existing.generation };
      }
      await txn.put("state", { scope, generation: 1, revoked: false });
      return { previewId: scope.previewId, authGeneration: 1 };
    });
  }
  async read(raw) {
    const wanted = identity(raw);
    const state = await this.ctx.storage.get("state");
    if (
      !state ||
      state.revoked ||
      state.scope.previewId !== wanted.previewId ||
      state.generation !== wanted.authGeneration
    )
      return null;
    return { ...state.scope, authGeneration: state.generation };
  }
  async rotate(raw) {
    const wanted = identity(raw);
    return this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get("state");
      if (
        !state ||
        state.revoked ||
        state.scope.previewId !== wanted.previewId ||
        state.generation !== wanted.authGeneration ||
        state.generation >= 2_147_483_647
      )
        throw fail();
      state.generation += 1;
      await txn.put("state", state);
      return { previewId: wanted.previewId, authGeneration: state.generation };
    });
  }
  async revoke(raw) {
    const wanted = identity(raw);
    return this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get("state");
      if (
        !state ||
        (state.scope?.previewId ?? state.previewId) !== wanted.previewId ||
        state.generation !== wanted.authGeneration
      )
        throw fail();
      if (state.revoked) return true;
      state.revoked = true;
      await txn.put("state", state);
      return true;
    });
  }
  async retire(raw) {
    const wanted = identity(raw);
    return this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get("state");
      if (!state) {
        await txn.put("state", {
          previewId: wanted.previewId,
          generation: wanted.authGeneration,
          revoked: true,
        });
        return true;
      }
      if (
        (state.scope?.previewId ?? state.previewId) !== wanted.previewId ||
        state.generation !== wanted.authGeneration
      )
        throw fail();
      if (!state.revoked) {
        state.revoked = true;
        await txn.put("state", state);
      }
      return true;
    });
  }
}

/** Only the trusted spike lifecycle holds create/rotate/revoke/retire. */
export class QaStablePreviewManagement extends WorkerEntrypoint {
  async create(raw) {
    const scope = scopeForCreate(raw);
    await live(this.env, { ...scope, authGeneration: 1 });
    const result = await stateStub(this.env, scope.previewId).create(scope);
    await resolve(this.env, result);
    return result;
  }
  async rotate(raw) {
    const wanted = identity(raw);
    await resolve(this.env, wanted);
    const result = await stateStub(this.env, wanted.previewId).rotate(wanted);
    await resolve(this.env, result);
    return result;
  }
  async revoke(raw) {
    const wanted = identity(raw);
    return stateStub(this.env, wanted.previewId).revoke(wanted);
  }
  async retire(raw) {
    const wanted = identity(raw);
    return stateStub(this.env, wanted.previewId).retire(wanted);
  }
}

/** Read-only capabilities for the bridge, Native runtime and preview mail gateway. */
export class QaStablePreviewAuthority extends WorkerEntrypoint {
  async resolve(raw) {
    const value = await resolve(this.env, raw);
    return publicAuthority(value.scope, value.authority);
  }
  async resolveForNative(raw) {
    return (await resolve(this.env, raw)).authority;
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
