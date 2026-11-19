import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
interface MiniflareInstance {
  getD1Database(binding: string, workerName?: string): Promise<unknown>;
  getWorker(name: string): Promise<unknown>;
  dispose(): Promise<void>;
}
type MiniflareConstructor = new (options: unknown) => MiniflareInstance;
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../../control-store/src/catalog/common.js";
import {
  applyWorkosSnapshot,
  recordMembershipBarrier,
  recordTerminalRevocation,
} from "../../control-store/src/catalog/identity/membership-state.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import {
  activateTestCore,
  migrate,
  organizationIdWithShard,
} from "../../control-store/test/support/control-d1.js";
import { digest } from "../../control-store/test/support/seed.js";
import { provider } from "./user-key-provider.fixture.js";

/*
 * The WorkOS management Worker over the REAL private WorkosRuntime service binding and REAL local D1 in
 * workerd. Two workers run in one Miniflare: `control` (the ControlRuntime entrypoint over the three D1
 * databases) and `workos` (the production lifecycle, revocation, D1 identity port and service-binding handler).
 * The only fake is the WorkOS provider, at the outbound fetch boundary the production code already uses.
 */

const WORKOS_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const CONTROL_DIRECTORY = fileURLToPath(new URL("../../control-store", import.meta.url));

function controlMiniflare(): { Miniflare: MiniflareConstructor } {
  const manifest = createRequire(import.meta.url).resolve("../../control-store/package.json");
  return createRequire(manifest)("miniflare") as { Miniflare: MiniflareConstructor };
}

/**
 * The REAL control-store Worker module: its actual `WorkosRuntime` class over the actual store, not a
 * delegation fixture. `cloudflare:workers` is the runtime's own module in workerd.
 */
const CONTROL_FIXTURE = `
export { ControlRuntime, MaintenanceRuntime, WorkosRuntime } from "./src/worker-main.ts";
export default { fetch() { return new Response("control"); } };
`;

/** The consumer: production lifecycle and revocation over the D1 identity port; no D1 or database binding. */
const WORKOS_FIXTURE = `
import { createD1WorkosIdentityPort } from "./src/d1-identity-port.ts";
import { createD1WorkosManagementDatabase } from "./src/d1-management-database.ts";
import { createD1WorkosPollerPort } from "./src/d1-poller-port.ts";
import { createWorkosUserKeyLifecycle } from "./src/user-key-lifecycle.ts";
import { createWorkosSessionRevocation } from "./src/session-revocation.ts";
import { createPrivateServiceBindingHandler } from "./src/service-binding.ts";
import { createUlidFactory, SystemEntropy } from "@ohmyhost/platform";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/session-eligible") {
      // the production session-status path: the D1 management database over the real service binding
      const database = createD1WorkosManagementDatabase(createD1WorkosIdentityPort({ runtime: env.CONTROL_RUNTIME }), createD1WorkosPollerPort({ runtime: env.CONTROL_RUNTIME, auditIds: {next: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV"} }));
      return Response.json(await database.isSessionEligible(await request.json()));
    }
    if (url.pathname === "/fixture/probe") {
      // a method of the binding called on the binding itself, as production does; used only to show that a
      // command outside the closed list is not served by the real ControlRuntime class
      const { method, input } = await request.json();
      try {
        await env.CONTROL_RUNTIME[method](input);
        return Response.json({ served: true });
      } catch (error) {
        return Response.json({
          served: false,
          name: String(error && error.name),
          message: String(error && error.message),
        });
      }
    }
    const identity = createD1WorkosIdentityPort({ runtime: env.CONTROL_RUNTIME });
    const fixed = request.headers.get("x-fixture-now");
    const clock = { now: () => (fixed === null ? new Date() : new Date(fixed)) };
    const ids = createUlidFactory({ clock: { now: () => new Date() }, entropy: new SystemEntropy() });
    const shared = { identity, credential: "test-workos-management", fetcher: (r) => fetch(r), clock, ids };
    return createPrivateServiceBindingHandler({
      rpc: {},
      userKeyLifecycle: createWorkosUserKeyLifecycle(shared),
      sessionRevocation: createWorkosSessionRevocation(shared),
    }).fetch(request);
  },
};
`;

async function bundle(
  contents: string,
  resolveDir: string,
): Promise<{ text: string; inputs: string[] }> {
  const result = await build({
    stdin: { contents, resolveDir, sourcefile: "fixture.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers", "node:*"],
    metafile: true,
    write: false,
    logLevel: "error",
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error("empty fixture bundle");
  return { text: output.text, inputs: Object.keys(result.metafile.inputs) };
}

let miniflare: MiniflareInstance;
let workos: { fetch(url: string, init?: RequestInit): Promise<Response> };
let context: CatalogContext;
let directory: D1Database;
let shards: D1Database[];
let fake: ReturnType<typeof provider>;
let closureInputs: string[] = [];
let sequence = 0;

beforeAll(async () => {
  const { Miniflare } = controlMiniflare();
  fake = provider();
  const control = await bundle(CONTROL_FIXTURE, CONTROL_DIRECTORY);
  const consumer = await bundle(WORKOS_FIXTURE, WORKOS_DIRECTORY);
  closureInputs = consumer.inputs;
  miniflare = new Miniflare({
    workers: [
      {
        name: "control",
        modules: true,
        script: control.text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: {
          CONTROL_CORE: "core",
        },
      },
      {
        name: "workos",
        modules: true,
        script: consumer.text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        // The service binding is the consumer's only Control authority: no D1 binding, no database URL.
        serviceBindings: { CONTROL_RUNTIME: { name: "control", entrypoint: "WorkosRuntime" } },
        outboundService: (request: Request) => fake.handle(request),
      },
    ],
  });
  directory = (await miniflare.getD1Database("CONTROL_CORE", "control")) as unknown as D1Database;
  // One shared core: the Directory, the organization rows and the ledger are the same database.
  shards = [directory, directory];
  await migrate(directory, "core");
  await activateTestCore(directory);
  context = { directory, router: new SharedCoreRouter(directory) };
  workos = (await miniflare.getWorker("workos")) as unknown as typeof workos;
}, 120_000);

afterAll(async () => miniflare.dispose());

const at = (second: number) => `2026-10-28T12:00:${String(second).padStart(2, "0")}.000Z`;
const FAR_FUTURE = 4_102_444_800;

async function seed(shard = 0) {
  sequence += 1;
  const organizationId = await organizationIdWithShard(2, shard, 13_000_000 + sequence * 7919);
  const workosOrganizationId = `org_d1rt${sequence}`;
  const owner = `user_d1owner${sequence}`;
  await applyWorkosSnapshot(context, {
    organizationId,
    workosOrganizationId,
    state: "active",
    snapshotDigest: digest(sequence + 20_000),
    snapshotFetchedAt: at(1),
    synchronizedAt: at(2),
    triggerEventId: `event_d1rt_${sequence}`,
    auditEventId: newUlid(),
    memberships: [
      { workosUserId: owner, role: "admin", status: "active", digest: digest(sequence + 30_000) },
    ],
  });
  await (shards[shard] as D1Database)
    .prepare("UPDATE organizations SET beta_admitted_at = ? WHERE organization_id = ?")
    .bind("2026-10-28T08:00:00.000000Z", organizationId)
    .run();
  return {
    organizationId,
    workosOrganizationId,
    owner,
    shard,
    sessionId: `session_d1rt${sequence}`,
  };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const scope = (s: Seeded, change: Record<string, unknown> = {}) => ({
  organizationId: s.organizationId,
  workosOrganizationId: s.workosOrganizationId,
  userId: s.owner,
  sessionId: s.sessionId,
  tokenExpiresAt: FAR_FUTURE,
  ...change,
});

async function post(path: string, body: unknown, now?: string) {
  const response = await workos.fetch(`https://workos.internal${path}`, {
    method: "POST",
    headers: now === undefined ? {} : { "x-fixture-now": now },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const create = (s: Seeded, idempotencyKey: string, change: Record<string, unknown> = {}) =>
  post("/user-api-keys/create", scope(s, { name: "ci key", idempotencyKey, ...change }));

const requestRows = async (s: Seeded) =>
  (
    await (shards[s.shard] as D1Database)
      .prepare(
        "SELECT request_id, provider_key_id, failure_code FROM user_api_key_requests WHERE organization_id = ? ORDER BY request_id",
      )
      .bind(s.organizationId)
      .all<{ request_id: string; provider_key_id: string | null; failure_code: string | null }>()
  ).results;

const auditTypes = async (s: Seeded) =>
  (
    await (shards[s.shard] as D1Database)
      .prepare(
        "SELECT event_type FROM organization_audit_events WHERE organization_id = ? AND event_type LIKE 'UserApiKey%' ORDER BY audit_event_id",
      )
      .bind(s.organizationId)
      .all<{ event_type: string }>()
  ).results.map((row) => row.event_type);

const providerWrites = () =>
  fake.state.posts.filter((entry) => entry.startsWith("POST /user_management/users/"));

describe("WorkOS user-key lifecycle over the real ControlRuntime service binding", () => {
  it("ports a closure that imports no PostgreSQL, database package or direct D1 access", () => {
    const outside = closureInputs.filter((input) =>
      /node_modules\/(?:\.pnpm\/)?(?:pg|pg-pool|@ohmyhost\+database)/u.test(input),
    );
    expect(outside).toEqual([]);
    expect(closureInputs.some((input) => input.includes("packages/database"))).toBe(false);
    expect(closureInputs.some((input) => input.endsWith("src/d1-identity-port.ts"))).toBe(true);
  });

  it("claims before the provider key, creates it once, returns the value once and replays without a second key", async () => {
    const s = await seed(0);
    const first = await create(s, "idem-happy");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ replayed: false, value: `sk_${"a".repeat(32)}` });
    expect(providerWrites().length).toBe(1);
    const requestId = first.body["request_id"] as string;
    expect(await requestRows(s)).toEqual([
      {
        request_id: requestId,
        provider_key_id: "api_key_" + fake.state.keys.length,
        failure_code: null,
      },
    ]);
    const replay = await create(s, "idem-happy");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ request_id: requestId, replayed: true, value: null });
    expect(fake.state.keys).toHaveLength(1);
    expect((await requestRows(s)).length).toBe(1);
    // Another request under the same idempotency key is refused, not served.
    const reused = await create(s, "idem-happy", { name: "other key" });
    expect(reused).toMatchObject({
      status: 409,
      body: { error: { code: "idempotency_key_reused" } },
    });
    expect(fake.state.keys).toHaveLength(1);
  });

  it("finishes the original request after a lost provider response without a second key", async () => {
    const s = await seed(1);
    const before = fake.state.keys.length;
    fake.state.loseNextCreateResponse = true;
    const lost = await create(s, "idem-lost");
    expect(lost).toMatchObject({
      status: 503,
      body: { error: { code: "api_key_creation_uncertain" } },
    });
    expect(fake.state.keys.length).toBe(before + 1);
    const rows = await requestRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_key_id).toBeNull();
    // A later clock (an hour after the claim, whatever the date today) does not change the claim: the same request
    // is found at the provider and finished.
    const retried = await post(
      "/user-api-keys/create",
      scope(s, { name: "ci key", idempotencyKey: "idem-lost" }),
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ replayed: true, value: null });
    expect(fake.state.keys.length).toBe(before + 1);
    expect(await requestRows(s)).toEqual([
      {
        request_id: rows[0]?.request_id,
        provider_key_id: `api_key_${fake.state.keys.length}`,
        failure_code: null,
      },
    ]);
  });

  it("refuses another tenant, a stranger, an expired token, a revoked session and an open barrier before any provider write", async () => {
    const s = await seed(0);
    const other = await seed(1);
    const writes = providerWrites().length;
    const cases: [string, Record<string, unknown>][] = [
      ["wrong tenant", { workosOrganizationId: other.workosOrganizationId }],
      ["wrong organization id", { organizationId: other.organizationId }],
      ["stranger", { userId: "user_stranger" }],
    ];
    for (const [label, change] of cases) {
      const response = await create(s, `idem-${label}`.replaceAll(" ", "-"), change);
      expect([label, response.status]).toEqual([label, 404]);
    }
    const expired = await create(s, "idem-expired", { tokenExpiresAt: 1 });
    expect(expired).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    await recordTerminalRevocation(context, {
      kind: "session",
      sessionId: s.sessionId,
      workosUserId: s.owner,
      sourceEventId: `rev_${s.sessionId}`,
      effectiveAt: at(5),
    });
    expect((await create(s, "idem-revoked")).status).toBe(404);
    const barred = await seed(0);
    await recordMembershipBarrier(context, {
      workosOrganizationId: barred.workosOrganizationId,
      workosUserId: barred.owner,
      sourceEventId: "bar_d1rt",
      eventCreatedAt: at(30),
    });
    expect((await create(barred, "idem-barrier")).status).toBe(404);
    expect(providerWrites().length).toBe(writes);
    expect(await requestRows(s)).toEqual([]);
    expect(await requestRows(barred)).toEqual([]);
    expect((await post("/user-api-keys/create", { nope: 1 })).status).toBe(400);
  });

  it("loses no authority silently when the user is revoked after the claim and before the provider create returns", async () => {
    const s = await seed(0);
    fake.state.beforeCreate = async () => {
      fake.state.beforeCreate = undefined;
      await recordTerminalRevocation(context, {
        kind: "user",
        workosUserId: s.owner,
        sourceEventId: `rev_user_${s.owner}`,
        effectiveAt: "2026-10-28T00:00:00.000Z",
      });
    };
    const response = await create(s, "idem-between");
    // The provider key exists and its id is recorded (finish is evidence, as in the original); the final
    // authorization after the finish refuses the response, so the plaintext is never returned.
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("sk_");
    expect(fake.state.keys.some((key) => key.user === s.owner)).toBe(true);
    const rows = await requestRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_key_id).toMatch(/^api_key_\d+$/u);
  });

  it("lists with the recorded names and revokes with both audit stages once", async () => {
    const s = await seed(1);
    const created = await create(s, "idem-list");
    expect(created.status).toBe(200);
    const listed = await post("/user-api-keys/list", scope(s, { after: null }));
    expect(listed.status).toBe(200);
    expect((listed.body["data"] as { name: string }[])[0]?.name).toBe("ci key");
    const keyId = (created.body["key"] as { id: string }).id;
    expect(await post("/user-api-keys/revoke", scope(s, { keyId }))).toMatchObject({
      status: 200,
      body: { revoked: true },
    });
    expect(fake.state.keys.some((key) => key.id === keyId)).toBe(false);
    expect(await auditTypes(s)).toEqual(
      expect.arrayContaining(["UserApiKeyRevocationRequested", "UserApiKeyRevoked"]),
    );
    const again = await post("/user-api-keys/revoke", scope(s, { keyId }));
    expect(again).toMatchObject({ status: 200, body: { revoked: true } });
    expect((await auditTypes(s)).filter((type) => type === "UserApiKeyRevoked").length).toBe(1);
    expect((await post("/user-api-keys/revoke", scope(s, { keyId: "bad" }))).status).toBe(400);
  });
});

describe("WorkOS session revocation over the real ControlRuntime service binding", () => {
  it("revokes the proven session once, answers repeats from the directory and refuses another user", async () => {
    sequence += 1;
    const user = `user_logout${sequence}`;
    const session = `session_logout${sequence}`;
    fake.state.sessions.push({ id: session, user_id: user, status: "active" });
    const revoked = await post("/session-revoke", { userId: user, sessionId: session });
    expect(revoked).toMatchObject({ status: 200, body: { revoked: true } });
    const stored = await directory
      .prepare("SELECT workos_user_id FROM revocations WHERE kind = 'session' AND resource_id = ?")
      .bind(session)
      .first<{ workos_user_id: string }>();
    expect(stored?.workos_user_id).toBe(user);
    const providerRevokes = () =>
      fake.state.posts.filter((entry) => entry === "POST /user_management/sessions/revoke").length;
    const count = providerRevokes();
    expect(await post("/session-revoke", { userId: user, sessionId: session })).toMatchObject({
      status: 200,
      body: { revoked: true },
    });
    expect(providerRevokes()).toBe(count);
    expect(
      await post("/session-revoke", { userId: `user_other${sequence}`, sessionId: session }),
    ).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(
      await post("/session-revoke", { userId: user, sessionId: `session_unknown${sequence}` }),
    ).toMatchObject({ status: 403 });
    expect((await post("/session-revoke", { userId: user })).status).toBe(400);
  });
});

describe("the eight WorkOS commands reach the actual ControlRuntime class over the real binding", () => {
  const eligible = async (input: Record<string, unknown>) =>
    (await (
      await workos.fetch("https://workos.internal/fixture/session-eligible", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).json()) as boolean;
  const probe = async (method: string, input: unknown) =>
    (await (
      await workos.fetch("https://workos.internal/fixture/probe", {
        method: "POST",
        body: JSON.stringify({ method, input }),
      })
    ).json()) as { served: boolean; name?: string; message?: string };

  it("answers session eligibility from the directory and shard, and denies after a revocation or a barrier", async () => {
    const s = await seed(0);
    const eligibility = (change: Record<string, unknown> = {}) => ({
      sessionId: s.sessionId,
      workosUserId: s.owner,
      workosOrganizationId: s.workosOrganizationId,
      observedAt: at(40),
      ...change,
    });
    expect(await eligible(eligibility())).toBe(true);
    expect(await eligible(eligibility({ workosUserId: "user_stranger" }))).toBe(false);
    expect(await eligible(eligibility({ workosOrganizationId: "org_unknown_d1rt" }))).toBe(false);
    await recordTerminalRevocation(context, {
      kind: "session",
      sessionId: s.sessionId,
      workosUserId: s.owner,
      sourceEventId: `rev_elig_${s.sessionId}`,
      effectiveAt: at(10),
    });
    expect(await eligible(eligibility())).toBe(false);
    const barred = await seed(1);
    expect(
      await eligible(
        eligibility({
          sessionId: barred.sessionId,
          workosUserId: barred.owner,
          workosOrganizationId: barred.workosOrganizationId,
        }),
      ),
    ).toBe(true);
    await recordMembershipBarrier(context, {
      workosOrganizationId: barred.workosOrganizationId,
      workosUserId: barred.owner,
      sourceEventId: "bar_elig_d1rt",
      eventCreatedAt: at(30),
    });
    expect(
      await eligible(
        eligibility({
          sessionId: barred.sessionId,
          workosUserId: barred.owner,
          workosOrganizationId: barred.workosOrganizationId,
        }),
      ),
    ).toBe(false);
  });

  it("serves the closed identity, poller and onboarding WorkOS surface and refuses other authority", async () => {
    // Each of the fifteen reaches its store command through the actual class: a strict input the command
    // refuses (invalid_request) proves the method exists and validates; an unknown method is not served.
    for (const method of [
      "authorizeUserApiKeyScope",
      "claimUserApiKeyCreation",
      "finishUserApiKeyCreation",
      "readUserApiKeyNames",
      "recordTerminalRevocation",
      "isSessionEligible",
      "readSessionRevocation",
      "recordUserApiKeyRevocationAudit",
      "readCreditWarningScope",
      "isCreditWarningOwner",
      "prepareWorkosOnboarding",
      "claimWorkosOnboardingOrganization",
      "recordWorkosOnboardingOrganization",
      "claimWorkosOnboardingMembership",
      "completeWorkosOnboarding",
      "claimWorkosInboxEvent",
      "findExpiredFinalWorkosInboxClaim",
      "recordWorkosInboxFailure",
      "recoverExpiredFinalWorkosInboxLease",
      "applyPolledWorkosSnapshot",
      "applyWorkosOrganizationDeletion",
      "revokeLocalAuthorizationForUncertainSnapshot",
    ]) {
      const result = await probe(method, { unexpected: true });
      // the command's own strict input validation answered, so the actual class dispatched to its store command
      expect(
        ["invalid_request", "ZodError"],
        `${method}: ${result.name} ${result.message}`,
      ).toContain(result.message);
      expect(result.served).toBe(false);
    }
    // Financial, maintenance and global authority are absent from the entrypoint, not merely refused.
    for (const method of [
      "setPaidAccess",
      "reserveWithPolicy",
      "refundSourceCredits",
      "purgeReconciliationInbox",
      "routeUnroutedInboxEvents",
      "readScopedDnsGrant",
      "applyOrganizationSnapshot",
      "applyWorkosOrganizationSnapshot",
      "createInitialProject",
    ]) {
      const result = await probe(method, {});
      expect([method, result.served]).toEqual([method, false]);
      expect(result.message).toMatch(/does not implement|not implement/iu);
    }
  });
});
