import type { ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import type { TestControl } from "../../../control-store/test/support/control-d1.js";
import { DeploymentWorkflowRuntime } from "../../../control-store/src/worker-main.js";
import {
  readCoreDeploymentWorkflowBindings,
  runCoreDeploymentWorkflow,
} from "../../src/core-deployment-workflow.js";
import {
  providerServices,
  recordingStep,
  type Handlers,
  type WorkflowAnswers,
  type WorkflowOverrides,
} from "./deployment-chain-providers.js";

/** One accepted product command and the Workflow instance id it runs under. */
export interface CoreWorkflowRun {
  readonly command: ProductCommandMessageV1;
  readonly workflowId: string;
}

/**
 * A Cloudflare Workflow binding that records every instance it is asked to create and answers with the instance
 * shape the binding returns. The chain tests run the recorded params through the real Workflow entrypoint later.
 */
export function recordingWorkflow() {
  const created: { readonly id: string; readonly params: unknown }[] = [];
  const instance = (id: string) => ({
    id,
    status: async () => ({ status: "queued" as const }),
  });
  const binding: WorkflowAnswers = {
    create: async ({ id, params }) => {
      created.push({ id, params: structuredClone(params) });
      return instance(id);
    },
    get: async (id) => {
      const found = created.find((entry) => entry.id === id);
      if (found === undefined) throw new Error(`Unknown Workflow instance ${id}`);
      return instance(id);
    },
  };
  return { binding, created };
}

/**
 * A Workflow binding that runs every created instance in-process, as the Workflow runs it: `create` resolves once the
 * instance finished, and a failing instance fails the create. The instance params are cloned as persisted params are.
 */
export function inProcessWorkflow(
  run: (event: { readonly instanceId: string; readonly payload: object }) => Promise<unknown>,
): WorkflowAnswers {
  const finished = new Map<string, unknown>();
  return {
    create: async ({ id, params }) => {
      finished.set(id, await run({ instanceId: id, payload: structuredClone(params) as object }));
      return { id, status: async () => ({ status: "complete" as const }) };
    },
    get: async (id) => {
      if (!finished.has(id)) throw new Error(`Unknown Workflow instance ${id}`);
      return { id, status: async () => ({ status: "complete" as const }) };
    },
  };
}

/**
 * The real Core bindings of the product Workflows: the Core capability is the deployed D1 Core, every provider is an
 * answer of `handlers` and every Workflow binding is an answer of `workflows` (a provider or Workflow without an
 * answer fails by name). Returns the bindings and the provider calls they received.
 */
export function coreWorkflowBindings(
  control: TestControl,
  handlers: Handlers,
  workflows: WorkflowOverrides = {},
) {
  const calls: [string, unknown][] = [];
  const bindings = readCoreDeploymentWorkflowBindings({
    RUNTIME_CONFIGURATION_STATE: "configured",
    DEPLOYMENT_WORKFLOW_RUNTIME: new DeploymentWorkflowRuntime({} as never, control.bindings),
    ...providerServices(handlers, calls, workflows),
  });
  return { bindings, calls };
}

/**
 * Runs the real product Workflow on the real D1 Core. Only the provider bindings are answers, and a provider the
 * handlers do not answer fails by name. Returns the result, the steps in order, the failed steps and the calls.
 */
export async function runCoreWorkflow(
  control: TestControl,
  run: CoreWorkflowRun,
  handlers: Handlers,
  workflows?: WorkflowOverrides,
) {
  const recorder = recordingStep(),
    { bindings, calls } = coreWorkflowBindings(control, handlers, workflows);
  const result = await runCoreDeploymentWorkflow(
    bindings,
    { payload: run.command, instanceId: run.workflowId },
    recorder.step,
  ).catch((error: unknown) => ({ thrown: error }));
  return { result, steps: recorder.steps, failures: recorder.failures, calls };
}
