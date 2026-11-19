import { z } from "zod";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  parseSharedGatewayReceipt,
  type SharedGatewayScope,
  type SharedGatewayMutation,
  type SharedGatewayActivation,
  type SharedGatewayCandidateRemoval,
  type SharedGatewayResolution,
  type SharedGatewayReceipt,
} from "@ohmyhost/platform";

const unavailable = (): never => {
  throw new Error("Gateway routing is unavailable");
};
const forbidden = (key: string) =>
  ["CONTROL_CORE", "CONTROL_GLOBAL", "CONTROL_DIRECTORY"].includes(key) ||
  /^CONTROL_SHARD_[0-9]+$/u.test(key);
/** A private capability binding is the only Core authority in the API Worker; a direct Core binding is refused. */
export function selectD1GatewayBindings(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return unavailable();
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || forbidden(key)))
    return unavailable();
  return value;
}
function capability<T>(
  bindings: Record<string, unknown>,
  key: string,
  methods: readonly string[],
): T {
  const value = bindings[key];
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    methods.some((method) => typeof Reflect.get(value, method) !== "function")
  )
    return unavailable();
  return value as T;
}
interface Lookup {
  resolve(input: { hostname: string }): Promise<unknown>;
}
interface Management {
  activate(input: SharedGatewayActivation): Promise<unknown>;
  observe(input: SharedGatewayScope): Promise<unknown>;
  remove(input: SharedGatewayMutation): Promise<unknown>;
  compensate(input: SharedGatewayMutation): Promise<unknown>;
  authorizeCandidateRemoval(input: SharedGatewayCandidateRemoval): Promise<unknown>;
}
const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const nativeRevision = z.number().int().min(1).max(2147483647);
const nativeAuth = z.union([
  z.strictObject({
    region: z.enum(["us", "eu"]),
    realmGeneration: nativeRevision,
    configurationRevision: nativeRevision,
  }),
  z.strictObject({
    region: z.enum(["us", "eu"]),
    realmGeneration: z.null(),
    configurationRevision: z.null(),
  }),
]);
const resolution = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  environmentName: z.enum(["dev", "prod"]),
  handle: z.string(),
  hostname: z.string(),
  publicOrigin: z.string(),
  targetDeploymentId: id,
  targetScriptName: z.string(),
  egressAllowedOrigins: z.array(z.string()).max(16),
  browserPolicy: z.unknown().transform(parseBrowserPolicy).optional(),
  nativeAuth: nativeAuth.optional(),
  poweredBy: z.boolean(),
});
async function closed<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return unavailable();
  }
}
function receipt(raw: unknown, scope: SharedGatewayScope): SharedGatewayReceipt {
  const value = parseSharedGatewayReceipt(raw);
  if (
    value.organizationId !== scope.organizationId ||
    value.projectId !== scope.projectId ||
    value.environmentId !== scope.environmentId
  )
    return unavailable();
  return value;
}
/** The API keeps the existing lookup/mutation service split; neither consumer receives a raw SQL command. */
export function createD1GatewayPersistence(bindings: Record<string, unknown>) {
  const management = () =>
    capability<Management>(bindings, "GATEWAY_MANAGEMENT_RUNTIME", [
      "activate",
      "observe",
      "remove",
      "compensate",
      "authorizeCandidateRemoval",
    ]);
  return {
    resolve: (input: { hostname: string }): Promise<SharedGatewayResolution | null> =>
      closed(async () => {
        const raw = await capability<Lookup>(bindings, "GATEWAY_LOOKUP_RUNTIME", [
          "resolve",
        ]).resolve(input);
        if (raw === null) return null;
        const value = resolution.parse(raw);
        if (
          value.hostname !== input.hostname ||
          value.targetScriptName !==
            `p-${value.projectId.toLowerCase()}-${value.environmentName}-${value.targetDeploymentId.toLowerCase()}`
        )
          return unavailable();
        return value;
      }),
    activate: (input: SharedGatewayActivation) =>
      closed(async () => receipt(await management().activate(input), input)),
    observe: (input: SharedGatewayScope) =>
      closed(async () => {
        const value = await management().observe(input);
        return value === null ? null : receipt(value, input);
      }),
    remove: (input: SharedGatewayMutation) =>
      closed(async () => receipt(await management().remove(input), input)),
    compensate: (input: SharedGatewayMutation) =>
      closed(async () => receipt(await management().compensate(input), input)),
    authorizeCandidateRemoval: (input: SharedGatewayCandidateRemoval) =>
      closed(async () => {
        const value = z
          .strictObject({ authorized: z.literal(true) })
          .parse(await management().authorizeCandidateRemoval(input));
        return value;
      }),
  };
}

/** This separate capability grants only the fixed accounting probe; it cannot mutate a route or select an expiry. */
export async function beginD1RuntimeProbe(
  bindings: Record<string, unknown>,
  input: SharedGatewayScope & { deploymentId: string; windowId: string },
): Promise<{ expiresAt: string }> {
  return closed(async () => {
    const runtime = capability<{ beginProbe(input: unknown): Promise<unknown> }>(
      bindings,
      "RUNTIME_PROBE_RUNTIME",
      ["beginProbe"],
    );
    const value = z
      .strictObject({
        expiresAt: z
          .string()
          .refine((at) => Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at),
      })
      .parse(await runtime.beginProbe(input));
    return value;
  });
}
