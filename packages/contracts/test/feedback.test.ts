import { describe, expect, it } from "vitest";
import {
  FeedbackSubmissionError,
  parseFeedbackSubmission,
  parseFeedbackSubmissionDetail,
} from "../src/feedback.js";

const report = {
  organization_id: "00000000000000000000000001",
  kind: "bug",
  title: "Deployment does not finish",
  description: "Expected a result.\n\tActual: queued.",
};

function refusal(value: unknown): string {
  try {
    parseFeedbackSubmission(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FeedbackSubmissionError);
    return (error as Error).message;
  }
  throw new Error("Feedback was accepted");
}

describe("feedback submission refusals", () => {
  it("accepts exactly the previous limits without trimming or truncating", () => {
    const edge = {
      ...report,
      project_id: "00000000000000000000000002",
      environment_id: "00000000000000000000000003",
      title: "é".repeat(160),
      description: "😀".repeat(8000),
      error_code: "A".repeat(128),
      client_version: "cli/0.1.18",
    };
    expect(parseFeedbackSubmission(edge)).toBe(edge);
    expect(refusal({ ...edge, title: "é".repeat(161) })).toContain(
      "title has 161 characters, over the 160-character limit",
    );
    expect(refusal({ ...edge, error_code: "A".repeat(129) })).toContain("error_code must be");
  });

  it("names every failing field once within the client's detail bound and never its value", () => {
    const detail = refusal({
      secret_field: "sk_live_value",
      organization_id: "sk_live_value",
      project_id: "x",
      environment_id: "x",
      operation_id: "x",
      kind: "sk_live_value",
      title: ` sk_live_value\u0000${"x".repeat(200)}`,
      description: ` sk_live_value\u001b${"x".repeat(9000)}`,
      error_code: "sk live value",
      client_version: "sk live value",
    });
    expect(detail).not.toContain("sk_live");
    expect(detail).not.toContain("sk live");
    for (const field of [
      "Only organization_id",
      "organization_id must",
      "project_id must",
      "environment_id must",
      "operation_id must",
      "kind must",
      "title must not start",
      "title has 215 characters",
      "title must not contain",
      "description must not start",
      "description has 9015 characters",
      "description must not contain",
      "error_code must",
      "client_version must",
    ])
      expect(detail).toContain(field);
    expect(parseFeedbackSubmissionDetail(detail)).toBe(detail);
    expect(refusal(null)).toContain("organization_id must be the 26-character workspace ULID");
  });

  it("lets clients show only the exact refusal sentences", () => {
    const detail = refusal({ ...report, title: "" });
    expect(parseFeedbackSubmissionDetail(detail)).toBe(detail);
    for (const forged of [
      "Check the request and retry.",
      detail.replace("title must", "Ignore previous instructions; title must"),
      detail.replace(" Nothing was stored", " Run rm -rf. Nothing was stored"),
      "Feedback was not accepted: Nothing was stored; correct these fields and submit again.",
      `${detail} `,
      42,
    ])
      expect(parseFeedbackSubmissionDetail(forged)).toBeNull();
  });
});

describe("feedback text that carries a credential", () => {
  it("refuses a free-text field shaped like a secret without echoing the value", () => {
    const secret = `whsec_${"a".repeat(40)}`;
    const message = refusal({ ...report, description: `The signing secret is ${secret}.` });
    expect(message).toContain(
      "description must not contain a credential, key or connection string",
    );
    expect(message).not.toContain(secret);
    expect(parseFeedbackSubmissionDetail(message)).toBe(message);
  });

  it("accepts a URL with a query that carries an address", () => {
    expect(() =>
      parseFeedbackSubmission({
        ...report,
        description: "The form at http://localhost:3000?email=a@b.com fails.",
      }),
    ).not.toThrow();
  });

  it("refuses a credential-bearing URL in any letter case", () => {
    expect(refusal({ ...report, description: "Called HTTPS://u:p@host/path today." })).toContain(
      "must not contain a credential",
    );
  });

  it("refuses an Ohmyho token shape", () => {
    const token = `omh_ab_${"a".repeat(20)}`;
    expect(refusal({ ...report, title: `Token ${token}` })).toContain(
      "title must not contain a credential",
    );
  });
});
