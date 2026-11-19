import { createHash } from "node:crypto";
import { projectEnvironmentAddress } from "@ohmyhost/project-handles";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type {
  CloudflareProjectDomains,
  CloudflareProjectDnsGrant,
  RotateCloudflareProjectDnsGrantInput,
} from "@ohmyhost/database";
import type {
  CloudflareCustomerDnsRecord,
  CloudflareDesiredDnsRecord,
  CloudflareWorkerRouteReceipt,
} from "@ohmyhost/provider-cloudflare";

export interface CloudflareDomainReconciliationState {
  readonly domains: CloudflareProjectDomains;
}

export interface CloudflareDomainReconciliationPersistence {
  read(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly deploymentId: Ulid;
    readonly environmentName: "dev" | "prod";
    readonly gatewayScriptName: string;
    readonly healthCheckPath: string;
  }): Promise<CloudflareDomainReconciliationState | null>;
  // Retained only for the deferred paid OAuth adapter. The platform-owned Free path never calls it.
  rotateGrant(
    input: RotateCloudflareProjectDnsGrantInput,
  ): Promise<CloudflareProjectDnsGrant | null>;
}

export interface CloudflareDomainReconciliationProviders {
  readonly dns: {
    observeGatewayWildcard(input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly hostname: "*.check.omh.st" | "*.dev.check.omh.st";
      readonly target: "check.omh.st" | "dev.check.omh.st";
    }): Promise<{ readonly recordId: string }>;
    reconcileRecords(input: {
      readonly zoneId: string;
      readonly zoneName: string;
      readonly records: readonly CloudflareDesiredDnsRecord[];
    }): Promise<{
      readonly status: "applied" | "replayed";
      readonly records: readonly CloudflareCustomerDnsRecord[];
    }>;
  };
  readonly routes: {
    observePlatformWildcardRoute(input: {
      readonly pattern: "*.check.omh.st/*" | "*.dev.check.omh.st/*";
      readonly scriptName: "ohmyho-gateway-production" | "ohmyho-gateway-poc-private-fullstack";
    }): Promise<CloudflareWorkerRouteReceipt>;
    createRoute(input: { readonly hostname: string; readonly scriptName: string }): Promise<{
      readonly outcome: "created" | "existing" | "recovered";
      readonly receipt: CloudflareWorkerRouteReceipt;
    }>;
  };
  readonly probe: (input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly deploymentId: Ulid;
    readonly environmentName: "dev" | "prod";
    readonly handle: string;
    readonly origin: string;
    readonly path: string;
    readonly method: "GET";
    readonly url: string;
  }) => Promise<{ readonly status: number }>;
}

export function createCloudflareDomainReconciliation(input: {
  readonly clock: { now(): Date };
  readonly platform: {
    readonly zoneId: string;
    readonly zoneName: "omh.st";
    readonly trafficCnameTarget: "dev.check.omh.st" | "check.omh.st";
  };
  readonly persistence: CloudflareDomainReconciliationPersistence;
  readonly providers: CloudflareDomainReconciliationProviders;
}) {
  return Object.freeze({
    async ensureEnvironment(raw: unknown) {
      const request = parseEnsureInput(raw);
      const state = await input.persistence.read(request);
      if (state === null) throw new CloudflareDomainReconciliationUnavailableError();
      const hostname =
        request.environmentName === "dev"
          ? state.domains.developmentDomain
          : state.domains.productionDomain;
      const address = projectEnvironmentAddress({
        projectId: request.projectId,
        handle: state.domains.handle,
        environmentName: request.environmentName,
        platform:
          input.platform.trafficCnameTarget === "check.omh.st" ? "production" : "development",
      });
      if (
        state.domains.zoneName !== input.platform.zoneName ||
        request.gatewayScriptName !==
          (input.platform.trafficCnameTarget === "check.omh.st"
            ? "ohmyho-gateway-production"
            : "ohmyho-gateway-poc-private-fullstack") ||
        hostname !== address.hostname
      ) {
        throw new CloudflareDomainReconciliationConflictError();
      }

      const wildcard =
        input.platform.trafficCnameTarget === "check.omh.st"
          ? ("*.check.omh.st" as const)
          : ("*.dev.check.omh.st" as const);
      const [dns, route] = await Promise.all([
        input.providers.dns.observeGatewayWildcard({
          zoneId: input.platform.zoneId,
          zoneName: input.platform.zoneName,
          hostname: wildcard,
          target: input.platform.trafficCnameTarget,
        }),
        input.providers.routes.observePlatformWildcardRoute({
          pattern: `${wildcard}/*`,
          scriptName: request.gatewayScriptName as
            | "ohmyho-gateway-production"
            | "ohmyho-gateway-poc-private-fullstack",
        }),
      ]);
      const publicUrl = `https://${hostname}`;
      const common = Object.freeze({
        environmentName: request.environmentName,
        hostname,
        dnsRecordId: dns.recordId,
        routeId: route.routeId,
        publicUrl,
        observedAt: route.observedAt.toISOString(),
      });
      // An existing project's exact route may still serve its old gateway during cutover.
      // Probe a separate hostname covered by the same wildcard before switching that route.
      const probeLabel = createHash("sha256")
        .update(
          [
            "shared-gateway-preflight",
            request.projectId,
            request.environmentId,
            request.operationId,
            request.deploymentId,
          ].join("\0"),
        )
        .digest("hex")
        .slice(0, 24);
      const probeOrigin = `https://gateway-probe-${probeLabel}.${input.platform.trafficCnameTarget}`;
      const probeUrl = new URL(request.healthCheckPath, `${probeOrigin}/`).href;
      let observed: { readonly status: number };
      try {
        observed = await input.providers.probe({
          organizationId: request.organizationId,
          projectId: request.projectId,
          environmentId: request.environmentId,
          operationId: request.operationId,
          deploymentId: request.deploymentId,
          environmentName: request.environmentName,
          handle: state.domains.handle,
          origin: probeOrigin,
          path: request.healthCheckPath,
          method: "GET",
          url: probeUrl,
        });
      } catch {
        return Object.freeze({ ...common, status: "pending" as const, probe: null });
      }
      if (!Number.isInteger(observed.status) || observed.status < 100 || observed.status > 599) {
        throw new CloudflareDomainReconciliationUnavailableError();
      }
      const observedAt = input.clock.now();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
        throw new CloudflareDomainReconciliationUnavailableError();
      }
      const probe = Object.freeze({
        url: probeUrl,
        status: observed.status,
        observedAt: observedAt.toISOString(),
      });
      return Object.freeze({
        ...common,
        status: observed.status === 404 ? ("ready" as const) : ("pending" as const),
        probe,
      });
    },
  });
}

export class CloudflareDomainReconciliationConflictError extends Error {
  public constructor() {
    super("Cloudflare domain reconciliation conflicts with durable project identity");
    this.name = "CloudflareDomainReconciliationConflictError";
  }
}

export class CloudflareDomainReconciliationUnavailableError extends Error {
  public constructor() {
    super("Cloudflare domain reconciliation is unavailable");
    this.name = "CloudflareDomainReconciliationUnavailableError";
  }
}

/**
 * A health-check path: a leading slash, then unreserved, sub-delimiter and percent characters with single slashes. The
 * check is linear; the nested quantifier it replaces backtracked exponentially on a long run followed by one bad character.
 */
function isHealthCheckPath(value: string): boolean {
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(value) && !value.includes("//");
}

function parseEnsureInput(value: unknown) {
  const record = exactRecord(value, [
    "environmentId",
    "environmentName",
    "deploymentId",
    "gatewayScriptName",
    "healthCheckPath",
    "operationId",
    "organizationId",
    "projectId",
  ]);
  const organizationId = parseUlid(String(record["organizationId"]));
  const projectId = parseUlid(String(record["projectId"]));
  const environmentId = parseUlid(String(record["environmentId"]));
  const operationId = parseUlid(String(record["operationId"]));
  const deploymentId = parseUlid(String(record["deploymentId"]));
  const environmentName = record["environmentName"];
  const gatewayScriptName = record["gatewayScriptName"];
  const healthCheckPath = record["healthCheckPath"];
  if (
    (environmentName !== "dev" && environmentName !== "prod") ||
    typeof gatewayScriptName !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(gatewayScriptName) ||
    typeof healthCheckPath !== "string" ||
    !isHealthCheckPath(healthCheckPath)
  ) {
    throw new TypeError("Cloudflare domain reconciliation input is invalid");
  }
  return Object.freeze({
    organizationId,
    projectId,
    environmentId,
    operationId,
    deploymentId,
    environmentName,
    gatewayScriptName,
    healthCheckPath,
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Cloudflare domain reconciliation input is invalid");
  }
  return record;
}
