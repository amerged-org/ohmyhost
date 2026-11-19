import { afterAll, beforeAll, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import { createD1AccountMetadataPorts } from "../../../control-api/src/d1-account-metadata.js";
import type { AuthenticatedPrincipal } from "../../../control-api/src/contracts.js";
import { createControlStore } from "../../src/store.js";
import {
  readCurrentIdentityMappings,
  readAccountProfileFacts,
  recordAccountSignupSource,
} from "../../src/catalog/identity/account-metadata.js";
import { newUlid, type CatalogContext } from "../../src/catalog/common.js";
import { coreRouter, createTestControl, type TestControl } from "../support/control-d1.js";
import { seedOrganization } from "../support/seed.js";

let control: TestControl, organizationId: string, workosId: string;
const at = "2026-10-29T05:00:00.123Z",
  storedAt = "2026-10-29T05:00:00.123000Z";
const context = (): CatalogContext => ({ directory: control.core, router: coreRouter(control) });
const runtime = {
  readCurrentIdentityMappings: (input: unknown) => readCurrentIdentityMappings(context(), input),
  readAccountProfileFacts: (input: unknown) => readAccountProfileFacts(context(), input),
  recordAccountSignupSource: (input: unknown) => recordAccountSignupSource(context(), input),
};
const authStatus = {
  async fetch(request: Request) {
    const body = (await request.json()) as Record<string, unknown>;
    if (new URL(request.url).pathname === "/user-profile")
      return Response.json({
        user_id: body["userId"],
        name: "Profile native",
        email: `${String(body["userId"])}@example.invalid`,
        email_verified: true,
        workos_organization_ids: [workosId],
      });
    const ids = body["workos_organization_ids"] as string[];
    return Response.json({
      user_id: body["user_id"],
      email: body["user_id"] === null ? null : `${String(body["user_id"])}@example.invalid`,
      organizations: ids.map((workos_id) => ({ workos_id, name: "Current workspace 👩‍💻" })),
    });
  },
};
const principal = (userId: string): AuthenticatedPrincipal => ({
  actorId: `user:${userId}`,
  credentialId: `workos_session:session_${userId.slice(5)}`,
  authorizationPrincipal: { kind: "user" as const, subjectId: `user:${userId}` },
  organizationIds: [parseUlid(organizationId)],
});
const sql = (text: string, ...values: unknown[]) =>
  control.core
    .prepare(text)
    .bind(...values)
    .run();
beforeAll(async () => {
  control = await createTestControl();
  organizationId = await seedOrganization(createControlStore(control.bindings), 1, 0);
  const mapped = await control.core
    .prepare("SELECT workos_organization_id id FROM organizations WHERE organization_id=?")
    .bind(organizationId)
    .first<{ id: string }>();
  if (!mapped) throw new Error("Missing seeded mapping");
  workosId = mapped.id;
}, 240_000);
afterAll(async () => {
  await control?.dispose();
});

it("reads profile and current identity and records a first NULL origin without replacing another user's source", async () => {
  const native = await createD1AccountMetadataPorts(runtime, authStatus, () => new Date(at)),
    who = principal("user_metadata");
  const profile = (overrides: Record<string, unknown>) => ({
    user_id: "user_metadata",
    name: "Profile native",
    email: "user_metadata@example.invalid",
    email_verified: true,
    organizations: [{ id: organizationId, workos_id: workosId, name: "Workspace" }],
    organization_ids: [organizationId],
    signup_source: null,
    attributed_at: null,
    initial_workspace_id: null,
    ...overrides,
  });
  expect(await native.accountProfile.read(who)).toEqual(profile({}));
  // The first write records the NULL origin; a later source never replaces it and replays the same facts.
  expect(await native.accountProfile.recordSource(who, null)).toEqual(
    profile({ attributed_at: at }),
  );
  expect(await native.accountProfile.recordSource(who, "later-source")).toEqual(
    profile({ attributed_at: at }),
  );
  const first = await native.accountProfile.read(who);
  expect(first.signup_source).toBeNull();
  expect(first.attributed_at).toBe(at);
  expect(
    (await native.accountProfile.read(principal("user_other_metadata"))).signup_source,
  ).toBeNull();
  expect(await native.currentIdentity.read(who)).toEqual({
    email: "user_metadata@example.invalid",
    organizations: [{ id: organizationId, name: "Current workspace 👩‍💻" }],
  });
  expect(
    await native.currentIdentity.read({
      ...who,
      actorId: "service:client_meta",
      authorizationPrincipal: { kind: "m2m_service", subjectId: "service:client_meta" },
    }),
  ).toEqual({ email: null, organizations: [{ id: organizationId, name: "Current workspace 👩‍💻" }] });
  await expect(native.accountProfile.recordSource(who, "bad source")).rejects.toThrow(
    "Invalid source",
  );
  expect(await runtime.readCurrentIdentityMappings({ organizationIds: [] })).toEqual([]);
  await expect(
    native.currentIdentity.read({ ...who, organizationIds: [parseUlid(newUlid())] }),
  ).rejects.toThrow("Identity scope is unavailable");
});

it("keeps attributed-only history, exact origin presence, inactive mappings, rollback and unknown first-write replay", async () => {
  const userId = "user_attributed_metadata",
    requestId = newUlid(),
    sourceId = "metadata-test-source";
  await sql(
    "INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros) VALUES(?,1,0,0)",
    sourceId,
  );
  await sql(
    "INSERT INTO onboarding_requests(request_id,workos_user_id,idempotency_sha256,request_sha256,name,organization_attempted,membership_attempted,workos_organization_id,organization_id,signup_source,completed_at,created_at) VALUES(?,?,unhex(?),unhex(?),'Retained workspace',1,1,?,?,?,?,?)",
    requestId,
    userId,
    "ab".repeat(32),
    "cd".repeat(32),
    workosId,
    organizationId,
    sourceId,
    storedAt,
    storedAt,
  );
  await sql(
    "INSERT INTO user_signup(workos_user_id,origin_source,origin_present,recorded_at,attributed_source,first_request_id,bonus_micros,attributed_at) VALUES(?,NULL,0,?,?,?,'9007199254740993',?)",
    userId,
    storedAt,
    sourceId,
    requestId,
    storedAt,
  );
  const native = await createD1AccountMetadataPorts(runtime, authStatus, () => new Date(at)),
    who = principal(userId);
  const retained = (overrides: Record<string, unknown>) => ({
    user_id: userId,
    name: "Profile native",
    email: `${userId}@example.invalid`,
    email_verified: true,
    organizations: [{ id: organizationId, workos_id: workosId, name: "Retained workspace" }],
    organization_ids: [organizationId],
    signup_source: sourceId,
    attributed_at: null,
    initial_workspace_id: organizationId,
    ...overrides,
  });
  expect(await native.accountProfile.read(who)).toEqual(retained({}));
  // An attributed-only user has origin_present=0: the first NULL origin is recorded without touching the attribution.
  expect(await native.accountProfile.recordSource(who, null)).toEqual(
    retained({ attributed_at: at }),
  );
  expect(
    await control.core
      .prepare(
        "SELECT bonus_micros,first_request_id,attributed_at FROM user_signup WHERE workos_user_id=?",
      )
      .bind(userId)
      .first(),
  ).toEqual({
    bonus_micros: "9007199254740993",
    first_request_id: requestId,
    attributed_at: storedAt,
  });
  await sql(
    "CREATE TRIGGER test_account_origin_abort AFTER INSERT ON user_signup WHEN NEW.workos_user_id='user_metadata_rollback' BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: guard_precondition_changed'); END",
  );
  try {
    await expect(
      runtime.recordAccountSignupSource({
        userId: "user_metadata_rollback",
        source: "first",
        recordedAt: at,
      }),
    ).rejects.toThrow();
  } finally {
    await sql("DROP TRIGGER test_account_origin_abort");
  }
  expect(
    await control.core
      .prepare("SELECT count(*) n FROM user_signup WHERE workos_user_id='user_metadata_rollback'")
      .first(),
  ).toEqual({ n: 0 });
  let lose = true;
  const db = {
    prepare: control.core.prepare.bind(control.core),
    async batch(statements: Parameters<typeof control.core.batch>[0]) {
      const result = await control.core.batch(statements);
      if (lose && result.some((r) => r.meta?.changes)) {
        lose = false;
        throw new Error("Network connection lost");
      }
      return result;
    },
  };
  await recordAccountSignupSource(
    { directory: db, router: coreRouter(control, { CONTROL_SHARD_0000: db }) },
    { userId: "user_metadata_unknown", source: "first", recordedAt: at },
  );
  expect(
    await runtime.readAccountProfileFacts({
      userId: "user_metadata_unknown",
      workosOrganizationIds: [],
    }),
  ).toMatchObject({ origin: { source: "first", recordedAt: at } });
  await sql("UPDATE organizations SET state='deleted' WHERE organization_id=?", organizationId);
  expect(await runtime.readCurrentIdentityMappings({ organizationIds: [organizationId] })).toEqual(
    [],
  );
  expect(await native.accountProfile.read(who)).toEqual(
    retained({ attributed_at: at, organizations: [], organization_ids: [] }),
  );
}, 60_000);
