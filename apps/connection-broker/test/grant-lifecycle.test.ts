function mustFixtureValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
import { expect, test } from "vitest";
import { nextRefreshToken, refreshGrant, type GrantLifecycleCore } from "../src/grant-lifecycle.js";
import { sealGrantTokens, openGrantTokens } from "../src/grant-vault.js";
import { makeRegistration } from "../src/registry.js";
const hex = (s: string) =>
  Array.from(atob(s), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const b64 = (s: string) =>
  btoa(
    String.fromCharCode(
      ...Uint8Array.from(mustFixtureValue(s.match(/../g)), (x) => parseInt(x, 16)),
    ),
  );
test("refresh claims one generation, keeps omitted replacement and reads back a lost commit", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32)),
    registration = makeRegistration("development"),
    grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const identity = {
    environment: "development",
    workspace: "org",
    human: "human",
    provider: "make",
    registration: "make-development-1",
    grantId,
    generation: 1,
    keyVersion: "1",
  };
  const sealed = await sealGrantTokens(
    identity,
    { accessToken: "old", refreshToken: "refresh" },
    key,
  );
  let claimed = false,
    providerCalls = 0,
    attempts = 0,
    committed:
      | {
          nonce: string;
          ciphertext: string;
          keyVersion: number;
        }
      | undefined;
  const core: GrantLifecycleCore = {
    async claimConnectionRefresh({ claimId }) {
      if (claimed) return null;
      claimed = true;
      return {
        grantId,
        claimId,
        generation: 1,
        organizationId: "org",
        projectId: "p",
        environmentId: "e",
        principalId: "human",
        registration: "make-development-1",
        encryptedTokens: {
          nonce: hex(sealed.nonce),
          ciphertext: hex(sealed.ciphertext),
          keyVersion: 1,
        },
      };
    },
    async markConnectionRefreshDispatched() {
      return true;
    },
    async commitConnectionRefresh(input) {
      attempts++;
      committed = input.encryptedTokens;
      if (attempts === 1) throw new Error("lost");
      return true;
    },
    async retainConnectionRefreshOrphan() {
      return "retained";
    },
    async claimConnectionRefreshOrphanRevocation() {
      return true;
    },
    async markConnectionRefreshOrphanRevocationDispatched() {
      return true;
    },
    async finishConnectionRefreshOrphanRevocation() {
      return true;
    },
    async failConnectionRefresh() {
      return true;
    },
    async disconnectConnectionGrant() {
      return true;
    },
    async readConnectionGrantStatus() {
      return null;
    },
    async readConnectionGrantForRevocation() {
      return null;
    },
    async claimConnectionRevocation() {
      return true;
    },
    async markConnectionRevocationDispatched() {
      return true;
    },
    async finishConnectionDisconnect() {
      return true;
    },
  };
  const adapter = {
    async authorizationUrl() {
      throw Error();
    },
    async exchange() {
      throw Error();
    },
    async verifyIdentity() {
      throw Error();
    },
    async revoke() {
      throw Error();
    },
    async refresh() {
      providerCalls++;
      return { accessToken: "new", expiresIn: 300 };
    },
  };
  expect(
    await refreshGrant(grantId, {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core,
      adapter,
    }),
  ).toBe("refreshed");
  expect(providerCalls).toBe(1);
  expect(attempts).toBe(2);
  expect(
    (
      await openGrantTokens(
        { ...identity, generation: 2 },
        {
          nonce: b64(mustFixtureValue(committed).nonce),
          ciphertext: b64(mustFixtureValue(committed).ciphertext),
        },
        key,
      )
    ).refreshToken,
  ).toBe("refresh");
  let failure: string | undefined;
  const retryCore = {
    ...core,
    async claimConnectionRefresh({ claimId }: { claimId: string }) {
      return {
        grantId,
        claimId,
        generation: 1,
        organizationId: "org",
        projectId: "p",
        environmentId: "e",
        principalId: "human",
        registration: "make-development-1",
        encryptedTokens: {
          nonce: hex(sealed.nonce),
          ciphertext: hex(sealed.ciphertext),
          keyVersion: 1,
        },
      };
    },
    async failConnectionRefresh(input: { outcome: string }) {
      failure = input.outcome;
      return true;
    },
  };
  expect(
    await refreshGrant(grantId, {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core: retryCore,
      adapter: {
        ...adapter,
        async refresh() {
          throw new Error("provider_rate_limited");
        },
      },
    }),
  ).toBe("in_progress");
  expect(failure).toBe("rate_limited");
  expect(nextRefreshToken("old", "new")).toBe("new");
  expect(
    await refreshGrant(grantId, {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core,
      adapter,
    }),
  ).toBe("in_progress");
});
test("a rotated token cannot reactivate a disconnected grant and enters fenced revocation custody", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32)),
    registration = makeRegistration("development"),
    grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
  const identity = {
    environment: "development",
    workspace: "org",
    human: "human",
    provider: "make",
    registration: registration.registration,
    grantId,
    generation: 1,
    keyVersion: "1",
  };
  const sealed = await sealGrantTokens(
    identity,
    { accessToken: "old", refreshToken: "old-refresh" },
    key,
  );
  let retained = false,
    marked = false,
    revoked = 0,
    failed = false;
  const core: GrantLifecycleCore = {
    async claimConnectionRefresh({ claimId }) {
      return {
        grantId,
        claimId,
        generation: 1,
        organizationId: "org",
        projectId: "p",
        environmentId: "e",
        principalId: "human",
        registration: registration.registration,
        encryptedTokens: {
          nonce: hex(sealed.nonce),
          ciphertext: hex(sealed.ciphertext),
          keyVersion: 1,
        },
      };
    },
    async markConnectionRefreshDispatched() {
      return true;
    },
    async commitConnectionRefresh() {
      return false;
    },
    async retainConnectionRefreshOrphan(input) {
      retained = true;
      expect(
        (
          await openGrantTokens(
            { ...identity, generation: 2 },
            {
              nonce: b64(input.encryptedTokens.nonce),
              ciphertext: b64(input.encryptedTokens.ciphertext),
            },
            key,
          )
        ).refreshToken,
      ).toBe("rotated");
      return "retained";
    },
    async claimConnectionRefreshOrphanRevocation() {
      return true;
    },
    async markConnectionRefreshOrphanRevocationDispatched() {
      marked = true;
      return true;
    },
    async finishConnectionRefreshOrphanRevocation(input) {
      expect(input.outcome).toBe("outcome_unknown");
      return true;
    },
    async failConnectionRefresh() {
      failed = true;
      return false;
    },
    async disconnectConnectionGrant() {
      return true;
    },
    async readConnectionGrantStatus() {
      return null;
    },
    async readConnectionGrantForRevocation() {
      return null;
    },
    async claimConnectionRevocation() {
      return true;
    },
    async markConnectionRevocationDispatched() {
      return true;
    },
    async finishConnectionDisconnect() {
      return true;
    },
  };
  const adapter = {
    async authorizationUrl() {
      throw Error();
    },
    async exchange() {
      throw Error();
    },
    async verifyIdentity() {
      throw Error();
    },
    async refresh() {
      return { accessToken: "new", refreshToken: "rotated", expiresIn: 300 };
    },
    async revoke() {
      revoked++;
      throw Error();
    },
  };
  expect(
    await refreshGrant(grantId, {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core,
      adapter,
    }),
  ).toBe("reconnect_required");
  expect({ retained, marked, revoked, failed }).toEqual({
    retained: true,
    marked: true,
    revoked: 1,
    failed: true,
  });
  const events: string[] = [];
  expect(
    await refreshGrant(grantId, {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core: {
        ...core,
        async retainConnectionRefreshOrphan() {
          throw Error("unavailable");
        },
        async failConnectionRefresh() {
          events.push("fenced");
          return true;
        },
      },
      adapter: {
        ...adapter,
        async revoke() {
          events.push("revoked");
        },
      },
    }),
  ).toBe("reconnect_required");
  expect(events).toEqual(["fenced", "revoked"]);
});

test("disconnect fences locally before its one revocation dispatch and reports unresolved outcomes", async () => {
  const { disconnectGrant } = await import("../src/grant-lifecycle.js");
  const key = crypto.getRandomValues(new Uint8Array(32)),
    registration = makeRegistration("development"),
    grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    events: string[] = [];
  const sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: "make-development-1",
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "a", refreshToken: "r" },
    key,
  );
  const core: GrantLifecycleCore = {
    async disconnectConnectionGrant() {
      events.push("fence");
      return true;
    },
    async readConnectionGrantStatus() {
      return { state: "disconnecting" };
    },
    async readConnectionGrantForRevocation() {
      return {
        grantId,
        generation: 1,
        organizationId: "org",
        projectId: "p",
        environmentId: "e",
        principalId: "human",
        registration: "make-development-1",
        revocationStatus: "pending",
        encryptedTokens: {
          nonce: hex(sealed.nonce),
          ciphertext: hex(sealed.ciphertext),
          keyVersion: 1,
        },
      };
    },
    async claimConnectionRevocation() {
      events.push("claim");
      return true;
    },
    async markConnectionRevocationDispatched() {
      events.push("dispatch");
      return true;
    },
    async finishConnectionDisconnect(input) {
      events.push(input.outcome);
      return true;
    },
    async claimConnectionRefresh() {
      return null;
    },
    async markConnectionRefreshDispatched() {
      return false;
    },
    async commitConnectionRefresh() {
      return false;
    },
    async retainConnectionRefreshOrphan() {
      return "conflict";
    },
    async claimConnectionRefreshOrphanRevocation() {
      return false;
    },
    async markConnectionRefreshOrphanRevocationDispatched() {
      return false;
    },
    async finishConnectionRefreshOrphanRevocation() {
      return false;
    },
    async failConnectionRefresh() {
      return false;
    },
  };
  const adapter = {
    async authorizationUrl() {
      throw Error();
    },
    async exchange() {
      throw Error();
    },
    async verifyIdentity() {
      throw Error();
    },
    async refresh() {
      throw Error();
    },
    async revoke() {
      events.push("revoke");
      throw Error();
    },
  };
  const result = await disconnectGrant(
    {
      organizationId: "org",
      principalId: "human",
      grantId,
      idempotencyKey: "key",
      mutationAuthority: {
        kind: "api_key",
        keyId: "key",
        userId: "user",
        workosOrganizationId: "org",
      },
    },
    {
      environment: "development",
      registration,
      client: { clientId: "id", clientSecret: "secret" },
      key,
      core,
      adapter,
    },
  );
  expect(result).toBe("revocation_pending");
  expect(events).toEqual(["fence", "claim", "dispatch", "revoke", "outcome_unknown"]);
});
