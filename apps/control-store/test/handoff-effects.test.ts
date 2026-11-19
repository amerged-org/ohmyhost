import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { bytes, seedProject, STORED_NOW } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());
const hash = "ab".repeat(32);
async function setup(projectScope: boolean) {
  const project = await seedProject(control);
  const grantId = crypto.randomUUID();
  await project.shard.batch([
    project.shard
      .prepare("UPDATE organizations SET beta_admitted_at=? WHERE organization_id=?")
      .bind(STORED_NOW, project.organizationId),
    project.shard
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES (?,'user_seed','admin','active',1,?,?,'evt')",
      )
      .bind(project.organizationId, bytes(32, 0), STORED_NOW),
    project.shard
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES (?,?,NULL,NULL,'user','user:user_seed','owner',?)",
      )
      .bind(project.organizationId, newUlid(), STORED_NOW),
    project.shard
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at) VALUES (?,?,'user_seed','client-1',?,?,?,?,0,1,?)",
      )
      .bind(
        project.organizationId,
        grantId,
        hash,
        projectScope ? project.projectId : null,
        projectScope ? 1 : null,
        projectScope ? project.billingEpochId : null,
        STORED_NOW,
      ),
  ]);
  return { project, grantId };
}

describe("handoff effect authority", () => {
  it("rejects an empty token cap and a revoked grant without storing a secret or receipt", async () => {
    const { project, grantId } = await setup(true);
    const store = createControlStore(control.bindings);
    const authority = { grantId, clientId: "client-1", consentHash: hash, action: "secrets:write" };
    const request = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      action: "set",
      name: "EXAMPLE",
      ciphertext: bytes(24, 1),
      nonce: bytes(12, 2),
      valueSha256: bytes(32, 3),
      keyVersion: 1,
      writtenAt: STORED_NOW,
      requestedAt: STORED_NOW,
      idempotencyKey: "denied",
      requestSha256: bytes(32, 4),
      principalId: "user:user_seed",
    };
    await expect(
      store.secrets.mutateApiEnvironmentSecret({
        ...request,
        handoffDelegation: { ...authority, authorizationRestriction: { actions: [] } },
      }),
    ).rejects.toBeDefined();
    const allowed = await store.secrets.mutateApiEnvironmentSecret({
      ...request,
      name: "ALLOWED",
      idempotencyKey: "allowed",
      handoffDelegation: authority,
    });
    expect(allowed.response.status).toBe("stored");
    await project.shard
      .prepare("UPDATE mcp_client_grants SET revoked_at=? WHERE grant_id=?")
      .bind(STORED_NOW, grantId)
      .run();
    await expect(
      store.secrets.mutateApiEnvironmentSecret({ ...request, handoffDelegation: authority }),
    ).rejects.toBeDefined();
    const count = await project.shard
      .prepare(
        "SELECT count(*) n FROM environment_secrets WHERE organization_id=? AND name='EXAMPLE'",
      )
      .bind(project.organizationId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
  it("blocks activation when a GitHub handoff is revoked after the provider claim", async () => {
    const { project, grantId } = await setup(false);
    const store = createControlStore(control.bindings);
    const authorizationId = newUlid();
    const principalId = "user:user_seed";
    const clock = Date.now();
    const now = new Date(clock).toISOString();
    const initialExpiry = new Date(clock + 30_000).toISOString();
    const renewedExpiry = new Date(clock + 50_000).toISOString();
    const attempt = {
      organizationId: project.organizationId,
      principalId,
      idempotencyKey: "github",
      authorizationId,
      sessionId: "session_one",
      userApiKeyId: null,
      workosOrganizationId: "org_test",
      tokenExpiresAt: 1800000000,
      stateSha256: "11".repeat(32),
      ciphertext: "ab".repeat(24),
      nonce: "cd".repeat(12),
      valueSha256: "12".repeat(32),
      keyVersion: 1,
      createdAt: STORED_NOW,
      expiresAt: new Date(clock + 600_000).toISOString(),
      installationId: null,
      flow: "installation",
      handoffDelegation: {
        grantId,
        clientId: "client-1",
        consentHash: hash,
        action: "sources:link",
      },
    };
    expect(await store.github.insertGithubConnectionAuthorization(attempt)).toBe(true);
    expect(
      await store.github.claimGithubConnectionAuthorization({
        authorizationId,
        installationId: "42",
        now,
        expiresAt: initialExpiry,
      }),
    ).toBe(true);
    const activeUse = await project.shard
      .prepare(
        "SELECT client_id, consent_hash FROM github_connection_provider_uses WHERE authorization_id=?",
      )
      .bind(authorizationId)
      .first();
    expect(activeUse).toMatchObject({ client_id: "client-1", consent_hash: hash });
    await expect(
      store.github.renewGithubConnectionProviderUse({
        authorizationId: newUlid(),
        now: STORED_NOW,
        expiresAt: "2026-10-28T10:01:00.000Z",
      }),
    ).resolves.toBe(false);
    await expect(
      store.github.renewGithubConnectionProviderUse({
        authorizationId,
        now: STORED_NOW,
        expiresAt: "2026-10-28T10:02:00.000Z",
      }),
    ).resolves.toBe(false);
    expect(
      await store.github.renewGithubConnectionProviderUse({
        authorizationId,
        now,
        expiresAt: renewedExpiry,
      }),
    ).toBe(true);
    expect(
      await project.shard
        .prepare("SELECT expires_at FROM github_connection_provider_uses WHERE authorization_id=?")
        .bind(authorizationId)
        .first(),
    ).toEqual({ expires_at: renewedExpiry.replace("Z", "000Z") });
    const disconnect = { userId: "user_seed", clientId: "client-1", consentHash: hash, now };
    expect(await store.identity.revokeMcpConsent(disconnect)).toEqual({ state: "pending" });
    await expect(
      store.github.renewGithubConnectionProviderUse({
        authorizationId,
        now,
        expiresAt: renewedExpiry,
      }),
    ).rejects.toBeDefined();
    await expect(
      store.github.completeGithubConnection({
        authorizationId,
        organizationId: project.organizationId,
        principalId,
        connectionId: newUlid(),
        now: STORED_NOW,
        proof: {
          installationId: "42",
          accountId: "7",
          accountLogin: "octo",
          accountType: "Organization",
          githubUserId: "5",
          githubUserLogin: "octocat",
          settingsUrl: "https://github.com/settings",
        },
      }),
    ).rejects.toBeDefined();
    expect(
      await store.github.hasActiveGithubConnection({ organizationId: project.organizationId }),
    ).toBe(false);
    await expect(
      store.github.releaseGithubConnectionProviderUse({ authorizationId: newUlid() }),
    ).resolves.toBe(false);
    await expect(
      store.github.releaseGithubConnectionProviderUse({ authorizationId }),
    ).resolves.toBe(true);
    await expect(
      store.github.releaseGithubConnectionProviderUse({ authorizationId }),
    ).resolves.toBe(false);
    expect(
      await project.shard
        .prepare("SELECT 1 FROM github_connection_provider_uses WHERE authorization_id=?")
        .bind(authorizationId)
        .first(),
    ).toBeNull();
    expect(await store.identity.revokeMcpConsent(disconnect)).toEqual({ state: "revoked" });
  });
});
