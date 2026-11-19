/* v8 ignore file -- ambient Cloudflare declarations have no runtime behavior */

declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    public constructor(context: unknown, env: Env);
  }
}
