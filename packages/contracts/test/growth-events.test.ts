import { describe, expect, it } from "vitest";
import { parseGrowthEvent } from "../src/growth-events.js";

describe("growth event contract", () => {
  it("rejects arbitrary data and preserves unknown identity", () => {
    const event = {
      schema_version: 1,
      event_id: "evt_123",
      event_name: "login_started",
      outcome: "attempted",
      occurred_at: "2026-11-15T00:00:00.000Z",
      received_at: "2026-11-15T00:00:00.000Z",
      platform_environment: "development",
      producer: "control_api",
      evidence_kind: "event",
      flow_id: null,
      account_id: null,
      organization_id: null,
      project_id: null,
      operation_id: null,
      deployment_id: null,
      transport: "remote_mcp",
      client_class: "other",
      client_class_trust: "reported",
      error_class: null,
      campaign_key: null,
      request_country: null,
    };
    expect(parseGrowthEvent(event)).toEqual(event);
    expect(
      parseGrowthEvent({ ...event, request_country: "NL", transport: "portal" }).request_country,
    ).toBe("NL");
    expect(() =>
      parseGrowthEvent({ ...event, request_country: "US", transport: "rest" }),
    ).toThrow();
    expect(() => parseGrowthEvent({ ...event, request_country: "Netherlands" })).toThrow();
    expect(() =>
      parseGrowthEvent({ ...event, request_country: "NL", producer: "workos" }),
    ).toThrow();
    expect(parseGrowthEvent({ ...event, platform_version: "version_123" }).platform_version).toBe(
      "version_123",
    );
    expect(() =>
      parseGrowthEvent({ ...event, platform_version: "https://invalid.example" }),
    ).toThrow();
    expect(() => parseGrowthEvent({ ...event, email: "test@example.com" })).toThrow();
    expect(() => parseGrowthEvent({ ...event, raw_url: "https://example.com" })).toThrow();
    expect(() => parseGrowthEvent({ ...event, unexpected: true })).toThrow();
  });
});

it("validates closed deployment and payment facts including nullable actor and amounts", async () => {
  const { parseGrowthFact } = await import("../src/growth-events.js");
  const base = {
    schema_version: 1,
    fact_id: "fact_1",
    source_id: "source_1",
    occurred_at: null,
    observed_at: "2026-11-15T00:00:00.000Z",
    source_version: "v1",
    account_id: null,
    organization_id: "org_1",
    project_id: null,
    operation_id: null,
  };
  const deployment = {
    ...base,
    fact_type: "deployment",
    deployment_id: "dep_1",
    environment_id: "env_1",
    target_environment: "dev",
    kind: "deploy",
    status: "succeeded",
    succeeded_at: "2026-11-15T00:00:00.000Z",
    health_status: "passed",
    health_evidence_id: "health_1",
  };
  expect(parseGrowthFact(deployment)).toEqual(deployment);
  expect(() => parseGrowthFact({ ...deployment, health_status: "assumed" })).toThrow();
  const payment = {
    ...base,
    fact_type: "payment",
    provider_fact_id: "provider_1",
    payment_id: null,
    amount_minor: 200,
    currency: "EUR",
    money_effect: "received",
  };
  expect(parseGrowthFact(payment)).toEqual(payment);
  expect(() => parseGrowthFact({ ...payment, amount_minor: -1 })).toThrow();
  expect(() => parseGrowthFact({ ...payment, currency: "eur" })).toThrow();
  expect(() => parseGrowthFact({ ...payment, email: "person@example.com" })).toThrow();
});
