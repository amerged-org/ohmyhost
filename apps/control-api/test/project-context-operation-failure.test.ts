import { publicOperationFailure } from "@ohmyhost/contracts/operation-failure";
import { describe, expect, it } from "vitest";
import { renderProjectContext } from "../src/project-context.js";

describe("project context operation failure", () => {
  it("shows what happened and the next action of a failed database size change", () => {
    const failure = publicOperationFailure("DATABASE_COMPUTE_FAILED");
    const { markdown } = renderProjectContext({
      project: {
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        name: "Website",
        dataMode: "isolated",
        region: "us",
      } as Parameters<typeof renderProjectContext>[0]["project"],
      generatedAt: "2026-10-31T12:00:00.000Z",
      status: {
        lifecycle: "active",
        dev_url: null,
        prod_url: null,
        latest_operation: {
          id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
          state: "failed",
          error: failure,
        },
      },
      notes: { version: 0, markdown: "", updatedAt: null },
      mail: null,
      domain: "unavailable",
      creditAccess: "not_authorized",
    });
    expect(markdown).toContain("Operation issue: database\\_compute\\_failed");
    expect(markdown).toContain(`What happened: ${failure.message}`);
    expect(markdown).toMatch(/Next action: .*new idempotency key/su);
  });
});
