declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Environment = unknown> {
    public constructor(context: unknown, environment: Environment);
    protected readonly env: Environment;
  }
}
