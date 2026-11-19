import { parseUlid } from "@ohmyhost/platform";

import type { ProviderReconciliationPort } from "./contracts.js";

export interface ProviderReconciliationBinding {
  reconcile(input: unknown): Promise<unknown>;
}

export class ProviderReconciliationExhaustedError extends Error {
  constructor() {
    super("Provider reconciliation attempts are exhausted");
    this.name = "ProviderReconciliationExhaustedError";
  }
}

export class ProviderReconciliationUnavailableError extends Error {
  constructor() {
    super("Provider reconciliation is unavailable");
    this.name = "ProviderReconciliationUnavailableError";
  }
}

/** The operation has no uncertain delivery or provider mutation pending: there is nothing to reconcile. */
export class ProviderReconciliationUnmatchedError extends Error {
  constructor() {
    super("Provider reconciliation has no pending recovery for this operation");
    this.name = "ProviderReconciliationUnmatchedError";
  }
}

export function createUnavailableProviderReconciliationPort(): ProviderReconciliationPort {
  return Object.freeze({
    async reconcile(): Promise<never> {
      throw new ProviderReconciliationUnavailableError();
    },
  });
}

export function createProviderReconciliationPort(
  binding: ProviderReconciliationBinding,
): ProviderReconciliationPort {
  if (!isRecord(binding) || typeof binding.reconcile !== "function") {
    throw new TypeError("Provider reconciliation Service Binding is invalid");
  }
  return Object.freeze({
    async reconcile(input: Parameters<ProviderReconciliationPort["reconcile"]>[0]) {
      parseUlid(input.organizationId);
      parseUlid(input.projectId);
      parseUlid(input.operationId);
      if (!/^sha256:[a-f0-9]{64}$/u.test(input.idempotencySha256)) {
        throw new TypeError("Provider reconciliation idempotency digest is invalid");
      }
      let rawResult: unknown;
      try {
        rawResult = await binding.reconcile({
          organizationId: input.organizationId,
          operationId: input.operationId,
          actorId: input.principalId,
          idempotencySha256: input.idempotencySha256,
        });
      } catch {
        throw new ProviderReconciliationUnavailableError();
      }
      const result = requireExactResult(rawResult);
      if (result.operationId !== input.operationId) {
        throw new ProviderReconciliationUnavailableError();
      }
      if (result.state === "exhausted") throw new ProviderReconciliationExhaustedError();
      if (result.state === "unmatched") throw new ProviderReconciliationUnmatchedError();
      return Object.freeze({
        attemptId: result.attemptId,
        operationId: result.operationId,
        state: result.state,
      });
    },
  });
}

function requireExactResult(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ["attemptId", "operationId", "state"])) {
    throw new ProviderReconciliationUnavailableError();
  }
  const state = value["state"];
  if (
    state !== "completed" &&
    state !== "pending" &&
    state !== "uncertain" &&
    state !== "exhausted" &&
    state !== "unmatched"
  ) {
    throw new ProviderReconciliationUnavailableError();
  }
  try {
    return Object.freeze({
      attemptId: parseUlid(String(value["attemptId"])),
      operationId: parseUlid(String(value["operationId"])),
      state,
    });
  } catch {
    throw new ProviderReconciliationUnavailableError();
  }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
