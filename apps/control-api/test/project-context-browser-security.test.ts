import { describe, expect, it } from "vitest";
import { renderProjectContext } from "../src/project-context.js";

describe("project context browser security", () => {
  it.each(["awaiting_deployment", "pending"] as const)(
    "explains an unprovisioned %s domain without premature DNS instructions",
    (status) => {
      const { markdown } = renderProjectContext({
        project: {
          projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
          name: "Website",
          dataMode: "isolated",
          region: "us",
        } as Parameters<typeof renderProjectContext>[0]["project"],
        generatedAt: "2026-09-29T12:00:00.000Z",
        status: { lifecycle: "active", dev_url: null, prod_url: null },
        notes: { version: 0, markdown: "", updatedAt: null },
        mail: null,
        domain: {
          status,
          suspensionReason: null,
          hostname: "site.customer.example",
          environment: "prod",
          cnameTarget: "customers.ohmyho.st",
          customHostnameStatus: null,
          sslStatus: null,
          validationRecords: [],
          url: null,
        },
        creditAccess: "not_authorized",
      });
      expect(markdown).toContain(status);
      if (status === "awaiting_deployment") {
        expect(markdown).toContain("Authorize Cloudflare now");
        expect(markdown).toContain("same hostname and idempotency key");
      } else {
        expect(markdown).toContain("original domain command");
        expect(markdown).not.toContain("check DNS/TLS again");
      }
      expect(markdown).not.toContain("DNS CNAME:");
    },
  );

  it("states the nonce Content-Security-Policy an agent must build for", () => {
    const { markdown } = renderProjectContext({
      project: {
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        name: "Website",
        dataMode: "isolated",
        region: "us",
      } as Parameters<typeof renderProjectContext>[0]["project"],
      generatedAt: "2026-09-23T12:00:00.000Z",
      status: { lifecycle: "active", dev_url: null, prod_url: null },
      notes: { version: 0, markdown: "", updatedAt: null },
      mail: null,
      domain: "unavailable",
      creditAccess: "not_authorized",
    });
    expect(markdown).toContain("## Browser security");
    expect(markdown).toContain("style-src 'self' 'nonce-");
    expect(markdown).toContain("x-nonce");
    expect(markdown).toContain('style=""');
  });
});
