declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    protected readonly ctx: { waitUntil(work: Promise<unknown>): void };
    constructor(context: { waitUntil(work: Promise<unknown>): void }, env: Env);
  }
}
