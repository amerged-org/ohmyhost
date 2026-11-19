import { parseUlid, type Ulid } from "@ohmyhost/platform";

import type { ProductWorkflowStepPort } from "./deployment-workflow.js";

export const PROVIDER_RECONCILIATION_STEP_CONFIG = Object.freeze({
  retries: Object.freeze({
    limit: 3,
    delay: "5 seconds" as const,
    backoff: "exponential" as const,
  }),
  timeout: "2 minutes" as const,
});

export interface ProductProviderReconciliationMessageV1 {
  readonly version: 1;
  readonly attemptId: Ulid;
  readonly claimId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface ProductProviderReconciliationPorts {
  load(message: ProductProviderReconciliationMessageV1): Promise<unknown>;
  observe(context: unknown): Promise<unknown>;
  prepare(input: {
    readonly message: ProductProviderReconciliationMessageV1;
    readonly context: unknown;
    readonly observation: unknown;
  }): Promise<
    | { readonly outcome: "unknown"; readonly attemptId: Ulid }
    | { readonly outcome: "resolved_absent"; readonly attemptId: Ulid }
    | {
        readonly outcome: "prepared";
        readonly attemptId: Ulid;
        readonly physicalWorkflowId: string;
        readonly originalMessage: Readonly<Record<string, unknown>>;
      }
  >;
  resume(input: {
    readonly physicalWorkflowId: string;
    readonly originalMessage: Readonly<Record<string, unknown>>;
  }): Promise<"completed" | "pending" | "uncertain">;
}

export type ProductProviderReconciliationResult =
  | { readonly status: "unknown"; readonly attemptId: Ulid }
  | { readonly status: "resolved_absent"; readonly attemptId: Ulid }
  | {
      readonly status: "resumed" | "pending" | "uncertain";
      readonly attemptId: Ulid;
      readonly physicalWorkflowId: string;
    };

export function parseProductProviderReconciliationMessageV1(
  value: unknown,
): ProductProviderReconciliationMessageV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "attemptId",
      "claimId",
      "organizationId",
      "projectId",
      "environmentId",
      "operationId",
      "actorId",
      "idempotencySha256",
    ])
  ) {
    throw new TypeError("Provider reconciliation message is invalid");
  }
  if (value["version"] !== 1) throw new TypeError("Provider reconciliation version is invalid");
  const actorId = value["actorId"];
  if (
    typeof actorId !== "string" ||
    !actorId.startsWith("user:") ||
    actorId.trim() !== actorId ||
    actorId.length > 255
  ) {
    throw new TypeError("Provider reconciliation actor identity is invalid");
  }
  return Object.freeze({
    version: 1,
    attemptId: parseUlid(String(value["attemptId"])),
    claimId: parseUlid(String(value["claimId"])),
    organizationId: parseUlid(String(value["organizationId"])),
    projectId: parseUlid(String(value["projectId"])),
    environmentId: parseUlid(String(value["environmentId"])),
    operationId: parseUlid(String(value["operationId"])),
    actorId,
    idempotencySha256: parseDigest(value["idempotencySha256"]),
  });
}

export function deterministicProviderReconciliationWorkflowId(
  message: ProductProviderReconciliationMessageV1,
): string {
  const parsed = parseProductProviderReconciliationMessageV1(message);
  return `product-provider-reconciliation-v1-${parsed.attemptId}`;
}

export async function runProductProviderReconciliationWorkflow(
  rawMessage: unknown,
  instanceId: string,
  step: Pick<ProductWorkflowStepPort, "do">,
  ports: ProductProviderReconciliationPorts,
): Promise<ProductProviderReconciliationResult> {
  const message = parseProductProviderReconciliationMessageV1(rawMessage);
  if (instanceId !== deterministicProviderReconciliationWorkflowId(message)) {
    throw new TypeError("Provider reconciliation Workflow identity changed");
  }
  const context = await step.do(
    "load-provider-reconciliation",
    PROVIDER_RECONCILIATION_STEP_CONFIG,
    () => ports.load(message),
  );
  const observation = await step.do(
    "observe-provider-reconciliation",
    PROVIDER_RECONCILIATION_STEP_CONFIG,
    () => ports.observe(context),
  );
  const prepared = await step.do(
    "persist-provider-reconciliation",
    PROVIDER_RECONCILIATION_STEP_CONFIG,
    () => ports.prepare({ message, context, observation }),
  );
  if (prepared.outcome === "unknown" || prepared.outcome === "resolved_absent") {
    return Object.freeze({ status: prepared.outcome, attemptId: prepared.attemptId });
  }
  const outcome = await step.do(
    "resume-original-deployment",
    PROVIDER_RECONCILIATION_STEP_CONFIG,
    () =>
      ports.resume({
        physicalWorkflowId: prepared.physicalWorkflowId,
        originalMessage: prepared.originalMessage,
      }),
  );
  return Object.freeze({
    status: outcome === "completed" ? ("resumed" as const) : outcome,
    attemptId: prepared.attemptId,
    physicalWorkflowId: prepared.physicalWorkflowId,
  });
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Provider reconciliation idempotency digest is invalid");
  }
  return value as `sha256:${string}`;
}
