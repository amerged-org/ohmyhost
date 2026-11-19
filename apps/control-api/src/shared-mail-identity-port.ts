import { createHash } from "node:crypto";
import type { SharedMailIdentityPort, SharedMailMutation, SharedMailScope } from "./shared-mail.js";

export type SharedMailIdentityBinding = {
  [K in keyof SharedMailIdentityPort]: (input: unknown) => Promise<unknown>;
};

/** Exact private request shapes keep API metadata out of provider-management authorization. */
export function createSharedMailIdentityPort(
  binding: SharedMailIdentityBinding,
): SharedMailIdentityPort {
  const base = (value: SharedMailScope & { projectId?: string; mailDomainId?: string }) => ({
    actorId: value.principalId,
    organizationId: value.organizationId,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    ...(value.mailDomainId === undefined ? {} : { mailDomainId: value.mailDomainId }),
  });
  const mutation = (value: SharedMailMutation) => ({
    idempotencyKeySha256: `sha256:${createHash("sha256").update(value.idempotencyKey).digest("hex")}`,
    requestSha256: `sha256:${Buffer.from(value.canonicalRequestDigest).toString("hex")}`,
  });
  async function identity(work: () => Promise<unknown>) {
    const value = await work();
    if (value === null) throw new Error("application_identity_not_found");
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "conflict"
    ) {
      const code = "code" in value ? value.code : undefined;
      throw new Error(typeof code === "string" ? code : "application_identity_stale");
    }
    return value;
  }
  async function authorization(work: () => Promise<unknown>) {
    const raw = await work();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("Invalid DNS authorization result");
    const value = raw as Record<string, unknown>;
    if (value["status"] === "conflict")
      throw new Error(typeof value["code"] === "string" ? value["code"] : "dns_resource_stale");
    if ("authorizationId" in value)
      return {
        authorization_id: value["authorizationId"],
        authorization_url: value["authorizationUrl"],
        expires_at: value["expiresAt"],
      };
    return {
      status: value["status"],
      zone: value["zone"],
      scopes: value["scopes"],
      expires_at: value["expiresAt"],
    };
  }
  return {
    readApplicationDomainIdentity: (scope) =>
      identity(() => binding.readApplicationDomainIdentity(base(scope))),
    declareApplicationDomainIdentity: (scope) =>
      identity(() =>
        binding.declareApplicationDomainIdentity({
          ...base(scope),
          ...(scope.delegation === undefined ? {} : { delegation: scope.delegation }),
          ...mutation(scope),
          hostname: scope.hostname,
        }),
      ),
    verifyApplicationDomainIdentity: (scope) =>
      identity(() =>
        binding.verifyApplicationDomainIdentity({
          ...base(scope),
          ...(scope.delegation === undefined ? {} : { delegation: scope.delegation }),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
        }),
      ),
    revokeApplicationDomainIdentity: (scope) =>
      identity(() =>
        binding.revokeApplicationDomainIdentity({
          ...base(scope),
          ...(scope.delegation === undefined ? {} : { delegation: scope.delegation }),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
        }),
      ),
    beginApplicationIdentityAuthorization: (scope) =>
      authorization(() =>
        binding.beginApplicationIdentityAuthorization({
          ...base(scope),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
          zone: scope.zone,
          ...(scope.delegation === undefined ? {} : { delegation: scope.delegation }),
        }),
      ),
    getApplicationIdentityAuthorizationStatus: (scope) =>
      authorization(() => binding.getApplicationIdentityAuthorizationStatus(base(scope))),
    beginWorkspaceMailAuthorization: (scope) =>
      authorization(() =>
        binding.beginWorkspaceMailAuthorization({
          ...base(scope),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
          zone: scope.zone,
          ...(scope.delegation === undefined ? {} : { delegation: scope.delegation }),
        }),
      ),
    getWorkspaceMailAuthorizationStatus: (scope) =>
      authorization(() => binding.getWorkspaceMailAuthorizationStatus(base(scope))),
    revokeApplicationIdentityAuthorization: (scope) =>
      authorization(() =>
        binding.revokeApplicationIdentityAuthorization({
          ...base(scope),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
        }),
      ),
    revokeWorkspaceMailAuthorization: (scope) =>
      authorization(() =>
        binding.revokeWorkspaceMailAuthorization({
          ...base(scope),
          ...mutation(scope),
          expectedRevision: scope.expectedRevision,
        }),
      ),
  };
}
