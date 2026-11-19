import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { projectInput, seedOrganization } from "../../control-store/test/support/seed.js";
import {
  createD1GithubOrganizationConnection,
  createD1GithubSourceAuthorization,
} from "../src/d1-github.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import { GithubConnectionRequiredError } from "../src/github-organization-connection.js";
import {
  GithubAuthorizationCodeRejectedError,
  GithubAuthorizationRejectedError,
  GithubRepositoryAccessRequiredError,
  GithubRepositoryNotInstalledError,
} from "../src/github-source-authorization.js";

const digest = (n: number) => new Uint8Array(32).fill(n);

async function fixture(control: Awaited<ReturnType<typeof createTestControl>>) {
  const store = createControlStore(control.bindings),
    organizationId = await seedOrganization(store, 2, 0),
    project = projectInput(organizationId, "github-flow");
  await store.projects.createInitialProject(project);
  await control.core
    .prepare(
      "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  const mapping = (await store.github.readGithubOrganizationMapping({ organizationId })) as {
    workosOrganizationId: string;
  };
  const now = Date.parse("2026-10-29T10:00:00.000Z");
  const clock = { now: () => new Date(now) },
    ids = { next: () => parseUlid(newUlid()) },
    cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: Buffer.alloc(32, 0x42).toString("base64"),
      currentKeyVersion: 1,
      crypto: globalThis.crypto,
    }),
    session = {
      sessionId: "session_gh",
      userId: "user_gh",
      organizationId: mapping.workosOrganizationId,
      tokenExpiresAt: Math.floor(now / 1000) + 600,
    },
    dependencies = {
      runtime: store.github as never,
      product: {
        ...store.productApi,
        readApiProductOperation: store.productApi.readApiProductOperation,
      } as never,
      control: { authorizeOrganizationAction: async () => "allow" as const },
      callbackUri: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
      clock,
      ids,
      cipher,
      sessionStatus: { isActive: async () => true },
      apiKeyStatus: { observe: async () => null },
    },
    urls = (value: unknown) => {
      const { state, codeChallenge } = value as Record<string, string>;
      return {
        installationUrl: `https://github.com/apps/test-app/installations/new?state=${state}`,
        authorizationUrl: `https://github.com/login/oauth/authorize?client_id=c&code_challenge=${codeChallenge}&code_challenge_method=S256&prompt=select_account&redirect_uri=${encodeURIComponent(dependencies.callbackUri)}&state=${state}`,
      };
    };
  const principalId = "user:user_gh",
    mutation = {
      organizationId: parseUlid(organizationId),
      projectId: parseUlid(project.projectId),
      principalId,
      requestId: "req_gh",
      idempotencyKey: "link-1",
      canonicalRequestDigest: digest(7),
      repositoryOwner: "octo",
      repositoryName: "app",
      session,
    };

  const principal = {
    authorizationPrincipal: { kind: "user", subjectId: principalId },
    session,
    credentialId: "session",
  } as never;
  return { store, organizationId, project, dependencies, urls, principalId, mutation, principal };
}

it("runs both GitHub flows over the Core: state, proofs, one accepted SourceLink operation per key and the single connection", async () => {
  const control = await createTestControl();
  try {
    const { store, project, principalId, organizationId, dependencies, urls, mutation, principal } =
      await fixture(control);

    // Project source authorization: begin is idempotent by key and digest, the callback accepts exactly one operation.
    let exchanges = 0;
    const sourceFlow = createD1GithubSourceAuthorization({
      ...dependencies,
      source: {
        beginRepositoryAuthorization: async (value) => urls(value),
        completeRepositoryAuthorization: async () => {
          exchanges += 1;
          return {
            installationId: 42,
            owner: "octo",
            permission: "contents:read",
            repository: "app",
            repositoryId: 77,
            userId: 5,
          };
        },
      },
    });
    const begun = await sourceFlow.begin(mutation);
    expect(begun).toMatchObject({
      status: "pending",
      repository_owner: "octo",
      operation_id: null,
    });
    expect(await sourceFlow.begin(mutation)).toEqual(begun);
    await expect(
      sourceFlow.begin({ ...mutation, canonicalRequestDigest: digest(8) }),
    ).rejects.toThrow();
    const state = new URL(begun.authorization_url as string).searchParams.get("state") as string;
    const authorized = await sourceFlow.callback({
      state,
      code: "code-1",
      signedInPrincipalId: principalId,
    });
    expect(authorized).toMatchObject({
      status: "authorized",
      installation_id: "42",
      repository_id: "77",
    });
    expect(authorized.operation_id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(
      await sourceFlow.callback({ state, code: "code-1", signedInPrincipalId: principalId }),
    ).toMatchObject({
      status: "authorized",
    });
    expect(exchanges).toBe(1);
    const accepted = await control.core
      .prepare(
        "SELECT count(*) n FROM product_command_intents WHERE operation_id=? AND event_type='SourceLinkRequestedV1'",
      )
      .bind(authorized.operation_id)
      .first<{ n: number }>();
    expect(accepted?.n).toBe(1);

    // Organization connection: install -> OAuth -> connected once, then a repository link with durable consent.
    const connectionFlow = createD1GithubOrganizationConnection({
      ...dependencies,
      source: {
        beginOrganizationAuthorization: async (value) => urls(value),
        completeOrganizationAuthorization: async () => ({
          installationId: 42,
          accountId: 7,
          accountLogin: "octo",
          accountType: "Organization",
          repositorySelection: "all",
          settingsUrl: "https://github.com/organizations/octo/settings/installations/42",
          userId: 5,
          userLogin: "octocat",
        }),
        observeOrganizationInstallation: async () => ({
          installationId: 42,
          accountId: 7,
          accountType: "Organization",
        }),
        validateOrganizationRepository: async () => ({
          installationId: 42,
          owner: "octo",
          name: "second",
          permission: "contents:read",
          externalRepositoryId: "78",
        }),
      },
    });
    expect(await connectionFlow.status(organizationId)).toEqual({
      status: "not_connected",
      connection: null,
    });
    const attempt = await connectionFlow.begin({
      organizationId,
      principal,
      idempotencyKey: "connect-1",
    });
    // The earlier project authorization names installation 42, so the attempt skips the install page.
    expect(attempt).toMatchObject({ status: "pending" });
    const connectionState = new URL(attempt.authorization_url as string).searchParams.get(
      "state",
    ) as string;
    const done = (await connectionFlow.callback({
      state: connectionState,
      code: "code-2",
      signedInPrincipalId: principalId,
    })) as {
      view: { status: string; connection: { installation_id: string } | null };
    };
    expect(done.view).toMatchObject({ status: "connected", connection: { installation_id: "42" } });
    expect(await connectionFlow.status(organizationId)).toMatchObject({ status: "connected" });
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_gh','admin','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','delegated-github')",
        )
        .bind(organizationId),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner','2026-10-28T10:00:00.000000Z')",
        )
        .bind(organizationId, newUlid(), principalId),
    ]);
    const connection = {
      organizationId,
      userId: "user_gh",
      clientId: "github-client",
      consentHash: "de".repeat(32),
    };
    const proof = await store.identity.ensureMcpConnectionProof({
      ...connection,
      projectId: project.projectId,
      now: dependencies.clock.now().toISOString(),
    });
    if (!proof) throw new Error("GitHub connection proof missing");
    const delegation = {
      grantId: proof.grantId,
      clientId: connection.clientId,
      consentHash: connection.consentHash,
      action: "sources:link" as const,
      authorizationRestriction: {
        actions: ["sources:link" as const],
        projectIds: [mutation.projectId],
      },
    };
    const link = { ...mutation, delegation, idempotencyKey: "link-2", repositoryName: "second" };
    const first = await connectionFlow.link(link);
    expect(first).toMatchObject({ status: 202 });
    const retained = await control.core
      .prepare(
        "SELECT authorization_action,authorization_restriction FROM operation_mcp_delegations WHERE project_id=?",
      )
      .bind(project.projectId)
      .first<{ authorization_action: string; authorization_restriction: string }>();
    expect(retained?.authorization_action).toBe("sources:link");
    expect(JSON.parse(retained?.authorization_restriction ?? "null")).toEqual(
      delegation.authorizationRestriction,
    );
    expect(await connectionFlow.link(link)).toEqual(first);
    await expect(
      connectionFlow.link({ ...link, canonicalRequestDigest: digest(9) }),
    ).rejects.toThrow();

    // The Owner disconnect revokes the workspace connection; the status then reads it as revoked.
    expect(await connectionFlow.disconnect({ organizationId, principal })).toMatchObject({
      status: "revoked",
      connection: { installation_id: "42", revoked_at: expect.any(String) },
    });
    expect(await connectionFlow.status(organizationId)).toMatchObject({ status: "revoked" });
    expect(await connectionFlow.disconnect({ organizationId, principal })).toMatchObject({
      status: "revoked",
    });
  } finally {
    await control.dispose();
  }
});

it("keeps an actionable source failure resumable and ends a denied connection attempt", async () => {
  const control = await createTestControl();
  try {
    const { organizationId, dependencies, urls, mutation, principal, principalId } =
      await fixture(control);
    let reject: Error = new GithubRepositoryNotInstalledError("not covered");
    const sourceFlow = createD1GithubSourceAuthorization({
      ...dependencies,
      source: {
        beginRepositoryAuthorization: async (value) => urls(value),
        completeRepositoryAuthorization: async () => {
          throw reject;
        },
      },
    });
    const begun = await sourceFlow.begin(mutation);
    const state = new URL(begun.authorization_url as string).searchParams.get("state") as string;
    // Each provider refusal is recorded under its own public reason; a customer-actionable one leaves the flow open.
    for (const [error, failure] of [
      [new GithubRepositoryNotInstalledError("x"), "repository_not_installed"],
      [new GithubRepositoryAccessRequiredError("x"), "repository_access_required"],
      [new GithubAuthorizationCodeRejectedError("x"), "authorization_code_rejected"],
      [new Error("boom"), "provider_unavailable"],
    ] as const) {
      reject = error;
      await expect(
        sourceFlow.callback({ state, code: "code-1", signedInPrincipalId: principalId }),
      ).rejects.toBe(error);
      const stored = await control.core
        .prepare("SELECT state,last_failure FROM github_source_authorizations")
        .first<{ state: string; last_failure: string }>();
      expect(stored).toEqual({ state: "pending", last_failure: failure });
    }
    reject = new GithubAuthorizationRejectedError("denied");
    await expect(
      sourceFlow.callback({ state, code: "code-1", signedInPrincipalId: principalId }),
    ).rejects.toBe(reject);
    expect(
      await control.core
        .prepare("SELECT state,last_failure FROM github_source_authorizations")
        .first(),
    ).toEqual({ state: "failed", last_failure: "denied" });

    // A customer who denies the organization connection ends that attempt for good.
    const connectionFlow = createD1GithubOrganizationConnection({
      ...dependencies,
      source: {
        beginOrganizationAuthorization: async (value) => urls(value),
        observeOrganizationInstallation: async () => ({}),
        completeOrganizationAuthorization: async () => ({}),
        validateOrganizationRepository: async () => ({}),
      },
    });
    const attempt = await connectionFlow.begin({
      organizationId,
      principal,
      idempotencyKey: "connect-denied",
    });
    const connectionState = new URL(attempt.authorization_url as string).searchParams.get(
      "state",
    ) as string;
    const denied = (await connectionFlow.callback({
      state: connectionState,
      denied: true,
      signedInPrincipalId: principalId,
    })) as {
      view: { status: string; last_failure: string };
    };
    expect(denied.view).toMatchObject({ status: "failed", last_failure: "denied" });
    expect(await connectionFlow.status(organizationId)).toEqual({
      status: "not_connected",
      connection: null,
    });
  } finally {
    await control.dispose();
  }
});

it("asks the customer to connect GitHub, then to install the App on a repository, before a link is accepted", async () => {
  const control = await createTestControl();
  try {
    const { organizationId, dependencies, urls, mutation, principal, principalId } =
      await fixture(control);
    const settingsUrl = "https://github.com/organizations/octo/settings/installations/42";
    const connectionFlow = createD1GithubOrganizationConnection({
      ...dependencies,
      source: {
        beginOrganizationAuthorization: async (value) => urls(value),
        observeOrganizationInstallation: async () => ({
          installationId: 42,
          accountId: 7,
          accountType: "Organization",
        }),
        completeOrganizationAuthorization: async () => ({
          installationId: 42,
          accountId: 7,
          accountLogin: "octo",
          accountType: "Organization",
          repositorySelection: "selected",
          settingsUrl,
          userId: 5,
          userLogin: "octocat",
        }),
        validateOrganizationRepository: async () => ({ status: "repository_not_installed" }),
      },
    });
    const missing = await connectionFlow.link(mutation).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(GithubConnectionRequiredError);
    expect(missing).toMatchObject({
      code: "github_connection_required",
      settingsUrl: undefined,
      message: "GitHub connection needs customer action",
    });

    const attempt = await connectionFlow.begin({
      organizationId,
      principal,
      idempotencyKey: "connect-selected",
    });
    const state = new URL(attempt.authorization_url as string).searchParams.get("state") as string;
    const installed = await connectionFlow.callback({
      state,
      installationId: "42",
      signedInPrincipalId: principalId,
    });
    expect(installed?.redirect).toContain("https://github.com/login/oauth/authorize");
    await connectionFlow.callback({
      state,
      code: "code-selected",
      signedInPrincipalId: principalId,
    });
    expect(await connectionFlow.status(organizationId)).toMatchObject({ status: "connected" });

    const notInstalled = await connectionFlow
      .link({ ...mutation, idempotencyKey: "link-not-installed" })
      .catch((error: unknown) => error);
    expect(notInstalled).toBeInstanceOf(GithubConnectionRequiredError);
    expect(notInstalled).toMatchObject({ code: "repository_not_installed", settingsUrl });
  } finally {
    await control.dispose();
  }
}, 60_000);

it("accepts a repository typed in another letter case and records GitHub's canonical owner and name", async () => {
  const control = await createTestControl();
  try {
    const { organizationId, dependencies, urls, mutation, principal, principalId } =
      await fixture(control);
    const settingsUrl = "https://github.com/organizations/octo/settings/installations/42";
    const connectionFlow = createD1GithubOrganizationConnection({
      ...dependencies,
      source: {
        beginOrganizationAuthorization: async (value) => urls(value),
        observeOrganizationInstallation: async () => ({
          installationId: 42,
          accountId: 7,
          accountType: "Organization",
        }),
        completeOrganizationAuthorization: async () => ({
          installationId: 42,
          accountId: 7,
          accountLogin: "octo",
          accountType: "Organization",
          repositorySelection: "selected",
          settingsUrl,
          userId: 5,
          userLogin: "octocat",
        }),
        // GitHub answers with the canonical spelling of the repository it matched.
        validateOrganizationRepository: async () => ({
          installationId: 42,
          owner: "octo",
          name: "app",
          permission: "contents:read",
          externalRepositoryId: "77",
        }),
      },
    });
    const attempt = await connectionFlow.begin({
      organizationId,
      principal,
      idempotencyKey: "connect-cased",
    });
    const state = new URL(attempt.authorization_url as string).searchParams.get("state") as string;
    await connectionFlow.callback({
      state,
      installationId: "42",
      signedInPrincipalId: principalId,
    });
    await connectionFlow.callback({
      state,
      code: "code-cased",
      signedInPrincipalId: principalId,
    });
    expect(await connectionFlow.status(organizationId)).toMatchObject({ status: "connected" });

    await connectionFlow.link({
      ...mutation,
      repositoryOwner: "Octo",
      repositoryName: "App",
      idempotencyKey: "link-cased",
    });
    expect(
      await control.core
        .prepare(
          "SELECT repository_owner, repository_name FROM product_command_intents WHERE project_id=?1 AND event_type='SourceLinkRequestedV1'",
        )
        .bind(mutation.projectId)
        .first(),
    ).toEqual({ repository_owner: "octo", repository_name: "app" });
  } finally {
    await control.dispose();
  }
}, 60_000);
