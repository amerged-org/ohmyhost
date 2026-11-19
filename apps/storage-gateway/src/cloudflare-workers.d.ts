declare module "cloudflare:workers" {
  // Cloudflare supplies this nominal class; the declaration describes only the used surface.
  // `fetch` is deliberately absent: a subclass defines it without `override`.
  export interface WorkerContext<Props = unknown> {
    readonly props: Props;
  }
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected readonly env: Env;
    protected readonly ctx: WorkerContext<Props>;
    public constructor(context: WorkerContext<Props>, env: Env);
  }
}
