import { parseUlid } from "@ohmyhost/platform";
import type {
  CloudflareCustomHostnameReceipt,
  CloudflareWorkerRouteReceipt,
} from "@ohmyhost/provider-cloudflare";
import {
  PaidDomainAlreadyConfiguredError,
  PaidDomainDeletingError,
  PaidDomainHostnameTakenError,
  PaidDomainKeyConflictError,
  PaidDomainProductionDeploymentRequiredError,
  type PaidDomainPersistence,
  type PaidDomainRecord,
  type PaidHostnameProof,
} from "./paid-domains.js";
export interface PaidDomainRuntimeBinding {
  readDomainPolicySync(input: unknown): Promise<unknown>;
  ackDomainPolicySync(input: unknown): Promise<unknown>;
  beginPaidDomainRecovery(input: unknown): Promise<unknown>;
  completePaidDomainRecovery(input: unknown): Promise<unknown>;
  admitPaidProjectDomain(
    input: Parameters<PaidDomainPersistence["accessReason"]>[0],
  ): ReturnType<PaidDomainPersistence["accessReason"]>;
  readPaidDomainTarget(input: Parameters<PaidDomainPersistence["readTarget"]>[0]): Promise<unknown>;
  claimPaidDomainApply(
    input: Parameters<PaidDomainPersistence["claimApply"]>[0] & { auditEventId: string },
  ): Promise<unknown>;
  putPaidDomainActive(input: Parameters<PaidDomainPersistence["putActive"]>[0]): Promise<unknown>;
  readPaidDomainRecord(input: Parameters<PaidDomainPersistence["read"]>[0]): Promise<unknown>;
  readPaidDomainProof(input: Parameters<PaidDomainPersistence["readProof"]>[0]): Promise<unknown>;
  ensurePaidDomainProof(
    input: Parameters<PaidDomainPersistence["ensureProof"]>[0],
  ): Promise<unknown>;
  verifyPaidDomainProof(
    input: Parameters<PaidDomainPersistence["verifyProof"]>[0],
  ): Promise<unknown>;
  claimPaidDomainDelete(
    input:
      | Parameters<PaidDomainPersistence["claimDelete"]>[0]
      | Omit<Parameters<PaidDomainPersistence["claimDelete"]>[0], "principalId" | "delegation">,
  ): Promise<unknown>;
  markPaidDomainDeleted(input: Parameters<PaidDomainPersistence["markDeleted"]>[0]): Promise<void>;
  claimPaidProjectDeletion(
    input: Parameters<PaidDomainPersistence["claimProjectDeletion"]>[0],
  ): Promise<unknown>;
}
function object(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid private Paid domain response");
  return value as Record<string, unknown>;
}
function receipt(value: unknown) {
  const r = object(value);
  if (typeof r["observedAt"] !== "string" && !(r["observedAt"] instanceof Date))
    throw new TypeError("Invalid Paid domain receipt time");
  const observedAt = new Date(r["observedAt"]);
  if (!Number.isFinite(observedAt.getTime()))
    throw new TypeError("Invalid Paid domain receipt time");
  return { ...r, observedAt };
}
function record(value: unknown): PaidDomainRecord | null {
  if (value === null) return null;
  const r = object(value);
  if (
    typeof r["organizationId"] !== "string" ||
    typeof r["projectId"] !== "string" ||
    typeof r["hostname"] !== "string" ||
    !(r["gatewayScriptName"] === null || typeof r["gatewayScriptName"] === "string") ||
    !["awaiting_deployment", "pending", "active", "deleting", "deleted", "displaced"].includes(
      String(r["state"]),
    ) ||
    typeof r["hostnameProven"] !== "boolean"
  )
    throw new TypeError("Invalid private Paid domain record");
  return {
    organizationId: parseUlid(r["organizationId"]),
    projectId: parseUlid(r["projectId"]),
    hostname: r["hostname"],
    gatewayScriptName: r["gatewayScriptName"],
    state: r["state"] as PaidDomainRecord["state"],
    customHostnameReceipt:
      r["customHostnameReceipt"] === null
        ? null
        : (receipt(r["customHostnameReceipt"]) as unknown as CloudflareCustomHostnameReceipt),
    workerRouteReceipt:
      r["workerRouteReceipt"] === null
        ? null
        : (receipt(r["workerRouteReceipt"]) as unknown as CloudflareWorkerRouteReceipt),
    hostnameProven: r["hostnameProven"],
  };
}
function proof(value: unknown): PaidHostnameProof | null {
  if (value === null) return null;
  const r = object(value);
  if (
    typeof r["organizationId"] !== "string" ||
    typeof r["projectId"] !== "string" ||
    typeof r["hostname"] !== "string" ||
    (r["state"] !== "pending" && r["state"] !== "verified") ||
    typeof r["challengeName"] !== "string" ||
    typeof r["challengeValue"] !== "string" ||
    typeof r["declaredAt"] !== "string" ||
    (r["verifiedAt"] !== null && typeof r["verifiedAt"] !== "string") ||
    (r["expiresAt"] !== null && typeof r["expiresAt"] !== "string")
  )
    throw new TypeError("Invalid Paid hostname proof");
  return {
    organizationId: parseUlid(r["organizationId"]),
    projectId: parseUlid(r["projectId"]),
    hostname: r["hostname"],
    state: r["state"],
    challengeName: r["challengeName"],
    challengeValue: r["challengeValue"],
    declaredAt: r["declaredAt"],
    verifiedAt: r["verifiedAt"] as string | null,
    expiresAt: r["expiresAt"] as string | null,
  };
}
async function invoke<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "PaidDomainHostnameTakenError")
        throw new PaidDomainHostnameTakenError(error.message);
      if (error.name === "PaidDomainKeyConflictError")
        throw new PaidDomainKeyConflictError(error.message);
      if (error.name === "PaidDomainAlreadyConfiguredError")
        throw new PaidDomainAlreadyConfiguredError(error.message);
      if (error.name === "PaidDomainDeletingError")
        throw new PaidDomainDeletingError(error.message);
      if (error.name === "PaidDomainProductionDeploymentRequiredError")
        throw new PaidDomainProductionDeploymentRequiredError(error.message);
    }
    throw error;
  }
}
export type NativePaidDomainRuntimeBinding = Pick<
  PaidDomainRuntimeBinding,
  | "readDomainPolicySync"
  | "ackDomainPolicySync"
  | "beginPaidDomainRecovery"
  | "completePaidDomainRecovery"
>;
export type PaidDomainBaseRuntimeBinding = Omit<
  PaidDomainRuntimeBinding,
  keyof NativePaidDomainRuntimeBinding
>;
type DeleteClaim = Parameters<PaidDomainPersistence["claimDelete"]>[0];
type DeleteMark = Parameters<PaidDomainPersistence["markDeleted"]>[0];
interface DeleteWire {
  claim(input: DeleteClaim): DeleteClaim | Omit<DeleteClaim, "principalId" | "delegation">;
  mark(input: DeleteMark): DeleteMark;
}
const scope = (input: { organizationId: string; projectId: string }) => ({
  organizationId: parseUlid(input.organizationId),
  projectId: parseUlid(input.projectId),
});
const fullDeleteWire: DeleteWire = {
  claim: (input) => ({
    ...scope(input),
    hostname: input.hostname,
    principalId: input.principalId,
    ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
    idempotencyKeySha256: input.idempotencyKeySha256,
    requestSha256: input.requestSha256,
    now: input.now,
  }),
  mark: (input) => ({
    ...scope(input),
    hostname: input.hostname,
    ...(input.idempotencyKeySha256 === undefined
      ? {}
      : { idempotencyKeySha256: input.idempotencyKeySha256 }),
    now: input.now,
  }),
};
const legacyProductionDeleteWire: DeleteWire = {
  claim: (input) => ({
    ...scope(input),
    hostname: input.hostname,
    idempotencyKeySha256: input.idempotencyKeySha256,
    requestSha256: input.requestSha256,
    now: input.now,
  }),
  mark: (input) => ({ ...scope(input), hostname: input.hostname, now: input.now }),
};
export function createD1PaidDomainPersistence(
  binding: PaidDomainRuntimeBinding,
  ids: { next(): string },
): PaidDomainPersistence {
  return createPaidPersistence(binding, ids, fullDeleteWire);
}
export function createLegacyProductionD1PaidDomainPersistence(
  binding: PaidDomainBaseRuntimeBinding,
  ids: { next(): string },
): PaidDomainPersistence {
  return createPaidPersistence(binding, ids, legacyProductionDeleteWire);
}
function createPaidPersistence(
  binding: PaidDomainBaseRuntimeBinding,
  ids: { next(): string },
  deletion: DeleteWire,
): PaidDomainPersistence {
  return Object.freeze<PaidDomainPersistence>({
    accessReason: (input) =>
      invoke(() => binding.admitPaidProjectDomain({ ...scope(input), now: input.now })),
    readTarget: async (input) => {
      const r = await invoke(() => binding.readPaidDomainTarget(scope(input)));
      if (r === null || r === "production_deployment_required") return r;
      const value = object(r);
      if (typeof value["gatewayScriptName"] !== "string")
        throw new TypeError("Invalid Paid domain target");
      return { gatewayScriptName: value["gatewayScriptName"] };
    },
    claimApply: async (input) => {
      const raw = await invoke(() =>
          binding.claimPaidDomainApply({
            ...scope(input),
            hostname: input.hostname,
            gatewayScriptName: input.gatewayScriptName,
            principalId: input.principalId,
            idempotencyKeySha256: input.idempotencyKeySha256,
            requestSha256: input.requestSha256,
            now: input.now,
            auditEventId: ids.next(),
          }),
        ),
        r = record(raw);
      if (
        !r ||
        typeof object(raw)["gatewayRetarget"] !== "boolean" ||
        typeof object(raw)["sameConnection"] !== "boolean"
      )
        throw new TypeError("Invalid Paid domain apply response");
      return {
        ...r,
        gatewayRetarget: object(raw)["gatewayRetarget"] as boolean,
        sameConnection: object(raw)["sameConnection"] as boolean,
      };
    },
    putActive: async (input) => {
      const r = record(
        await invoke(() =>
          binding.putPaidDomainActive({
            ...scope(input),
            hostname: input.hostname,
            gatewayScriptName: input.gatewayScriptName,
            idempotencyKeySha256: input.idempotencyKeySha256,
            requestSha256: input.requestSha256,
            customHostnameReceipt: input.customHostnameReceipt,
            workerRouteReceipt: input.workerRouteReceipt,
            now: input.now,
          }),
        ),
      );
      if (!r) throw new TypeError("Missing Paid domain active receipt");
      return r;
    },
    read: async (input) => record(await invoke(() => binding.readPaidDomainRecord(scope(input)))),
    readProof: async (input) =>
      proof(
        await invoke(() =>
          binding.readPaidDomainProof({
            ...scope(input),
            hostname: input.hostname,
            now: input.now,
          }),
        ),
      ),
    ensureProof: async (input) =>
      proof(
        await invoke(() =>
          binding.ensurePaidDomainProof({
            ...scope(input),
            hostname: input.hostname,
            challengeValue: input.challengeValue,
            now: input.now,
          }),
        ),
      ),
    verifyProof: async (input) =>
      proof(
        await invoke(() =>
          binding.verifyPaidDomainProof({
            ...scope(input),
            hostname: input.hostname,
            challengeValue: input.challengeValue,
            now: input.now,
            expiresAt: input.expiresAt,
          }),
        ),
      ),
    claimDelete: async (input) =>
      record(await invoke(() => binding.claimPaidDomainDelete(deletion.claim(input)))),
    markDeleted: (input) => invoke(() => binding.markPaidDomainDeleted(deletion.mark(input))),
    claimProjectDeletion: async (input) =>
      record(
        await invoke(() =>
          binding.claimPaidProjectDeletion({
            ...scope(input),
            operationId: input.operationId,
            now: input.now,
          }),
        ),
      ),
  });
}
