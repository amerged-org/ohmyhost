import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
  runProductCommandWorkflow,
  type ProductCommandWorkflowPorts,
  type ProductWorkflowStepPort,
} from "@ohmyhost/orchestrator";
import type { WorkflowEvent } from "cloudflare:workers";

/** Renew inside durable callbacks so each actual retry is fenced before provider work. */
export function withOperationLease(
  step: ProductWorkflowStepPort,
  renew: (durationMilliseconds: number) => Promise<void>,
): ProductWorkflowStepPort {
  return {
    do: (name, config, run) =>
      step.do(name, config, async () => {
        await renew(900_000 + (config.timeout === "15 minutes" ? 900_000 : 120_000));
        return run();
      }),
    async sleep(name, duration) {
      const milliseconds = {
        "10 seconds": 10_000,
        "10 minutes": 600_000,
        "1 minute": 60_000,
        "1 hour": 3_600_000,
      }[duration];
      await renew(milliseconds + 900_000);
      await step.sleep(name, duration);
      await renew(900_000);
    },
  };
}

export async function runDeploymentWorkflowEntrypoint(
  event: Pick<WorkflowEvent<unknown>, "payload" | "instanceId">,
  step: ProductWorkflowStepPort,
  ports: ProductCommandWorkflowPorts,
  activate: (input: {
    readonly attemptId: string;
    readonly physicalWorkflowId: string;
    readonly command: ReturnType<typeof parseProductCommandMessageV1>;
  }) => Promise<unknown>,
  activateReplay: (input: {
    readonly attemptId: string;
    readonly physicalWorkflowId: string;
    readonly command: ReturnType<typeof parseProductCommandMessageV1>;
  }) => Promise<unknown>,
  run: typeof runProductCommandWorkflow = runProductCommandWorkflow,
) {
  const recovery = parseRecoveryEnvelope(event.payload);
  const command = parseProductCommandMessageV1(recovery?.command ?? event.payload);
  const logicalWorkflowId = deterministicProductCommandWorkflowId(command);
  const expectedPhysicalWorkflowId =
    recovery === null
      ? logicalWorkflowId
      : `${recovery.kind === "provider" ? "product-provider-reconcile-v1" : "product-command-replay-v1"}-${recovery.attemptId}`;
  if (event.instanceId !== expectedPhysicalWorkflowId) {
    throw new TypeError("Deployment Workflow physical instance is not bound to its command");
  }
  if (recovery !== null) {
    await (recovery.kind === "provider" ? activate : activateReplay)({
      attemptId: recovery.attemptId,
      physicalWorkflowId: event.instanceId,
      command,
    });
  }
  return run(command, step, ports, logicalWorkflowId, event.instanceId);
}

function parseRecoveryEnvelope(value: unknown): {
  readonly command: unknown;
  readonly attemptId: string;
  readonly kind: "provider" | "replay";
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "command" ||
    (keys[1] !== "reconciliationAttemptId" && keys[1] !== "replayAttemptId")
  ) {
    return null;
  }
  const kind = keys[1] === "reconciliationAttemptId" ? "provider" : "replay";
  const attemptId = String(record[keys[1]]);
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(attemptId)) {
    throw new TypeError("Provider reconciliation attempt identity is invalid");
  }
  return Object.freeze({ command: record["command"], attemptId, kind });
}
