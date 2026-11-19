import type {
  ProjectProvisioningCompletionPort,
  ProjectProvisioningFailurePort,
  ProjectProvisioningMessageV1,
} from "@ohmyhost/orchestrator";

// Lives here, not in workflow-runtime.ts, so consumers that only need the type
// (the Core adapters, the database package's replay test) do not pull the
// `cloudflare:workers` module into their TypeScript program.
export interface ProjectProvisioningWorkflowPersistence {
  readonly completion: ProjectProvisioningCompletionPort;
  readonly failure: ProjectProvisioningFailurePort;
}

export interface CloudflareQueueBinding<Body> {
  send(body: Body): Promise<unknown>;
}

export interface CloudflareWorkflowInstance {
  status(): Promise<unknown>;
}

export interface CloudflareWorkflowBinding<Message = ProjectProvisioningMessageV1> {
  create(input: {
    readonly id: string;
    readonly params: Message;
  }): Promise<CloudflareWorkflowInstance>;
  get(id: string): Promise<CloudflareWorkflowInstance>;
}

interface CloudflareQueueMessage<Body> {
  readonly body: Body;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface CloudflareQueueBatch<Body> {
  readonly messages: readonly CloudflareQueueMessage<Body>[];
}
