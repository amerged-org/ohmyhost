import { z } from "zod";

import { ulid, instant } from "../common.js";
import { CommandConflictError } from "../../run-command.js";

export class BuildInputConflictError extends CommandConflictError {
  constructor() {
    super("build_input_conflict");
  }
}

/** The organization already holds its open build capacity; a settled build frees one slot. */
export class BuildCapacityReachedError extends CommandConflictError {
  constructor() {
    super("build_capacity_reached");
  }
}

export const buildScope = z.strictObject({
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
});
export type BuildScope = z.output<typeof buildScope>;
const claimId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const claimInput = z.strictObject({
  scope: buildScope,
  inputFingerprint: fingerprint,
  claimId,
  leaseMilliseconds: z.number().int().min(1).max(300_000),
});
export type ClaimInput = z.output<typeof claimInput>;
export const authorizeInput = z.strictObject({ scope: buildScope, claimId });
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim() === v);
export const receiptInput = z.strictObject({
  scope: buildScope,
  buildId: label(512),
  projectName: label(255),
});
export const completionInput = z.strictObject({
  receipt: receiptInput,
  inputFingerprint: fingerprint,
  claimId,
});
export type CompletionInput = z.output<typeof completionInput>;
// The existing BuildRunner wire carries canonical JavaScript ISO instants. The stored representation retains microseconds.
const timestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
  .pipe(instant);
export const usageInput = z.strictObject({
  receipt: receiptInput,
  usage: z
    .strictObject({
      runner: z.literal("cloudflare-build-sandbox"),
      instanceType: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
      status: z.enum(["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"]),
      startedAt: timestamp,
      provisioningStartedAt: timestamp.nullable(),
      completedAt: timestamp,
    })
    .refine(
      (v) =>
        v.completedAt >= v.startedAt &&
        (v.provisioningStartedAt === null ||
          (v.provisioningStartedAt >= v.startedAt && v.provisioningStartedAt <= v.completedAt)),
    ),
});
export type UsageInput = z.output<typeof usageInput>;

export type BuildClaimResult =
  | {
      readonly status: "claimed";
      readonly mode: "start" | "observe";
      readonly attemptNumber: number;
      readonly reservationCreatedAt: Date;
      readonly startAllowedUntil: Date;
      readonly leaseExpiresAt: Date;
    }
  | { readonly status: "pending"; readonly leaseExpiresAt: Date; readonly startAllowedUntil: Date }
  | { readonly status: "completed"; readonly envelope: CompletionInput };

export interface BuildRuntimeBinding {
  claimBuildInput(input: unknown): Promise<BuildClaimResult>;
  authorizeBuildStart(input: unknown): Promise<boolean>;
  putBuildReceipt(input: unknown): Promise<void>;
  putBuildUsage(input: unknown): Promise<void>;
}
