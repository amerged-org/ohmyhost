import { z } from "zod";
import { parseSharedGatewayReceipt } from "@ohmyhost/platform";
import { CommandConflictError } from "../../run-command.js";
import { storedTimestamp } from "../../timestamps.js";
import { ulid } from "../common.js";

export class DeliveryInputError extends CommandConflictError {
  constructor() {
    super("runtime_secret_delivery_input", "Runtime secret delivery input is invalid");
    this.name = "RuntimeSecretDeliveryInputError";
  }
}
export class DeliveryScopeError extends CommandConflictError {
  constructor() {
    super("runtime_secret_delivery_scope", "Runtime secret delivery scope is not active");
    this.name = "RuntimeSecretDeliveryScopeError";
  }
}
export class DeliveryLeaseError extends CommandConflictError {
  constructor() {
    super("runtime_secret_delivery_lease", "Runtime secret delivery lease is stale");
    this.name = "RuntimeSecretDeliveryLeaseError";
  }
}
export class ManifestAuthorityError extends CommandConflictError {
  constructor() {
    super(
      "runtime_secret_manifest",
      "Runtime secret manifest does not match the stored secrets of the environment",
    );
    this.name = "RuntimeSecretManifestAuthorityError";
  }
}
export class DeliveryConflictError extends CommandConflictError {
  constructor() {
    super(
      "runtime_secret_delivery_conflict",
      "Runtime secret delivery evidence conflicts with the stored receipt",
    );
    this.name = "RuntimeSecretDeliveryConflictError";
  }
}
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try {
    return schema.parse(raw);
  } catch {
    throw new DeliveryInputError();
  }
}
/** The existing runtime supplies canonical millisecond instants; SQL keeps the corresponding exact UTC6 form. */
export const clock = z
  .string()
  .refine((value) => {
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString() === value;
  })
  .transform(storedTimestamp);
export const scope = z.strictObject({ organizationId: ulid, projectId: ulid, environmentId: ulid });
export type Scope = z.output<typeof scope>;
export const safe = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const positive = safe.min(1);
export const trigger = z.enum(["deploy", "rollback", "promotion", "reconcile"]);
export const providerTag = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u);
export const name = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u);
export const names = z
  .array(name)
  .max(100)
  .refine((values) =>
    values.every((value, index) => index === 0 || String(values[index - 1]) < value),
  );
export const bytes32 = z
  .instanceof(Uint8Array)
  .refine((value) => value.byteLength === 32)
  .transform((value) => Uint8Array.from(value));
export const claimInput = scope
  .extend({
    trigger,
    runtimeProvider: z.literal("wfp"),
    operationId: ulid.optional(),
    force: z.boolean().optional(),
    leaseId: ulid,
    claimedAt: clock,
    leaseMilliseconds: positive.max(900000),
  })
  .refine(
    (value) =>
      (value.trigger === "reconcile"
        ? value.operationId === undefined
        : value.operationId !== undefined) &&
      (value.force !== true || value.trigger === "reconcile"),
  );
export const failInput = scope.extend({
  leaseId: ulid,
  generation: safe,
  releaseSequence: positive,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
  failedAt: clock,
});
export const releaseInput = scope.extend({
  leaseId: ulid,
  generation: safe,
  releaseSequence: positive,
  releasedAt: clock,
});
export const stageInput = scope
  .extend({
    stageReceiptId: ulid,
    operationId: ulid,
    productDeploymentId: ulid,
    candidateReceiptId: ulid,
    leaseId: ulid,
    generation: safe,
    releaseSequence: positive,
    trigger,
    providerTag,
    appliedSecretNames: names,
    manifestSha256: bytes32,
    manifestSecretCount: safe.max(100),
    stagedAt: clock,
  })
  .refine((value) => value.manifestSecretCount === value.appliedSecretNames.length);
export const activateInput = scope.extend({
  activationReceiptId: ulid,
  stageReceiptId: ulid,
  operationId: ulid,
  productDeploymentId: ulid,
  candidateReceiptId: ulid,
  candidateScriptName: z.string().regex(/^p-[0-9a-z]{26}-(?:dev|prod)-[0-9a-z]{26}$/u),
  candidateProviderTag: providerTag,
  candidateArtifactDigest: bytes32,
  gateway: z.unknown().transform(parseSharedGatewayReceipt),
  activatedAt: clock,
});
export const compensateInput = scope.extend({
  compensationReceiptId: ulid,
  stageReceiptId: ulid,
  candidateReceiptId: ulid,
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
  compensatedAt: clock,
});
export const pendingInput = z.strictObject({ now: clock, limit: positive.max(128) });
/** A WFP manifest is authorized by the names and revisions it carries; the values never reach Core. */
export const manifestAuthorityInput = scope.extend({
  secrets: z.array(z.strictObject({ name, revision: positive })).max(100),
});
export const recordedInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  environmentName: z.enum(["dev", "prod"]),
  candidateReceiptId: ulid,
});
export const sealedInput = scope.extend({
  operationId: ulid,
  claimId: ulid,
  name,
  ciphertext: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength >= 17 && value.byteLength <= 65552)
    .transform((value) => Uint8Array.from(value)),
  nonce: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength === 12)
    .transform((value) => Uint8Array.from(value)),
  valueSha256: bytes32,
  keyVersion: positive.max(2147483647),
  writtenAt: clock,
});
export const promotionMailInput = scope.extend({ operationId: ulid, claimId: ulid });
export type Row = Record<string, unknown>;
/** Cast all native int8 to SQL text before D1 crosses the JS boundary. Runtime refuses unsafe counters like PG. */
export function integer(raw: unknown, minimum = 0): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new DeliveryInputError();
  return value;
}
export function storedNames(raw: unknown): string[] {
  try {
    return names.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    throw new DeliveryInputError();
  }
}
