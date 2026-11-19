import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newUlid, type CatalogContext } from "../../control-store/src/catalog/common.js";
import { applyWorkosSnapshot } from "../../control-store/src/catalog/identity/membership-state.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { createControlStore } from "../../control-store/src/store.js";
import {
  createTestControl,
  organizationIdWithShard,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { digest } from "../../control-store/test/support/seed.js";
import { createCreditWarningRecipients } from "../src/credit-warning-recipients.js";
import { createD1WorkosIdentityPort } from "../src/d1-identity-port.js";
import { createD1OnboardingPersistence } from "../src/d1-onboarding-port.js";
import { createWorkosOrganizationOnboarding } from "../src/organization-onboarding.js";
import { createWorkosSessionRevocation } from "../src/session-revocation.js";
import { createWorkosUserKeyLifecycle } from "../src/user-key-lifecycle.js";
import { onboardingProvider } from "./onboarding-provider.fixture.js";
import { provider } from "./user-key-provider.fixture.js";

/*
 * The consumer modules of the WorkOS management Worker, in this process, over the REAL Core store on a real local D1
 * database (no service binding, so the production code is observable by coverage). The only fakes are the WorkOS
 * provider at its HTTP boundary. The same modules run over the real ControlRuntime binding in
 * `d1-control-runtime.integration.test.ts`.
 */

const credential = "test-workos-management";
const FAR_FUTURE = 4_102_444_800;
const at = (second: number) => `2026-10-28T12:00:${String(second).padStart(2, "0")}.000Z`;

let control: TestControl;
let context: CatalogContext;
let identity: ReturnType<typeof createD1WorkosIdentityPort>;
let store: ReturnType<typeof createControlStore>;
let sequence = 0;

beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
  identity = createD1WorkosIdentityPort({ runtime: store.identity });
  context = { directory: control.core, router: new SharedCoreRouter(control.core) };
}, 120_000);

afterAll(async () => control?.dispose());

async function seed() {
  sequence += 1;
  const organizationId = await organizationIdWithShard(2, 0, 17_000_000 + sequence * 7919);
  const workosOrganizationId = `org_d1c${sequence}`;
  const owner = `user_d1cowner${sequence}`;
  await applyWorkosSnapshot(context, {
    organizationId,
    workosOrganizationId,
    state: "active",
    snapshotDigest: digest(sequence + 40_000),
    snapshotFetchedAt: at(1),
    synchronizedAt: at(2),
    triggerEventId: `event_d1c_${sequence}`,
    auditEventId: newUlid(),
    memberships: [
      { workosUserId: owner, role: "admin", status: "active", digest: digest(sequence + 50_000) },
    ],
  });
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at = ? WHERE organization_id = ?")
    .bind("2026-10-28T08:00:00.000000Z", organizationId)
    .run();
  return {
    organizationId,
    workosOrganizationId,
    userId: owner,
    sessionId: `session_d1c${sequence}`,
    tokenExpiresAt: FAR_FUTURE,
  };
}

describe("WorkOS consumer modules over the real Core store", () => {
  it("finishes a creation whose permission read failed before the request as rejected, so a retry creates the key once", async () => {
    const fake = provider();
    const lifecycle = createWorkosUserKeyLifecycle({
      identity,
      credential,
      fetcher: (request) => fake.handle(request),
      clock: { now: () => new Date() },
      ids: { next: () => newUlid() },
    });
    const scope = await seed();
    fake.state.failNextPermissionRead = true;
    await expect(
      lifecycle.create({ ...scope, name: "ci key", idempotencyKey: "idem-unsent" }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
    expect(fake.state.posts).toEqual([]);
    expect(
      await lifecycle.create({ ...scope, name: "ci key", idempotencyKey: "idem-unsent" }),
    ).toMatchObject({ replayed: false, value: `sk_${"a".repeat(32)}` });
    expect(fake.state.keys).toHaveLength(1);
  });

  it("creates a user key once, replays it without the value, recovers a lost response, lists and revokes", async () => {
    const fake = provider();
    const lifecycle = createWorkosUserKeyLifecycle({
      identity,
      credential,
      fetcher: (request) => fake.handle(request),
      clock: { now: () => new Date() },
      ids: { next: () => newUlid() },
    });
    const scope = await seed();
    const created = await lifecycle.create({ ...scope, name: "ci key", idempotencyKey: "idem-1" });
    expect(created).toMatchObject({ replayed: false, value: `sk_${"a".repeat(32)}` });
    const replay = await lifecycle.create({ ...scope, name: "ci key", idempotencyKey: "idem-1" });
    expect(replay).toMatchObject({ replayed: true, value: null });
    expect(fake.state.keys).toHaveLength(1);
    const listed = await lifecycle.list({ ...scope, after: null });
    expect(listed.data[0]?.name).toBe("ci key");
    // A lost provider response finishes the original request on the retry without a second key.
    const other = await seed();
    fake.state.loseNextCreateResponse = true;
    await expect(
      lifecycle.create({ ...other, name: "ci key", idempotencyKey: "idem-lost" }),
    ).rejects.toMatchObject({ code: "api_key_creation_uncertain" });
    expect(
      await lifecycle.create({ ...other, name: "ci key", idempotencyKey: "idem-lost" }),
    ).toMatchObject({ replayed: true, value: null });
    expect(fake.state.keys).toHaveLength(2);
    expect(await lifecycle.revoke({ ...scope, keyId: created.key.id })).toEqual({ revoked: true });
    expect(fake.state.keys).toHaveLength(1);
    await expect(lifecycle.create({ nope: 1 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("revokes the proven session once and refuses another user", async () => {
    const fake = provider();
    const revocation = createWorkosSessionRevocation({
      identity,
      credential,
      fetcher: (request) => fake.handle(request),
      clock: { now: () => new Date() },
      ids: { next: () => newUlid() },
    });
    sequence += 1;
    const userId = `user_d1clogout${sequence}`;
    const sessionId = `session_d1clogout${sequence}`;
    fake.state.sessions.push({ id: sessionId, user_id: userId, status: "active" });
    expect(await revocation.revoke({ userId, sessionId })).toEqual({ revoked: true });
    expect(await revocation.revoke({ userId, sessionId })).toEqual({ revoked: true });
    await expect(revocation.revoke({ userId: `${userId}x`, sessionId })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("reads the profile and creates the first workspace through the provider exactly once", async () => {
    const fake = await onboardingProvider();
    try {
      const onboarding = createWorkosOrganizationOnboarding({
        persistence: createD1OnboardingPersistence(store.identity),
        credential,
        fetcher: fake.fetcher,
        clock: { now: () => new Date() },
        ids: { next: () => newUlid() },
      });
      const request = {
        userId: "user_d1conboard",
        sessionId: "session_d1conboard",
        name: "Workspace",
        signupSource: "direct",
        idempotencyKey: "onboard-1",
      };
      const created = await onboarding.create(request);
      expect(created).toMatchObject({ name: "Workspace" });
      expect(fake.posts).toEqual(["/organizations", "/user_management/organization_memberships"]);
      expect(await onboarding.create(request)).toEqual(created);
      expect(fake.posts).toHaveLength(2);
      await expect(onboarding.create({ ...request, name: "Other" })).rejects.toMatchObject({
        code: "idempotency_key_reused",
      });
      expect(
        await onboarding.profile({ userId: request.userId, sessionId: request.sessionId }),
      ).toMatchObject({
        user_id: request.userId,
        email_verified: true,
        workos_organization_ids: [`org_${(created as { id: string }).id}`],
      });
    } finally {
      await fake.close();
    }
  });

  it("resolves the verified owner of an exhausted organization from the provider", async () => {
    const owner = { userId: "user_d1cwarn", workosId: "org_d1cwarn" };
    const exhaustedAt = "2026-10-28T10:00:00.000Z";
    const recipients = createCreditWarningRecipients({
      persistence: {
        readScope: async () => owner.workosId,
        isOwner: async () => true,
      },
      credential,
      clock: { now: () => new Date("2026-10-28T12:00:00.000Z") },
      fetcher: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === `/organizations/${owner.workosId}`)
          return Response.json({
            id: owner.workosId,
            name: "Warned",
            created_at: at(0),
            updated_at: at(0),
          });
        if (url.pathname === "/user_management/organization_memberships")
          return Response.json({
            object: "list",
            data: [
              {
                id: "om_warn",
                organization_id: owner.workosId,
                user_id: owner.userId,
                status: "active",
                roles: [{ slug: "admin" }],
                created_at: at(0),
                updated_at: at(0),
              },
            ],
            list_metadata: { after: null },
          });
        return Response.json({
          id: owner.userId,
          object: "user",
          email: "owner@example.invalid",
          email_verified: true,
        });
      },
    });
    const organizationId = newUlid();
    expect(await recipients.resolve({ organizationId, exhaustedAt })).toEqual({
      organizationId,
      exhaustedAt,
      required: true,
      recipients: [{ userId: owner.userId, email: "owner@example.invalid" }],
    });
    await expect(recipients.resolve({ organizationId })).rejects.toThrow("credit_warning_invalid");
  });
});
