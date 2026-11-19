declare module "cloudflare:workers" {
  export interface WorkerContext<Props = unknown> {
    readonly props: Props;
  }
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: WorkerContext<Props>;
    public constructor(context: unknown, env: Env);
  }
  export interface DurableObjectContext {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    };
  }
  export class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: DurableObjectContext;
    public constructor(context: DurableObjectContext, env: Env);
  }
}
