/* v8 ignore file -- runtime declaration only */

declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }
}
