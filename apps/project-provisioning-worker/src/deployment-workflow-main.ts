import {
  readCoreDeploymentWorkflowBindings,
  runCoreDeploymentWorkflow,
} from "./core-deployment-workflow.js";
import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runProductProviderReconciliationWorkflow } from "@ohmyhost/orchestrator";
import { parseUlid, SystemClock } from "@ohmyhost/platform";

import {
  createCoreProviderReconciliationPorts,
  requestCoreProviderReconciliation,
} from "./provider-reconciliation-composition.js";

export class DeploymentWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runCoreDeploymentWorkflow(readCoreDeploymentWorkflowBindings(this.env), event, step);
  }
}

export class ProviderReconciliationWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const bindings = readCoreDeploymentWorkflowBindings(this.env);
    return runProductProviderReconciliationWorkflow(
      event.payload,
      event.instanceId,
      step,
      createCoreProviderReconciliationPorts(
        bindings,
        bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
        new SystemClock(),
      ),
    );
  }
}

export class ProductProviderReconciliationService extends WorkerEntrypoint<unknown> {
  public async reconcile(input: unknown) {
    const bindings = readCoreDeploymentWorkflowBindings(this.env);
    const request = parseReconciliationRequest(input);
    return logReconciliationRequest(request.operationId, () =>
      requestCoreProviderReconciliation(
        bindings,
        bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
        request,
        new SystemClock(),
      ),
    );
  }
}

export default {};

async function logReconciliationRequest<T extends { readonly state: string }>(
  operationId: string,
  run: () => Promise<T>,
): Promise<T> {
  console.log(
    JSON.stringify({ event: "provider_reconciliation_rpc", operationId, stage: "started" }),
  );
  try {
    const result = await run();
    console.log(
      JSON.stringify({
        event: "provider_reconciliation_rpc",
        operationId,
        stage: "completed",
        state: result.state,
      }),
    );
    return result;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "provider_reconciliation_rpc",
        operationId,
        stage: "failed",
        errorName: error instanceof Error ? error.name : "NonError",
        errorMessage:
          error instanceof Error ? error.message : "Unknown provider reconciliation error",
      }),
    );
    throw error;
  }
}

function parseReconciliationRequest(value: unknown) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["organizationId", "operationId", "actorId", "idempotencySha256"])
  ) {
    throw new TypeError("Provider reconciliation request is invalid");
  }
  const idempotencySha256 = value["idempotencySha256"];
  if (typeof idempotencySha256 !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(idempotencySha256)) {
    throw new TypeError("Provider reconciliation idempotency digest is invalid");
  }
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
    organizationId: parseUlid(String(value["organizationId"])),
    operationId: parseUlid(String(value["operationId"])),
    actorId,
    idempotencySha256: idempotencySha256 as `sha256:${string}`,
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
