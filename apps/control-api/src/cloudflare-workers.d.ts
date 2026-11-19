declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly env: Env;
    constructor(context: unknown, env: Env);
  }
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
    constructor(context: unknown, env: Env);
  }

  // Type-only static-delay Workflow slice used by the imported original provisioning completion runner.
  // Mirrors apps/project-provisioning-worker/worker-configuration.d.ts; no runtime binding is introduced.
  export type WorkflowDurationLabel =
    | "second"
    | "minute"
    | "hour"
    | "day"
    | "week"
    | "month"
    | "year";
  export type WorkflowSleepDuration = `${number} ${WorkflowDurationLabel}${"s" | ""}` | number;
  export type WorkflowEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
    schedule?: { cron: string; scheduledTime: number };
  };
  export interface WorkflowStaticStepConfig {
    retries?: {
      limit: number;
      delay: WorkflowSleepDuration;
      backoff?: "constant" | "linear" | "exponential";
    };
    timeout?: WorkflowSleepDuration;
    sensitive?: "output";
  }
  export interface WorkflowStep {
    do<T>(
      name: string,
      config: WorkflowStaticStepConfig,
      callback: (context: {
        step: { name: string; count: number };
        attempt: number;
        config: WorkflowStaticStepConfig;
      }) => Promise<T>,
    ): Promise<T>;
  }
}
