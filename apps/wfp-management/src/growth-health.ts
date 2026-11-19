export interface DeploymentHealthObservation {
  schema_version: 1;
  observation_id: string;
  candidate_receipt_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  deployment_id: string;
  health_status: "passed" | "failed";
  http_status: number;
  observed_at: string;
}
export interface DeploymentHealthCollector {
  observeHealth(input: DeploymentHealthObservation): Promise<{ accepted: boolean }>;
}
export interface GrowthHealthContext {
  waitUntil(task: Promise<unknown>): void;
}
/** Best-effort only; a lost observation remains unknown and is never a deployment error. */
export function reportDeploymentHealth(
  collector: DeploymentHealthCollector | undefined,
  context: GrowthHealthContext | undefined,
  input: DeploymentHealthObservation,
): void {
  try {
    if (!context) {
      console.warn("growth deployment health gap: no execution context");
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delivery = Promise.race([
      Promise.resolve()
        .then(() => collector?.observeHealth(input))
        .then((result) => {
          if (!result?.accepted) throw new Error("unavailable");
        }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 2000);
      }),
    ])
      .catch(() => {
        console.warn("growth deployment health gap: collection unavailable");
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
    context.waitUntil(delivery);
  } catch {
    console.warn("growth deployment health gap: scheduling unavailable");
  }
}
