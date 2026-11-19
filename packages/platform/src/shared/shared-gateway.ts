import { parseBrowserPolicy, type BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import { parseUlid } from "./ulid.js";

export interface SharedGatewayScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export function sharedGatewayScriptName(namespace: string): string {
  switch (namespace) {
    case "sandbox":
    case "ohmyho-sandbox":
      return "ohmyho-gateway-sandbox";
    case "ohmyho-poc-private-fullstack":
      return "ohmyho-gateway-poc-private-fullstack";
    case "ohmyho-production":
      return "ohmyho-gateway-production";
    default:
      throw new TypeError("Unknown shared gateway namespace");
  }
}

export interface SharedGatewayMutation extends SharedGatewayScope {
  readonly operationId: string;
  readonly claimId: string;
  readonly expectedRevision: number | null;
}

export interface SharedGatewayActivation extends SharedGatewayMutation {
  readonly candidateReceiptId: string;
  readonly egressAllowedOrigins: readonly string[];
  readonly browserPolicy?: BrowserPolicy;
}

export interface SharedGatewayCandidateRemoval extends SharedGatewayScope {
  readonly operationId: string;
  readonly claimId: string;
  readonly candidateReceiptId: string;
  readonly productDeploymentId: string;
  readonly scriptName: string;
  readonly providerTag: string;
}

export interface SharedGatewayReceipt extends SharedGatewayScope {
  readonly provider: "ohmyhost-shared-gateway";
  readonly environmentName: "dev" | "prod";
  readonly handle: string;
  readonly hostname: string;
  readonly publicOrigin: string;
  readonly targetDeploymentId: string;
  readonly targetScriptName: string;
  readonly targetArtifactDigest: `sha256:${string}`;
  readonly targetProviderTag: string;
  readonly egressPolicyDigest: `sha256:${string}`;
  readonly egressAllowedOrigins: readonly string[];
  readonly browserPolicy?: BrowserPolicy;
  readonly candidateReceiptId: string;
  readonly revision: number;
  readonly predecessorRevision: number | null;
  readonly operationId: string;
  readonly active: boolean;
  readonly observedAt: Date;
}

/** Control adds its current platform signing public key before crossing the routing binding. */
export type SharedGatewayResolution = Pick<
  SharedGatewayReceipt,
  | "organizationId"
  | "projectId"
  | "environmentId"
  | "environmentName"
  | "handle"
  | "hostname"
  | "publicOrigin"
  | "targetDeploymentId"
  | "targetScriptName"
  | "egressAllowedOrigins"
  | "browserPolicy"
> & {
  /** The owning organization shows the "Powered by ohmyho.st" flag on this production site. */
  readonly poweredBy: boolean;
  /** Native capability is derived from the active deployment and current Core generation. */
  readonly nativeAuth?:
    | {
        readonly realmGeneration: number;
        readonly configurationRevision: number;
        readonly region: "us" | "eu";
      }
    | {
        readonly realmGeneration: null;
        readonly configurationRevision: null;
        readonly region: "us" | "eu";
      };
};

/** The current receipt is the only accepted wire contract; historical Cloudflare snapshots are not runtime inputs. */
export function parseSharedGatewayReceipt(input: unknown): SharedGatewayReceipt {
  const keys = [
    "provider",
    "organizationId",
    "projectId",
    "environmentId",
    "environmentName",
    "handle",
    "hostname",
    "publicOrigin",
    "targetDeploymentId",
    "targetScriptName",
    "targetArtifactDigest",
    "targetProviderTag",
    "egressPolicyDigest",
    "egressAllowedOrigins",
    "candidateReceiptId",
    "revision",
    "predecessorRevision",
    "operationId",
    "active",
    "observedAt",
  ];
  if (input !== null && typeof input === "object" && "browserPolicy" in input)
    keys.push("browserPolicy");
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== keys.sort().join(",")
  )
    throw new TypeError("Shared gateway receipt is invalid");
  const value = input as Record<string, unknown>;
  for (const name of [
    "organizationId",
    "projectId",
    "environmentId",
    "targetDeploymentId",
    "candidateReceiptId",
    "operationId",
  ]) {
    if (typeof value[name] !== "string")
      throw new TypeError("Shared gateway receipt scope is invalid");
    parseUlid(value[name]);
  }
  if (
    value["provider"] !== "ohmyhost-shared-gateway" ||
    (value["environmentName"] !== "dev" && value["environmentName"] !== "prod") ||
    typeof value["handle"] !== "string" ||
    value["handle"].length < 3 ||
    value["handle"].length > 59 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+){0,4}$/u.test(value["handle"]) ||
    typeof value["publicOrigin"] !== "string" ||
    !isDnsEgressOrigin(value["publicOrigin"]) ||
    new URL(value["publicOrigin"]).hostname !== value["hostname"] ||
    value["targetScriptName"] !==
      `p-${String(value["projectId"]).toLowerCase()}-${value["environmentName"]}-${String(value["targetDeploymentId"]).toLowerCase()}`
  )
    throw new TypeError("Shared gateway receipt identity is invalid");
  for (const name of ["targetArtifactDigest", "egressPolicyDigest"])
    if (typeof value[name] !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value[name]))
      throw new TypeError("Shared gateway receipt digest is invalid");
  if (
    typeof value["targetProviderTag"] !== "string" ||
    value["targetProviderTag"].length < 1 ||
    value["targetProviderTag"].length > 255 ||
    value["targetProviderTag"].trim() !== value["targetProviderTag"] ||
    /\p{Cc}/u.test(value["targetProviderTag"]) ||
    typeof value["active"] !== "boolean" ||
    typeof value["revision"] !== "number" ||
    !Number.isSafeInteger(value["revision"]) ||
    value["revision"] < 1 ||
    // A null predecessor is a root: the first revision, or a first deployment after failed history.
    (value["predecessorRevision"] !== null &&
      (typeof value["predecessorRevision"] !== "number" ||
        !Number.isSafeInteger(value["predecessorRevision"]) ||
        value["predecessorRevision"] < 1 ||
        value["predecessorRevision"] >= value["revision"]))
  )
    throw new TypeError("Shared gateway receipt version is invalid");
  const origins = value["egressAllowedOrigins"];
  if (
    !Array.isArray(origins) ||
    origins.length > 16 ||
    origins.some(
      (origin, index) =>
        typeof origin !== "string" ||
        !isDnsEgressOrigin(origin) ||
        (index > 0 && String(origins[index - 1]) >= origin),
    )
  )
    throw new TypeError("Shared gateway receipt egress is invalid");
  const observed = value["observedAt"];
  const observedAt =
    observed instanceof Date
      ? new Date(observed.getTime())
      : typeof observed === "string"
        ? new Date(observed)
        : null;
  if (
    observedAt === null ||
    !Number.isFinite(observedAt.getTime()) ||
    (typeof observed === "string" && observedAt.toISOString() !== observed)
  )
    throw new TypeError("Shared gateway receipt observation is invalid");
  return Object.freeze({
    ...value,
    egressAllowedOrigins: Object.freeze([...origins]),
    ...(value["browserPolicy"] === undefined
      ? {}
      : { browserPolicy: parseBrowserPolicy(value["browserPolicy"]) }),
    observedAt,
  }) as unknown as SharedGatewayReceipt;
}
