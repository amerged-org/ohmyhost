import { expect, test } from "vitest";
import { reconcileConnections, type MaintenanceCore } from "../src/maintenance.js";
import { makeRegistration } from "../src/registry.js";
import { sealGrantTokens } from "../src/grant-vault.js";
const hex = (s: string) =>
  Array.from(atob(s), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
test("maintenance revokes only after a durable claim and never replays an uncertain dispatch", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32)),
    registration = makeRegistration("development"),
    grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    attemptId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
  const encrypted = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: registration.registration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "a", refreshToken: "r" },
    key,
  );
  let activeRegistration = registration.registration,
    activeEncrypted = encrypted,
    claimed = false,
    marked = false,
    calls = 0,
    outcome = "";
  const core: MaintenanceCore = {
    async listExpiredConnectionGrants() {
      return [];
    },
    async claimExpiredConnectionGrant() {
      return false;
    },
    async listDisconnectingConnectionGrants() {
      return [];
    },
    async readConnectionGrantForRevocation() {
      return null;
    },
    async claimConnectionRevocation() {
      return false;
    },
    async markConnectionRevocationDispatched() {
      return false;
    },
    async finishConnectionDisconnect() {
      return false;
    },
    async listConnectionOrphans() {
      return [attemptId];
    },
    async readConnectionOrphan() {
      return {
        attemptId,
        grantId,
        organizationId: "org",
        principalId: "human",
        registration: activeRegistration,
        generation: 1,
        encryptedTokens: {
          nonce: hex(activeEncrypted.nonce),
          ciphertext: hex(activeEncrypted.ciphertext),
          keyVersion: 1,
        },
      };
    },
    async claimConnectionOrphanRevocation() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    async markConnectionOrphanRevocationDispatched() {
      marked = true;
      return true;
    },
    async finishConnectionOrphanRevocation(input) {
      outcome = input.outcome;
      return true;
    },
    async listConnectionRefreshOrphans() {
      return [];
    },
    async readConnectionRefreshOrphan() {
      return null;
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
      expect(marked).toBe(true);
      calls++;
      throw Error();
    },
  };
  const deps = {
    environment: "development" as const,
    registration,
    client: { clientId: "id", clientSecret: "secret" },
    key,
    core,
    adapter,
  };
  await reconcileConnections(deps);
  await reconcileConnections(deps);
  expect(calls).toBe(1);
  expect(outcome).toBe("outcome_unknown");
  activeRegistration = "make-development-1";
  activeEncrypted = await sealGrantTokens(
    {
      environment: "development",
      workspace: "org",
      human: "human",
      provider: "make",
      registration: activeRegistration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "a", refreshToken: "r" },
    key,
  );
  claimed = false;
  marked = false;
  await reconcileConnections(deps);
  expect(calls).toBe(2);
  expect(outcome).toBe("outcome_unknown");
  activeRegistration = "make-production-1";
  claimed = false;
  marked = false;
  await reconcileConnections(deps);
  expect(calls).toBe(2);
  expect(marked).toBe(false);
});
