import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";
import process from "node:process";
import {
  inspectSession,
  parseOptions,
  perform,
  readSecrets,
} from "../scripts/native-auth-restore-operator.mjs";

const account = "00000000000000000000000000000001",
  org = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  project = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const args = [
  "--environment",
  "production",
  "--account",
  account,
  "--organization",
  org,
  "--project",
  project,
  "--export",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "--restore",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "--claim",
  "12345678-1234-1234-1234-123456789abc",
  "--sha256",
  "a".repeat(64),
];
const jwt = (extra = {}) =>
  [
    "e30",
    Buffer.from(
      JSON.stringify({
        iss: "https://api.workos.com/user_management/client_00000000000000000000000018",
        client_id: "client_00000000000000000000000018",
        sub: "user_abc",
        sid: "session_abc",
        org_id: "org_abc",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 1000,
        ...extra,
      }),
    ).toString("base64url"),
    "c2ln",
  ].join(".");
function fixtures({
  actor = "user:user_abc",
  organizations = [org],
  namespace = "production",
  status = "absent",
  settings,
  invoke,
} = {}) {
  let calls = [];
  const resumes = [];
  const bindings = [
    { type: "plain_text", name: "RESOURCE_NAMESPACE", text: "production" },
    {
      type: "durable_object_namespace",
      name: "RECOVERY_SANDBOX",
      class_name: "RecoverySandbox",
      namespace_id: "a".repeat(32),
    },
    { type: "secret_text", name: "RECOVERY_CONFIGURATION" },
    ...[
      [
        "NATIVE_RESTORE_JOB_STORE",
        "ohmyho-control-store-production",
        "NativeAuthRestoreJobRuntime",
      ],
      ["RECOVERY_CONTROL_STORE", "ohmyho-control-store-production", "RecoveryRuntime"],
      ...["US", "EU"].flatMap((region) => [
        [
          `NATIVE_RESTORE_ADMIN_${region}`,
          `ohmyho-native-auth-production-${region.toLowerCase()}`,
          "NativeAdminService",
        ],
        [
          `NATIVE_RESTORE_POLICY_${region}`,
          `ohmyho-native-auth-production-${region.toLowerCase()}`,
          "NativePolicyService",
        ],
        [
          `NATIVE_RESTORE_PREPARATION_${region}`,
          "ohmyho-neon-management-production",
          "NativeAuthRestorePreparationService",
        ],
      ]),
    ].map(([name, service, entrypoint]) => ({ type: "service", name, service, entrypoint })),
  ];
  return {
    calls,
    resumes,
    fetcher: async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/v1/me")
          ? { actor_id: actor, organization_ids: organizations }
          : {
              success: true,
              result: url.endsWith("/containers/me")
                ? { external_account_id: account }
                : { bindings: settings ? settings(bindings) : bindings },
            },
    }),
    openProxy: async () => ({
      env: {
        RECOVERY: {
          inspectNativeRestore: async () => ({ status: "ready", namespace }),
          observeNativeRestore: async (x) => ({
            status,
            restoreId: x.restoreId,
            claimId: x.claimId,
          }),
          resumeNativeRestore: async (x) => {
            resumes.push(globalThis.structuredClone(x));
            status = "complete";
            return { status: "complete", restoreId: x.restoreId };
          },
          invokeNativeRestore: async (x) => {
            calls.push(globalThis.structuredClone(x));
            status = "unknown";
            const result = invoke
              ? await invoke(x)
              : { status: "complete", restoreId: x.restoreId };
            status = "complete";
            return result;
          },
        },
      },
      dispose: async () => {},
    }),
  };
}
test("private caller checks scope and serializes exact invocation, with explicit replay identity", async () => {
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const o = parseOptions([...args, "--execute"]),
    f = fixtures();
  assert.equal(
    inspectSession(jwt({ auth_time: 0, roles: ["member", "billing"] }), {
      client: "client_00000000000000000000000018",
    }),
    "user_abc",
  );
  const secrets = {
    session: jwt({ auth_time: 0, roles: ["member"], permissions: ["widgets:users-table:manage"] }),
    passphrase: "private passphrase",
  };
  assert.equal((await perform(o, secrets, f)).status, "complete");
  assert.deepEqual(f.calls, [
    {
      organizationId: org,
      projectId: project,
      restoreId: o.restoreId,
      claimId: o.claimId,
      principalId: "user:user_abc",
      exportOperationId: o.exportOperationId,
      archiveSha256: o.archiveSha256,
      passphrase: secrets.passphrase,
    },
  ]);
  await perform(o, secrets, f);
  assert.equal(f.calls.length, 1); // A known-complete restore never dispatches again.
  const resumable = fixtures({ status: "resume-input" });
  await perform(o, secrets, resumable);
  assert.deepEqual(f.calls[0], resumable.calls[0]);
  const consumed = fixtures({ status: "resume-consumed" });
  await perform(o, { session: jwt() }, consumed);
  assert.deepEqual(consumed.resumes, [
    { organizationId: org, projectId: project, restoreId: o.restoreId, claimId: o.claimId },
  ]);
  assert.equal(consumed.calls.length, 0);
  const cleanup = fixtures({ status: "resume-cleanup" });
  await perform(o, { session: jwt() }, cleanup);
  assert.deepEqual(cleanup.resumes, consumed.resumes);
  assert.equal(cleanup.calls.length, 0);
  const cleanupWithNewClaim = fixtures({ status: "resume-cleanup" });
  await assert.rejects(
    perform(
      { ...o, rearmClaimId: "87654321-1234-1234-1234-123456789abc" },
      { session: jwt() },
      cleanupWithNewClaim,
    ),
  );
  assert.equal(cleanupWithNewClaim.resumes.length, 0);
  const rearmClaimId = "87654321-1234-1234-1234-123456789abc";
  const rearm = fixtures({ status: "rearm-input" });
  await perform(
    parseOptions([...args, "--execute", "--rearm-claim", rearmClaimId]),
    secrets,
    rearm,
  );
  assert.deepEqual(rearm.calls, [
    { ...f.calls[0], claimId: rearmClaimId, expectedPreviousClaimId: o.claimId },
  ]);
  const encoded = Buffer.from(JSON.stringify({ session: jwt(), passphrase: "p\u00e4ss" }));
  const split = encoded.indexOf(Buffer.from("\u00e4")) + 1;
  assert.equal(
    (await readSecrets(Readable.from([encoded.subarray(0, split), encoded.subarray(split)]), true))
      .passphrase,
    "p\u00e4ss",
  );
  await assert.rejects(readSecrets(Readable.from([Buffer.from([255])]), true));
  await assert.rejects(readSecrets(Readable.from([Buffer.alloc(20001)]), true));
  const preview = fixtures();
  assert.equal(
    (await perform(parseOptions(args), { session: jwt() }, preview)).status,
    "wiring_ready",
  );
  assert.equal(preview.calls.length, 0);
});
test("rejects foreign account, scope, narrowed tokens and unavailable readiness before invocation", async () => {
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  assert.throws(() => parseOptions(args.map((x) => (x === account ? "f".repeat(32) : x))));
  assert.throws(() => parseOptions([...args, "--rearm-claim", args[args.indexOf("--claim") + 1]]));
  const o = parseOptions([...args, "--execute"]);
  for (const [f, session] of [
    [fixtures({ organizations: [] }), jwt()],
    [fixtures({ actor: "user:other" }), jwt()],
    [fixtures({ namespace: "wrong" }), jwt()],
    [fixtures({ status: "active" }), jwt()],
    [fixtures({ status: "unknown" }), jwt()],
    [fixtures({ status: "rearm-input" }), jwt()],
    [fixtures({ status: "unexpected" }), jwt()],
    [fixtures({ settings: () => [] }), jwt()],
    [
      fixtures({
        settings: (bindings) =>
          bindings.map((binding) =>
            binding.name === "NATIVE_RESTORE_JOB_STORE"
              ? { ...binding, service: "ohmyho-control-store-poc-private-fullstack" }
              : binding,
          ),
      }),
      jwt(),
    ],
    [fixtures({ settings: (bindings) => [...bindings, bindings[0]] }), jwt()],
    [
      fixtures({
        settings: (bindings) =>
          bindings.map((binding) =>
            binding.name === "RESOURCE_NAMESPACE"
              ? { ...binding, text: "poc-private-fullstack" }
              : binding,
          ),
      }),
      jwt(),
    ],
    [fixtures(), jwt({ ohmyhost_authorization: { actions: [] } })],
    [fixtures(), jwt({ permissions: [null] })],
    [fixtures(), jwt({ auth_time: -1 })],
    [fixtures(), jwt({ auth_time: 1.5 })],
    [fixtures(), jwt({ auth_time: "123" })],
    [fixtures(), jwt({ auth_time: Number.MAX_SAFE_INTEGER + 1 })],
    [fixtures(), jwt({ roles: "member" })],
    [fixtures(), jwt({ roles: [null] })],
    [fixtures(), jwt({ roles: [""] })],
    [fixtures(), jwt({ roles: ["x".repeat(257)] })],
    [fixtures(), jwt({ roles: Array(101).fill("member") })],
    [fixtures(), jwt({ iss: "https://api.workos.com/other", roles: ["member"], auth_time: 0 })],
    [fixtures(), jwt({ client_id: "client_other", roles: ["member"], auth_time: 0 })],
    [fixtures(), jwt({ sid: undefined, roles: ["member"], auth_time: 0 })],
    [fixtures(), jwt({ exp: 1, roles: ["member"], auth_time: 0 })],
    [fixtures(), jwt({ scope: "auth:manage", roles: ["member"], auth_time: 0 })],
  ]) {
    await assert.rejects(
      perform(o, { session, passphrase: "secret" }, f),
      /NATIVE_RESTORE_UNVERIFIED/,
    );
    assert.equal(f.calls.length, 0);
  }
});
test("does not expose provider errors and preserves exact replay after failure", async () => {
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  const o = parseOptions([...args, "--execute"]);
  const f = fixtures({
    invoke: () => {
      throw new Error("opaque provider failure");
    },
  });
  await assert.rejects(perform(o, { session: jwt(), passphrase: "secret" }, f));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].claimId, o.claimId);
  await assert.rejects(perform(o, { session: jwt(), passphrase: "secret" }, f));
  assert.equal(f.calls.length, 1); // An uncertain effect is observed, never blindly retried.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["scripts/native-auth-restore-operator.mjs", ...args, "--execute"],
    {
      input: JSON.stringify({
        session: "private-session-should-not-appear",
        passphrase: "private-password-should-not-appear",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-session-should-not-appear|private-password-should-not-appear/,
  );
  assert.equal(JSON.parse(result.stderr).reason_code, "NATIVE_RESTORE_UNVERIFIED");
});
