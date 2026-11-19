declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }

  /** The part of the Durable Object state the build sandbox object uses. */
  export interface DurableObjectContext {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put<T>(key: string, value: T): Promise<void>;
    };
    readonly container: {
      readonly running: boolean;
      start(options?: {
        env?: Record<string, string>;
        entrypoint?: string[];
        enableInternet?: boolean;
        labels?: Record<string, string>;
      }): void;
      getTcpPort(port: number): {
        fetch(url: string, init?: RequestInit): Promise<Response>;
      };
    };
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectContext;
    protected readonly env: Env;
    public constructor(ctx: DurableObjectContext, env: Env);
  }
}
