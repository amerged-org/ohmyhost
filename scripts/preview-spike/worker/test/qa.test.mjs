/* global structuredClone */
import assert from "node:assert/strict";
import test from "node:test";
import { QA_FIXTURES } from "../../capabilities/config.mjs";
import { GUEST_ACCEPTANCE, GUEST_MAIL_KEY } from "../../mail/adapter.mjs";
import { signId } from "../protocol.mjs";
import {
  guestQaVariables,
  prepareQaSession,
  qaManifest,
  readMailSession,
  readQaSession,
  revokeQaSession,
} from "../qa.mjs";

const id = (number) => String(number).padStart(26, "0");
const sessionId = "a".repeat(32);
const token = "synthetic-control-token-at-least-32-bytes";
const clockTime = Date.parse("2026-11-15T12:00:00.000Z");
const manifest = () => ({
  platform: "development",
  projects: QA_FIXTURES.map((fixture, index) => ({
    fixture,
    organizationId: id(1),
    projectId: id(10 + index),
    environmentId: id(20 + index),
    physicalEnvironmentId: id(30 + index),
    registrationVersion: index + 1,
    region: "eu",
    handle: `qa-${index}`,
    origin: `https://dev-qa-${index}.dev.check.omh.st`,
    principalId: "qa-operator",
    devAccessEpoch: index + 1,
  })),
});
const baseEnv = () => ({
  SPIKE_QA_ENABLED: "development",
  SPIKE_QA_MANIFEST: JSON.stringify(manifest()),
  SPIKE_CONTROL_TOKEN: token,
  SPIKE_PREVIEW_DOMAIN: "preview.dev.omh.st",
});
const mailState = () => ({
  config: { fixture: "next-app-mail" },
  qa: { fixture: "next-app-mail", internal: "must-not-leak" },
  running: true,
  ready: true,
  generation: 2,
  privateState: "must-not-leak",
});
const mailVariables = () => ({
  OHMYHOST_MAIL_GATEWAY_URL: "https://qa-mail.invalid",
  OHMYHOST_MAIL_KEY: GUEST_MAIL_KEY,
  OHMYHOST_PROJECT_ID: manifest().projects[6].projectId,
  PREVIEW_ACCEPTANCE_KEY: GUEST_ACCEPTANCE,
  PREVIEW_MAIL_RECIPIENT: "qa@example.invalid",
});

test("QA session creation selects the trusted manifest and revokes its exact Auth generation", async (t) => {
  const env = baseEnv();
  assert.deepEqual(qaManifest(env), manifest());
  assert.equal(qaManifest({ SPIKE_QA_ENABLED: "production", SPIKE_QA_MANIFEST: "not-json" }), null);
  assert.throws(() => qaManifest({ ...env, SPIKE_QA_MANIFEST: "not-json" }));
  const duplicate = manifest();
  duplicate.projects[1].projectId = duplicate.projects[0].projectId;
  assert.throws(() => qaManifest({ ...env, SPIKE_QA_MANIFEST: JSON.stringify(duplicate) }));

  const creates = [],
    revocations = [];
  env.QA_STABLE_PREVIEW_MANAGEMENT = {
    async create(input) {
      creates.push(structuredClone(input));
      return { previewId: sessionId, authGeneration: 7 };
    },
    async retire(input) {
      revocations.push(structuredClone(input));
      return true;
    },
  };
  for (const fixture of QA_FIXTURES.filter((value) => value !== "next-native-auth"))
    assert.deepEqual(await prepareQaSession(env, { fixture, projectId: id(99) }, sessionId), {
      fixture,
    });
  assert.equal(creates.length, 0);
  await assert.rejects(prepareQaSession(env, { fixture: "foreign" }, sessionId));
  await assert.rejects(prepareQaSession(env, { fixture: "next-native-auth" }, "invalid"));
  assert.equal(creates.length, 0);

  const selected = manifest().projects[5];
  const prepared = await prepareQaSession(
    env,
    { fixture: "next-native-auth", projectId: id(99) },
    sessionId,
  );
  const expected = {
    platform: "development",
    fixture: "next-native-auth",
    organizationId: selected.organizationId,
    projectId: selected.projectId,
    environmentId: selected.environmentId,
    region: selected.region,
    handle: selected.handle,
    devOrigin: selected.origin,
    principalId: selected.principalId,
    devAccessEpoch: selected.devAccessEpoch,
    previewId: sessionId,
    previewOrigin: `https://${await signId(sessionId, token)}.preview.dev.omh.st`,
  };
  assert.deepEqual(creates, [expected]);
  assert.deepEqual(prepared, {
    fixture: "next-native-auth",
    authScope: { ...expected, authGeneration: 7 },
  });
  await revokeQaSession(env, { config: { fixture: "next-native-auth" }, qa: prepared });
  assert.deepEqual(revocations, [{ previewId: sessionId, authGeneration: 7 }]);

  await t.test("Auth revocation must be confirmed before cleanup can succeed", async () => {
    env.QA_STABLE_PREVIEW_MANAGEMENT.retire = async () => false;
    await assert.rejects(
      revokeQaSession(env, { config: { fixture: "next-native-auth" }, qa: prepared }),
    );
  });
  await t.test(
    "a lost Auth creation reply retires the first generation before cleanup",
    async () => {
      env.QA_STABLE_PREVIEW_MANAGEMENT.retire = async (input) => {
        revocations.push(structuredClone(input));
        return true;
      };
      await revokeQaSession(env, {
        config: { fixture: "next-native-auth" },
        previewId: sessionId,
        qaAuthPending: true,
        qa: null,
      });
      assert.deepEqual(revocations.at(-1), { previewId: sessionId, authGeneration: 1 });
    },
  );
  await t.test("Auth creation rejects a mismatched identity or generation", async () => {
    for (const result of [
      { previewId: "b".repeat(32), authGeneration: 1 },
      { previewId: sessionId, authGeneration: 0 },
      { previewId: sessionId, authGeneration: 2_147_483_648 },
      { previewId: sessionId, authGeneration: "1" },
    ]) {
      env.QA_STABLE_PREVIEW_MANAGEMENT.create = async () => result;
      await assert.rejects(prepareQaSession(env, { fixture: "next-native-auth" }, sessionId));
    }
  });
  await t.test(
    "mail cleanup uses only the persisted session and generation and requires confirmation",
    async () => {
      let received;
      env.QA_MAIL_PRIVATE = {
        async cleanup(value) {
          received = value;
          return { deleted: true };
        },
      };
      const state = {
        config: { fixture: "next-app-mail" },
        qa: { fixture: "next-app-mail" },
        previewId: sessionId,
        generation: 3,
      };
      await revokeQaSession(env, state);
      assert.deepEqual(received, { sessionId, generation: 3 });
      env.QA_MAIL_PRIVATE.cleanup = async () => ({ deleted: false });
      await assert.rejects(revokeQaSession(env, state), /qa_mail_cleanup_unconfirmed/u);
    },
  );
});

test("only public mail markers and the selected project can enter the guest", async (t) => {
  const env = baseEnv();
  let value = mailVariables(),
    reads = 0;
  env.QA_MAIL_PRIVATE = {
    async configuration() {
      reads += 1;
      return structuredClone(value);
    },
  };
  assert.deepEqual(await guestQaVariables(env, mailState()), {
    SPIKE_QA_FIXTURE: "next-app-mail",
    ...value,
  });
  assert.deepEqual(await guestQaVariables(env, { ...mailState(), qa: null }), {});
  assert.deepEqual(
    await guestQaVariables(env, {
      ...mailState(),
      config: { fixture: "react-vite" },
      qa: { fixture: "react-vite" },
    }),
    { SPIKE_QA_FIXTURE: "react-vite" },
  );
  assert.equal(reads, 1);

  for (const [name, mutate] of [
    [
      "foreign project",
      (v) => {
        v.OHMYHOST_PROJECT_ID = id(99);
      },
    ],
    [
      "real key",
      (v) => {
        v.OHMYHOST_MAIL_KEY = "private-mail-key";
      },
    ],
    [
      "real acceptance token",
      (v) => {
        v.PREVIEW_ACCEPTANCE_KEY = "private-acceptance-token";
      },
    ],
    [
      "foreign gateway",
      (v) => {
        v.OHMYHOST_MAIL_GATEWAY_URL = "https://mail.example.invalid";
      },
    ],
    [
      "extra secret field",
      (v) => {
        v.SECRET = "private";
      },
    ],
    [
      "missing recipient",
      (v) => {
        delete v.PREVIEW_MAIL_RECIPIENT;
      },
    ],
    [
      "invalid recipient",
      (v) => {
        v.PREVIEW_MAIL_RECIPIENT = "not-an-address";
      },
    ],
    [
      "oversized recipient",
      (v) => {
        v.PREVIEW_MAIL_RECIPIENT = `${"a".repeat(320)}@b.invalid`;
      },
    ],
    [
      "recipient with control characters",
      (v) => {
        v.PREVIEW_MAIL_RECIPIENT = "private\nvalue@example.invalid";
      },
    ],
  ]) {
    await t.test(name, async () => {
      value = mailVariables();
      mutate(value);
      await assert.rejects(guestQaVariables(env, mailState()), /qa_guest_configuration_invalid/u);
    });
  }
  await t.test("a foreign QA fixture cannot supply a mail guest", async () => {
    value = mailVariables();
    await assert.rejects(guestQaVariables(env, { ...mailState(), qa: { fixture: "react-vite" } }));
  });
  await t.test("disabled QA cannot accept an undefined project ID", async () => {
    value = { ...mailVariables(), OHMYHOST_PROJECT_ID: undefined };
    await assert.rejects(guestQaVariables({ ...env, SPIKE_QA_ENABLED: "disabled" }, mailState()));
  });
});

test("mail authority returns only a live exact-session scalar snapshot", async (t) => {
  let lease = { id: sessionId, expiresAt: clockTime + 10_000, privateLease: "must-not-leak" };
  let state = mailState(),
    currentTime = clockTime;
  const lookups = [];
  const env = {
    SPIKE_LIMIT: {
      getByName(name) {
        lookups.push(["limit", name]);
        return { current: async () => lease };
      },
    },
    SANDBOX: {
      getByName(name) {
        lookups.push(["sandbox", name]);
        return { status: async () => state };
      },
    },
  };
  const read = (input = { sessionId }) => readMailSession(env, input, () => currentTime);
  assert.deepEqual(await read(), { sessionId, generation: 2, expiresAt: clockTime + 10_000 });
  assert.deepEqual(lookups.slice(0, 2), [
    ["limit", "development"],
    ["sandbox", sessionId],
  ]);
  for (const [name, bad] of [
    ["null request", null],
    ["missing ID", {}],
    ["invalid ID", { sessionId: "bad" }],
    ["extra input", { sessionId, extra: true }],
    ["non-string ID", { sessionId: [sessionId] }],
  ]) {
    await t.test(name, async () => {
      lookups.length = 0;
      assert.equal(await read(bad), null);
      assert.deepEqual(lookups, []);
    });
  }
  for (const [name, badLease] of [
    ["no lease", null],
    ["foreign lease", { id: "b".repeat(32), expiresAt: clockTime + 10_000 }],
    ["expired lease", { id: sessionId, expiresAt: clockTime }],
    ["invalid expiry", { id: sessionId, expiresAt: "future" }],
  ]) {
    await t.test(name, async () => {
      lease = badLease;
      lookups.length = 0;
      assert.equal(await read(), null);
      assert.equal(
        lookups.some(([kind]) => kind === "sandbox"),
        false,
      );
    });
  }
  lease = { id: sessionId, expiresAt: clockTime + 10_000 };
  for (const [name, badState] of [
    ["foreign fixture", { ...mailState(), config: { fixture: "react-vite" } }],
    ["foreign QA fixture", { ...mailState(), qa: { fixture: "react-vite" } }],
    ["not QA", { ...mailState(), qa: null }],
    ["not running", { ...mailState(), running: false }],
    ["not ready", { ...mailState(), ready: false }],
    ["poisoned", { ...mailState(), poisoned: true }],
    ["cleanup requested", { ...mailState(), cleanupRequested: true }],
    ["invalid generation", { ...mailState(), generation: 0 }],
  ]) {
    await t.test(name, async () => {
      state = badState;
      assert.equal(await read(), null);
    });
  }
  await t.test("lease expiring while status is read is rejected", async () => {
    state = mailState();
    currentTime = clockTime;
    env.SANDBOX.getByName = () => ({
      async status() {
        currentTime = lease.expiresAt;
        return state;
      },
    });
    assert.equal(await read(), null);
  });
  await t.test("lease replaced while status is read is rejected", async () => {
    lease = { id: sessionId, expiresAt: clockTime + 10_000 };
    currentTime = clockTime;
    env.SANDBOX.getByName = () => ({
      async status() {
        lease = { id: "b".repeat(32), expiresAt: clockTime + 10_000 };
        return state;
      },
    });
    assert.equal(await read(), null);
  });
  await t.test(
    "generic QA session lookup pins fixture and generation, with readiness optional",
    async () => {
      lease = { id: sessionId, expiresAt: clockTime + 10_000 };
      state = {
        ...mailState(),
        config: { fixture: "next-native-auth" },
        qa: { fixture: "next-native-auth" },
        ready: false,
        generation: 3,
      };
      env.SANDBOX.getByName = () => ({ status: async () => state });
      const session = (fixture, generation, ready) =>
        readQaSession(env, { sessionId }, fixture, generation, ready, () => clockTime);
      assert.deepEqual(await session("next-native-auth", 3, false), {
        sessionId,
        generation: 3,
        expiresAt: lease.expiresAt,
      });
      assert.equal(await session("next-native-auth", 2, false), null);
      assert.equal(await session("next-native-auth", 3, true), null);
      assert.equal(await session("next-app-mail", 3, false), null);
      state.qa.fixture = "next-app-mail";
      assert.equal(await session("next-native-auth", 3, false), null);
    },
  );
  await t.test("invalid clock cannot make an expired lease active", async () => {
    lease = { id: sessionId, expiresAt: clockTime - 1 };
    state = mailState();
    assert.equal(await readMailSession(env, { sessionId }, () => Number.NaN), null);
  });
});
