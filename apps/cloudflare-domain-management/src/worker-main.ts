import { WorkerEntrypoint } from "cloudflare:workers";
import {
  OrganizationCreditError,
  CloudflareAuthorizationClosedError,
  CloudflareProjectDomainConflictError,
  SharedMailDomainError,
} from "@ohmyhost/database";
import { CloudflareCustomerDnsConflictError } from "@ohmyhost/provider-cloudflare";

import {
  requireCloudflareDomainManagementBindings,
  requireLegacyProductionCloudflareDomainManagementBindings,
  type CloudflareDomainManagementBindings,
  type CloudflareDomainManagementBaseBindings,
} from "./bindings.js";
import { createD1MailComponents } from "./d1-mail-components.js";
import { createD1ProductionCloudflareRuntime, type Runtime } from "./d1-runtime.js";
import { ScopedDnsConflictError } from "./scoped-dns-authorization.js";
import { CloudflareZoneNotBoundError } from "./runtime.js";
import {
  PaidDomainAlreadyConfiguredError,
  PaidDomainDeletingError,
  PaidDomainHostnameTakenError,
  PaidDomainHostnameUnprovenError,
  PaidDomainProductionDeploymentRequiredError,
  PaidDomainKeyConflictError,
} from "./paid-domains.js";

interface WorkerDependencies {
  readonly runtimeFactory: (bindings: CloudflareDomainManagementBindings) => Promise<Runtime>;
}

export function createCloudflareDomainManagementEntrypoint(dependencies: WorkerDependencies) {
  return createOperations(dependencies?.runtimeFactory, requireCloudflareDomainManagementBindings);
}
export function createLegacyProductionCloudflareDomainManagementEntrypoint(dependencies: {
  readonly runtimeFactory: (bindings: CloudflareDomainManagementBaseBindings) => Promise<Runtime>;
}) {
  return createOperations(
    dependencies?.runtimeFactory,
    requireLegacyProductionCloudflareDomainManagementBindings,
  );
}
function createOperations<B>(
  runtimeFactory: (bindings: B) => Promise<Runtime>,
  readBindings: (value: unknown) => B,
) {
  if (typeof runtimeFactory !== "function") {
    throw new TypeError("Cloudflare domain-management Worker dependencies are invalid");
  }
  const invoke = async (
    rawBindings: unknown,
    method: keyof Pick<
      Runtime,
      | "beginAuthorization"
      | "getStatus"
      | "configureDomains"
      | "completeAuthorization"
      | "ensureMailRecords"
      | "ensureWorkspaceMailRecords"
      | "retireWorkspaceMailRecords"
      | "deleteMailRecords"
      | "ensureEnvironment"
      | "deleteProject"
      | "planPaidDomain"
      | "applyPaidDomain"
      | "getPaidDomain"
      | "deletePaidDomain"
      | "readApplicationDomainIdentity"
      | "revalidateApplicationDomainIdentity"
      | "declareApplicationDomainIdentity"
      | "verifyApplicationDomainIdentity"
      | "revokeApplicationDomainIdentity"
      | "beginApplicationIdentityAuthorization"
      | "getApplicationIdentityAuthorizationStatus"
      | "beginWorkspaceMailAuthorization"
      | "getWorkspaceMailAuthorizationStatus"
      | "revokeApplicationIdentityAuthorization"
      | "revokeWorkspaceMailAuthorization"
      | "sweepRevokedGrants"
    >,
    input: unknown,
  ) => {
    try {
      const runtime = await runtimeFactory(readBindings(rawBindings)),
        operation = runtime[method];
      if (!operation) throw new Error("Domain operation unavailable");
      return await operation(input);
    } catch (error) {
      if (error instanceof ScopedDnsConflictError)
        return Object.freeze({ status: "conflict" as const, code: error.code });
      if (error instanceof SharedMailDomainError)
        return Object.freeze({ status: "conflict" as const, code: error.code });
      if (method === "beginAuthorization" && error instanceof CloudflareZoneNotBoundError)
        return Object.freeze({
          status: "conflict" as const,
          code: "cloudflare_zone_not_bound" as const,
        });
      if (method === "beginAuthorization" && error instanceof CloudflareAuthorizationClosedError)
        return Object.freeze({ status: "authorization_closed" as const });
      if (method === "beginAuthorization" && error instanceof CloudflareProjectDomainConflictError)
        return Object.freeze({
          status: "conflict" as const,
          code: "idempotency_key_reused" as const,
        });
      // The project's domains belong to another handle: a renamed project is not an idempotency replay.
      if (method === "configureDomains" && error instanceof CloudflareProjectDomainConflictError)
        return Object.freeze({
          status: "conflict" as const,
          code: "project_domains_conflict" as const,
        });
      if (
        method === "applyPaidDomain" &&
        error instanceof OrganizationCreditError &&
        [
          "paid_plan_required",
          "insufficient_organization_credits",
          "project_budget_exceeded",
        ].includes(error.code)
      )
        return Object.freeze({
          status: "payment_required" as const,
          code: error.code,
        });
      if (
        (method === "applyPaidDomain" || method === "deletePaidDomain") &&
        error instanceof PaidDomainKeyConflictError
      ) {
        return Object.freeze({
          status: "conflict" as const,
          code: "idempotency_key_reused" as const,
        });
      }
      if (
        (method === "applyPaidDomain" || method === "deletePaidDomain") &&
        error instanceof PaidDomainAlreadyConfiguredError
      )
        return Object.freeze({
          status: "conflict" as const,
          code: "domain_already_configured" as const,
        });
      if (
        (method === "applyPaidDomain" || method === "deletePaidDomain") &&
        error instanceof PaidDomainDeletingError
      )
        return Object.freeze({ status: "conflict" as const, code: "domain_deleting" as const });
      if (method === "applyPaidDomain" && error instanceof PaidDomainHostnameTakenError)
        return Object.freeze({
          status: "conflict" as const,
          code: "domain_hostname_taken" as const,
        });
      if (method === "applyPaidDomain" && error instanceof PaidDomainHostnameUnprovenError)
        return Object.freeze({
          status: "conflict" as const,
          code: "domain_ownership_required" as const,
        });
      if (
        (method === "applyPaidDomain" || method === "deletePaidDomain") &&
        error instanceof CloudflareCustomerDnsConflictError
      )
        return Object.freeze({ status: "conflict" as const, code: "domain_dns_conflict" as const });
      if (
        (method === "planPaidDomain" || method === "applyPaidDomain") &&
        error instanceof PaidDomainProductionDeploymentRequiredError
      )
        return Object.freeze({
          status: "conflict" as const,
          code: "production_deployment_required" as const,
        });
      throw error;
    }
  };
  return Object.freeze({
    fetch: async () =>
      new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } }),
    beginAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "beginAuthorization", input),
    getStatus: (bindings: unknown, input: unknown) => invoke(bindings, "getStatus", input),
    configureDomains: (bindings: unknown, input: unknown) =>
      invoke(bindings, "configureDomains", input),
    completeAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "completeAuthorization", input),
    ensureEnvironment: (bindings: unknown, input: unknown) =>
      invoke(bindings, "ensureEnvironment", input),
    deleteMailRecords: (bindings: unknown, input: unknown) =>
      invoke(bindings, "deleteMailRecords", input),
    ensureMailRecords: (bindings: unknown, input: unknown) =>
      invoke(bindings, "ensureMailRecords", input),
    ensureWorkspaceMailRecords: (bindings: unknown, input: unknown) =>
      invoke(bindings, "ensureWorkspaceMailRecords", input),
    retireWorkspaceMailRecords: (bindings: unknown, input: unknown) =>
      invoke(bindings, "retireWorkspaceMailRecords", input),
    deleteProject: (bindings: unknown, input: unknown) => invoke(bindings, "deleteProject", input),
    planPaidDomain: (bindings: unknown, input: unknown) =>
      invoke(bindings, "planPaidDomain", input),
    applyPaidDomain: (bindings: unknown, input: unknown) =>
      invoke(bindings, "applyPaidDomain", input),
    getPaidDomain: (bindings: unknown, input: unknown) => invoke(bindings, "getPaidDomain", input),
    deletePaidDomain: (bindings: unknown, input: unknown) =>
      invoke(bindings, "deletePaidDomain", input),
    readApplicationDomainIdentity: (bindings: unknown, input: unknown) =>
      invoke(bindings, "readApplicationDomainIdentity", input),
    revalidateApplicationDomainIdentity: (bindings: unknown, input: unknown) =>
      invoke(bindings, "revalidateApplicationDomainIdentity", input),
    declareApplicationDomainIdentity: (bindings: unknown, input: unknown) =>
      invoke(bindings, "declareApplicationDomainIdentity", input),
    verifyApplicationDomainIdentity: (bindings: unknown, input: unknown) =>
      invoke(bindings, "verifyApplicationDomainIdentity", input),
    revokeApplicationDomainIdentity: (bindings: unknown, input: unknown) =>
      invoke(bindings, "revokeApplicationDomainIdentity", input),
    beginApplicationIdentityAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "beginApplicationIdentityAuthorization", input),
    getApplicationIdentityAuthorizationStatus: (bindings: unknown, input: unknown) =>
      invoke(bindings, "getApplicationIdentityAuthorizationStatus", input),
    beginWorkspaceMailAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "beginWorkspaceMailAuthorization", input),
    getWorkspaceMailAuthorizationStatus: (bindings: unknown, input: unknown) =>
      invoke(bindings, "getWorkspaceMailAuthorizationStatus", input),
    revokeApplicationIdentityAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "revokeApplicationIdentityAuthorization", input),
    revokeWorkspaceMailAuthorization: (bindings: unknown, input: unknown) =>
      invoke(bindings, "revokeWorkspaceMailAuthorization", input),
    sweepRevokedGrants: (bindings: unknown, input: unknown) =>
      invoke(bindings, "sweepRevokedGrants", input),
  });
}

const entrypoint = createCloudflareDomainManagementEntrypoint({
  runtimeFactory: (bindings) =>
    createD1ProductionCloudflareRuntime(bindings, createD1MailComponents),
});

type DomainEntrypoint = ReturnType<typeof createCloudflareDomainManagementEntrypoint>;
type ServiceMethods = Exclude<keyof DomainEntrypoint, "fetch">;
type DomainService = { [M in ServiceMethods]: (input: unknown) => ReturnType<DomainEntrypoint[M]> };
/** One closed 26-method RPC implementation, composed with one trusted entrypoint. */
export function createCloudflareDomainManagementService<B>(
  entrypoint: DomainEntrypoint,
): new (context: unknown, env: B) => DomainService {
  return class CloudflareDomainManagementService extends WorkerEntrypoint<B> {
    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async beginAuthorization(input: unknown) {
      return entrypoint.beginAuthorization(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async getStatus(input: unknown) {
      return entrypoint.getStatus(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async configureDomains(input: unknown) {
      return entrypoint.configureDomains(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async completeAuthorization(input: unknown) {
      return entrypoint.completeAuthorization(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async ensureEnvironment(input: unknown) {
      return entrypoint.ensureEnvironment(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async deleteMailRecords(input: unknown) {
      return entrypoint.deleteMailRecords(this.env, input);
    }
    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async ensureMailRecords(input: unknown) {
      return entrypoint.ensureMailRecords(this.env, input);
    }
    public async ensureWorkspaceMailRecords(input: unknown) {
      return entrypoint.ensureWorkspaceMailRecords(this.env, input);
    }
    public async retireWorkspaceMailRecords(input: unknown) {
      return entrypoint.retireWorkspaceMailRecords(this.env, input);
    }

    /* v8 ignore next -- Cloudflare invokes this WorkerEntrypoint delegation wrapper */
    public async deleteProject(input: unknown) {
      return entrypoint.deleteProject(this.env, input);
    }

    public async planPaidDomain(input: unknown) {
      return entrypoint.planPaidDomain(this.env, input);
    }

    public async applyPaidDomain(input: unknown) {
      return entrypoint.applyPaidDomain(this.env, input);
    }

    public async getPaidDomain(input: unknown) {
      return entrypoint.getPaidDomain(this.env, input);
    }

    public async deletePaidDomain(input: unknown) {
      return entrypoint.deletePaidDomain(this.env, input);
    }

    public async readApplicationDomainIdentity(input: unknown) {
      return entrypoint.readApplicationDomainIdentity(this.env, input);
    }
    public async revalidateApplicationDomainIdentity(input: unknown) {
      return entrypoint.revalidateApplicationDomainIdentity(this.env, input);
    }
    public async declareApplicationDomainIdentity(input: unknown) {
      return entrypoint.declareApplicationDomainIdentity(this.env, input);
    }
    public async verifyApplicationDomainIdentity(input: unknown) {
      return entrypoint.verifyApplicationDomainIdentity(this.env, input);
    }
    public async revokeApplicationDomainIdentity(input: unknown) {
      return entrypoint.revokeApplicationDomainIdentity(this.env, input);
    }
    public async beginApplicationIdentityAuthorization(input: unknown) {
      return entrypoint.beginApplicationIdentityAuthorization(this.env, input);
    }
    public async getApplicationIdentityAuthorizationStatus(input: unknown) {
      return entrypoint.getApplicationIdentityAuthorizationStatus(this.env, input);
    }
    public async beginWorkspaceMailAuthorization(input: unknown) {
      return entrypoint.beginWorkspaceMailAuthorization(this.env, input);
    }
    public async getWorkspaceMailAuthorizationStatus(input: unknown) {
      return entrypoint.getWorkspaceMailAuthorizationStatus(this.env, input);
    }
    public async revokeApplicationIdentityAuthorization(input: unknown) {
      return entrypoint.revokeApplicationIdentityAuthorization(this.env, input);
    }
    public async revokeWorkspaceMailAuthorization(input: unknown) {
      return entrypoint.revokeWorkspaceMailAuthorization(this.env, input);
    }
    public async sweepRevokedGrants(input: unknown) {
      return entrypoint.sweepRevokedGrants(this.env, input);
    }
  };
}
export const CloudflareDomainManagementService =
  createCloudflareDomainManagementService<CloudflareDomainManagementBindings>(entrypoint);

export default class CloudflareDomainManagementWorker extends WorkerEntrypoint<CloudflareDomainManagementBindings> {
  /* v8 ignore next -- Cloudflare invokes this route-free WorkerEntrypoint wrapper */
  public async fetch() {
    return entrypoint.fetch();
  }
}
