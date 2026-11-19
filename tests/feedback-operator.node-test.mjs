import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { perform, parseOptions, readInput } from "../scripts/feedback-operator.mjs";
import { Readable } from "node:stream";

const database = "22802c60-952a-4d8e-974d-43de060ed347";
const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const org = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const event = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const receipt = { id, organization_id: org, submitted_at: "2026-01-01T00:00:00.000Z" };
const session = [
  "e30",
  Buffer.from(
    JSON.stringify({
      iss: "https://api.workos.com/user_management/client_00000000000000000000000018",
      client_id: "client_00000000000000000000000018",
      sub: "user_operator",
      sid: "session_abc",
      org_id: "org_abc",
      exp: Math.floor(Date.now() / 1000) + 1000,
    }),
  ).toString("base64url"),
  "c2ln",
].join(".");
const request = {
  feedbackId: id,
  status: "resolved",
  release: "0.1.50",
  reply: "The requested behavior is now available. 😀",
};

function fixture({
  actor = "user:user_operator",
  environment = "production",
  live = 100,
  status = "received",
  uncertain = false,
} = {}) {
  const calls = [];
  return {
    calls,
    token: "not-logged-token",
    makeEventId: () => event,
    fetcher: async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith("/v1/me")
          ? { actor_id: actor, organization_ids: [] }
          : {
              success: true,
              result: url.endsWith("/settings")
                ? {
                    bindings: [
                      { name: "CONTROL_CORE", type: "d1", id: database },
                      { name: "CONTROL_CORE_DATABASE_ID", type: "plain_text", text: database },
                      {
                        name: "CONTROL_PLATFORM_ENVIRONMENT",
                        type: "plain_text",
                        text: environment,
                      },
                    ],
                  }
                : url.endsWith("/deployments")
                  ? { deployments: [{ versions: [{ percentage: live, version_id: "v1" }] }] }
                  : {
                      uuid: database,
                      name: "ohmyho-control-core-production",
                      jurisdiction: "eu",
                      read_replication: { mode: "disabled" },
                    },
            },
    }),
    openProxy: async (_root, options) => {
      calls.push({ configPath: options.configPath });
      return {
        env: {
          FEEDBACK: {
            preview: async (input) => {
              calls.push({ preview: input });
              return { environment, receipt, currentStatus: status, lastEventId: null };
            },
            apply: async (input) => {
              calls.push({ apply: input });
              if (uncertain) {
                uncertain = false;
                throw new Error("Network connection lost");
              }
              return {
                outcome: "recorded",
                receipt,
                eventId: input.eventId,
                status: input.status,
                recordedAt: "2026-01-02T00:00:00.000Z",
              };
            },
          },
        },
        dispose: async () => {
          calls.push({ disposed: true });
        },
      };
    },
  };
}

test("preview fixes receipt, actor, target and event; apply and same-review retry invoke only the private capability", async () => {
  const options = parseOptions(["preview", "--environment", "production"]),
    f = fixture();
  const review = await perform(options, { session, request }, f);
  assert.equal(review.snapshot.actorId, "user:user_operator");
  assert.equal(review.snapshot.expectedStatus, "received");
  assert.equal(review.snapshot.expectedLastEventId, null);
  assert.equal(review.snapshot.receipt.id, id);
  assert.equal(review.snapshot.eventId, event);
  assert.doesNotMatch(JSON.stringify(review), /not-logged-token|c2ln/u);
  const applied = await perform({ ...options, command: "apply" }, { session, review }, f);
  const replay = await perform({ ...options, command: "apply" }, { session, review }, f);
  assert.deepEqual(applied, replay);
  assert.deepEqual(
    f.calls.filter((x) => x.apply).map((x) => x.apply),
    [review.snapshot, review.snapshot],
  );
  assert.equal(f.calls.filter((x) => x.disposed).length, 3);
  const lost = fixture({ uncertain: true });
  await assert.rejects(perform({ ...options, command: "apply" }, { session, review }, lost));
  await perform({ ...options, command: "apply" }, { session, review }, lost);
  assert.deepEqual(
    lost.calls.filter((x) => x.apply).map((x) => x.apply),
    [review.snapshot, review.snapshot],
  );
});

test("rejects bad identity, provider environment, changed review, malformed options and unsafe input", async () => {
  const options = parseOptions(["preview", "--environment", "production"]);
  await assert.rejects(
    perform(options, { session, request }, fixture({ actor: "user:someone_else" })),
  );
  await assert.rejects(
    perform(options, { session, request }, fixture({ environment: "development" })),
  );
  await assert.rejects(perform(options, { session, request }, fixture({ live: 50 })));
  await assert.rejects(
    perform(options, { session, request: { ...request, reply: "short" } }, fixture()),
  );
  await assert.rejects(
    perform(
      options,
      { session, request: { ...request, reply: "An invalid surrogate must be refused: \ud800" } },
      fixture(),
    ),
  );
  const review = await perform(options, { session, request }, fixture());
  await assert.rejects(
    perform(
      { ...options, command: "apply" },
      { session, review: { ...review, snapshot: { ...review.snapshot, status: "closed" } } },
      fixture(),
    ),
  );
  await assert.rejects(
    perform(
      { ...options, environment: "development", command: "apply" },
      { session, review },
      fixture(),
    ),
  );
  assert.throws(() => parseOptions(["apply", "--environment", "production", "--actor", "fake"]));
  await assert.rejects(readInput(Readable.from([Buffer.from("x".repeat(21000))]), "preview"));
  assert.deepEqual(
    await readInput(Readable.from([Buffer.from(JSON.stringify({ session, request }))]), "preview"),
    { session, request },
  );
});

test("validated RPC acknowledgement remains usable after its proxy is disposed", async () => {
  const options = parseOptions(["preview", "--environment", "production"]),
    f = fixture();
  const review = await perform(options, { session, request }, f);
  const openOriginal = f.openProxy;
  let disposed = false;
  f.openProxy = async (...args) => {
    const actual = await openOriginal(...args);
    return {
      env: {
        FEEDBACK: {
          apply: async (input) => {
            const result = await actual.env.FEEDBACK.apply(input);
            return new Proxy(result, {
              get(target, property, receiver) {
                if (disposed) throw new Error("RPC result used after proxy disposal");
                return Reflect.get(target, property, receiver);
              },
            });
          },
        },
      },
      dispose: async () => {
        disposed = true;
        await actual.dispose();
      },
    };
  };
  const result = await perform({ ...options, command: "apply" }, { session, review }, f);
  assert.equal(disposed, true);
  assert.deepEqual(result, {
    outcome: "recorded",
    receipt,
    eventId: event,
    status: request.status,
    recordedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(f.calls.filter((call) => call.apply).length, 1);
});
