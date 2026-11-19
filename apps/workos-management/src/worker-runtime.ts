import type { createWorkosUserKeyLifecycle } from "./user-key-lifecycle.js";
import type { CandidateClock, CandidateIdFactory, WorkosManagementDatabase } from "./ports.js";
import { composeWorkosManagementCandidate } from "./composition.js";
import {
  createPrivateServiceBindingHandler,
  createServiceBindingAuthenticator,
} from "./service-binding.js";
import { createWorkosReadOnlyBoundary } from "./workos-readonly-transport.js";
import {
  createWorkosSessionStatusChecker,
  type WorkosSessionAnswerCache,
} from "./session-status.js";
import type { createWorkosOrganizationOnboarding } from "./organization-onboarding.js";
import type { createWorkosSessionRevocation } from "./session-revocation.js";
import { createWorkosUserApiKeyValidation } from "./user-api-keys.js";
import { createWorkosCurrentIdentity } from "./current-identity.js";

/**
 * The Worker holds the private `CONTROL_RUNTIME` service binding to the Core's WorkosRuntime and nothing else: no
 * direct database binding of any kind.
 */
export interface WorkosManagementWorkerBindings {
  readonly WORKOS_DEPLOYMENT: "development" | "production";
  readonly WORKOS_MANAGEMENT_CREDENTIAL: string;
  readonly MANAGEMENT_ARTIFACT_SHA256: string;
  readonly CF_VERSION_METADATA: {
    readonly id: string;
    readonly tag: string;
    readonly timestamp: string;
  };
  readonly WORKOS_AUTHKIT_DOMAIN?: string;
  readonly WORKOS_CONNECT_APPLICATION_ID?: string;
  readonly WORKOS_CONNECT_CLIENT_ID?: string;
  readonly WORKOS_CONNECT_CLIENT_SECRET?: string;
  readonly CONTROL_RUNTIME: unknown;
}

/** Names the Worker must not carry: any of them would be a direct Core database binding next to the capability. */
const FORBIDDEN_BINDINGS = /^(?:CONTROL_CORE|CONTROL_GLOBAL|CONTROL_SHARD_\d{4})$/u;

export const parseWorkosManagementWorkerBindings = (
  bindings: Partial<WorkosManagementWorkerBindings>,
): WorkosManagementWorkerBindings => {
  const probeValues = [
    bindings.WORKOS_AUTHKIT_DOMAIN,
    bindings.WORKOS_CONNECT_APPLICATION_ID,
    bindings.WORKOS_CONNECT_CLIENT_ID,
    bindings.WORKOS_CONNECT_CLIENT_SECRET,
  ];
  const hasProbe = probeValues.some((value) => value !== undefined);
  if (
    (bindings.WORKOS_DEPLOYMENT !== "development" && bindings.WORKOS_DEPLOYMENT !== "production") ||
    typeof bindings.WORKOS_MANAGEMENT_CREDENTIAL !== "string" ||
    bindings.WORKOS_MANAGEMENT_CREDENTIAL.length < 8 ||
    typeof bindings.MANAGEMENT_ARTIFACT_SHA256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(bindings.MANAGEMENT_ARTIFACT_SHA256) ||
    bindings.CF_VERSION_METADATA === undefined ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(bindings.CF_VERSION_METADATA.id) ||
    bindings.CF_VERSION_METADATA.tag !== bindings.MANAGEMENT_ARTIFACT_SHA256 ||
    !Number.isFinite(Date.parse(bindings.CF_VERSION_METADATA.timestamp)) ||
    (hasProbe && !probeValues.every((value) => typeof value === "string" && value.length > 0))
  ) {
    throw new TypeError("WorkOS management Worker bindings are incomplete");
  }
  const common = {
    WORKOS_DEPLOYMENT: bindings.WORKOS_DEPLOYMENT,
    WORKOS_MANAGEMENT_CREDENTIAL: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
    MANAGEMENT_ARTIFACT_SHA256: bindings.MANAGEMENT_ARTIFACT_SHA256,
    CF_VERSION_METADATA: {
      id: bindings.CF_VERSION_METADATA.id,
      tag: bindings.CF_VERSION_METADATA.tag,
      timestamp: bindings.CF_VERSION_METADATA.timestamp,
    },
    ...(hasProbe
      ? {
          WORKOS_AUTHKIT_DOMAIN: bindings.WORKOS_AUTHKIT_DOMAIN as string,
          WORKOS_CONNECT_APPLICATION_ID: bindings.WORKOS_CONNECT_APPLICATION_ID as string,
          WORKOS_CONNECT_CLIENT_ID: bindings.WORKOS_CONNECT_CLIENT_ID as string,
          WORKOS_CONNECT_CLIENT_SECRET: bindings.WORKOS_CONNECT_CLIENT_SECRET as string,
        }
      : {}),
  };
  // A missing service binding never falls back to anything, and a direct database binding next to it is refused
  // rather than ignored.
  const runtime: unknown = bindings.CONTROL_RUNTIME;
  if (
    runtime === undefined ||
    runtime === null ||
    (typeof runtime !== "object" && typeof runtime !== "function") ||
    Reflect.ownKeys(bindings).some(
      (name) => typeof name === "string" && FORBIDDEN_BINDINGS.test(name),
    )
  ) {
    throw new TypeError("WorkOS management Worker bindings are incomplete");
  }
  return { ...common, CONTROL_RUNTIME: runtime };
};

export function createWorkosManagementWorkerRuntime(input: {
  readonly userKeyLifecycle?: ReturnType<typeof createWorkosUserKeyLifecycle>;
  readonly organizationOnboarding?: ReturnType<typeof createWorkosOrganizationOnboarding>;
  readonly sessionRevocation?: ReturnType<typeof createWorkosSessionRevocation>;
  readonly sessionAnswers: WorkosSessionAnswerCache;
  readonly bindings: Partial<WorkosManagementWorkerBindings>;
  readonly database: WorkosManagementDatabase;
  readonly fetcher: (request: Request) => Promise<Response>;
  readonly clock: CandidateClock;
  readonly ids: CandidateIdFactory;
  readonly organizationIds: CandidateIdFactory;
}) {
  const bindings = parseWorkosManagementWorkerBindings(input.bindings);
  const secretBoundary = createWorkosReadOnlyBoundary({
    secret: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
    ...(bindings.WORKOS_AUTHKIT_DOMAIN === undefined
      ? {}
      : {
          capabilityProbe: {
            authkitDomain: bindings.WORKOS_AUTHKIT_DOMAIN,
            connectApplicationId: bindings.WORKOS_CONNECT_APPLICATION_ID as string,
            connectClientId: bindings.WORKOS_CONNECT_CLIENT_ID as string,
            connectClientSecret: bindings.WORKOS_CONNECT_CLIENT_SECRET as string,
          },
        }),
    fetcher: input.fetcher,
  });
  const serviceBoundary = createServiceBindingAuthenticator();
  const graph = composeWorkosManagementCandidate({
    deployment: bindings.WORKOS_DEPLOYMENT,
    candidateFgaEnabled: false,
    authenticator: serviceBoundary.authenticator,
    clock: input.clock,
    ids: input.ids,
    organizationIds: input.organizationIds,
    database: input.database,
    resolver: secretBoundary.resolver,
    transport: secretBoundary.transport,
  });
  return {
    graph,
    handler: createPrivateServiceBindingHandler({
      currentIdentity: createWorkosCurrentIdentity({
        credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
        fetcher: input.fetcher,
      }),
      ...(input.userKeyLifecycle ? { userKeyLifecycle: input.userKeyLifecycle } : {}),
      userApiKeys: createWorkosUserApiKeyValidation({
        credential: bindings.WORKOS_MANAGEMENT_CREDENTIAL,
        fetcher: input.fetcher,
      }),
      ...(input.sessionRevocation ? { sessionRevocation: input.sessionRevocation } : {}),
      ...(input.organizationOnboarding
        ? { organizationOnboarding: input.organizationOnboarding }
        : {}),
      rpc: graph.rpc,
      authentication: serviceBoundary.authentication,
      sessionStatus: createWorkosSessionStatusChecker({
        clock: input.clock,
        database: input.database,
        resolver: secretBoundary.resolver,
        transport: secretBoundary.transport,
        answerCache: input.sessionAnswers,
      }),
    }),
  } as const;
}
