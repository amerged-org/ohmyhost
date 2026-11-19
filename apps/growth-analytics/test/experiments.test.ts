import { expect, it } from "vitest";
import { evaluateExperiment, type ExperimentInput } from "../src/experiments.js";
it("keeps legacy experiments unconfigured rather than inventing outcomes", () => {
  expect(
    evaluateExperiment({
      experiment: {} as ExperimentInput,
      asOf: "2026-11-15T00:00:00.000Z",
      exposures: [],
      events: [],
      facts: [],
      complete: false,
    }),
  ).toMatchObject({ mature: false, conclusion: "pending / unconfigured" });
});

it("counts attributed healthy deployments in mature new-account cohorts and keeps missing evidence unknown", () => {
  const experiment: ExperimentInput = {
    hypothesis: "Improve deployment",
    evidence_basis: "hypothesis",
    evidence_reference: null,
    segment: "new_accounts_7d",
    primary_metric: "healthy_deployment_7d",
    guardrails: [],
    horizon_start: "2026-11-01T00:00:00.000Z",
    horizon_end: "2026-12-01T00:00:00.000Z",
    baseline_version: "old",
    variant_version: "new",
    surface: "authorized_product_response",
    exposure_mode: "before_after",
  };
  const event = (account: string, evidence_kind: "event" | "snapshot") => ({
    schema_version: 1 as const,
    event_id: `created_${account}`,
    event_name: "account_created" as const,
    outcome: "succeeded" as const,
    occurred_at: "2026-11-09T00:00:00.000Z",
    received_at: "2026-11-09T00:00:00.000Z",
    platform_environment: "development" as const,
    producer: "workos" as const,
    evidence_kind,
    flow_id: null,
    account_id: account,
    organization_id: null,
    project_id: null,
    operation_id: null,
    deployment_id: null,
    transport: "unknown" as const,
    client_class: "unknown" as const,
    client_class_trust: "unknown" as const,
    error_class: null,
    campaign_key: null,
    request_country: null,
  });
  const fact = {
    schema_version: 1 as const,
    fact_type: "deployment" as const,
    fact_id: "fact",
    source_id: "source",
    occurred_at: "2026-11-12T00:00:00.000Z",
    observed_at: "2026-11-12T00:00:00.000Z",
    source_version: "one",
    account_id: "one",
    organization_id: "org",
    project_id: "project",
    operation_id: null,
    deployment_id: "deployment",
    environment_id: "env",
    target_environment: "prod" as const,
    kind: "deploy" as const,
    status: "succeeded" as const,
    succeeded_at: "2026-11-12T00:00:00.000Z",
    health_status: "passed" as const,
    health_evidence_id: "health",
  };
  const exposures = ["one", "snapshot", "unknown"].map((subject) => ({
    subject,
    variant: "baseline",
    version: "old",
    delivered_at: "2026-11-10T00:00:00.000Z",
  }));
  const result = evaluateExperiment({
    experiment,
    asOf: "2026-11-18T00:00:00.000Z",
    exposures,
    events: [event("one", "event"), event("snapshot", "snapshot")],
    facts: [fact, { ...fact, fact_id: "unattributed", account_id: null }],
    complete: false,
  });
  expect(result.conclusion).toContain(
    "baseline: 3 exposed, 2 mature, 0 pending, 1 converted, 2 unknown",
  );
  expect(result.limitations).toContain("Bounded source reads incomplete");
  const snapshotReady = {
    ...event("one", "snapshot"),
    event_name: "workspace_ready" as const,
    occurred_at: "2026-11-12T00:00:00.000Z",
  };
  const workspaceResult = evaluateExperiment({
    experiment: { ...experiment, primary_metric: "workspace_ready_7d" },
    asOf: "2026-11-18T00:00:00.000Z",
    exposures: exposures.slice(0, 1),
    events: [event("one", "event"), snapshotReady],
    facts: [],
    complete: false,
  });
  expect(workspaceResult.conclusion).toContain("1 mature, 0 pending, 0 converted, 1 unknown");
  const noActor = evaluateExperiment({
    experiment: { ...experiment, segment: "all" },
    asOf: "2026-11-18T00:00:00.000Z",
    exposures: exposures.slice(0, 1),
    events: [],
    facts: [{ ...fact, account_id: null }],
    complete: true,
  });
  expect(noActor.conclusion).toContain("1 mature, 0 pending, 0 converted, 1 unknown");
});

it("ignores deliveries without a verified account or a platform version", async () => {
  const { observeDeliveredExperiment } = await import("../src/experiments.js");
  const db = {
    prepare() {
      throw new Error("must not access database");
    },
  } as unknown as Parameters<typeof observeDeliveredExperiment>[0];
  const event = {
    producer: "control_api",
    evidence_kind: "event",
    event_name: "product_call_succeeded",
    outcome: "succeeded",
    account_id: null,
    platform_version: "version",
  } as Parameters<typeof observeDeliveredExperiment>[1];
  await expect(observeDeliveredExperiment(db, event)).resolves.toBeUndefined();
  await expect(
    observeDeliveredExperiment(db, { ...event, account_id: "account", platform_version: null }),
  ).resolves.toBeUndefined();
});
