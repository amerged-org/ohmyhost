import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { runWorkflowEntrypoint } from "./worker-runtime.js";

export class ProjectProvisioningWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return runWorkflowEntrypoint(event, step, this.env);
  }
}

export default {};
