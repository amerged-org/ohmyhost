import { describe, expect, it } from "vitest";

import {
  createOperationDeploymentResult,
  parseOperationDeploymentResult,
  createOperationDeploymentProgress,
  parseOperationDeploymentProgress,
} from "../src/operation-deployment-result.js";

const valid = () => ({
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  deploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  planId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  artifactSha256: "a".repeat(64),
  url: "https://example.poc.aixyte.com/",
});

it("carries scoped mail readiness and DNS records on a waiting operation and rejects unsafe projections", () => {
  const progress = createOperationDeploymentProgress({
    phase: "waiting_for_mail",
    project_id: valid().operationId,
    deployment_id: valid().deploymentId,
    observed_at: "2026-11-14T12:00:00.000Z",
    mail: {
      domain: "mail.example.com",
      status: "verification_pending",
      configured_at: "2026-11-14T11:00:00.000Z",
      observed_at: "2026-11-14T11:30:00.000Z",
      sending: "pending",
      receiving: "disabled",
      next_check_after_seconds: 60,
      dns_records: [
        {
          type: "TXT",
          name: "dkim.mail.example.com",
          value: "public-dns-value",
          status: "pending",
        },
      ],
    },
  });
  expect(progress.mail?.dns_records[0]?.value).toBe("public-dns-value");
  expect(progress.suggested_action).toContain("DNS records shown here");
  expect(parseOperationDeploymentProgress(progress)).toEqual(progress);
  if (!progress.mail) throw new Error("Missing mail progress");
  expect(
    createOperationDeploymentProgress({ ...progress, mail: { ...progress.mail, dns_records: [] } })
      .suggested_action,
  ).toContain("ohmyhost mail status");
  expect(() => parseOperationDeploymentProgress({ ...progress, phase: "publishing" })).toThrow();
  expect(() =>
    parseOperationDeploymentProgress({
      ...progress,
      mail: {
        ...progress.mail,
        dns_records: [{ type: "TXT", name: "foreign.example.net", value: "x", status: "pending" }],
      },
    }),
  ).toThrow();
  expect(() =>
    parseOperationDeploymentProgress({
      ...progress,
      mail: { ...progress.mail, secret: "private" },
    }),
  ).toThrow();
});

it("names a REST operation beside each mail tool that a remote agent cannot call", () => {
  const base = {
    project_id: valid().operationId,
    deployment_id: valid().deploymentId,
    observed_at: "2026-11-14T12:00:00.000Z",
  };
  const restPath = "REST GET /v1/projects/{project_id}/environments/{environment_id}/mail-domain";
  expect(
    createOperationDeploymentProgress({
      ...base,
      phase: "waiting_for_mail",
      mail: {
        domain: "mail.example.com",
        status: "verification_pending",
        configured_at: "2026-11-14T11:00:00.000Z",
        observed_at: "2026-11-14T11:30:00.000Z",
        sending: "pending",
        receiving: "disabled",
        next_check_after_seconds: 60,
        dns_records: [],
      },
    }).suggested_action,
  ).toContain(restPath);
  expect(
    createOperationDeploymentProgress({ ...base, phase: "mail_status_unavailable" })
      .suggested_action,
  ).toContain(restPath);
});

describe("operation deployment result", () => {
  it("creates the exact public deployment result", () => {
    expect(createOperationDeploymentResult(valid())).toEqual({
      schemaVersion: "ohmyhost.operation-deployment-result/v2",
      ...valid(),
    });
  });

  it("rejects identity and artifact drift", () => {
    const result = createOperationDeploymentResult(valid());
    expect(() => parseOperationDeploymentResult({ ...result, operationId: "not-a-ulid" })).toThrow(
      /deployment result/u,
    );
    expect(() => parseOperationDeploymentResult({ ...result, artifactSha256: "a" })).toThrow(
      /deployment result/u,
    );
  });

  it("rejects unsafe URLs and unknown fields", () => {
    const result = createOperationDeploymentResult(valid());
    expect(() => parseOperationDeploymentResult({ ...result, url: "http://example.com" })).toThrow(
      /deployment result/u,
    );
    expect(() => parseOperationDeploymentResult({ ...result, receipt: {} })).toThrow(
      /deployment result/u,
    );
  });
});
