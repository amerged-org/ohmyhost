import { z } from "zod";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { isDnsEgressOrigin } from "@ohmyhost/contracts/egress-origin";
import { CommandConflictError } from "../../run-command.js";
import { ulid } from "../common.js";

export class SharedGatewayConflictError extends CommandConflictError {
  constructor() {
    super("shared_gateway_conflict", "Shared gateway routing conflicts with current project state");
    this.name = "SharedGatewayConflictError";
  }
}
export const scopeInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
});
export const mutationInput = scopeInput.extend({
  operationId: ulid,
  claimId: ulid,
  expectedRevision: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1)
    .nullable(),
});
export function canonicalHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value.includes(".") &&
    value.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))
  );
}
export function canonicalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === value &&
      parsed.port === "" &&
      canonicalHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}
const origin = z.string().refine(isDnsEgressOrigin);
export const activateInput = mutationInput.extend({
  candidateReceiptId: ulid,
  egressAllowedOrigins: z
    .array(origin)
    .max(16)
    .refine((origins) =>
      origins.every((value, index) => index === 0 || String(origins[index - 1]) < value),
    ),
  browserPolicy: z.unknown().transform(parseBrowserPolicy).optional(),
});
export const removalInput = scopeInput.extend({
  operationId: ulid,
  claimId: ulid,
  candidateReceiptId: ulid,
  productDeploymentId: ulid,
  scriptName: z.string(),
  providerTag: z.string().regex(/^[a-f0-9]{32}$/u),
});
export const probeInput = scopeInput.extend({ deploymentId: ulid, windowId: ulid });
export const resolveInput = z.strictObject({ hostname: z.string().refine(canonicalHostname) });
export type Scope = z.output<typeof scopeInput>;
export type Mutation = z.output<typeof mutationInput>;
export type Activation = z.output<typeof activateInput>;
export type Row = Readonly<Record<string, unknown>>;
