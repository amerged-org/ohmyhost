import type { ProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import type { ManagedSourceProcessorBinding } from "./bindings.js";
import type {
  ProjectDispatchRuntimeBinding,
  ProjectWorkflowRuntimeBinding,
} from "./core-persistence.js";
import type { CloudflareQueueBinding, CloudflareWorkflowBinding } from "./runtime-types.js";
export interface CorePublisherBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly PROJECT_DISPATCH_RUNTIME: ProjectDispatchRuntimeBinding;
  readonly PROJECT_PROVISIONING_QUEUE: CloudflareQueueBinding<string>;
}
export interface CoreConsumerBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly PROJECT_WORKFLOW_RUNTIME: ProjectWorkflowRuntimeBinding;
  readonly PROJECT_DISPATCH_RUNTIME: Pick<
    ProjectDispatchRuntimeBinding,
    "readManagedSourceDispatchState"
  >;
  readonly PROJECT_PROVISIONING_WORKFLOW: CloudflareWorkflowBinding;
  readonly DEPLOYMENT_WORKFLOW: CloudflareWorkflowBinding<ProductCommandMessageV1>;
  readonly MANAGED_SOURCE_PROCESSOR?: ManagedSourceProcessorBinding;
}
export interface CoreWorkflowBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly PROJECT_WORKFLOW_RUNTIME: ProjectWorkflowRuntimeBinding;
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("Project Core bindings are missing");
  const r = raw as Record<string, unknown>;
  if (r["RUNTIME_CONFIGURATION_STATE"] !== "configured")
    throw new TypeError("Project provisioning Worker configuration state is disabled");
  return r;
}
function methods(value: unknown, names: readonly string[]) {
  if (
    typeof value !== "object" ||
    value === null ||
    names.some((name) => typeof Reflect.get(value, name) !== "function")
  )
    throw new TypeError("Project Core capability is unavailable");
}
const workflowMethods = [
  "completeProjectProvisioningHello",
  "failProjectProvisioningHello",
  "reconcileProjectProvisioningHello",
];
export function readCoreWorkflowBindings(raw: unknown): CoreWorkflowBindings {
  const r = record(raw);
  methods(r["PROJECT_WORKFLOW_RUNTIME"], workflowMethods);
  return r as unknown as CoreWorkflowBindings;
}
export function readCoreConsumerBindings(raw: unknown): CoreConsumerBindings {
  const r = record(raw);
  methods(r["PROJECT_WORKFLOW_RUNTIME"], workflowMethods);
  methods(r["PROJECT_DISPATCH_RUNTIME"], ["readManagedSourceDispatchState"]);
  methods(r["PROJECT_PROVISIONING_WORKFLOW"], ["create", "get"]);
  methods(r["DEPLOYMENT_WORKFLOW"], ["create", "get"]);
  if (r["MANAGED_SOURCE_PROCESSOR"] !== undefined)
    methods(r["MANAGED_SOURCE_PROCESSOR"], ["process", "initialize"]);
  return r as unknown as CoreConsumerBindings;
}
export function readCorePublisherBindings(raw: unknown): CorePublisherBindings {
  const r = record(raw);
  methods(r["PROJECT_PROVISIONING_QUEUE"], ["send"]);
  methods(r["PROJECT_DISPATCH_RUNTIME"], [
    "claimProvisioningDispatch",
    "recoverProvisioningDispatch",
    "acknowledgeProvisioningDispatch",
    "failProvisioningDispatch",
    "claimProductDispatch",
    "recoverProductDispatch",
    "acknowledgeProductDispatch",
    "failProductDispatch",
    "claimManagedSourceDispatch",
    "recoverManagedSourceDispatch",
    "sweepExhaustedManagedSourceDispatch",
    "acknowledgeManagedSourceDispatch",
    "failManagedSourceDispatch",
    "recoverProductExecutionLease",
    "acceptProductDispatch",
    "readProductDispatchIntent",
    "readManagedSourceDispatchState",
  ]);
  return r as unknown as CorePublisherBindings;
}
