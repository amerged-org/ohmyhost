import type { WFP_DISPATCH_LIMITS, WfpEgressContext } from "@ohmyhost/contracts/wfp-dispatch";
import { AI_GATEWAY_ORIGIN_DEVELOPMENT, AI_GATEWAY_ORIGIN_PRODUCTION } from "@ohmyhost/platform";
import type { GatewayRegistry } from "./gateway-registry.js";
export interface BuildObjectBody {
  readonly version: string;
  readonly httpEtag: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The read-only part of the R2 bucket binding this Worker uses. */
export interface BuildObjectsBinding {
  get(key: string): Promise<BuildObjectBody | null>;
}

/**
 * Dynamic Dispatch to a candidate script. Customer code only runs under the platform limits and
 * the Outbound Worker's egress context of its project, exactly as behind the public gateway.
 */
export interface WfpDispatchNamespaceBinding {
  get(
    scriptName: string,
    args: Record<string, never>,
    options: Readonly<{
      limits: typeof WFP_DISPATCH_LIMITS;
      outbound: Readonly<{ EGRESS_CONTEXT: WfpEgressContext }>;
    }>,
  ): { fetch(request: Request): Promise<Response> };
}

/**
 * Core's runtime-secret authority. A manifest reaches a provider only when Core stores exactly its names and revisions
 * for the environment; the values never leave the caller's manifest and no digest is compared here.
 */
export interface RuntimeSecretAuthorityBinding {
  registerNextCacheScope?(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    deploymentId: string;
  }): Promise<unknown>;
  authorizeManifest(input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    secrets: readonly { name: string; revision: number }[];
  }): Promise<unknown>;
}

export interface WfpManagementWorkerBindings {
  readonly WFP_ACCOUNT_ID: string;
  readonly WFP_DISPATCH_NAMESPACE: string;
  readonly WFP_WORKERS_DEV_SUBDOMAIN: string;
  /** The build objects bucket of US projects; `BUILD_OBJECTS_US` binds it. */
  readonly BUILD_OBJECTS_BUCKET_US: string;
  /** The build objects bucket of EU projects; `BUILD_OBJECTS_EU` binds it. */
  readonly BUILD_OBJECTS_BUCKET_EU: string;
  /** Worker secret: the Workers for Platforms API token. */
  readonly WFP_API_TOKEN: string;
  readonly DATABASE_SERVICE_US: string;
  readonly DATABASE_SERVICE_EU: string;
  readonly NATIVE_AUTH_SERVICE_US?: string;
  readonly NATIVE_AUTH_SERVICE_EU?: string;
  readonly NATIVE_AUTH_REGISTRY_AUTHORITY?: {
    readRegistration(input: { projectId: string; environmentId: string }): Promise<unknown>;
  };
  readonly BUILD_OBJECTS_US: BuildObjectsBinding;
  readonly BUILD_OBJECTS_EU: BuildObjectsBinding;
  readonly WFP_DISPATCH: WfpDispatchNamespaceBinding;
  readonly GATEWAY_REGISTRY: GatewayRegistry;
  readonly RUNTIME_PROBES: { beginProbe(input: unknown): Promise<unknown> };
  readonly RUNTIME_SECRET_AUTHORITY: RuntimeSecretAuthorityBinding;
}

export interface WfpManagementConfiguration {
  readonly gatewayRegistry: GatewayRegistry;
  readonly runtimeSecretAuthority: RuntimeSecretAuthorityBinding;
  readonly accountId: string;
  readonly namespace: string;
  readonly workersDevSubdomain: string;
  /** The build objects buckets by name; an artifact is read from the bucket its provenance names. */
  readonly buildObjectsBuckets: readonly Readonly<{
    bucketName: string;
    objects: BuildObjectsBinding;
  }>[];
  readonly apiToken: string;
  readonly databaseServiceUs: string;
  readonly databaseServiceEu: string;
  readonly nativeAuthServiceUs?: string;
  readonly nativeAuthServiceEu?: string;
  readonly nativeAuthAuthority?: {
    readRegistration(input: { projectId: string; environmentId: string }): Promise<unknown>;
  };
  readonly mailGatewayService: string;
  readonly mailGatewayOrigin: string;
  readonly storageGatewayOrigin: string;
  readonly aiGatewayOrigin: string;
}

const RESOURCE_NAMESPACES = ["sandbox", "poc-private-fullstack", "production"];

/**
 * Validates every binding and derives the platform service identities from the dispatch
 * namespace, so one environment can never name another environment's gateways.
 */
export function requireWfpManagementConfiguration(value: unknown): WfpManagementConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const bindings = value as Record<string, unknown>;
  const namespace = bindings["WFP_DISPATCH_NAMESPACE"];
  const resourceNamespace =
    typeof namespace === "string" && namespace.startsWith("ohmyho-")
      ? namespace.slice("ohmyho-".length)
      : "";
  const workersDevSubdomain = bindings["WFP_WORKERS_DEV_SUBDOMAIN"];
  const apiToken = bindings["WFP_API_TOKEN"];
  const buildObjectsBucket =
    resourceNamespace === "production" ? "ohmyho-builds-production" : "ohmyho-builds-development";
  const buildObjectsUs = bindings["BUILD_OBJECTS_US"];
  const buildObjectsEu = bindings["BUILD_OBJECTS_EU"];
  if (
    typeof bindings["WFP_ACCOUNT_ID"] !== "string" ||
    !/^[a-f0-9]{32}$/u.test(bindings["WFP_ACCOUNT_ID"]) ||
    typeof namespace !== "string" ||
    !RESOURCE_NAMESPACES.includes(resourceNamespace) ||
    bindings["DATABASE_SERVICE_US"] !==
      `ohmyho-project-database-${resourceNamespace === "poc-private-fullstack" ? "development" : resourceNamespace}-us` ||
    bindings["DATABASE_SERVICE_EU"] !==
      `ohmyho-project-database-${resourceNamespace === "poc-private-fullstack" ? "development" : resourceNamespace}-eu` ||
    typeof workersDevSubdomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workersDevSubdomain) ||
    bindings["BUILD_OBJECTS_BUCKET_US"] !== buildObjectsBucket ||
    bindings["BUILD_OBJECTS_BUCKET_EU"] !== `${buildObjectsBucket}-eu` ||
    typeof apiToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/u.test(apiToken) ||
    !hasMethod(buildObjectsUs, "get") ||
    !hasMethod(buildObjectsEu, "get") ||
    !hasMethod(bindings["WFP_DISPATCH"], "get") ||
    !hasMethod(bindings["RUNTIME_PROBES"], "beginProbe") ||
    !hasMethod(bindings["RUNTIME_SECRET_AUTHORITY"], "authorizeManifest") ||
    !["activate", "observe", "remove", "compensate", "authorizeCandidateRemoval"].every((method) =>
      hasMethod(bindings["GATEWAY_REGISTRY"], method),
    )
  ) {
    invalid();
  }
  return Object.freeze({
    gatewayRegistry: bindings["GATEWAY_REGISTRY"] as unknown as GatewayRegistry,
    runtimeSecretAuthority: bindings[
      "RUNTIME_SECRET_AUTHORITY"
    ] as unknown as RuntimeSecretAuthorityBinding,
    accountId: bindings["WFP_ACCOUNT_ID"],
    namespace,
    workersDevSubdomain,
    buildObjectsBuckets: Object.freeze([
      Object.freeze({ bucketName: buildObjectsBucket, objects: buildObjectsUs }),
      Object.freeze({ bucketName: `${buildObjectsBucket}-eu`, objects: buildObjectsEu }),
    ]),
    apiToken,
    databaseServiceUs: bindings["DATABASE_SERVICE_US"] as string,
    databaseServiceEu: bindings["DATABASE_SERVICE_EU"] as string,
    ...(typeof bindings["NATIVE_AUTH_SERVICE_US"] === "string"
      ? { nativeAuthServiceUs: bindings["NATIVE_AUTH_SERVICE_US"] }
      : {}),
    ...(typeof bindings["NATIVE_AUTH_SERVICE_EU"] === "string"
      ? { nativeAuthServiceEu: bindings["NATIVE_AUTH_SERVICE_EU"] }
      : {}),
    ...(hasMethod(bindings["NATIVE_AUTH_REGISTRY_AUTHORITY"], "readRegistration")
      ? {
          nativeAuthAuthority: bindings[
            "NATIVE_AUTH_REGISTRY_AUTHORITY"
          ] as unknown as WfpManagementConfiguration["nativeAuthAuthority"] & {},
        }
      : {}),
    mailGatewayService: `ohmyho-mail-gateway-${resourceNamespace}`,
    mailGatewayOrigin: `https://ohmyho-mail-gateway-${resourceNamespace}.${workersDevSubdomain}.workers.dev`,
    storageGatewayOrigin: `https://ohmyho-storage-gateway-${resourceNamespace}.${workersDevSubdomain}.workers.dev`,
    aiGatewayOrigin:
      resourceNamespace === "production"
        ? AI_GATEWAY_ORIGIN_PRODUCTION
        : AI_GATEWAY_ORIGIN_DEVELOPMENT,
  });
}

function hasMethod(value: unknown, name: string): value is BuildObjectsBinding {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, name) === "function"
  );
}

function invalid(): never {
  throw new Error("wfp_management_configuration_invalid");
}
