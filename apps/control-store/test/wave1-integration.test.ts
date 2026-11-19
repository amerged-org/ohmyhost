import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createControlStore } from "../src/store.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";

const state = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = state.env;
  },
}));

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
  state.env = control.bindings;
});
afterAll(async () => control.dispose());

// Explicit W37 store inventory; each private executor receives only its dedicated RPC surface.
const NATIVE_IDENTITY = [
  "acceptNativeAuthUserMutation",
  "acceptNativeRestoreJob",
  "ackDomainPolicySync",
  "acknowledgeNativeRestoreJob",
  "assertNativeRestoreImportAllowed",
  "authorizeAcceptedNativeAuthUserMutation",
  "authorizeNativeAuthDeletion",
  "authorizeNativeAuthDeletionQuiescence",
  "authorizeNativeAuthOwner",
  "authorizeNativeAuthOwnerOperation",
  "authorizeNativeAuthRegistration",
  "authorizeNativeAuthRegistrationRevocation",
  "authorizeNativeMail",
  "authorizeNativeRestoreAdmission",
  "beginHandleDomainRecovery",
  "beginNativeAuthDatabaseOperation",
  "beginNativeAuthProjectDeletion",
  "beginNativeAuthRoleOperation",
  "beginNativeRestoreJob",
  "beginPaidDomainRecovery",
  "claimNativeProviderHandoff",
  "claimNativeRestoreJob",
  "completeHandleDomainRecovery",
  "completeNativeProviderHandoff",
  "completeNativeRestorePinReconciliation",
  "completePaidDomainRecovery",
  "confirmNativeAuthRegistration",
  "consumeNativeRestoreJobInput",
  "fenceNativeAuthRegistrationRevocation",
  "finishNativeAuthProjectDeletion",
  "finishNativeRestoreJob",
  "initializeNativeAuthRealm",
  "isNativeRestoreAcknowledged",
  "isNativeRestoreRealmImported",
  "markNativeRestoreRealmImported",
  "observeNativeRestoreJob",
  "readDomainPolicySync",
  "proveNativeAuthUnprovisionedPolicy",
  "readNativeAuthConfig",
  "readNativeAuthDatabaseEnvironments",
  "readNativeAuthDatabaseReconciliation",
  "readNativeAuthPreviewReconciliation",
  "readNativeAuthProjectDeletion",
  "readNativeAuthProvider",
  "readNativeAuthProviderEnvelope",
  "readNativeAuthProvisioningPolicy",
  "readNativeAuthReadiness",
  "readNativeAuthRegistration",
  "readNativeAuthRestorePreparation",
  "readNativeAuthTarget",
  "readNativeProviderHandoffState",
  "readNativeRestoreForSanitization",
  "readNativeRestoreJobClaim",
  "readNativeRestoreJobInput",
  "readNativeRestorePinReconciliation",
  "recordNativeAuthDatabaseObservation",
  "recordNativeAuthDeletionPurge",
  "recordNativeAuthDeletionQuiescence",
  "recordNativeAuthPreparation",
  "recordNativeAuthProjectDeletionObservation",
  "recordNativeAuthProviderSuccess",
  "recordNativeAuthRestoreVerification",
  "recordNativeAuthRoleObservation",
  "recordNativeRestorePin",
  "recordNativeRestorePinAbsent",
  "reserveNativeAuthDatabaseOperation",
  "reserveNativeAuthRegistration",
  "reserveNativeAuthRoleOperation",
  "reserveNativeRestorePin",
  "resolveNativeAuthAdminAuthority",
  "resolveNativeAuthAtomicSnapshot",
  "resolveNativeAuthAuthority",
  "resolveNativeAuthDatabaseClaim",
  "resolveNativeAuthProviderPolicy",
  "resolveNativeAuthRegistrationGeneration",
  "updateNativeAuthConfig",
  "updateNativeAuthProvider",
];
// The public Owner API reaches these reviewed commands through its private Control binding.
const NATIVE_CONTROL_EXPOSED = [
  "authorizeNativeAuthOwner",
  "proveNativeAuthUnprovisionedPolicy",
  "readNativeAuthConfig",
  "updateNativeAuthConfig",
  "readNativeAuthProvider",
  "updateNativeAuthProvider",
  "readNativeAuthReadiness",
  "acceptNativeUserOperation",
];
const IDENTITY = [
  "readCreditWarningScope",
  "isCreditWarningOwner",
  "isSignupFeedbackClaim",
  "prepareWorkosOnboarding",
  "claimWorkosOnboardingOrganization",
  "recordWorkosOnboardingOrganization",
  "claimWorkosOnboardingMembership",
  "completeWorkosOnboarding",

  "claimWorkosInboxEvent",
  "findExpiredFinalWorkosInboxClaim",
  "recordWorkosInboxFailure",
  "recoverExpiredFinalWorkosInboxLease",
  "applyPolledWorkosSnapshot",
  "applyWorkosOrganizationDeletion",
  "revokeLocalAuthorizationForUncertainSnapshot",
  "applyOrganizationSnapshot",
  "assertOperationDelegationCurrent",
  "recordMembershipBarrier",
  "recordTerminalRevocation",
  "isSessionEligible",
  "authorizeUserApiKeyScope",
  "claimUserApiKeyCreation",
  "finishUserApiKeyCreation",
  "readUserApiKeyNames",
  "readSessionRevocation",
  "recordUserApiKeyRevocationAudit",
  "insertMcpHandoff",
  "findMcpHandoff",
  "consumeMcpHandoff",
  "completeMcpSecret",
  "completeMcpGithub",
  "ensureMcpConnectionProof",
  "revokeMcpConsent",
  "listOrganizationMcpConnections",
  "revokeOrganizationMcpConnection",
];
// The eight identity commands the WorkOS management Worker calls through ControlRuntime (user API key
// lifecycle, session revocation and eligibility); the rest of the identity group stays in-process.
const WORKOS_EXPOSED = [
  "authorizeUserApiKeyScope",
  "claimUserApiKeyCreation",
  "finishUserApiKeyCreation",
  "readUserApiKeyNames",
  "recordTerminalRevocation",
  "isSessionEligible",
  "readSessionRevocation",
  "recordUserApiKeyRevocationAudit",
];
// The API composition exposes closed feature handoffs and connection evidence/revocation.
// The removed user-selected grant control plane is never restored for compatibility.
const MCP_EXPOSED = [
  "readNativeProviderHandoffState",
  "claimNativeProviderHandoff",
  "completeNativeProviderHandoff",
  "insertMcpHandoff",
  "findMcpHandoff",
  "consumeMcpHandoff",
  "completeMcpSecret",
  "completeMcpGithub",
  "ensureMcpConnectionProof",
  "revokeMcpConsent",
  "listOrganizationMcpConnections",
  "revokeOrganizationMcpConnection",
];
const SCOPED_DNS = [
  "issueScopedDnsAuthorization",
  "consumeScopedDnsAuthorization",
  "readScopedDnsGrant",
  "refreshScopedDnsGrantTokens",
  "revokeScopedDnsAuthorization",
  "recordScopedDnsReceipts",
];

describe("Wave 1 integration: the Q1, Q2, Q3 and Q6 slices are bound in-process, not exposed", () => {
  it("binds the identity, scoped DNS, paid-domain and purge commands on the store only", async () => {
    const store = createControlStore(control.bindings);
    expect(Object.keys(store.identity).sort()).toEqual([...IDENTITY, ...NATIVE_IDENTITY].sort());
    expect(store).not.toHaveProperty("entitlement");
    // The scoped DNS authority is ScopedDnsRuntime (cfScopedDns); no domains command of that name exists on the store.
    for (const name of SCOPED_DNS) expect(store.domains, name).not.toHaveProperty(name);
    expect(store.billing).toHaveProperty("admitPaidProjectDomain");
    // global purges belong to maintenance, never to the ordinary authority
    expect(store.maintenance).toHaveProperty("purgeMcpHandoffRoutes");
    expect(store.maintenance).toHaveProperty("purgeReconciliationInbox");
    for (const name of ["purgeMcpHandoffRoutes", "purgeReconciliationInbox"]) {
      for (const group of [store.identity, store.operations, store.domains, store.billing]) {
        expect(group, name).not.toHaveProperty(name);
      }
    }
  });

  it("exposes through the entrypoints only the snapshot and the eight WorkOS commands, no financial, DNS, grant or purge method", async () => {
    const entry = await import("../src/worker-main.js");
    type Rpc = Record<string, unknown>;
    const ordinary = new (entry.ControlRuntime as unknown as new () => Rpc)();
    const maintenance = new (entry.MaintenanceRuntime as unknown as new () => Rpc)();
    expect(typeof ordinary["applyWorkosOrganizationSnapshot"]).toBe("function");
    const workos = new (entry.WorkosRuntime as unknown as new () => Rpc)();
    const poller = [
      "readCreditWarningScope",
      "isCreditWarningOwner",
      "isSignupFeedbackClaim",
      "prepareWorkosOnboarding",
      "claimWorkosOnboardingOrganization",
      "recordWorkosOnboardingOrganization",
      "claimWorkosOnboardingMembership",
      "completeWorkosOnboarding",
      "claimWorkosInboxEvent",
      "findExpiredFinalWorkosInboxClaim",
      "recordWorkosInboxFailure",
      "recoverExpiredFinalWorkosInboxLease",
      "applyPolledWorkosSnapshot",
      "applyWorkosOrganizationDeletion",
      "revokeLocalAuthorizationForUncertainSnapshot",
    ];
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(workos))
        .filter((name) => name !== "constructor")
        .sort(),
    ).toEqual([...WORKOS_EXPOSED, ...poller].sort());
    for (const name of [...WORKOS_EXPOSED, ...poller]) {
      const call = workos[name] as (input: unknown) => Promise<unknown>;
      await expect(call.call(workos, { unexpected: true })).rejects.toMatchObject({
        name:
          name === "isSignupFeedbackClaim"
            ? "TypeError"
            : expect.stringMatching(/^(?:ZodError|Error)$/u),
      });
    }
    expect(await control.core.prepare("SELECT count(*) AS n FROM webhook_inbox").first()).toEqual({
      n: 0,
    });
    for (const name of poller) {
      expect(ordinary[name], `ControlRuntime.${name}`).toBeUndefined();
      expect(maintenance[name], `MaintenanceRuntime.${name}`).toBeUndefined();
    }
    for (const name of WORKOS_EXPOSED) {
      expect(typeof ordinary[name], `ControlRuntime.${name}`).toBe("function");
      await expect(
        (ordinary[name] as (input: unknown) => Promise<unknown>).call(ordinary, {
          unexpected: true,
        }),
      ).rejects.toMatchObject({ name: expect.stringMatching(/^(?:ZodError|Error)$/u) });
      // commands of one organization or user are never global authority
      expect(maintenance[name], `MaintenanceRuntime.${name}`).toBeUndefined();
    }
    for (const name of NATIVE_CONTROL_EXPOSED) {
      expect(typeof ordinary[name], `ControlRuntime.${name}`).toBe("function");
      expect(maintenance[name], `MaintenanceRuntime.${name}`).toBeUndefined();
    }
    for (const name of MCP_EXPOSED) {
      expect(typeof ordinary[name], `ControlRuntime.${name}`).toBe("function");
      expect(maintenance[name], `MaintenanceRuntime.${name}`).toBeUndefined();
    }
    for (const name of [
      "findMcpGrant",
      "mcpAllows",
      "listMcpGrants",
      "listMcpMailGrants",
      "attachMcpCreatedProject",
    ]) {
      expect(ordinary[name], `retired ControlRuntime.${name}`).toBeUndefined();
      expect(createControlStore(control.bindings).identity).not.toHaveProperty(name);
    }
    const unexposed = [
      // assertOperationDelegationCurrent is the one ordinary identity command that was already exposed before Wave 1
      ...[...IDENTITY, ...NATIVE_IDENTITY].filter(
        (name) =>
          name !== "applyOrganizationSnapshot" &&
          name !== "assertOperationDelegationCurrent" &&
          !WORKOS_EXPOSED.includes(name) &&
          !MCP_EXPOSED.includes(name) &&
          !NATIVE_CONTROL_EXPOSED.includes(name),
      ),
      ...SCOPED_DNS,
      "refundSourceCredits",
      "purgeMcpHandoffRoutes",
      "purgeReconciliationInbox",
      "recordEvidenceExport",
      "advanceRetentionHorizon",
      "purgeEvidenceBelowHorizon",
      "markEffectsArchived",
      "listUnarchivedEffects",
    ];
    for (const name of unexposed) {
      expect(ordinary[name], `ControlRuntime.${name}`).toBeUndefined();
      expect(maintenance[name], `MaintenanceRuntime.${name}`).toBeUndefined();
    }
  });

  it("serves the bound commands through the store's fence on real D1 and validates their input", async () => {
    const store = createControlStore(control.bindings);
    await expect(store.domains.readCloudflareProjectDomains({})).rejects.toThrow();
    await expect(store.identity.claimUserApiKeyCreation({ permissions: ["x"] })).rejects.toThrow();
    await expect(store.billing.admitPaidProjectDomain({})).rejects.toThrow();
    expect(
      await store.identity.isSessionEligible({
        sessionId: "session_none",
        workosUserId: "user_nobody",
        workosOrganizationId: "org_seed_unknown",
        observedAt: "2026-10-28T10:00:00.000Z",
      }),
    ).toBe(false);
  });
});
