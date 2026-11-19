declare module "cloudflare:workers" {
  export interface WorkerContext<Props = unknown> {
    readonly props: Props;
  }
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: WorkerContext<Props>;
    public constructor(ctx: WorkerContext<Props>, env: Env);
  }
  export interface SqlCursor<Row> {
    toArray(): Row[];
  }
  export interface SqlStorage {
    exec<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<Row>;
  }
  export interface DurableObjectContext {
    readonly storage: { readonly sql: SqlStorage; transactionSync<T>(callback: () => T): T };
  }
  export class DurableObject<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: DurableObjectContext;
    public constructor(ctx: DurableObjectContext, env: Env);
  }
}
