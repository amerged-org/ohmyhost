declare module "cloudflare:workers" {
  export interface StateTransaction {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  }
  export interface TofuObjectContext {
    readonly storage: {
      get<T>(key: string): Promise<T | undefined>;
      transaction<T>(work: (transaction: StateTransaction) => Promise<T>): Promise<T>;
    };
  }
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: TofuObjectContext;
    public constructor(context: TofuObjectContext, env: Env);
  }
}
