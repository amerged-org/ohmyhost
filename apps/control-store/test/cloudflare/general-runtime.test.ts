import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
it("executes the actual general domain authorization, sealed grant, refresh-use and Paid metadata transactions", async () => {
  const c = await createTestControl();
  try {
    const p = await seedProject(c),
      scope = { organizationId: p.organizationId, projectId: p.projectId },
      store = createControlStore(c.bindings).cloudflareDomain;
    const now = new Date(),
      time = (delta: number) => new Date(now.getTime() + delta).toISOString(),
      key = "sha256:" + "31".repeat(32),
      request = "sha256:" + "32".repeat(32);
    await c.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,'app.example.test',NULL,'awaiting_deployment','user:user_consent',unhex(?3),unhex(?4),?5,?5,NULL)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        "31".repeat(32),
        "32".repeat(32),
        time(0).replace("Z", "000Z"),
      )
      .run();
    const authorizationId = newUlid(),
      stateHash = new Uint8Array(32).fill(9);
    const auth = {
      ...scope,
      authorizationId,
      principalId: "user:user_consent",
      zoneName: "example.test",
      idempotencyKeySha256: "sha256:" + "41".repeat(32),
      requestSha256: "sha256:" + "42".repeat(32),
      stateSha256: stateHash,
      issuedAt: time(0),
      expiresAt: time(600000),
    };
    expect((await store.claimAuthorization(auth)).authorizationId).toBe(authorizationId);
    expect(
      (
        await store.claimAuthorization({
          ...auth,
          authorizationId: newUlid(),
          issuedAt: time(1),
          expiresAt: time(600001),
        })
      ).authorizationId,
    ).toBe(authorizationId);
    // Only the user who started the authorization consumes it; another principal leaves it open.
    expect(
      await store.consumeAuthorization({
        authorizationId,
        stateSha256: stateHash,
        principalId: "user:someone-else",
        consumedAt: time(2),
      }),
    ).toBeNull();
    expect(
      await store.consumeAuthorization({
        authorizationId,
        stateSha256: stateHash,
        principalId: auth.principalId,
        consumedAt: time(2),
      }),
    ).toMatchObject(scope);
    expect(
      await store.consumeAuthorization({
        authorizationId,
        stateSha256: stateHash,
        principalId: auth.principalId,
        consumedAt: time(2),
      }),
    ).toBeNull();
    const secret = {
      accessCiphertext: Buffer.alloc(32, 1).toString("base64"),
      accessNonce: Buffer.alloc(12, 2).toString("base64"),
      refreshCiphertext: Buffer.alloc(32, 3).toString("base64"),
      refreshNonce: Buffer.alloc(12, 4).toString("base64"),
      keyVersion: 1,
    };
    const grant = {
      ...scope,
      authorizationId,
      principalId: "user:user_consent",
      zoneName: "example.test",
      zoneId: "a".repeat(32),
      accountId: "b".repeat(32),
      scopes: ["dns.write", "zone.read"],
      ...secret,
      accessExpiresAt: time(3600000),
      connectedAt: time(3),
    };
    expect(await store.putGrant(grant)).toBe("created");
    expect(await store.putGrant(grant)).toBe("existing");
    expect(await store.readStatus({ ...scope, now: time(4) })).toMatchObject({
      status: "authorized",
      zone: "example.test",
    });
    const use = { ...scope, useId: newUlid(), now: time(5) };
    expect(await store.claimGrantUse(use)).toMatchObject({
      status: "claimed",
      grant: { authorizationId },
    });
    await store.renewGrantUse({ ...use, now: time(6) });
    expect(
      await store.finishGrantUse({
        ...use,
        ...secret,
        authorizationId,
        expectedUpdatedAt: time(3),
        now: time(7),
        accessExpiresAt: time(7200000),
      }),
    ).toMatchObject({ authorizationId, updatedAt: time(7).replace("Z", "000Z") });
    expect(
      (await c.core.prepare("SELECT count(*) n FROM cloudflare_general_grant_uses").first())?.["n"],
    ).toBe(0);
    expect(
      await store.claimPaidDomainApply({
        ...scope,
        hostname: "app.example.test",
        gatewayScriptName: null,
        principalId: "user:user_consent",
        idempotencyKeySha256: key,
        requestSha256: request,
        now: time(8),
        auditEventId: newUlid(),
      }),
    ).toMatchObject({ state: "awaiting_deployment", gatewayRetarget: false });
    expect(await store.readPaidDomainRecord(scope)).toMatchObject({
      hostname: "app.example.test",
      state: "awaiting_deployment",
    });
  } finally {
    await c.dispose();
  }
}, 60000);
