import { describe, expect, it } from "vitest";
import { renderProjectContext } from "../src/project-context.js";

// Tools the remote MCP server does not register: a line that names one must also name its REST operation.
const REMOTE_UNAVAILABLE_TOOLS = [
  "database_compute_get",
  "domain_paid_apply",
  "mail_domain_status",
  "billing_recharge_get",
  "billing_portal_create",
];

const base = {
  project: {
    projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
    name: "Website",
    dataMode: "isolated",
    region: "us",
  },
  generatedAt: "2026-10-31T12:00:00.000Z",
  status: { lifecycle: "active", dev_url: null, prod_url: null },
  notes: { version: 0, markdown: "", updatedAt: null },
  mail: "unavailable",
  domain: {
    hostname: "www.example.com",
    status: "awaiting_deployment",
    sslStatus: "pending",
    suspensionReason: null,
    customHostnameStatus: null,
    cnameTarget: null,
    validationRecords: [],
  },
  creditAccess: "not_authorized",
};

function render(overrides: Record<string, unknown>): string {
  const input = { ...base, ...overrides } as unknown as Parameters<typeof renderProjectContext>[0];
  return renderProjectContext(input).markdown;
}

describe("project context names a REST operation beside each tool a remote agent cannot call", () => {
  it("renders the compute, domain, mail and billing states with their REST alternatives", () => {
    const rendered = [
      render({}),
      render({ billingIssue: "unavailable" }),
      render({
        billingIssue: {
          code: "payment_failed",
          invoice_id: "in_1",
          required_action: "open_billing_portal",
        },
      }),
    ].join("\n");

    expect(rendered).toContain("Compute context unavailable");
    expect(rendered).toContain("Mail verification unavailable");
    expect(rendered).toContain("Billing status unavailable");
    expect(rendered).toContain("billing_portal_create");
    for (const line of rendered.split("\n")) {
      if (REMOTE_UNAVAILABLE_TOOLS.some((tool) => line.includes(tool)))
        expect(line, line).toContain("REST ");
    }
  });
});
