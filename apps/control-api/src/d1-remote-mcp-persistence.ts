import { OperationAuthorizationConflictError, type McpDelegationStore } from "@ohmyhost/database";
import type { RemoteMcpPersistence, McpRecoveryContext } from "./remote-mcp-persistence.js";
export interface D1RemoteMcpRuntime {
  insertMcpHandoff(input: unknown): Promise<void>;
  findMcpHandoff(input: unknown): ReturnType<McpDelegationStore["findHandoff"]>;
  consumeMcpHandoff(input: unknown): ReturnType<McpDelegationStore["consumeHandoff"]>;
  completeMcpSecret(input: unknown): Promise<void>;
  readNativeProviderHandoffState?(
    input: unknown,
  ): ReturnType<McpDelegationStore["readNativeProviderHandoffState"]>;
  claimNativeProviderHandoff?(
    input: unknown,
  ): ReturnType<McpDelegationStore["claimNativeProviderHandoff"]>;
  completeNativeProviderHandoff?(
    input: unknown,
  ): ReturnType<McpDelegationStore["completeNativeProviderHandoff"]>;
  completeMcpGithub(input: unknown): Promise<void>;
  ensureMcpConnectionProof(input: unknown): ReturnType<McpDelegationStore["ensureConnectionProof"]>;
  revokeMcpConsent(input: unknown): ReturnType<McpDelegationStore["revoke"]>;
  readMcpAuthorizedMemberships(
    input: unknown,
  ): Promise<{ disconnected: boolean; organizationIds: readonly string[] }>;
  readMcpEnvironmentName(input: unknown): Promise<string | null>;
  readMcpMailDomainOrganization(input: unknown): Promise<string | null>;
  readMcpProjectOrganization(input: unknown): Promise<string | null>;
  readMcpGrantRevision(input: unknown): Promise<string | null>;
  readMcpRecoveryContext(input: unknown): Promise<readonly McpRecoveryContext[]>;
  authorizeMcpExecution(input: unknown): Promise<void>;
  readMcpPlanEnvironmentName(input: unknown): Promise<string | null>;
}
export function isD1RemoteMcpRuntime(value: unknown): value is D1RemoteMcpRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    [
      "insertMcpHandoff",
      "findMcpHandoff",
      "consumeMcpHandoff",
      "completeMcpSecret",
      "completeMcpGithub",
      "ensureMcpConnectionProof",
      "revokeMcpConsent",
      "readMcpAuthorizedMemberships",
      "readMcpEnvironmentName",
      "readMcpMailDomainOrganization",
      "readMcpProjectOrganization",
      "readMcpGrantRevision",
      "readMcpRecoveryContext",
      "authorizeMcpExecution",
      "readMcpPlanEnvironmentName",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}
/** Closed metadata actions only. Token verification, browser CSRF and SDK dispatch stay in the common MCP caller. */
export function createD1RemoteMcpPersistence(runtime: D1RemoteMcpRuntime): RemoteMcpPersistence {
  const store: McpDelegationStore = {
    insertHandoff(input) {
      const { consumedAt, outcome, ...fresh } = input;
      void consumedAt;
      void outcome;
      return runtime.insertMcpHandoff(fresh);
    },
    findHandoff: (requestHash) => runtime.findMcpHandoff({ requestHash }),
    consumeHandoff: (input) => runtime.consumeMcpHandoff(input),
    completeSecret: (requestHash, outcome) =>
      runtime.completeMcpSecret({
        requestHash,
        ...(typeof outcome === "boolean" ? { succeeded: outcome } : outcome),
      }),
    readNativeProviderHandoffState: async (input) => {
      if (!runtime.readNativeProviderHandoffState) throw new Error("native_handoff_unavailable");
      const state = await runtime.readNativeProviderHandoffState(input);
      if (
        state !== null &&
        !["pending", "retryable", "succeeded", "expired", "declined"].includes(state)
      )
        throw new Error("native_handoff_unavailable");
      return state;
    },
    claimNativeProviderHandoff: (input) => {
      if (!runtime.claimNativeProviderHandoff) throw new Error("native_handoff_unavailable");
      return runtime.claimNativeProviderHandoff(input);
    },
    completeNativeProviderHandoff: async (input) => {
      if (!runtime.completeNativeProviderHandoff) throw new Error("native_handoff_unavailable");
      const completed = await runtime.completeNativeProviderHandoff(input);
      if (typeof completed !== "boolean") throw new Error("native_handoff_unavailable");
      return completed;
    },
    completeGithub: (requestHash, succeeded) =>
      runtime.completeMcpGithub({ requestHash, succeeded }),
    ensureConnectionProof: (identity, projectId, now) =>
      runtime.ensureMcpConnectionProof({
        organizationId: identity.organizationId,
        userId: identity.userId,
        clientId: identity.clientId,
        consentHash: identity.consentHash,
        projectId,
        now,
      }),
    revoke: (identity, now) =>
      runtime.revokeMcpConsent({
        userId: identity.userId,
        clientId: identity.clientId,
        consentHash: identity.consentHash,
        now,
      }),
  };
  return {
    store,
    authorizedMemberships: (input) => runtime.readMcpAuthorizedMemberships(input),
    environmentName: (scope) => runtime.readMcpEnvironmentName(scope),
    mailDomainOrganization: (mailDomainId) =>
      runtime.readMcpMailDomainOrganization({ mailDomainId }),
    projectOrganization: (projectId, activeOnly) =>
      runtime.readMcpProjectOrganization({ projectId, activeOnly }),
    grantRevision: (grantId) => runtime.readMcpGrantRevision({ grantId }),
    recoveryContext: (operationId, organizationIds) =>
      runtime.readMcpRecoveryContext({ operationId, organizationIds }),
    async authorizeExecution(scope) {
      try {
        await runtime.authorizeMcpExecution(scope);
      } catch (error) {
        const code =
          error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
        if (
          code === "operation_authorization_changed" ||
          (error instanceof Error &&
            (error.name === "OperationAuthorizationConflictError" ||
              error.message === "Queued operation authorization or source generation changed"))
        )
          throw new OperationAuthorizationConflictError();
        throw error;
      }
    },
    planEnvironmentName: (planId, projectId) =>
      runtime.readMcpPlanEnvironmentName({ planId, projectId }),
  };
}
