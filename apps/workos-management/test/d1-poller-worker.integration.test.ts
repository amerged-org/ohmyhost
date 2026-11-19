import { readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid } from "../../control-store/src/catalog/common.js";
import type { D1Database } from "../../control-store/src/d1-types.js";
import { createControlStore } from "../../control-store/src/store.js";
import { activateTestCore, migrate } from "../../control-store/test/support/control-d1.js";

interface Runtime {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(input: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}
let runtime: Runtime;
let db: D1Database;
let worker: Awaited<ReturnType<Runtime["getWorker"]>>;
let controlProbe: Awaited<ReturnType<Runtime["getWorker"]>>;
let store: ReturnType<typeof createControlStore>;
let roles = [{ slug: "admin" }];
let providerCalls = 0;
const onboardingOrganizations = new Map<string, Record<string, unknown>>();
const onboardingMemberships: Record<string, unknown>[] = [];
const onboardingPosts: string[] = [];
let loseOrganizationReply = true;
let loseMembershipReply = true;
const ORG = "org_worker_poller";
/** Members (user id, role slug) of the organizations the membership-sync flood test lets the provider fixture serve. */
const organizationMembers = new Map<string, [string, string][]>();
const stamp = () => new Date().toISOString();
const stored = () => stamp().replace(/Z$/u, "000Z");
const bundle = async (contents: string, directory: URL) => {
  const output = await build({
    stdin: { contents, resolveDir: fileURLToPath(directory), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "node-built-in-modules",
        setup(builder) {
          builder.onResolve({ filter: /^(?:node:)?[a-z][a-z0-9_/-]*$/ }, (args) => {
            const name = args.path.replace(/^node:/, "");
            if (!builtinModules.includes(name) && !builtinModules.includes(`node:${name}`)) return;
            return args.kind === "require-call"
              ? { path: name, namespace: "node-built-in-modules" }
              : { path: `node:${name}`, external: true };
          });
          builder.onLoad({ filter: /.*/, namespace: "node-built-in-modules" }, (args) => ({
            contents: `import value from ${JSON.stringify(`node:${args.path}`)}; module.exports = value;`,
            loader: "js",
          }));
        },
      },
    ],
    write: false,
    logLevel: "error",
  });
  return output.outputFiles[0]?.text ?? "";
};
const WORKER = `
import {createWorkosManagementWorkerEntrypoint} from './src/worker-main.ts';
export {CreditWarningRecipientsService} from './src/worker-main.ts';
const actual = createWorkosManagementWorkerEntrypoint({
  fetcher: request => fetch(request),
});
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/fixture/recipients') {
    try {return Response.json(await env.CREDIT_RECIPIENTS.resolve(await request.json()));}
    catch(error) {return Response.json({error: String(error.message)}, {status:503});}
  }
  const bindings = url.searchParams.has('missing') ? {...env, CONTROL_RUNTIME: undefined} : env;
  if (url.pathname === '/fixture/scheduled') return Response.json(await actual.scheduled({cron:'* * * * *', scheduledTime:Date.now()}, bindings));
  return actual.fetch(request, bindings);
}};
`;
beforeAll(async () => {
  const controlManifest = createRequire(import.meta.url).resolve(
    "../../control-store/package.json",
  );
  const manifest = createRequire(controlManifest).resolve("wrangler/package.json");
  const { Miniflare, convertV4MiniflareOptions } = createRequire(manifest)("miniflare") as {
    convertV4MiniflareOptions(options: unknown): unknown;
    Miniflare: new (options: unknown) => Runtime;
  };
  const [control, consumer] = await Promise.all([
    bundle(
      `export {ControlRuntime, MaintenanceRuntime, WorkosRuntime} from './src/worker-main.ts'; export default {fetch(){return new Response('control')}};`,
      new URL("../../control-store/", import.meta.url),
    ),
    bundle(WORKER, new URL("../", import.meta.url)),
  ]);
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "probe",
          modules: true,
          script: readFileSync(
            new URL("../../../.github/scripts/phase1-workos-capability-probe.mjs", import.meta.url),
            "utf8",
          ),
          compatibilityDate: "2026-08-24",
          serviceBindings: { WORKOS_MANAGEMENT: "workos" },
        },
        {
          name: "control",
          modules: true,
          script: control,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { CONTROL_CORE: "core" },
        },
        {
          name: "workos",
          modules: true,
          script: consumer,
          compatibilityDate: "2026-08-24",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: {
            CONTROL_RUNTIME: { name: "control", entrypoint: "WorkosRuntime" },
            CREDIT_RECIPIENTS: { name: "workos", entrypoint: "CreditWarningRecipientsService" },
          },
          bindings: {
            WORKOS_DEPLOYMENT: "development",
            WORKOS_MANAGEMENT_CREDENTIAL: "fixture-workos-token",
            MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
            CF_VERSION_METADATA: {
              id: "11111111-1111-4111-8111-111111111111",
              tag: "a".repeat(64),
              timestamp: "2026-10-28T12:00:00.000Z",
            },
          },
          outboundService: async (request: Request) => {
            providerCalls++;
            expect(request.headers.get("authorization")).toBe("Bearer fixture-workos-token");
            const url = new URL(request.url);
            const at = stamp();
            if (url.pathname.startsWith("/organizations/external_id/")) {
              const value = onboardingOrganizations.get(
                decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
              );
              return Response.json(value ?? {}, { status: value === undefined ? 404 : 200 });
            }
            if (url.pathname === "/organizations" && request.method === "POST") {
              const value = (await request.json()) as Record<string, unknown>;
              const prior = await db
                .prepare(
                  "SELECT organization_attempted FROM onboarding_requests WHERE request_id=?",
                )
                .bind(value["external_id"])
                .first();
              expect(prior).toEqual({ organization_attempted: 1 });
              onboardingPosts.push(url.pathname);
              const organization = {
                ...value,
                id: `org_${String(value["external_id"])}`,
                created_at: at,
                updated_at: at,
              };
              onboardingOrganizations.set(String(value["external_id"]), organization);
              if (loseOrganizationReply) {
                loseOrganizationReply = false;
                return Response.json({ error: "reply lost" }, { status: 503 });
              }
              return Response.json(organization, { status: 201 });
            }
            if (
              url.pathname === "/user_management/organization_memberships" &&
              request.method === "POST"
            ) {
              const value = (await request.json()) as Record<string, unknown>;
              const prior = await db
                .prepare(
                  "SELECT membership_attempted FROM onboarding_requests WHERE workos_organization_id=?",
                )
                .bind(value["organization_id"])
                .first();
              expect(prior).toEqual({ membership_attempted: 1 });
              onboardingPosts.push(url.pathname);
              const membership = {
                id: "om_live_onboarding",
                organization_id: value["organization_id"],
                user_id: value["user_id"],
                status: "active",
                roles: [{ slug: value["role_slug"] }],
                created_at: at,
                updated_at: at,
              };
              onboardingMemberships.push(membership);
              if (loseMembershipReply) {
                loseMembershipReply = false;
                return Response.json({ error: "reply lost" }, { status: 503 });
              }
              return Response.json(membership, { status: 201 });
            }
            if (
              url.pathname === "/user_management/organization_memberships" &&
              url.searchParams.has("user_id")
            )
              return Response.json({
                object: "list",
                data: onboardingMemberships.filter(
                  (m) =>
                    m["user_id"] === url.searchParams.get("user_id") &&
                    (!url.searchParams.has("organization_id") ||
                      m["organization_id"] === url.searchParams.get("organization_id")),
                ),
                list_metadata: { after: null },
              });
            if (url.pathname === "/user_management/users/user_live_onboarding")
              return Response.json({
                object: "user",
                id: "user_live_onboarding",
                first_name: "Live",
                last_name: "User",
                email: "live@example.test",
                email_verified: true,
              });

            const servedOrganization = /^\/organizations\/(org_[a-z]+_\w+)$/u.exec(
              url.pathname,
            )?.[1];
            if (servedOrganization !== undefined && organizationMembers.has(servedOrganization))
              return Response.json({
                id: servedOrganization,
                name: "Fixture",
                created_at: at,
                updated_at: at,
              });
            const served = organizationMembers.get(url.searchParams.get("organization_id") ?? "");
            if (url.pathname === "/user_management/organization_memberships" && served)
              return Response.json({
                object: "list",
                data: served.map(([userId, slug]) => ({
                  id: `om_${userId}`,
                  organization_id: url.searchParams.get("organization_id"),
                  user_id: userId,
                  status: "active",
                  roles: [{ slug }],
                  created_at: at,
                  updated_at: at,
                })),
                list_metadata: { after: null },
              });
            if (url.pathname === `/organizations/${ORG}`)
              return Response.json({ id: ORG, name: "Fixture", created_at: at, updated_at: at });
            if (url.pathname === "/user_management/organization_memberships")
              return Response.json({
                object: "list",
                data: [
                  {
                    id: "om_worker_poller",
                    organization_id: ORG,
                    user_id: "user_worker_poller",
                    status: "active",
                    roles,
                    created_at: at,
                    updated_at: at,
                  },
                ],
                list_metadata: { after: null },
              });
            if (url.pathname === "/user_management/users/user_worker_poller")
              return Response.json({
                object: "user",
                id: "user_worker_poller",
                email_verified: true,
                email: "owner@example.test",
              });
            return Response.json({}, { status: 404 });
          },
        },
      ],
    }),
  );
  db = (await runtime.getD1Database("CONTROL_CORE", "control")) as D1Database;
  await migrate(db, "core");
  await activateTestCore(db);
  store = createControlStore({ CONTROL_CORE: db });
  worker = await runtime.getWorker("workos");
  controlProbe = await runtime.getWorker("probe");
}, 120_000);
afterAll(async () => runtime?.dispose());

const rows = async (sql: string, ...values: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all()
  ).results;
async function record(type = "organization.created", workosId = ORG, maxAttempts = 3) {
  const id = newUlid();
  await store.operations.recordInboxEvent({
    provider: "workos",
    inboxEventId: id,
    externalEventId: `evt_${id}`,
    eventType: type,
    payload: { schemaVersion: "workos.organization-trigger.v1", workosOrganizationId: workosId },
    bodyDigest: "ab".repeat(32),
    receivedAt: stamp(),
    signatureTimestamp: stamp(),
    maxAttempts,
    routing: { kind: "workos_organization", workosOrganizationId: workosId },
  });
  return id;
}
const scheduled = async () => {
  const response = await worker.fetch("https://fixture/fixture/scheduled");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    ok: boolean;
    recovery: { outcome: string } | null;
    poll: { outcome: string; changedScope?: string; errorCode?: string };
    polled: number;
  };
};

it("revokes a removed member in one scheduled run even when more organization creations are queued ahead of it than one run can drain", async () => {
  const victim = "org_removal_victim";
  organizationMembers.set(victim, [
    ["user_victim_owner", "admin"],
    ["user_removed_member", "member"],
  ]);
  await record("organization.created", victim);
  const created = await scheduled();
  expect(created.poll).toMatchObject({ outcome: "acknowledged" });
  const grants = (userId: string) =>
    rows(
      "SELECT revoked_at IS NULL AS active FROM local_authorization_grants WHERE principal_id=? AND project_id IS NULL",
      `user:${userId}`,
    );
  expect(await grants("user_removed_member")).toEqual([{ active: 1 }]);

  // A signed-in user creates workspaces in a loop: two events each, all received before the removal below.
  const flood: string[] = [];
  for (let index = 0; index < 35; index += 1) {
    const workos = `org_flood_${index}`;
    organizationMembers.set(workos, [[`user_flood_${index}`, "admin"]]);
    flood.push(await record("organization.created", workos));
    flood.push(await record("organization_membership.created", workos));
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  // WorkOS removes the member; the signed webhook reaches the inbox last and opens the fail-closed barrier at ingress.
  organizationMembers.set(victim, [["user_victim_owner", "admin"]]);
  const removalId = newUlid();
  const removedAt = stamp();
  await store.ingress.recordWorkosWebhook({
    inboxEventId: removalId,
    externalEventId: `evt_${removalId}`,
    eventType: "organization_membership.deleted",
    payload: { schemaVersion: "workos.organization-trigger.v1", workosOrganizationId: victim },
    bodyDigest: "cd".repeat(32),
    receivedAt: removedAt,
    signatureTimestamp: removedAt,
    maxAttempts: 3,
    projection: {
      kind: "membership-barrier",
      workosOrganizationId: victim,
      workosUserId: "user_removed_member",
      sourceEventId: `evt_${removalId}`,
      eventCreatedAt: removedAt,
    },
  });

  const run = await scheduled();

  // The removal never waits behind the queue: it is the first event this run claims, and the run drains a batch.
  expect(await rows("SELECT state FROM webhook_inbox WHERE inbox_event_id=?", removalId)).toEqual([
    { state: "acknowledged" },
  ]);
  expect(await grants("user_removed_member")).toEqual([{ active: 0 }]);
  expect(
    await rows(
      "SELECT state FROM organization_memberships WHERE workos_user_id='user_removed_member'",
    ),
  ).toEqual([{ state: "revoked" }]);
  expect(
    await rows(
      "SELECT reconciled_at IS NOT NULL AS closed FROM workos_membership_sync_barriers WHERE workos_user_id='user_removed_member'",
    ),
  ).toEqual([{ closed: 1 }]);
  expect(run.polled).toBeGreaterThan(1);
  const queued = async () =>
    (
      (
        await rows(
          `SELECT count(*) AS n FROM webhook_inbox WHERE acknowledged_at IS NULL AND inbox_event_id IN (${flood.map(() => "?").join(",")})`,
          ...flood,
        )
      )[0] as { n: number }
    ).n;
  // The flood is larger than one run, so the removal was served by priority, not because the queue was empty.
  expect(await queued()).toBeGreaterThan(0);
  // The remaining creations drain over the next runs and leave the shared inbox empty for the tests below.
  for (let tick = 0; tick < 5 && (await queued()) > 0; tick += 1) await scheduled();
  expect(await queued()).toBe(0);
}, 120_000);

it("runs the real WorkOS Worker scheduled and fetch paths through the real ControlRuntime binding", async () => {
  // The real provider-facing organization flow stores its intent/attempt before either POST. Lost replies
  // converge under the same request: no duplicate organization or membership is sent to the provider.
  const onboarding = {
    userId: "user_live_onboarding",
    sessionId: "session_live_onboarding",
    name: "Live workspace",
    signupSource: "direct",
    idempotencyKey: "live-onboard-key",
    initial: true,
  };
  const create = async (value = onboarding) =>
    worker.fetch("https://internal/organizations", { method: "POST", body: JSON.stringify(value) });
  const first = await create();
  expect(first.status).toBe(503);
  const second = await create();
  expect(second.status).toBe(503);
  const third = await create();
  expect(third.status).toBe(201);
  const workspace = (await third.json()) as { id: string; name: string };
  expect(workspace.name).toBe(onboarding.name);
  expect(onboardingPosts).toEqual(["/organizations", "/user_management/organization_memberships"]);
  expect(await (await create()).json()).toEqual(workspace);
  expect(
    await (
      await create({
        ...onboarding,
        idempotencyKey: "initial-another-key",
        name: "Ignored subsequent initial name",
      })
    ).json(),
  ).toEqual(workspace);
  const changed = await create({ ...onboarding, name: "Changed same idempotency key" });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ error: { code: "idempotency_key_reused" } });
  const profile = await worker.fetch("https://internal/user-profile", {
    method: "POST",
    body: JSON.stringify({ userId: onboarding.userId, sessionId: onboarding.sessionId }),
  });
  expect(profile.status).toBe(200);
  expect(await profile.json()).toEqual({
    user_id: onboarding.userId,
    workos_organization_ids: [`org_${workspace.id}`],
    name: "Live User",
    email: "live@example.test",
    email_verified: true,
  });
  // Completing the workspace opens its credit account (the Free month is renewed by its first charge) and grants nothing.
  expect(
    await rows(
      "SELECT organization_id, onetime_micros, reserved_micros FROM credit_account WHERE organization_id=?",
      workspace.id,
    ),
  ).toEqual([{ organization_id: workspace.id, onetime_micros: 0, reserved_micros: 0 }]);
  expect(await rows("SELECT key FROM credit_grant WHERE organization_id=?", workspace.id)).toEqual(
    [],
  );
  const probeRequest = {
    userId: onboarding.userId,
    sessionId: onboarding.sessionId,
    artifactSha256: "a".repeat(64),
    versionId: "11111111-1111-4111-8111-111111111111",
    deployment: "development",
  };
  const probeCall = () =>
    controlProbe.fetch("http://127.0.0.1/control-probe", {
      method: "POST",
      body: JSON.stringify(probeRequest),
    });
  const convergence = await probeCall();
  expect(convergence.status).toBe(200);
  const convergenceBody = await convergence.json();
  expect(convergenceBody).toMatchObject({
    schemaVersion: 3,
    kind: "workos-control-profile/v3",
    state: "verified",
  });
  expect(JSON.stringify(convergenceBody)).not.toContain("live@example.test");
  expect(JSON.stringify(convergenceBody)).not.toContain(onboarding.userId);
  await store.identity.recordTerminalRevocation({
    kind: "session",
    sessionId: onboarding.sessionId,
    workosUserId: onboarding.userId,
    sourceEventId: "evt_revoke_live_onboard",
    effectiveAt: stamp(),
  });
  expect((await create()).status).toBe(403);
  expect(onboardingPosts).toHaveLength(2);

  const created = await record();
  const result = await scheduled();
  expect(result).toMatchObject({ ok: true, recovery: null, poll: { outcome: "acknowledged" } });
  const organizationId = result.poll.changedScope;
  expect(organizationId).toBeTypeOf("string");
  expect(
    await rows("SELECT state, attempt_count FROM webhook_inbox WHERE inbox_event_id = ?", created),
  ).toEqual([{ state: "acknowledged", attempt_count: 1 }]);
  expect(
    await rows(
      "SELECT role, state FROM organization_memberships WHERE organization_id = ?",
      organizationId,
    ),
  ).toEqual([{ role: "admin", state: "active" }]);
  expect(
    await rows(
      "SELECT role FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
      organizationId,
    ),
  ).toEqual([{ role: "owner" }]);
  const exhaustedAt = new Date(Date.now() - 1000).toISOString();
  const warning = () =>
    worker.fetch("https://fixture/fixture/recipients", {
      method: "POST",
      body: JSON.stringify({ organizationId, exhaustedAt }),
    });
  expect(await (await warning()).json()).toEqual({
    organizationId,
    exhaustedAt,
    required: false,
    recipients: [],
  });
  await db
    .prepare("UPDATE organizations SET beta_admitted_at = ?1 WHERE organization_id = ?2")
    .bind(stored(), organizationId)
    .run();
  await db
    .prepare("UPDATE credit_account SET exhausted_at = ?2 WHERE organization_id = ?1")
    .bind(organizationId, exhaustedAt.replace(/Z$/u, "000Z"))
    .run();
  expect(await (await warning()).json()).toEqual({
    organizationId,
    exhaustedAt,
    required: true,
    recipients: [{ userId: "user_worker_poller", email: "owner@example.test" }],
  });
  const invalid = await record("organization.updated");
  roles = [{ slug: "admin" }, { slug: "member" }];
  expect(await scheduled()).toMatchObject({
    ok: true,
    poll: { outcome: "retry_scheduled", errorCode: "WORKOS_UNSUPPORTED_MULTIPLE_ROLES" },
  });
  expect(
    await rows(
      "SELECT grant_id FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
      organizationId,
    ),
  ).toEqual([]);
  expect(await rows("SELECT state FROM webhook_inbox WHERE inbox_event_id = ?", invalid)).toEqual([
    { state: "retry_wait" },
  ]);
  roles = [{ slug: "admin" }];
  expect(await (await warning()).json()).toEqual({ error: "credit_warning_no_verified_owner" });
  await db
    .prepare("UPDATE webhook_inbox SET available_at = ?1 WHERE inbox_event_id = ?2")
    .bind(stored(), invalid)
    .run();
  expect(await scheduled()).toMatchObject({
    ok: true,
    poll: { outcome: "acknowledged", changedScope: organizationId },
  });
  expect(
    await rows(
      "SELECT role FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
      organizationId,
    ),
  ).toEqual([{ role: "owner" }]);
  const beforeDelete = providerCalls;
  await record("organization.deleted");
  expect(await scheduled()).toMatchObject({
    ok: true,
    poll: { outcome: "acknowledged", changedScope: organizationId },
  });
  expect(providerCalls).toBe(beforeDelete);
  expect(
    await rows("SELECT state FROM organizations WHERE organization_id = ?", organizationId),
  ).toEqual([{ state: "deleted" }]);
  await record("organization.updated");
  expect(await scheduled()).toMatchObject({
    ok: true,
    poll: { outcome: "acknowledged", changedScope: organizationId },
  });
  expect(
    await rows("SELECT state FROM organizations WHERE organization_id = ?", organizationId),
  ).toEqual([{ state: "deleted" }]);
  expect(
    await rows(
      "SELECT grant_id FROM local_authorization_grants WHERE organization_id = ? AND revoked_at IS NULL",
      organizationId,
    ),
  ).toEqual([]);
  const final = await record("organization.updated", "org_expired_worker_poller", 1);
  const lease = new Date(Date.now() + 500).toISOString();
  await store.identity.claimWorkosInboxEvent({
    claimId: newUlid(),
    claimedAt: stamp(),
    leaseExpiresAt: lease,
  });
  while (Date.now() <= Date.parse(lease) + 10)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await scheduled()).toMatchObject({
    ok: true,
    recovery: { outcome: "reconciliation_required" },
    poll: { outcome: "idle" },
  });
  expect(await rows("SELECT state FROM webhook_inbox WHERE inbox_event_id = ?", final)).toEqual([
    { state: "reconciliation_required" },
  ]);
  const response = await worker.fetch("https://internal/session-status", {
    method: "POST",
    body: JSON.stringify({
      sessionId: "session_worker_poller",
      userId: "user_worker_poller",
      organizationId: ORG,
      tokenExpiresAt: 4_102_444_800,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ active: false });
  expect(await (await worker.fetch("https://fixture/fixture/scheduled?missing=1")).json()).toEqual({
    ok: false,
    error: { code: "unavailable" },
  });
  const directoryBeforeGlobal = await rows("SELECT count(*) AS n FROM org_directory");
  const providerBeforeGlobal = providerCalls;
  for (const [eventType, payload, maxAttempts, outcome] of [
    ["future.non_org", "{}", 1, "reconciliation_required"],
    ["organization.updated", "null", 2, "retry_scheduled"],
  ] as const) {
    const id = newUlid(),
      at = stored();
    await db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at) VALUES(?,'workos',?,?,?,?,?,?,'pending',0,?,?)",
      )
      .bind(
        id,
        `evt_global_${id}`,
        eventType,
        payload,
        new Uint8Array(32).fill(6),
        at,
        at,
        maxAttempts,
        at,
      )
      .run();
    expect(await scheduled()).toMatchObject({
      ok: true,
      poll: { outcome, errorCode: "WORKOS_INVALID_TRIGGER" },
    });
    expect(
      await rows(
        "SELECT organization_id,state,attempt_count,last_error_code,payload FROM webhook_inbox WHERE inbox_event_id=?",
        id,
      ),
    ).toEqual([
      {
        organization_id: null,
        state: outcome === "retry_scheduled" ? "retry_wait" : "reconciliation_required",
        attempt_count: 1,
        last_error_code: "WORKOS_INVALID_TRIGGER",
        payload,
      },
    ]);
  }
  const expiredGlobal = newUlid(),
    expiredToken = newUlid();
  const claimedPast = new Date(Date.now() - 5000).toISOString().replace(/Z$/u, "000Z");
  const expiredPast = new Date(Date.now() - 1000).toISOString().replace(/Z$/u, "000Z");
  await db
    .prepare(
      "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at) VALUES(?,'workos',?,'organization.updated',?, ?,?,?,'processing',1,1,?,?,?,?)",
    )
    .bind(
      expiredGlobal,
      `evt_expired_global_${expiredGlobal}`,
      JSON.stringify({
        schemaVersion: "workos.organization-trigger.v1",
        workosOrganizationId: "org_no_recovery_mapping",
      }),
      new Uint8Array(32).fill(7),
      claimedPast,
      claimedPast,
      claimedPast,
      expiredToken,
      claimedPast,
      expiredPast,
    )
    .run();
  expect(await scheduled()).toMatchObject({
    ok: true,
    recovery: { outcome: "reconciliation_required" },
  });
  expect(
    await rows(
      "SELECT organization_id,state,claim_id,last_error_code FROM webhook_inbox WHERE inbox_event_id=?",
      expiredGlobal,
    ),
  ).toEqual([
    {
      organization_id: null,
      state: "reconciliation_required",
      claim_id: null,
      last_error_code: "WORKOS_LEASE_EXPIRED",
    },
  ]);
  const heldGlobal = newUlid(),
    sharedToken = newUlid(),
    heldAt = stored();
  const heldUntil = new Date(Date.now() + 120000).toISOString().replace(/Z$/u, "000Z");
  for (const [provider, id, signature] of [
    ["workos", heldGlobal, heldAt],
    ["stripe", newUlid(), null],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,signature_timestamp,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at) VALUES(?,?,?,'future.non_org','{}',?,?,?,'processing',1,3,?,?,?,?)",
      )
      .bind(
        id,
        provider,
        `evt_held_${id}`,
        new Uint8Array(32).fill(8),
        heldAt,
        signature,
        heldAt,
        sharedToken,
        heldAt,
        heldUntil,
      )
      .run();
  }
  const repeated = await store.identity.claimWorkosInboxEvent({
    claimId: sharedToken,
    claimedAt: stamp(),
    leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
  });
  expect(repeated).toMatchObject({
    organizationId: null,
    inboxEventId: heldGlobal,
    claimId: sharedToken,
    attemptNumber: 1,
  });
  expect(
    await rows(
      "SELECT organization_id,attempt_count,lease_expires_at FROM webhook_inbox WHERE inbox_event_id=?",
      heldGlobal,
    ),
  ).toEqual([{ organization_id: null, attempt_count: 1, lease_expires_at: heldUntil }]);
  expect(
    await rows(
      "SELECT count(*) AS n FROM webhook_inbox WHERE claim_id=? AND state='processing'",
      sharedToken,
    ),
  ).toEqual([{ n: 2 }]);
  // A retained identical legacy copy is consumed only after the canonical identity exists; held replay never consumes it.
  await db
    .prepare(
      `INSERT INTO inbox_unrouted(inbox_event_id,provider,external_event_id,routing_key,event_type,payload,body_sha256,received_at,purge_after,max_attempts,signature_timestamp)
    SELECT inbox_event_id,provider,external_event_id,'legacy:unscoped',event_type,payload,body_sha256,received_at,?2,max_attempts,signature_timestamp FROM webhook_inbox WHERE inbox_event_id=?1`,
    )
    .bind(heldGlobal, heldUntil)
    .run();
  expect(
    (
      await store.identity.claimWorkosInboxEvent({
        claimId: sharedToken,
        claimedAt: stamp(),
        leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
      })
    )?.inboxEventId,
  ).toBe(heldGlobal);
  expect(
    await rows("SELECT inbox_event_id FROM inbox_unrouted WHERE inbox_event_id=?", heldGlobal),
  ).toEqual([{ inbox_event_id: heldGlobal }]);
  expect(
    await store.identity.claimWorkosInboxEvent({
      claimId: newUlid(),
      claimedAt: stamp(),
      leaseExpiresAt: new Date(Date.now() + 180000).toISOString(),
    }),
  ).toBeNull();
  expect(await rows("SELECT 1 FROM inbox_unrouted WHERE inbox_event_id=?", heldGlobal)).toEqual([]);
  expect(
    await rows(
      "SELECT state,claim_id,attempt_count FROM webhook_inbox WHERE inbox_event_id=?",
      heldGlobal,
    ),
  ).toEqual([{ state: "processing", claim_id: sharedToken, attempt_count: 1 }]);
  expect(await rows("SELECT count(*) AS n FROM org_directory")).toEqual(directoryBeforeGlobal);
  expect(providerCalls).toBe(providerBeforeGlobal);
  // A healthy-looking deployment/settings record is insufficient: the actual Core read now fails.
  await db.prepare("DROP TABLE revocations").run();
  const unavailable = await probeCall();
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toEqual({
    ok: false,
    error: { code: "convergence_unverified" },
  });
}, 30_000);
