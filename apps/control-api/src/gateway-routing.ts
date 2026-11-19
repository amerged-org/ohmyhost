import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { digestDevAccessPublicJwk, validateDevAccessPublicJwk } from "@ohmyhost/dev-access-tokens";
import type { SharedGatewayActivation, SharedGatewayMutation } from "@ohmyhost/platform";
import { createD1GatewayPersistence, selectD1GatewayBindings } from "./d1-gateway-routing.js";

export interface GatewayRoutingBindings {
  readonly GATEWAY_LOOKUP_RUNTIME?: unknown;
  readonly GATEWAY_MANAGEMENT_RUNTIME?: unknown;
  readonly DEV_ACCESS_SESSION_PUBLIC_JWK: string;
}

const devAccessKeys = new Map<string, Promise<{ keyId: string; publicJwk: JsonWebKey }>>();

/** The public key is a deploy-time secret: one validation (or rejection) per isolate serves every request. */
function devAccessKey(secret: string) {
  let key = devAccessKeys.get(secret);
  if (key === undefined) {
    key = (async () => {
      const publicJwk = await validateDevAccessPublicJwk(
        globalThis.crypto,
        JSON.parse(secret) as JsonWebKey,
      );
      return { keyId: await digestDevAccessPublicJwk(globalThis.crypto, publicJwk), publicJwk };
    })();
    devAccessKeys.set(secret, key);
  }
  return key;
}

/** Separate private bindings grant lookup and mutation authority independently. */
export function createGatewayRoutingHandlers(bindings: GatewayRoutingBindings) {
  const d1 = createD1GatewayPersistence(selectD1GatewayBindings(bindings));
  return {
    async resolve(input: unknown) {
      const value = exact(input, ["hostname"]);
      if (typeof value["hostname"] !== "string") throw new TypeError("Invalid gateway hostname");
      const target = await d1.resolve({ hostname: value["hostname"] });
      if (target === null) return null;
      if (target.environmentName === "prod") return { ...target, devAccess: null };
      return { ...target, devAccess: await devAccessKey(bindings.DEV_ACCESS_SESSION_PUBLIC_JWK) };
    },
    activate(input: unknown) {
      return d1.activate(mutation(input, true));
    },
    observe(input: unknown) {
      return d1.observe(identity(exact(input, ["organizationId", "projectId", "environmentId"])));
    },
    remove(input: unknown) {
      return d1.remove(mutation(input, false));
    },
    compensate(input: unknown) {
      return d1.compensate(mutation(input, false));
    },
    authorizeCandidateRemoval(input: unknown) {
      const value = exact(input, [
        "organizationId",
        "projectId",
        "environmentId",
        "operationId",
        "claimId",
        "candidateReceiptId",
        "productDeploymentId",
        "scriptName",
        "providerTag",
      ]);
      const scope = identity(value);
      const productDeploymentId = id(value["productDeploymentId"]);
      const scriptName = `p-${scope.projectId.toLowerCase()}-`;
      if (
        typeof value["scriptName"] !== "string" ||
        !value["scriptName"].startsWith(scriptName) ||
        !value["scriptName"].endsWith(`-${productDeploymentId.toLowerCase()}`) ||
        typeof value["providerTag"] !== "string" ||
        !/^[a-f0-9]{32}$/u.test(value["providerTag"])
      )
        throw new TypeError("Invalid candidate removal identity");
      return d1.authorizeCandidateRemoval({
        ...scope,
        operationId: id(value["operationId"]),
        claimId: id(value["claimId"]),
        candidateReceiptId: id(value["candidateReceiptId"]),
        productDeploymentId,
        scriptName: value["scriptName"] as string,
        providerTag: value["providerTag"] as string,
      });
    },
  };
}

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new TypeError("Invalid gateway routing request");
  return input as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value))
    throw new TypeError("Invalid gateway routing identity");
  return value;
}

function identity(value: Record<string, unknown>) {
  return {
    organizationId: id(value["organizationId"]),
    projectId: id(value["projectId"]),
    environmentId: id(value["environmentId"]),
  };
}

function mutation(input: unknown, activation: true): SharedGatewayActivation;
function mutation(input: unknown, activation: false): SharedGatewayMutation;
function mutation(
  input: unknown,
  activation: boolean,
): SharedGatewayActivation | SharedGatewayMutation {
  const value = exact(input, [
    "organizationId",
    "projectId",
    "environmentId",
    "operationId",
    "claimId",
    "expectedRevision",
    ...(activation ? ["candidateReceiptId", "egressAllowedOrigins"] : []),
    ...(activation &&
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "browserPolicy")
      ? ["browserPolicy"]
      : []),
  ]);
  const expectedRevision = value["expectedRevision"];
  if (
    (expectedRevision !== null || !activation) &&
    (typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1)
  )
    throw new TypeError("Invalid gateway routing revision");
  const base = {
    ...identity(value),
    operationId: id(value["operationId"]),
    claimId: id(value["claimId"]),
    expectedRevision: expectedRevision as number | null,
  };
  if (!activation) return { ...base, expectedRevision: base.expectedRevision as number };
  const origins = value["egressAllowedOrigins"];
  if (
    !Array.isArray(origins) ||
    origins.length > 16 ||
    origins.some((origin) => typeof origin !== "string")
  )
    throw new TypeError("Invalid gateway egress policy");
  return {
    ...base,
    candidateReceiptId: id(value["candidateReceiptId"]),
    egressAllowedOrigins: origins as string[],
    ...(Object.hasOwn(value, "browserPolicy")
      ? { browserPolicy: parseBrowserPolicy(value["browserPolicy"]) }
      : {}),
  };
}
