import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { seedDeletionIntent } from "../support/accepted-operation.js";
import {
  connectGrant as connect,
  declareZone as declare,
  losingBatchWith,
  scope,
  secret,
  sha,
  time,
} from "../support/cloudflare-fixtures.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  losingWriteResponses,
  seedProject,
  STORED_NOW,
  type SeededProject,
} from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control.dispose());

const count = async (table: string, p: SeededProject, extra = "") =>
  (
    await control.core
      .prepare(`SELECT count(*) n FROM ${table} WHERE organization_id=?1 ${extra}`)
      .bind(p.organizationId)
      .first<{ n: number }>()
  )?.n;

const configureInput = (p: SeededProject, overrides: Record<string, unknown> = {}) => ({
  ...scope(p),
  operationId: newUlid(),
  queuedEventId: newUlid(),
  startedEventId: newUlid(),
  succeededEventId: newUlid(),
  auditEventId: newUlid(),
  outboxEventId: newUlid(),
  platform: "production",
  principalId: "user:owner",
  idempotencyKeySha256: sha(0x51),
  requestSha256: sha(0x52),
  projectHandle: p.handle,
  configuredAt: time(0),
  occurredAt: time(0),
  ...overrides,
});

describe("configure and authorization", () => {
  it("configures the domains, their operation history, audit and outbox as one effect, replays by identity and answers a lost reply from the commit", async () => {
    const p = await seedProject(control),
      input = configureInput(p);
    const created = await store.cloudflareDomain.configureDomains(input);
    expect(created).toMatchObject({
      status: 202,
      location: `/v1/operations/${input.operationId}`,
      body: { id: input.operationId, state: "succeeded" },
    });
    expect(
      await control.core
        .prepare(
          "SELECT production_domain,development_domain FROM cloudflare_project_domains WHERE organization_id=?1",
        )
        .bind(p.organizationId)
        .first(),
    ).toEqual({
      production_domain: `${p.handle}.check.omh.st`,
      development_domain: `dev-${p.handle}.check.omh.st`,
    });
    expect(await count("operation_events", p, `AND operation_id='${input.operationId}'`)).toBe(3);
    expect(await count("audit_events", p, "AND event_type='ProjectDomainsConfigured'")).toBe(1);
    expect(await count("outbox_events", p, "AND event_type='ProjectDomainsConfiguredV1'")).toBe(1);

    // The same identity under fresh event ids is the same operation; the project's existing domains replay for any
    // later key, digest or principal of the same handle, and only a real handle change is refused.
    const replay = await store.cloudflareDomain.configureDomains(configureInput(p));
    expect(replay.body.id).toBe(input.operationId);
    expect(await count("cloudflare_project_domains", p)).toBe(1);
    expect(
      (
        await store.cloudflareDomain.configureDomains(
          configureInput(p, { principalId: "user:other" }),
        )
      ).body.id,
    ).toBe(input.operationId);
    await expect(
      store.cloudflareDomain.configureDomains(configureInput(p, { projectHandle: "renamed" })),
    ).rejects.toMatchObject({ name: "CloudflareProjectDomainConflictError" });
    const other = await seedProject(control);
    await expect(
      store.cloudflareDomain.configureDomains(configureInput(other, { projectHandle: "renamed" })),
    ).rejects.toThrow("Cloudflare domain configuration is unavailable");

    // A reply lost after the commit is answered from the committed row, never written twice.
    const lost = await seedProject(control),
      lostInput = configureInput(lost),
      flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    expect((await flaky.cloudflareDomain.configureDomains(lostInput)).body.id).toBe(
      lostInput.operationId,
    );
    expect(await count("cloudflare_project_domains", lost)).toBe(1);
  });

  it("replays the domains a project already holds for a later request with another key and digest", async () => {
    // The admission of a project writes its domains under a synthetic key; the customer's first configure is a
    // different request that must answer that operation instead of a conflict.
    const p = await seedProject(control),
      admitted = configureInput(p, {
        idempotencyKeySha256: sha(0x61),
        requestSha256: sha(0x62),
      });
    await store.cloudflareDomain.configureDomains(admitted);
    const later = await store.cloudflareDomain.configureDomains(
      configureInput(p, { idempotencyKeySha256: sha(0x71), requestSha256: sha(0x72) }),
    );
    expect(later.body.id).toBe(admitted.operationId);
    expect(await count("cloudflare_project_domains", p)).toBe(1);
    expect(await count("operations", p)).toBe(1);
  });

  it("refuses an undeclared zone, a changed request and a closed authorization, and answers a lost claim reply from the committed state", async () => {
    const p = await seedProject(control),
      auth = await connect(control, store, p);
    await expect(
      store.cloudflareDomain.claimAuthorization({ ...auth, zoneName: "undeclared.test" }),
    ).rejects.toMatchObject({ name: "CloudflareZoneNotBoundError" });
    await expect(
      store.cloudflareDomain.claimAuthorization({
        ...auth,
        authorizationId: newUlid(),
        stateSha256: new Uint8Array(32).fill(250),
        requestSha256: sha(0x43),
      }),
    ).rejects.toMatchObject({ name: "CloudflareProjectDomainConflictError" });
    await expect(store.cloudflareDomain.claimAuthorization(auth)).rejects.toMatchObject({
      name: "CloudflareAuthorizationClosedError",
    });

    const fresh = await seedProject(control),
      lostAuth = await declare(control, fresh),
      flaky = createControlStore({
        CONTROL_CORE: losingBatchWith(
          control.core,
          /INSERT INTO cloudflare_project_authorization_states/u,
        ),
      });
    expect(await flaky.cloudflareDomain.claimAuthorization(lostAuth)).toMatchObject({
      authorizationId: lostAuth.authorizationId,
    });
    expect(await count("cloudflare_project_authorization_states", fresh)).toBe(1);
  });
});

describe("project deletion", () => {
  it("serves the deletion state and drives one grant through revoke, readback, restart and the terminal finalize", async () => {
    const p = await seedProject(control),
      { authorizationId } = await connect(control, store, p);
    await store.cloudflareDomain.configureDomains(configureInput(p));
    const hostname = (name: "dev" | "prod", id: string, errors: string[]) => ({
      ...scope(p),
      receiptId: newUlid(),
      observedAt: time(name === "dev" ? 3 : 4),
      kind: "custom_hostname" as const,
      providerResourceId: id.repeat(32),
      environmentName: name,
      hostname: name === "prod" ? `${p.handle}.check.omh.st` : `dev-${p.handle}.check.omh.st`,
      status: "pending",
      providerCreatedAt: time(3),
      ownershipVerification: null,
      ownershipVerificationHttp: null,
      verificationErrors: errors,
    });
    await store.domains.putCloudflareProjectDomainReceipt(hostname("prod", "a", []));
    await store.domains.putCloudflareProjectDomainReceipt(
      hostname("dev", "b", ["timeout", "DNS record missing", 'quote " and, comma']),
    );
    expect(
      (
        await control.core
          .prepare(
            "SELECT verification_errors FROM cloudflare_project_domain_receipts WHERE organization_id=?1 AND provider_resource_id=?2",
          )
          .bind(p.organizationId, "b".repeat(32))
          .first<{ verification_errors: string }>()
      )?.verification_errors,
    ).toBe('{timeout,"DNS record missing","quote \\" and, comma"}');
    const operationId = newUlid(),
      deletion = { ...scope(p), operationId };
    expect(await store.cloudflareDomain.readDeletion(deletion)).toBeNull();
    await p.shard.batch([
      p.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId),
      p.shard
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
        )
        .bind(p.organizationId, operationId, p.projectId, p.billingEpochId, STORED_NOW),
    ]);
    await seedDeletionIntent(p, p.prodEnvironmentId, operationId);

    const before = await store.cloudflareDomain.readDeletion(deletion);
    expect(before).toMatchObject({
      domains: { handle: p.handle },
      revocation: null,
      grant: { authorizationId, status: "active" },
    });
    expect(
      before?.customHostnameDeleteTargets.map((target) => [
        target.environmentName,
        target.customHostnameId,
      ]),
    ).toEqual([
      ["dev", "b".repeat(32)],
      ["prod", "a".repeat(32)],
    ]);

    // Rotation is fenced by the grant version it read.
    const grant = before?.grant as { updatedAt: string };
    const rotation = {
      ...deletion,
      authorizationId,
      expectedUpdatedAt: grant.updatedAt,
      ...secret(3),
      accessExpiresAt: time(58),
      rotatedAt: time(5),
    };
    expect(await store.cloudflareDomain.rotateDeletionGrant(rotation)).toMatchObject({
      authorizationId,
      updatedAt: `${time(5).slice(0, 23)}000Z`,
    });
    expect(await store.cloudflareDomain.rotateDeletionGrant(rotation)).toBeNull();
    const rotated = (await store.cloudflareDomain.readDeletion(deletion))?.grant as {
      updatedAt: string;
    };

    // The first preparation starts the revoke, the second one the readback, and a third is blocked.
    const prepare = {
      ...deletion,
      authorizationId,
      expectedGrantUpdatedAt: rotated.updatedAt,
      refreshTokenSha256: new Uint8Array(32).fill(0x61),
      preparedAt: time(6),
    };
    expect(await store.cloudflareDomain.prepareRevocation(prepare)).toBe("revoke");
    expect(await store.cloudflareDomain.prepareRevocation(prepare)).toBe("readback");
    expect(await store.cloudflareDomain.prepareRevocation(prepare)).toBe("blocked");
    expect(await store.cloudflareDomain.readDeletion(deletion)).toMatchObject({
      revocation: { state: "readback_started", authorizationId },
    });

    // Restarting after a readback swaps the sealed refresh pair and the token digest together.
    const restart = {
      ...rotation,
      expectedUpdatedAt: rotated.updatedAt,
      ...secret(5),
      rotatedAt: time(7),
      expectedRefreshTokenSha256: prepare.refreshTokenSha256,
      refreshTokenSha256: new Uint8Array(32).fill(0x62),
    };
    expect(await store.cloudflareDomain.restartRevocation(restart)).toMatchObject({
      authorizationId,
      updatedAt: `${time(7).slice(0, 23)}000Z`,
    });
    expect(await store.cloudflareDomain.restartRevocation(restart)).toBeNull();

    // A readback whose reply is lost stays unknown: the retry must not be answered from a guess.
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) }),
      again = { ...prepare, refreshTokenSha256: restart.refreshTokenSha256 };
    await expect(flaky.cloudflareDomain.prepareRevocation(again)).rejects.toMatchObject({
      code: "store_outcome_unknown",
    });
    expect(
      (
        await control.core
          .prepare("SELECT state FROM cloudflare_project_oauth_revocations WHERE project_id=?1")
          .bind(p.projectId)
          .first<{ state: string }>()
      )?.state,
    ).toBe("readback_started");

    // The terminal effect: domains soft-deleted, grant sealed material dropped, revocation confirmed.
    const finalize = { ...deletion, finalizedAt: time(8) };
    expect(await store.cloudflareDomain.finalizeDeletion(finalize)).toBe(true);
    expect(
      await control.core
        .prepare(
          "SELECT g.status,g.access_ciphertext,r.state,d.deleted_at FROM cloudflare_project_dns_grants g JOIN cloudflare_project_oauth_revocations r USING(organization_id,project_id) JOIN cloudflare_project_domains d USING(organization_id,project_id) WHERE g.project_id=?1",
        )
        .bind(p.projectId)
        .first(),
    ).toEqual({
      status: "revoked",
      access_ciphertext: null,
      state: "confirmed",
      deleted_at: `${time(8).slice(0, 23)}000Z`,
    });
    // The same instant is a replay of the confirmed effect; another instant or another operation is not.
    expect(await store.cloudflareDomain.finalizeDeletion(finalize)).toBe(true);
    expect(
      await store.cloudflareDomain.finalizeDeletion({ ...finalize, finalizedAt: time(9) }),
    ).toBe(false);
    expect(
      await store.cloudflareDomain.finalizeDeletion({ ...finalize, operationId: newUlid() }),
    ).toBe(false);
  });

  it("finalizes the platform side of a project without a grant and reads nothing for a project that is not deleting", async () => {
    const p = await seedProject(control),
      operationId = newUlid(),
      deletion = { ...scope(p), operationId };
    await store.cloudflareDomain.configureDomains(configureInput(p));
    expect(await store.cloudflareDomain.readDeletion(deletion)).toBeNull();
    await p.shard.batch([
      p.shard
        .prepare(
          "UPDATE projects SET lifecycle_state='deleting' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(p.organizationId, p.projectId),
      p.shard
        .prepare(
          "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
        )
        .bind(p.organizationId, operationId, p.projectId, p.billingEpochId, STORED_NOW),
    ]);
    await seedDeletionIntent(p, p.prodEnvironmentId, operationId);
    expect(
      await store.cloudflareDomain.finalizePlatformDeletion({ ...deletion, finalizedAt: time(9) }),
    ).toBe(true);
    expect(await store.cloudflareDomain.readDeletion(deletion)).toMatchObject({
      grant: null,
      revocation: null,
    });
  });
});
