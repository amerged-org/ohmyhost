declare module "cloudflare:workers" {
  export type WorkflowEvent<T> = {
    readonly payload: Readonly<T>;
    readonly timestamp: Date;
    readonly instanceId: string;
    readonly workflowName: string;
    readonly schedule?: { readonly cron: string; readonly scheduledTime: number };
  };
  export interface WorkerContext<Props = unknown> {
    readonly props: Props;
  }
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: WorkerContext<Props>;
    public constructor(context: WorkerContext<Props>, env: Env);
  }
  export interface DurableObjectContext {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: DurableObjectContext;
    public constructor(context: DurableObjectContext, env: Env);
  }
}
