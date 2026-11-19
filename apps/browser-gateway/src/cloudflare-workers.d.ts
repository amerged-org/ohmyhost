declare module "cloudflare:workers" {
  export interface DurableObjectTransaction {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }
  export interface DurableObjectStorage extends DurableObjectTransaction {
    transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T>;
    deleteAll(): Promise<void>;
  }
  export interface DurableObjectState {
    readonly id: { readonly name?: string };
    abort(reason?: string, options?: { retryAlarm?: boolean }): void;
    readonly storage: DurableObjectStorage;
  }
  export class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: DurableObjectState;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
