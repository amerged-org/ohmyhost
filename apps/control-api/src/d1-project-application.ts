import {
  parseUlid,
  AUTHORIZATION_ACTIONS,
  type AuthorizationPort,
  type Clock,
  type UlidFactory,
} from "@ohmyhost/platform";
import { createControlApi } from "./app.js";
import type {
  ControlApiDependencies,
  BearerAuthenticator,
  RateLimitPort,
  SafeErrorReporter,
} from "./contracts.js";
import {
  createD1ControlApiPersistence,
  unportedD1ControlOperation as unported,
  type D1ProjectRuntime,
} from "./d1-project-persistence.js";
import type { WorkosOrganizationResolver } from "./workos-authenticator.js";
import type { ProjectExportsPort } from "./project-exports.js";

/** The original authentication resolver, with both current WorkOS mapping and exact M2M binding read from the Core. */
export function createD1WorkosOrganizationResolver(
  runtime: D1ProjectRuntime,
): WorkosOrganizationResolver {
  return {
    async resolve(workosOrganizationId) {
      const id = await runtime.resolveWorkosOrganization({ workosOrganizationId });
      return id === null ? null : parseUlid(id);
    },
    async resolveM2m(input) {
      const binding = await runtime.resolveM2mOrganization(input);
      return binding === null
        ? null
        : { organizationId: parseUlid(binding.organizationId), scopes: [...binding.scopes] };
    },
  };
}

/** Closed project, audit, log and secret actions retain the original owner/member and concrete-resource policy. */
export function createD1ProjectAuthorization(runtime: D1ProjectRuntime): AuthorizationPort {
  return {
    async check(input) {
      if (
        input.principal.kind !== "user" ||
        !AUTHORIZATION_ACTIONS.includes(input.action) ||
        !["organization", "project", "mail_domain"].includes(input.resource.kind)
      )
        return "deny";
      return runtime.authorizeOrganizationAction({
        organizationId: input.resource.organizationId,
        principalId: input.principal.subjectId,
        action: input.action,
        ...(input.resource.kind === "mail_domain"
          ? { mailDomainId: input.resource.mailDomainId }
          : {}),
        ...(input.resource.kind !== "project"
          ? {}
          : {
              projectId: input.resource.projectId,
              ...(input.resource.environmentId === undefined
                ? {}
                : { environmentId: input.resource.environmentId }),
            }),
      });
    },
  };
}

/** The caller gates every unported route before invoking this existing public API router. */
export function createD1ProjectApplication(input: {
  runtime: D1ProjectRuntime;
  authentication: BearerAuthenticator;
  platform: "development" | "production";
  clock: Clock;
  ids: UlidFactory;
  applicationId: string;
  rateLimits: RateLimitPort;
  reporter: SafeErrorReporter;
  projectExports?: ProjectExportsPort;
  accountMetadata?: Awaited<
    ReturnType<typeof import("./d1-account-metadata.js").createD1AccountMetadataPorts>
  >;
  environmentSecrets?: ControlApiDependencies["environmentSecrets"];
  metadata?: Pick<ControlApiDependencies, "projectNotes" | "poweredByFlag">;
  identity?: Pick<
    ControlApiDependencies,
    "userApiKeys" | "organizationOnboarding" | "sessionRevocation" | "billing"
  >;
  remote?: Pick<
    ControlApiDependencies,
    | "internalAuthentication"
    | "remoteAuthorization"
    | "remoteProjectIds"
    | "remoteDelegation"
    | "remoteMailDomainIds"
    | "remoteMailDomainDelegation"
  >;
  database?: Pick<
    ControlApiDependencies,
    | "databaseCompute"
    | "projectDatabaseAccess"
    | "projectDatabaseEvents"
    | "projectDatabaseWrite"
    | "projectDatabaseDiagnostics"
  >;
  /** Ports with their own Core capability; each one replaces its explicit "unported" default below. */
  extended?: Partial<ControlApiDependencies>;
  persistenceExtras?: Parameters<typeof createD1ControlApiPersistence>[0]["extras"];
}) {
  return createControlApi({
    managedProjectCreation: true,
    ...input.accountMetadata,
    ...input.database,
    ...input.metadata,
    ...input.identity,
    ...input.remote,
    ...(input.projectExports === undefined ? {} : { projectExports: input.projectExports }),
    authentication: input.authentication,
    authorization: createD1ProjectAuthorization(input.runtime),
    persistence: createD1ControlApiPersistence({
      ...input,
      ...(input.persistenceExtras === undefined ? {} : { extras: input.persistenceExtras }),
    }),
    productSurface: {
      getProjectStatus: unported,
      getSource: unported,
      configureAutoDeploy: unported,
      getAutoDeploy: unported,
      planDeployment: unported,
      createDeployment: unported,
      listDeployments: unported,
      getDeployment: unported,
      planRollback: unported,
      rollback: unported,
      changeProjectHandle: unported,
      planPromotion: unported,
      promote: unported,
      planDelete: unported,
      deleteProject: unported,
    },
    providerReconciliation: { reconcile: unported },
    environmentSecrets: input.environmentSecrets ?? {
      list: unported,
      put: unported,
      remove: unported,
      rotate: unported,
    },
    projectMailDomains: { configure: unported, get: unported },
    devAccessTickets: { issue: unported },
    ...input.extended,
    clock: input.clock,
    ids: input.ids,
    allowedOrigins: new Set(),
    applicationId: input.applicationId,
    rateLimits: input.rateLimits,
    reporter: input.reporter,
  });
}

/** A complete closed method set is required; a partial/missing service binding cannot select a legacy authority. */
export function isD1ProjectRuntime(value: unknown): value is D1ProjectRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    [
      "admitCustomerProject",
      "readTakenProjectHandles",
      "listCustomerProjects",
      "getCustomerProject",
      "resolveWorkosOrganization",
      "resolveM2mOrganization",
      "authorizeOrganizationAction",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}
