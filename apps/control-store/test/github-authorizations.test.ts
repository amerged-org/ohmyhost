import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedProject, STORED_NOW } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const digest = (n: number) => n.toString(16).padStart(64, "0");
const sealed = (n: number) => ({
  ciphertext: "ab".repeat(24),
  nonce: "cd".repeat(12),
  valueSha256: digest(n),
  keyVersion: 1,
});
const at = (minute: number) => `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000000Z`;

describe("github", () => {
  it("keeps the source-link and organization-connection state machines exact, idempotent and single-active", async () => {
    const store = createControlStore(control.bindings),
      project = await seedProject(control),
      organizationId = project.organizationId,
      principalId = "user:user_gh",
      session = { sessionId: "session_one", userApiKeyId: null, tokenExpiresAt: 1_800_000_000 };
    const mapping = (await store.github.readGithubOrganizationMapping({ organizationId })) as {
      workosOrganizationId: string;
    };
    expect(mapping.workosOrganizationId).toMatch(/^org_/u);

    // Source authorization: one row per key, a lost race reads the winner, claiming needs an unexpired pending row.
    const authorizationId = newUlid();
    const source = {
      organizationId,
      projectId: project.projectId,
      principalId,
      idempotencyKey: "link-1",
      authorizationId,
      environmentId: project.devEnvironmentId,
      billingEpochId: project.billingEpochId,
      workosOrganizationId: mapping.workosOrganizationId,
      ...session,
      repositoryOwner: "octo",
      repositoryName: "app",
      requestSha256: digest(1),
      stateSha256: digest(2),
      ...sealed(3),
      createdAt: at(0),
      expiresAt: at(30),
    };
    expect(await store.github.insertGithubSourceAuthorization(source)).toBe(true);
    expect(
      await store.github.insertGithubSourceAuthorization({
        ...source,
        authorizationId: newUlid(),
        stateSha256: digest(9),
      }),
    ).toBe(false);
    const stored = (await store.github.readGithubSourceAuthorization({
      organizationId,
      projectId: project.projectId,
      principalId,
      idempotencyKey: "link-1",
    })) as Record<string, unknown>;
    expect(stored).toMatchObject({
      authorization_id: authorizationId,
      state: "pending",
      state_sha256: digest(2),
      request_sha256: digest(1),
      value_sha256: digest(3),
      ciphertext: sealed(3).ciphertext,
    });
    expect(
      await store.github.readGithubSourceAuthorizationByState({ stateSha256: digest(2) }),
    ).toEqual(stored);
    expect(
      await store.github.claimGithubSourceAuthorization({
        authorizationId,
        denied: false,
        now: at(31),
      }),
    ).toBeNull();
    expect(
      await store.github.claimGithubSourceAuthorization({
        authorizationId,
        denied: false,
        now: at(5),
      }),
    ).toMatchObject({
      state: "authorizing",
    });
    expect(
      await store.github.claimGithubSourceAuthorization({
        authorizationId,
        denied: false,
        now: at(6),
      }),
    ).toBeNull();
    await store.github.releaseGithubSourceAuthorization({
      authorizationId,
      resumable: true,
      failure: "repository_not_installed",
    });
    expect(await store.github.readGithubSourceAuthorizationById({ authorizationId })).toMatchObject(
      {
        state: "pending",
        last_failure: "repository_not_installed",
      },
    );
    await store.github.claimGithubSourceAuthorization({
      authorizationId,
      denied: false,
      now: at(7),
    });
    const operationId = newUlid();
    await control.core
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,billing_epoch_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
      )
      .bind(
        organizationId,
        project.projectId,
        operationId,
        project.billingEpochId,
        STORED_NOW,
        STORED_NOW,
      )
      .run();
    const done = {
      authorizationId,
      operationId,
      githubUserId: "5",
      installationId: "42",
      repositoryId: "77",
    };
    expect(await store.github.completeGithubSourceAuthorization(done)).toMatchObject({
      state: "authorized",
      operation_id: operationId,
      installation_id: "42",
    });
    expect(await store.github.completeGithubSourceAuthorization(done)).toMatchObject({
      state: "authorized",
    });
    expect(
      await store.github.completeGithubSourceAuthorization({ ...done, operationId: newUlid() }),
    ).toBeNull();
    expect(await store.github.readGithubInstallationHints({ organizationId, principalId })).toEqual(
      ["42"],
    );

    // Consent evidence: appended once for the operation and key, replayable by key.
    const consent = {
      organizationId,
      projectId: project.projectId,
      principalId,
      idempotencyKey: "consent-1",
      operationId,
      environmentId: project.devEnvironmentId,
      billingEpochId: project.billingEpochId,
      connectionId: newUlid(),
      installationId: "42",
      repositoryId: "77",
      repositoryOwner: "octo",
      repositoryName: "app",
      requestSha256: digest(4),
      authorizedAt: at(8),
    };

    // Organization connection: an attempt moves installation -> oauth -> authorizing -> connected exactly once.
    const connectionAuthorizationId = newUlid();
    const attempt = {
      organizationId,
      principalId,
      idempotencyKey: "connect-1",
      authorizationId: connectionAuthorizationId,
      workosOrganizationId: mapping.workosOrganizationId,
      ...session,
      stateSha256: digest(11),
      ...sealed(12),
      createdAt: at(0),
      expiresAt: at(30),
      installationId: null,
      flow: "installation" as const,
    };
    expect(await store.github.insertGithubConnectionAuthorization(attempt)).toBe(true);
    expect(
      await store.github.insertGithubConnectionAuthorization({
        ...attempt,
        authorizationId: newUlid(),
        stateSha256: digest(19),
      }),
    ).toBe(false);
    expect(await store.github.readGithubConnection({ organizationId })).toBeNull();
    expect(
      await store.github.advanceGithubConnectionToOauth({
        authorizationId: connectionAuthorizationId,
        installationId: "42",
      }),
    ).toMatchObject({
      flow: "oauth",
      installation_id: "42",
    });
    expect(
      await store.github.claimGithubConnectionAuthorization({
        authorizationId: connectionAuthorizationId,
        installationId: "42",
      }),
    ).toBe(true);
    expect(
      await store.github.claimGithubConnectionAuthorization({
        authorizationId: connectionAuthorizationId,
        installationId: "42",
      }),
    ).toBe(false);
    const proof = {
      installationId: "42",
      accountId: "7",
      accountLogin: "octo",
      accountType: "Organization" as const,
      githubUserId: "5",
      githubUserLogin: "octocat",
      settingsUrl: "https://github.com/organizations/octo/settings/installations/42",
    };
    const connect = {
      authorizationId: connectionAuthorizationId,
      organizationId,
      principalId,
      connectionId: newUlid(),
      now: at(9),
      proof,
    };
    const connected = (await store.github.completeGithubConnection(connect)) as {
      outcome: string;
      row: { connection_id: string };
    };
    expect(connected).toMatchObject({ outcome: "connected", row: { state: "connected" } });
    expect(await store.github.completeGithubConnection(connect)).toMatchObject({
      outcome: "connected",
    });
    expect(await store.github.hasActiveGithubConnection({ organizationId })).toBe(true);
    expect(await store.github.readGithubConnection({ organizationId })).toMatchObject({
      connection_id: connected.row.connection_id,
      installation_id: "42",
      account_login: "octo",
      revoked_at: null,
    });
    expect(
      await store.github.readGithubConnectionById({
        organizationId,
        connectionId: connected.row.connection_id,
      }),
    ).toMatchObject({ installation_id: "42", account_login: "octo" });
    const finished = await store.github.readGithubConnectionAuthorization({
      organizationId,
      principalId,
      idempotencyKey: "connect-1",
    });
    expect(finished).toMatchObject({
      authorization_id: connectionAuthorizationId,
      state: "connected",
    });
    expect(
      await store.github.readGithubConnectionAuthorizationByState({ stateSha256: digest(11) }),
    ).toEqual(finished);
    expect(
      await store.github.readGithubConnectionAuthorizationById({
        authorizationId: connectionAuthorizationId,
      }),
    ).toEqual(finished);

    // A second attempt from another GitHub account is refused while the first connection is active.
    const second = newUlid();
    await store.github.insertGithubConnectionAuthorization({
      ...attempt,
      idempotencyKey: "connect-2",
      authorizationId: second,
      stateSha256: digest(21),
      installationId: "43",
      flow: "oauth",
    });
    await store.github.claimGithubConnectionAuthorization({
      authorizationId: second,
      installationId: "43",
    });
    expect(
      await store.github.completeGithubConnection({
        ...connect,
        authorizationId: second,
        connectionId: newUlid(),
        proof: { ...proof, installationId: "43", accountId: "8" },
      }),
    ).toEqual({ outcome: "different_account" });
    expect(
      await store.github.failGithubConnectionAuthorization({
        authorizationId: second,
        reason: "code_spent",
        nextState: "failed",
      }),
    ).toMatchObject({
      state: "failed",
      last_failure: "code_spent",
    });

    // The link consent is evidence of the connected organization for the accepted operation.
    expect(
      await store.github.insertGithubRepositoryLinkConsent({
        ...consent,
        connectionId: connected.row.connection_id,
      }),
    ).toBe(true);
    expect(
      await store.github.insertGithubRepositoryLinkConsent({
        ...consent,
        connectionId: connected.row.connection_id,
      }),
    ).toBe(false);
    expect(
      await store.github.readGithubRepositoryLinkConsent({
        organizationId,
        projectId: project.projectId,
        principalId,
        idempotencyKey: "consent-1",
      }),
    ).toEqual({ operationId, requestSha256: digest(4) });

    // Revoking is recorded once; the newest connection stays readable as revoked.
    const revoked = await store.github.revokeGithubConnection({
      organizationId,
      connectionId: connected.row.connection_id,
      now: at(20),
      reason: "installation_uninstalled",
    });
    expect(revoked).toMatchObject({ revoked_at: at(20) });
    expect(await store.github.hasActiveGithubConnection({ organizationId })).toBe(false);
  });
});
