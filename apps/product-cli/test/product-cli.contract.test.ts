import { readFileSync } from "node:fs";

import cliPackage from "../package.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { LifecycleTransportError, ProviderCapabilityBlockedError } from "../src/cli.js";
import type { ProductCliTestHarness, ProductCliHarnessOptions } from "./contract.js";
import { loadProductCliHarness } from "./load-harness.js";

const CREDENTIAL = {
  accessToken: "access-token-a",
  refreshToken: "refresh-token-a",
  expiresAt: "2026-08-18T01:00:00.000Z",
};
const DEVICE_CREDENTIAL = {
  ...CREDENTIAL,
  accessToken: unsignedJwt({ exp: Date.parse("2026-08-18T01:00:20.000Z") / 1_000 }),
};
const OPERATION_ID = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const RESPONSE_CONTRACT_INVALID_ACTION =
  "The ohmyho.st API answered in a form this client version does not accept, usually because the client is older than the service. Compare 'ohmyhost --version' with https://ohmyho.st/client-release.json; if it is older, install the published CLI and MCP and reload MCP. Then run the same command again; this command has no idempotency key, so check its current state first if it may have changed anything. If the current version answers this too, report it with feedback submit (kind bug, error code response_contract_invalid).";
const LOGOUT_UNCONFIRMED_ACTION =
  "The saved login was removed from this computer, but ohmyho.st did not confirm that its session ended. Running logout again cannot retry this, because the login is gone; do not sign in again just to revoke it. Tell the customer the session end was not confirmed.";
const ALPHA = {
  id: "01M0WRKSPACEAAAAAAAAAAAAAA",
  workos_id: "org_workspace_alpha",
  name: "Alpha workspace",
};
const BETA = {
  id: "01M0WRKSPACEBBBBBBBBBBBBBB",
  workos_id: "org_workspace_beta",
  name: "Beta workspace",
};
/** Two ignored polls keep the harness clock where DEVICE_CREDENTIAL's own expiry is consistent. */
const LOGIN_POLLS = ["authorization_pending", "slow_down", DEVICE_CREDENTIAL] as const;

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unsignedJwt(payload: Readonly<Record<string, unknown>>): string {
  return [base64Url('{"alg":"none","typ":"JWT"}'), base64Url(JSON.stringify(payload)), "c2ln"].join(
    ".",
  );
}

describe("Product CLI Phase 1 contract", () => {
  it("refreshes an expiring credential during deployment wait without submitting another deployment", async () => {
    const refreshedCredential = {
      ...CREDENTIAL,
      accessToken: "access-after-wait",
      refreshToken: "refresh-after-wait",
    };
    const harness = await createHarness({
      storedCredential: { ...CREDENTIAL, expiresAt: "2026-08-18T00:00:06.000Z" },
      refreshedCredential,
    });
    const result = await harness.run([
      "deploy",
      "--project",
      OPERATION_ID,
      "--plan-id",
      OPERATION_ID,
      "--idempotency-key",
      "deploy-wait-refresh",
      "--yes",
      "--wait",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const snapshot = await harness.snapshot();
    expect(snapshot.refreshRequests).toEqual([{ token: CREDENTIAL.refreshToken }]);
    expect(snapshot.storedCredential).toEqual(refreshedCredential);
    expect(snapshot.apiCalls).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/v1/projects/${OPERATION_ID}/deployments`,
        headers: expect.objectContaining({ Authorization: `Bearer ${CREDENTIAL.accessToken}` }),
      }),
      expect.objectContaining({
        method: "GET",
        path: `/v1/operations/${OPERATION_ID}`,
        headers: expect.objectContaining({
          Authorization: `Bearer ${refreshedCredential.accessToken}`,
        }),
      }),
    ]);
    expect(result.stdout + result.stderr).not.toContain(refreshedCredential.accessToken);
  });

  it("completes RFC 8628 Device Flow as a public client and performs no product mutation", async () => {
    const harness = await createHarness({
      deviceTokenOutcomes: ["authorization_pending", "slow_down", DEVICE_CREDENTIAL],
    });

    const result = await harness.run(["login", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "login",
      status: "authenticated",
    });
    const snapshot = await harness.snapshot();
    expect(snapshot.presentedAuthorizations).toEqual([
      {
        verificationUri: "https://auth.example.test/device",
        userCode: "ABCD-EFGH",
      },
    ]);
    expect(snapshot.lifecycleEvents[0]).toBe("authorization-presented");
    expect(snapshot.lifecycleEvents.slice(1)).toEqual([
      "token-polled",
      "token-polled",
      "token-polled",
    ]);
    expect(snapshot.deviceAuthorizationRequests).toEqual([
      { clientId: expect.any(String), scope: expect.stringContaining("openid") },
    ]);
    expect(snapshot.tokenPollRequests).toHaveLength(3);
    expect(snapshot.tokenPollRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          clientId: expect.any(String),
          deviceCode: expect.any(String),
        }),
      ]),
    );
    expect(snapshot.storedCredential).toEqual({
      ...DEVICE_CREDENTIAL,
      expiresAt: "2026-08-18T01:00:20.000Z",
    });
    // Login reads the account profile and verifies the identity; it mutates no product resource.
    expect(snapshot.apiCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/me/profile",
      "GET /v1/me",
    ]);
    expect(snapshot.profiles).toEqual([
      { name: "account", userId: "user-a", organizationId: null, organizationName: null },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/clientSecret|provider|database/iu);
  });

  it("issues the next device code instead of ending a sign-in the customer is still walking to", async () => {
    // Observed 2026-09-19 01:08: the AuthKit page answered "invalid code" for a code issued at
    // 00:55. A device code lives five minutes and the provider offers no way to lengthen it, so a
    // customer relayed through an agent regularly arrives after it lapsed. Nobody refused; the
    // clock ran out, and the old behaviour answered device_authorization_expired.
    const harness = await createHarness({
      deviceTokenOutcomes: ["authorization_pending", "expired_token", DEVICE_CREDENTIAL],
    });

    const result = await harness.run(["login", "--json"]);

    // The sign-in no longer ends at the lapsed code: a second one is requested and shown, which is
    // what the relaying agent needs to pass on. (The fixture's token is pinned to its own clock, so
    // this asserts the renewal rather than the completed login.)
    const snapshot = await harness.snapshot();
    expect(snapshot.deviceAuthorizationRequests).toHaveLength(2);
    expect(snapshot.presentedAuthorizations).toHaveLength(2);
    expect(snapshot.lifecycleEvents.filter((event) => event === "authorization-presented")).toEqual(
      ["authorization-presented", "authorization-presented"],
    );
    expect(parseDocument(result.stdout)).not.toMatchObject({
      error: { code: "device_authorization_expired" },
    });
  });

  it("selects the signed-in customer's workspace at login and never guesses between several", async () => {
    // The workspace lives in the access token. Without this selection a new customer stays on
    // organization_ids: [] and every project call answers resource_not_found.
    const refreshed = {
      accessToken: "access-scoped-to-workspace",
      refreshToken: "refresh-scoped-to-workspace",
      expiresAt: "2026-08-18T02:00:00.000Z",
    };
    const single = await createHarness({
      deviceTokenOutcomes: LOGIN_POLLS,
      organizations: [ALPHA],
      refreshedCredential: refreshed,
    });

    const silent = await single.run(["login", "--json"]);

    expect(silent.exitCode, silent.stdout).toBe(0);
    expect(parseDocument(silent.stdout)).toEqual({
      version: 1,
      command: "login",
      status: "authenticated",
      organization: { id: ALPHA.id, name: ALPHA.name },
      profile: {
        name: "alpha-workspace",
        user_id: "user-a",
        organization_id: ALPHA.id,
        organization_name: ALPHA.name,
      },
    });
    const singleSnapshot = await single.snapshot();
    expect(singleSnapshot.refreshRequests).toEqual([
      { token: DEVICE_CREDENTIAL.refreshToken, workosOrganizationId: ALPHA.workos_id },
    ]);
    expect(singleSnapshot.storedCredential).toEqual({
      ...refreshed,
      workosOrganizationId: ALPHA.workos_id,
      organizationId: ALPHA.id,
    });

    const several = await createHarness({
      deviceTokenOutcomes: LOGIN_POLLS,
      organizations: [ALPHA, BETA],
      refreshedCredential: refreshed,
    });

    const ambiguous = await several.run(["login", "--json"]);

    expect(ambiguous.exitCode, ambiguous.stdout).toBe(0);
    expect(parseDocument(ambiguous.stdout)).toEqual({
      version: 1,
      command: "login",
      status: "authenticated",
      organization: null,
      profile: {
        name: "account",
        user_id: "user-a",
        organization_id: null,
        organization_name: null,
      },
      organizations: [
        { id: ALPHA.id, name: ALPHA.name },
        { id: BETA.id, name: BETA.name },
      ],
      next_action:
        "Ask the customer which workspace to use, then run 'OHMYHOST_ENVIRONMENT=development ohmyhost organization use --organization ULID --profile-name account --json'.",
    });
    const severalSnapshot = await several.snapshot();
    expect(severalSnapshot.refreshRequests).toEqual([]);
    expect(severalSnapshot.storedCredential).toEqual({
      ...DEVICE_CREDENTIAL,
      expiresAt: "2026-08-18T01:00:20.000Z",
    });

    const chosen = await createHarness({
      deviceTokenOutcomes: LOGIN_POLLS,
      organizations: [ALPHA, BETA],
      refreshedCredential: refreshed,
    });

    const named = await chosen.run(["login", "--organization", BETA.id, "--json"]);

    expect(named.exitCode, named.stdout).toBe(0);
    expect(parseDocument(named.stdout)).toMatchObject({
      command: "login",
      status: "authenticated",
      organization: { id: BETA.id, name: BETA.name },
    });
    const chosenSnapshot = await chosen.snapshot();
    expect(chosenSnapshot.refreshRequests).toEqual([
      { token: DEVICE_CREDENTIAL.refreshToken, workosOrganizationId: BETA.workos_id },
    ]);
    expect(chosenSnapshot.storedCredential).toMatchObject({ organizationId: BETA.id });

    const empty = await createHarness({
      deviceTokenOutcomes: LOGIN_POLLS,
      organizations: [],
    });

    const none = await empty.run(["login", "--json"]);

    expect(none.exitCode, none.stdout).toBe(0);
    expect(parseDocument(none.stdout)).toEqual({
      version: 1,
      command: "login",
      status: "authenticated",
      organization: null,
      profile: {
        name: "account",
        user_id: "user-a",
        organization_id: null,
        organization_name: null,
      },
      organizations: [],
      next_action:
        "Run 'OHMYHOST_ENVIRONMENT=development ohmyhost organization create --name NAME --idempotency-key KEY --profile-name account --json' to create the first workspace.",
    });
    expect((await empty.snapshot()).refreshRequests).toEqual([]);

    const foreign = await createHarness({
      deviceTokenOutcomes: LOGIN_POLLS,
      organizations: [ALPHA],
      refreshedCredential: refreshed,
    });

    const denied = await foreign.run(["login", "--organization", BETA.id, "--json"]);

    expect(denied.exitCode).toBe(2);
    expect(parseDocument(denied.stdout)).toMatchObject({
      command: "login",
      status: "error",
      error: { code: "organization_not_found", retryable: false },
    });
    const foreignSnapshot = await foreign.snapshot();
    expect(foreignSnapshot.refreshRequests).toEqual([]);
    // Nothing is saved before the requested organization is verified: a login for a workspace the
    // account does not belong to stores no credential and adds no saved login.
    expect(foreignSnapshot.storedCredential).toBeUndefined();
    expect(foreignSnapshot.profiles).toEqual([]);

    // A later refresh must keep the selection, or the workspace silently disappears again.
    const expiring = await createHarness({
      storedCredential: {
        ...CREDENTIAL,
        expiresAt: "2026-08-18T00:00:01.000Z",
        workosOrganizationId: ALPHA.workos_id,
        organizationId: ALPHA.id,
      },
      refreshedCredential: refreshed,
      organizations: [ALPHA],
    });

    const whoami = await expiring.run(["whoami", "--json"]);

    expect(whoami.exitCode, whoami.stdout).toBe(0);
    const expiringSnapshot = await expiring.snapshot();
    expect(expiringSnapshot.refreshRequests).toEqual([
      { token: CREDENTIAL.refreshToken, workosOrganizationId: ALPHA.workos_id },
    ]);
    expect(expiringSnapshot.storedCredential).toEqual({
      ...refreshed,
      workosOrganizationId: ALPHA.workos_id,
      organizationId: ALPHA.id,
    });
  });

  it("repairs a session that carries no workspace and names the next step when it cannot", async () => {
    // A session signed in before selection existed reports organization_ids: [] and sees an empty
    // project list, which reads like an empty account. whoami is where an agent looks first.
    const refreshed = {
      accessToken: "access-scoped-to-workspace",
      refreshToken: "refresh-scoped-to-workspace",
      expiresAt: "2026-08-18T02:00:00.000Z",
    };
    const single = await createHarness({
      storedCredential: CREDENTIAL,
      identityOrganizationIds: [],
      organizations: [ALPHA],
      refreshedCredential: refreshed,
    });

    const repaired = await single.run(["whoami", "--json"]);

    expect(repaired.exitCode, repaired.stdout).toBe(0);
    expect(parseDocument(repaired.stdout)).toEqual({
      version: 1,
      command: "whoami",
      status: "authenticated",
      identity: {
        actor_id: "user:user-a",
        email: "harness@example.test",
        organization_ids: [ALPHA.id],
        organizations: [{ id: ALPHA.id, name: ALPHA.name }],
      },
      organization: { id: ALPHA.id, name: ALPHA.name },
      selected: ALPHA.id,
      context: {
        credential: "profile",
        profile: {
          name: "harness",
          user_id: "user-a",
          organization_id: ALPHA.id,
          organization_name: ALPHA.name,
        },
      },
    });
    const singleSnapshot = await single.snapshot();
    expect(singleSnapshot.refreshRequests).toEqual([
      { token: CREDENTIAL.refreshToken, workosOrganizationId: ALPHA.workos_id },
    ]);
    expect(singleSnapshot.storedCredential).toEqual({
      ...refreshed,
      workosOrganizationId: ALPHA.workos_id,
      organizationId: ALPHA.id,
    });

    const several = await createHarness({
      storedCredential: CREDENTIAL,
      identityOrganizationIds: [],
      organizations: [ALPHA, BETA],
      refreshedCredential: refreshed,
    });

    const ambiguous = await several.run(["whoami", "--json"]);

    expect(ambiguous.exitCode, ambiguous.stdout).toBe(0);
    expect(parseDocument(ambiguous.stdout)).toEqual({
      version: 1,
      command: "whoami",
      status: "authenticated",
      identity: {
        actor_id: "user:user-a",
        email: "harness@example.test",
        organization_ids: [],
        organizations: [],
      },
      context: {
        credential: "profile",
        profile: {
          name: "harness",
          user_id: "user-a",
          organization_id: null,
          organization_name: null,
        },
      },
      organizations: [
        { id: ALPHA.id, name: ALPHA.name },
        { id: BETA.id, name: BETA.name },
      ],
      next_action:
        "Ask the customer which workspace to use, then run 'OHMYHOST_ENVIRONMENT=development ohmyhost organization use --organization ULID --profile-name harness --json'.",
    });
    expect((await several.snapshot()).refreshRequests).toEqual([]);

    const empty = await createHarness({
      storedCredential: CREDENTIAL,
      identityOrganizationIds: [],
      organizations: [],
    });

    const first = await empty.run(["whoami", "--json"]);

    expect(first.exitCode, first.stdout).toBe(0);
    expect(parseDocument(first.stdout)).toEqual({
      version: 1,
      command: "whoami",
      status: "authenticated",
      identity: {
        actor_id: "user:user-a",
        email: "harness@example.test",
        organization_ids: [],
        organizations: [],
      },
      context: {
        credential: "profile",
        profile: {
          name: "harness",
          user_id: "user-a",
          organization_id: null,
          organization_name: null,
        },
      },
      organizations: [],
      next_action:
        "Run 'OHMYHOST_ENVIRONMENT=development ohmyhost organization create --name NAME --idempotency-key KEY --profile-name harness --json' to create the first workspace.",
    });
  });

  it("derives the exact credential expiry from the WorkOS access-token JWT when expires_in is absent", async () => {
    const credential = {
      ...CREDENTIAL,
      accessToken: unsignedJwt({ exp: Date.parse("2026-08-18T00:30:05.000Z") / 1_000 }),
    };
    const harness = await createHarness({
      deviceTokenOutcomes: [credential],
      deviceTokenExpiresInSeconds: null,
    });

    const result = await harness.run(["login", "--json"]);

    expect(result.exitCode).toBe(0);
    expect((await harness.snapshot()).storedCredential).toEqual({
      ...credential,
      expiresAt: "2026-08-18T00:30:05.000Z",
    });
  });

  it.each([
    [
      "access_denied",
      "device_authorization_denied",
      false,
      "The customer declined the sign-in in the browser; nothing was saved. Ask the customer whether to sign in, then run the same login command again and send them the new link and code.",
    ],
    [
      "expired_token",
      "device_authorization_expired",
      false,
      "Nobody finished the sign-in within 30 minutes; nothing was saved. Run the same login command again and send the customer the new link and code at once.",
    ],
    [
      "invalid_grant",
      "device_authorization_failed",
      true,
      "The sign-in service answered unexpectedly; nothing was saved. Run the same login command again; if it fails twice more, ask the customer to try again later.",
    ],
  ] as const)("returns a stable login failure for %s", async (outcome, code, retryable, action) => {
    const harness = await createHarness({ deviceTokenOutcomes: [outcome] });

    const result = await harness.run(["login", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "login",
      status: "error",
      error: { code, retryable, suggested_action: action },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
  });

  it("rejects a Device Flow token response without a validated expiry", async () => {
    const harness = await createHarness({
      deviceTokenOutcomes: [CREDENTIAL],
      deviceTokenExpiresInSeconds: null,
    });

    const result = await harness.run(["login", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "login",
      status: "error",
      error: { code: "device_token_expiry_missing", retryable: false },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(CREDENTIAL.accessToken);
  });

  it.each([
    ["malformed JWT", "not-a-jwt"],
    ["invalid base64url", "e30.%.c2ln"],
    ["invalid header JSON", `${base64Url("{")}.${base64Url('{"exp":1787029205}')}.c2ln`],
    ["invalid JSON", `${base64Url("{}")}.${base64Url("{")}.${base64Url("signature")}`],
    ["missing exp", unsignedJwt({ sub: "user-a" })],
    ["non-safe exp", unsignedJwt({ exp: Number.MAX_SAFE_INTEGER + 1 })],
    ["non-future exp", unsignedJwt({ exp: Date.parse("2026-08-18T00:00:05.000Z") / 1_000 })],
  ])(
    "rejects a Device Flow token with %s when expires_in is absent",
    async (_case, accessToken) => {
      const harness = await createHarness({
        deviceTokenOutcomes: [{ ...CREDENTIAL, accessToken }],
        deviceTokenExpiresInSeconds: null,
      });

      const result = await harness.run(["login", "--json"]);

      expect(result.exitCode).toBe(4);
      expect(parseDocument(result.stdout)).toMatchObject({
        error: { code: "device_token_expiry_missing", retryable: false },
      });
      expect((await harness.snapshot()).storedCredential).toBeUndefined();
      expect(result.stdout + result.stderr).not.toContain(accessToken);
    },
  );

  it("rejects conflicting expires_in and JWT exp instead of choosing a longer lifetime", async () => {
    const accessToken = unsignedJwt({
      exp: Date.parse("2026-08-18T01:00:06.000Z") / 1_000,
    });
    const harness = await createHarness({
      deviceTokenOutcomes: [{ ...CREDENTIAL, accessToken }],
      deviceTokenExpiresInSeconds: 3_600,
    });

    const result = await harness.run(["login", "--json"]);

    expect(result.exitCode).toBe(4);
    expect(parseDocument(result.stdout)).toMatchObject({
      error: { code: "device_token_expiry_missing", retryable: false },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(accessToken);
  });

  it("routes project create only through the authenticated generated SDK", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run([
      "project",
      "create",
      "--organization",
      "org-a",
      "--name",
      "alpha",
      "--idempotency-key",
      "project-create-1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "project create",
      status: "accepted",
      operation: { id: expect.any(String), state: "queued" },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([
      {
        method: "POST",
        path: "/v1/projects",
        transport: "generated-sdk",
        headers: expect.objectContaining({
          Authorization: `Bearer ${CREDENTIAL.accessToken}`,
          "Idempotency-Key": "project-create-1",
        }),
        body: { organization_id: "org-a", name: "alpha" },
      },
    ]);
  });

  it("discovers the authenticated customer scope only through the generated SDK", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run(["whoami", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "whoami",
      status: "authenticated",
      identity: {
        actor_id: "user:user-a",
        organization_ids: ["00000000000000000000000001"],
      },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([
      {
        method: "GET",
        path: "/v1/me",
        transport: "generated-sdk",
        headers: expect.objectContaining({ Authorization: `Bearer ${CREDENTIAL.accessToken}` }),
      },
      {
        method: "GET",
        path: "/v1/organizations/00000000000000000000000001/github",
        transport: "generated-sdk",
        headers: expect.objectContaining({ Authorization: `Bearer ${CREDENTIAL.accessToken}` }),
      },
    ]);
  });

  it("discovers projects and project status only through authenticated generated SDK calls", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });
    const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVX";

    const listed = await harness.run(["project", "list", "--limit", "25", "--json"]);
    const status = await harness.run(["project", "status", "--project", projectId, "--json"]);

    expect(listed.exitCode).toBe(0);
    expect(parseDocument(listed.stdout)).toMatchObject({
      command: "project list",
      projects: { items: [{ id: projectId, name: "alpha", handle: "calm-otter-waves" }] },
    });
    expect(status.exitCode).toBe(0);
    expect(parseDocument(status.stdout)).toMatchObject({
      command: "project status",
      project: { project_id: projectId, lifecycle: "active" },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/v1/projects",
        transport: "generated-sdk",
      }),
      expect.objectContaining({
        method: "GET",
        path: `/v1/projects/${projectId}/status`,
        transport: "generated-sdk",
      }),
    ]);
  });

  it("routes the exact Cloudflare domain lifecycle through the generated SDK and operation waiter", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });
    const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVX";

    const authorization = await harness.run([
      "domain",
      "cloudflare",
      "authorize",
      "--project",
      projectId,
      "--zone",
      "aixyte.com",
      "--idempotency-key",
      "cloudflare-auth-a",
      "--json",
    ]);
    const status = await harness.run([
      "domain",
      "cloudflare",
      "status",
      "--project",
      projectId,
      "--json",
    ]);
    const applied = await harness.run([
      "domain",
      "cloudflare",
      "apply",
      "--project",
      projectId,
      "--idempotency-key",
      "domains-apply-a",
      "--yes",
      "--wait",
      "--json",
    ]);

    expect(parseDocument(authorization.stdout)).toMatchObject({
      command: "domain cloudflare authorize",
      status: "authorization_required",
      authorization: {
        authorization_url: expect.stringMatching(/^https:\/\/dash\.cloudflare\.com/u),
      },
    });
    expect(parseDocument(status.stdout)).toMatchObject({
      command: "domain cloudflare status",
      status: "authorized",
      cloudflare_dns: { zone: "aixyte.com", scopes: ["dns.write", "zone.read"] },
    });
    expect(parseDocument(applied.stdout)).toMatchObject({
      command: "domain cloudflare apply",
      status: "completed",
      operation: { state: "succeeded" },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([
      expect.objectContaining({
        method: "POST",
        path: `/v1/projects/${projectId}/cloudflare-dns/authorization`,
        headers: expect.objectContaining({ "Idempotency-Key": "cloudflare-auth-a" }),
        body: { zone: "aixyte.com" },
      }),
      expect.objectContaining({
        method: "GET",
        path: `/v1/projects/${projectId}/cloudflare-dns`,
      }),
      expect.objectContaining({
        method: "PUT",
        path: `/v1/projects/${projectId}/domains`,
        headers: expect.objectContaining({ "Idempotency-Key": "domains-apply-a" }),
      }),
      expect.objectContaining({ method: "GET", path: `/v1/operations/${OPERATION_ID}` }),
    ]);
  });

  it("returns self-contained help and version metadata without credentials or network", async () => {
    const harness = await createHarness();

    const help = await harness.run(["--help"]);
    const version = await harness.run(["--version"]);

    expect(help.exitCode).toBe(0);
    const helpDocument = parseDocument(help.stdout);
    expect(helpDocument).toMatchObject({
      version: 1,
      command: "help",
      status: "succeeded",
      usage: "ohmyhost <command> [options] [--profile-name NAME] --json",
    });
    const commands = helpDocument["commands"] as Array<{ command: string; usage: string }>;
    expect(commands).toHaveLength(157);
    expect(commands.some(({ command }) => command.startsWith("preview"))).toBe(false);
    expect(commands.map(({ command }) => command)).toEqual(
      expect.arrayContaining([
        "project preview get",
        "project preview open",
        "project preview stop",
        "project preview rotate",
      ]),
    );
    const exportGet = commands.find(({ command }) => command === "export get");
    expect(exportGet?.usage).toContain("never a download URL");
    expect(exportGet?.usage).toContain("export download-link");
    const preview = await harness.run(["preview", "list", "--json"]);
    expect(preview.exitCode).toBe(2);
    expect(commands.map(({ command }) => command)).toEqual([
      "init",
      "login",
      "logout",
      "whoami",
      "profile list",
      "connection begin",
      "connection list",
      "connection status",
      "connection discover",
      "connection import",
      "connection disconnect",
      "github connect",
      "github status",
      "github disconnect",
      "export create",
      "export get",
      "export download-link",
      "credits account",
      "referral link",
      "credits balance",
      "billing recharge get",
      "billing recharge set",
      "billing checkout",
      "billing status",
      "billing portal",
      "credits usage",
      "budget get",
      "budget set",
      "organization create",
      "organization list",
      "organization use",
      "organization mcp-connections list",
      "organization mcp-connections revoke",
      "operation get",
      "operation reconcile",
      "token create",
      "token list",
      "token revoke",
      "feedback status",
      "feedback submit",
      "project create",
      "project data plan",
      "project data change",
      "project list",
      "project context",
      "project notes set",
      "project status",
      "project dev add",
      "project preview get",
      "project preview open",
      "project preview stop",
      "project preview rotate",
      "project dev-access create",
      "project dev-share link",
      "project dev-share rotate",
      "project dev-share revoke",
      "project dev-access mode",
      "project flag status",
      "project flag set",
      "project handle check",
      "project handle set",
      "database compute set",
      "database compute get",
      "database write",
      "database query",
      "database access create",
      "database access list",
      "database access revoke",
      "database watch create",
      "database watch list",
      "database watch delete",
      "database table create",
      "database webhook create",
      "database webhook subscription activate",
      "database webhook subscription deactivate",
      "database webhook subscription status",
      "database webhook list",
      "database webhook get",
      "database webhook delete",
      "database webhook test",
      "database webhook deliveries",
      "database webhook replay",
      "database schedule set",
      "database schedule list",
      "database schedule get",
      "database schedule delete",
      "database schedule runs",
      "database schedule run",
      "database executions",
      "database psql",
      "link",
      "source auto-deploy set",
      "source auto-deploy status",
      "source inspect",
      "source status",
      "source files",
      "source file",
      "source versions",
      "source diff",
      "source upload",
      "source publish",
      "source publish complete",
      "source initialize",
      "source restore",
      "domain cloudflare authorize",
      "domain cloudflare status",
      "domain cloudflare apply",
      "domain paid plan",
      "domain paid apply",
      "domain paid status",
      "domain paid delete",
      "plan",
      "deploy",
      "logs",
      "deployment list",
      "deployment get",
      "deployment logs",
      "rollback plan",
      "rollback",
      "deployment promote plan",
      "deployment promote",
      "delete plan",
      "delete",
      "secret list",
      "function runs",
      "secret set",
      "auth",
      "secret delete",
      "mail workspace list",
      "mail workspace create",
      "mail workspace status",
      "mail workspace retire",
      "mail workspace dns-authorize",
      "mail workspace dns-revoke",
      "mail workspace dns-status",
      "mail binding get",
      "mail binding set",
      "mail binding detach",
      "mail identity get",
      "mail identity declare",
      "mail identity verify",
      "mail identity revoke",
      "mail identity authorize",
      "mail identity authorization-revoke",
      "mail identity authorization-status",
      "mail setup",
      "mail status",
      "mail webhook set",
      "mail webhook verify",
      "mail webhook disable",
      "mail webhook rotate",
      "mail messages list",
      "mail messages get",
      "mail messages retry",
      "mail domain set",
      "mail domain status",
      "mail domain delete",
    ]);
    expect(commands.every(({ usage }) => usage.includes("--json"))).toBe(true);
    const webhookCreateUsage = commands.find(
      ({ command }) => command === "database webhook create",
    )?.usage;
    expect(webhookCreateUsage).toContain("data.<topic>");
    expect(webhookCreateUsage).toContain("data.*");
    expect(webhookCreateUsage).toContain(
      "a bare * is not accepted and does not include data events",
    );
    expect(commands.find(({ command }) => command === "database watch create")?.usage).toContain(
      "data.<topic>",
    );
    const tableCreateUsage = commands.find(
      ({ command }) => command === "database table create",
    )?.usage;
    expect(tableCreateUsage).toContain("--columns-file PATH");
    expect(tableCreateUsage).toContain(
      "the table is created in the public schema as the migration role",
    );
    expect(tableCreateUsage).toContain("identical repeats answer created false");
    expect(tableCreateUsage).toContain("at most 100 tables, 64 columns");
    // The surface reference reads each usage only when it is a double-quoted string on the line after its label.
    const helpSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const helpBlock = helpSource.slice(
      helpSource.indexOf("const HELP_USAGE"),
      helpSource.indexOf("const HELP_COMMANDS"),
    );
    const labelLines = [...helpBlock.matchAll(/^ {2}"?([a-z][a-z0-9 -]*)"?:/gmu)];
    const doubleQuotedUsages = [
      ...helpBlock.matchAll(/^ {2}"?([a-z][a-z0-9 -]*)"?:\s*\n?\s*"((?:[^"\\]|\\.)*)"/gmu),
    ];
    expect(labelLines.length).toBe(commands.length);
    expect(doubleQuotedUsages.map((match) => match[1])).toEqual(
      labelLines.map((match) => match[1]),
    );
    for (const entry of commands) {
      const scopedHelp = await harness.run([...entry.command.split(" "), "--help", "--json"]);
      expect(scopedHelp.exitCode).toBe(0);
      expect(parseDocument(scopedHelp.stdout)).toMatchObject({
        command: "help",
        status: "succeeded",
        commands: [entry],
      });
    }
    const secretSetUsage = commands.find(({ command }) => command === "secret set")?.usage;
    expect(secretSetUsage).toBe(
      "printf '%s' \"$SECRET_VALUE\" | ohmyhost secret set NAME --project ULID --environment ENVIRONMENT_ULID --idempotency-key KEY [--profile-user USER_ID --profile-organization ULID | --token-user USER_ID --token-organization ULID] --stdin [--wait] --json (with --profile-user and --profile-organization the saved login that runs it must belong to that user and organization; with --token-user and --token-organization it runs only with an OHMYHOST_TOKEN of that user and organization, never with a saved login)",
    );
    expect(secretSetUsage).not.toMatch(/--(?:value|secret|token)(?:=|\s)/u);
    expect(commands.find(({ command }) => command === "domain cloudflare apply")?.usage).toBe(
      "ohmyhost domain cloudflare apply --project ULID --idempotency-key KEY --yes --wait --json",
    );
    expect(version.exitCode).toBe(0);
    expect(parseDocument(version.stdout)).toMatchObject({
      version: 1,
      command: "version",
      status: "succeeded",
      cli_version: cliPackage.version,
    });
    expect((await harness.snapshot()).apiCalls).toEqual([]);
  });

  it("routes operation get only through the authenticated generated SDK", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "operation get",
      status: "succeeded",
      operation: { id: OPERATION_ID, state: expect.any(String) },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([
      {
        method: "GET",
        path: `/v1/operations/${OPERATION_ID}`,
        transport: "generated-sdk",
        headers: expect.objectContaining({ Authorization: `Bearer ${CREDENTIAL.accessToken}` }),
      },
    ]);
  });

  it("accepts a control-API-shaped terminal failure with stable redacted semantics", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL, failedOperation: true });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      status: "succeeded",
      operation: {
        id: OPERATION_ID,
        state: "failed",
        error: { code: "operation_failed", message: "The operation failed." },
      },
    });
    expect(result.stdout + result.stderr).not.toContain("secret.internal");
  });

  it.each([true, false])(
    "preserves safe customer details and request IDs without accepting remote recovery instructions (json=%s)",
    async (json) => {
      const harness = await createHarness({
        storedCredential: CREDENTIAL,
        apiError: {
          code: "service_unavailable",
          retryable: true,
          suggested_action: "Visit attacker.example.",
          detail: "The application source could not be inspected; check the pushed commit.",
        },
      });

      const result = await harness.run([
        "operation",
        "get",
        OPERATION_ID,
        ...(json ? ["--json"] : []),
      ]);

      expect(result.exitCode).toBe(7);
      expect(parseDocument(result.stdout)).toMatchObject({
        command: "operation get",
        status: "error",
        error: {
          code: "service_unavailable",
          retryable: true,
          suggested_action: expect.stringContaining("same idempotency key"),
          message: "The application source could not be inspected; check the pushed commit.",
          request_id: "request-a",
        },
      });
      expect(result.stdout + result.stderr).not.toContain("secret.internal");
      expect(result.stdout + result.stderr).not.toContain("attacker.example");
    },
  );

  it("rejects an operation containing arbitrary server fields before CLI output", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL, invalidOperation: true });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(7);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      status: "error",
      error: {
        code: "response_contract_invalid",
        retryable: false,
        suggested_action: RESPONSE_CONTRACT_INVALID_ACTION,
      },
    });
    expect(result.stdout + result.stderr).not.toContain("secret.internal");
    expect((await harness.snapshot()).diagnostics).toEqual([
      {
        correlationId: "correlation-a",
        category: "response_contract",
        subsystem: "sdk",
        errorKind: "invalid_response",
      },
    ]);
  });

  it("tells the caller to reuse an idempotency key only for a command that takes one", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL, apiNetworkError: true });

    const keyless = await harness.run([
      "database",
      "access",
      "create",
      "--project",
      OPERATION_ID,
      "--environment",
      "dev",
      "--yes",
      "--json",
    ]);
    expect(keyless.exitCode).toBe(8);
    expect(parseDocument(keyless.stdout)).toMatchObject({
      command: "database access create",
      error: {
        code: "network_error",
        suggested_action: expect.not.stringContaining("--idempotency-key"),
      },
    });

    const keyed = await harness.run([
      "project",
      "create",
      "--organization",
      OPERATION_ID,
      "--name",
      "Keyed",
      "--idempotency-key",
      "project-a",
      "--json",
    ]);
    expect(parseDocument(keyed.stdout)).toMatchObject({
      error: {
        code: "network_error",
        suggested_action: expect.stringContaining("with the same --idempotency-key"),
      },
    });
  });

  it("refuses an unknown help topic with exit 2", async () => {
    const harness = await createHarness({});

    const result = await harness.run(["help", "nosuchgroup", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(parseDocument(result.stdout)).toMatchObject({ error: { code: "invalid_command" } });
  });

  it("classifies network failures with redacted diagnostics and correlation", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL, apiNetworkError: true });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(8);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      error: {
        code: "network_error",
        retryable: true,
        suggested_action:
          "The request did not reach the ohmyho.st API, or its answer was cut off. If the agent runs in a sandbox without network access, run the command with network access. Otherwise run the same command again; this command has no idempotency key, so check its current state first if it may have changed anything.",
      },
    });
    expect(result.stdout + result.stderr).not.toContain("secret.internal");
    expect((await harness.snapshot()).diagnostics).toEqual([
      {
        correlationId: "correlation-a",
        category: "network",
        subsystem: "sdk",
        errorKind: "network_transport",
      },
    ]);
  });

  it("maps an unknown TypeError to non-retryable internal_error without raw detail", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      apiProgrammingError: true,
    });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      error: {
        code: "internal_error",
        retryable: false,
        suggested_action:
          "The ohmyhost client stopped on an unexpected error; the stderr line starting with [ohmyhost: identifies it. Compare 'ohmyhost --version' with https://ohmyho.st/client-release.json and install the published client if it is older, then run the same command again; this command has no idempotency key, so check its current state first if it may have changed anything. If the current client fails the same way, report it with feedback submit (kind bug, error code internal_error) and quote that stderr line.",
      },
    });
    expect(result.stdout + result.stderr).not.toContain("secret.internal");
    expect((await harness.snapshot()).diagnostics).toEqual([
      {
        correlationId: "correlation-a",
        category: "internal",
        subsystem: "runtime",
        errorKind: "unexpected",
      },
    ]);
  });

  it.each(["AbortError", "TimeoutError", "ProjectCreateContractUnavailableError"])(
    "rejects remote JSON name spoof %s as an invalid response contract",
    async (name) => {
      const harness = await createHarness({
        storedCredential: CREDENTIAL,
        apiSpoofedErrorName: name,
      });

      const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

      expect(result.exitCode).toBe(7);
      expect(parseDocument(result.stdout)).toMatchObject({
        command: "operation get",
        error: { code: "response_contract_invalid", retryable: false },
      });
      expect((await harness.snapshot()).diagnostics).toEqual([
        {
          correlationId: "correlation-a",
          category: "response_contract",
          subsystem: "sdk",
          errorKind: "invalid_response",
        },
      ]);
    },
  );

  it("returns an actionable authentication error before any product API call", async () => {
    const harness = await createHarness();

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(5);
    expect(parseDocument(result.stdout)).toMatchObject({
      status: "error",
      error: {
        code: "authentication_required",
        retryable: false,
        suggested_action: "Run 'OHMYHOST_ENVIRONMENT=development ohmyhost login --json'.",
      },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["expired", "2026-08-17T23:59:59.000Z"],
  ] as const)("fails closed when refresh of a %s expiry fails", async (_label, expiresAt) => {
    const harness = await createHarness({
      storedCredential: {
        accessToken: CREDENTIAL.accessToken,
        refreshToken: CREDENTIAL.refreshToken,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(5);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      status: "error",
      error: {
        code: "token_refresh_failed",
        retryable: true,
        suggested_action:
          "Renewing the saved login harness at the sign-in service failed. Run the same command again in a minute, with the same --idempotency-key if it has one. If it fails again, run 'OHMYHOST_ENVIRONMENT=development ohmyhost login --user user-a --profile-name harness --json' and send the customer the link and code.",
      },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain(CREDENTIAL.accessToken);
  });

  it("rotates an expired credential through the public-client refresh port before SDK use", async () => {
    const refreshedCredential = {
      accessToken: "access-token-b",
      refreshToken: "refresh-token-b",
      expiresAt: "2026-08-18T02:00:00.000Z",
    };
    const harness = await createHarness({
      storedCredential: { ...CREDENTIAL, expiresAt: "2026-08-17T23:59:59.000Z" },
      refreshedCredential,
    });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    const snapshot = await harness.snapshot();
    expect(snapshot.refreshRequests).toEqual([{ token: CREDENTIAL.refreshToken }]);
    expect(snapshot.credentialReplaceCount).toBe(1);
    expect(snapshot.storedCredential).toEqual(refreshedCredential);
    expect(snapshot.apiCalls).toEqual([
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${refreshedCredential.accessToken}`,
        }),
      }),
    ]);
    expect(result.stdout + result.stderr).not.toContain(refreshedCredential.accessToken);
  });

  it("does not rewrite a valid credential for a read-only authenticated command", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(0);
    const snapshot = await harness.snapshot();
    expect(snapshot.refreshRequests).toEqual([]);
    expect(snapshot.credentialReplaceCount).toBe(0);
    expect(snapshot.storedCredential).toEqual(CREDENTIAL);
  });

  it("blocks expired-token use non-retryably until a real refresh adapter is verified", async () => {
    const harness = await createHarness({
      storedCredential: { ...CREDENTIAL, expiresAt: "2026-08-17T23:59:59.000Z" },
      refreshError: new ProviderCapabilityBlockedError(),
    });

    const result = await harness.run(["operation", "get", OPERATION_ID, "--json"]);

    expect(result.exitCode).toBe(9);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "operation get",
      error: { code: "blocked_prerequisite", retryable: false },
    });
    expect((await harness.snapshot()).apiCalls).toEqual([]);
  });

  it("removes only the local credential on plain logout", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run(["logout", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(parseDocument(result.stdout)).toMatchObject({
      version: 1,
      command: "logout",
      status: "logged_out",
    });
    expect(await harness.snapshot()).toMatchObject({
      revokeRequests: [],
      apiCalls: [],
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
  });

  it("clears the local credential and reports a remote revocation failure", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      revokeError: new LifecycleTransportError(),
    });

    const result = await harness.run(["logout", "--revoke", "--json"]);

    expect(result.exitCode).toBe(6);
    expect(parseDocument(result.stdout)).toMatchObject({
      status: "error",
      error: {
        code: "token_revocation_failed",
        retryable: false,
        suggested_action: LOGOUT_UNCONFIRMED_ACTION,
      },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout).not.toContain(CREDENTIAL.accessToken);
    expect(result.stderr).not.toContain(CREDENTIAL.refreshToken);
  });

  it("does not misclassify an unknown lifecycle programming error as retryable transport", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      revokeError: new TypeError("programming detail secret.internal"),
    });

    const result = await harness.run(["logout", "--revoke", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "logout",
      error: { code: "internal_error", retryable: false },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain("secret.internal");
  });

  it("performs bounded remote revocation only when explicitly requested", async () => {
    const harness = await createHarness({ storedCredential: CREDENTIAL });

    const result = await harness.run(["--revoke", "logout", "--json"]);

    expect(result.exitCode).toBe(0);
    const snapshot = await harness.snapshot();
    expect(snapshot).toMatchObject({
      revokeRequests: [{ token: CREDENTIAL.refreshToken }],
    });
    expect(snapshot.storedCredential).toBeUndefined();
  });

  it("supports explicit logout --revoke with the same fail-closed cleanup", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      revokeError: new LifecycleTransportError(),
    });

    const result = await harness.run(["logout", "--revoke", "--json"]);

    expect(result.exitCode).toBe(6);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "logout",
      status: "error",
      error: { code: "token_revocation_failed", retryable: false },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(CREDENTIAL.refreshToken);
  });

  it("bounds remote revocation and still clears local credentials on timeout", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      revokeNeverSettles: true,
      lifecycleTimeoutMs: 5,
    });

    const result = await harness.run(["logout", "--revoke", "--json"]);

    expect(result.exitCode).toBe(8);
    expect(parseDocument(result.stdout)).toMatchObject({
      error: {
        code: "request_timeout",
        retryable: false,
        suggested_action: LOGOUT_UNCONFIRMED_ACTION,
      },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain(CREDENTIAL.refreshToken);
  });

  it("reports unverified provider lifecycle capability as a non-retryable release blocker", async () => {
    const harness = await createHarness({
      storedCredential: CREDENTIAL,
      revokeError: new ProviderCapabilityBlockedError(),
    });

    const result = await harness.run(["logout", "--revoke", "--json"]);

    expect(result.exitCode).toBe(9);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "logout",
      error: { code: "blocked_prerequisite", retryable: false },
    });
    expect((await harness.snapshot()).storedCredential).toBeUndefined();
  });

  it("returns a stable cancellation after presenting Device Flow instructions", async () => {
    const harness = await createHarness({ deviceTokenOutcomes: [CREDENTIAL] });
    const controller = new AbortController();

    const pending = harness.run(["login", "--json"], controller.signal);
    controller.abort();
    const result = await pending;

    expect(result.exitCode).toBe(130);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "login",
      status: "error",
      error: {
        code: "command_cancelled",
        retryable: true,
        suggested_action:
          "The command was stopped by an interrupt or termination signal, for example the shell's command timeout, before it finished; run the same command again; this command has no idempotency key, so check its current state first if it may have changed anything. Give login and commands with --wait or --follow several minutes, or run them in the background.",
      },
    });
    const snapshot = await harness.snapshot();
    expect(snapshot.presentedAuthorizations).toEqual([
      expect.objectContaining({ userCode: "ABCD-EFGH" }),
    ]);
    expect(snapshot.tokenPollRequests).toEqual([]);
    expect(snapshot.storedCredential).toBeUndefined();
  });

  it("rejects token-shaped argv instead of accepting secrets on the command line", async () => {
    const harness = await createHarness();

    const result = await harness.run(["login", "--token", "secret-value", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(parseDocument(result.stdout)).toMatchObject({
      command: "login",
      status: "error",
      error: { code: "invalid_command", retryable: false },
    });
    expect(result.stdout + result.stderr).not.toContain("secret-value");
    expect(await harness.snapshot()).toMatchObject({
      deviceAuthorizationRequests: [],
      tokenPollRequests: [],
      apiCalls: [],
    });
  });

  it("never reflects an arbitrary command token into the output label", async () => {
    const harness = await createHarness();

    const result = await harness.run(["attacker-secret-command", "--json"]);

    expect(parseDocument(result.stdout)).toMatchObject({
      command: "unknown",
      error: {
        code: "invalid_command",
        suggested_action:
          "Unknown command; nothing was sent. 'ohmyhost --help --json' lists every command with its flags. If a documented command is missing, this CLI is older than https://ohmyho.st/client-release.json: install the published version.",
      },
    });
    expect(result.stdout + result.stderr).not.toContain("attacker-secret-command");
  });

  it.each([
    [
      "names the usage of a recognized command without echoing its arguments",
      ["project", "context", "--project", "not-a-secret-but-invalid", "--bogus", "value"],
      "The arguments of 'project context' are invalid or incomplete; nothing was sent. Usage: ohmyhost project context --project ULID --json.",
    ],
    [
      "explains when --project may be left out",
      ["project", "status", "--json"],
      "The arguments of 'project status' are invalid or incomplete; nothing was sent. Usage: ohmyhost project status --project ULID --json. --project may be omitted only inside a directory linked with 'OHMYHOST_ENVIRONMENT=development ohmyhost link' for this OHMYHOST_ENVIRONMENT; otherwise pass --project ULID.",
    ],
  ])("%s", async (_label, argv, action) => {
    const harness = await createHarness();

    const result = await harness.run(argv);

    expect(result.exitCode).toBe(2);
    expect(parseDocument(result.stdout)).toMatchObject({
      status: "error",
      error: { code: "invalid_command", retryable: false, suggested_action: action },
    });
    expect(result.stdout).not.toContain("not-a-secret-but-invalid");
    expect((await harness.snapshot()).apiCalls).toEqual([]);
  });
});

async function createHarness(options?: ProductCliHarnessOptions): Promise<ProductCliTestHarness> {
  return (await loadProductCliHarness())(options);
}

function parseDocument(output: string): Record<string, unknown> {
  expect(output.endsWith("\n")).toBe(true);
  const lines = output.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}
