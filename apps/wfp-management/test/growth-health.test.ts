import { expect, it, vi } from "vitest";
import { reportDeploymentHealth, type DeploymentHealthObservation } from "../src/growth-health.js";

it("settles unavailable and timed out health delivery without turning telemetry into a deployment error", async () => {
  vi.useFakeTimers();
  const work: Promise<unknown>[] = [];
  const observation: DeploymentHealthObservation = {
    schema_version: 1,
    observation_id: crypto.randomUUID(),
    candidate_receipt_id: "candidate",
    organization_id: "org",
    project_id: "project",
    environment_id: "env",
    deployment_id: "deployment",
    health_status: "passed",
    http_status: 200,
    observed_at: new Date().toISOString(),
  };
  try {
    expect(() =>
      reportDeploymentHealth(undefined, { waitUntil: (p) => work.push(p) }, observation),
    ).not.toThrow();
    await Promise.all(work);
    work.length = 0;
    expect(() =>
      reportDeploymentHealth(
        { observeHealth: () => new Promise(() => {}) },
        { waitUntil: (p) => work.push(p) },
        observation,
      ),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all(work);
    expect(() => reportDeploymentHealth(undefined, undefined, observation)).not.toThrow();
  } finally {
    vi.useRealTimers();
  }
});
