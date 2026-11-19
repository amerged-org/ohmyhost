declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }
  export interface RecoveryObjectContext {
    readonly id: { toString(): string };
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      put<T>(key: string, value: T): Promise<void>;
      delete(key: string): Promise<boolean>;
    };
    readonly container: {
      readonly running: boolean;
      getTcpPort(port: number): { fetch(url: string, init?: RequestInit): Promise<Response> };
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: RecoveryObjectContext;
    public constructor(context: RecoveryObjectContext, env: Env);
  }
}
