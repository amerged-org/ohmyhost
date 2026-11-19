declare module "cloudflare:workers" {
  // Cloudflare supplies these nominal classes; the declarations describe only the used surface.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  export abstract class RpcTarget {}
  export interface WorkerContext<Props = unknown> {
    readonly props: Props;
  }
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: WorkerContext<Props>;
    public constructor(context: WorkerContext<Props>, env: Env);
  }
  export interface DatabaseObjectContext {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: DatabaseObjectContext;
    public constructor(context: DatabaseObjectContext, env: Env);
  }
}
