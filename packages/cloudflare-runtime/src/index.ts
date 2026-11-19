export interface CloudflareQueueBinding<Body> {
  send(body: Body): Promise<unknown>;
}

export interface CloudflareQueueMessage<Body> {
  readonly body: Body;
  ack(): void;
  retry(options?: { readonly delaySeconds?: number }): void;
}

export interface CloudflareQueueBatch<Body> {
  readonly messages: readonly CloudflareQueueMessage<Body>[];
}

export interface CloudflareWorkflowInstance {
  status(): Promise<unknown>;
}

export interface CloudflareWorkflowBinding<Message> {
  create(input: {
    readonly id: string;
    readonly params: Message;
  }): Promise<CloudflareWorkflowInstance>;
  get(id: string): Promise<CloudflareWorkflowInstance>;
}
