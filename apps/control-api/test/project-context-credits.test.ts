import { describe, expect, it } from "vitest";
import { renderProjectContext } from "../src/project-context.js";

type Input = Parameters<typeof renderProjectContext>[0];
const projectId = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const meter = (charged: string) => ({
  environment_id: null,
  meter: "requests",
  unit: "request",
  rate_card_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
  quantity: "10",
  charged_micros: charged,
});
const day = {
  day: "2026-10-29",
  projects: [{ project_id: projectId, meters: [meter("1200"), meter("34")] }],
};
const usage: NonNullable<Input["usage"]> = {
  organization_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
  as_of: "2026-10-30T10:00:00.000Z",
  unit: "microcredits",
  period: "2026-10",
  from: "2026-10-17T00:00:00.000Z",
  projects: [{ project_id: projectId, used_micros: "1234" }],
  days: [day],
};
const common: Input = {
  project: { projectId, name: "Website", dataMode: "isolated", region: "us" } as Input["project"],
  generatedAt: "2026-10-30T10:00:00.000Z",
  status: { lifecycle: "active", dev_url: null, prod_url: null },
  notes: { version: 0, markdown: "", updatedAt: null },
  mail: null,
  domain: "unavailable",
  creditAccess: "included",
  credits: { available_micros: "5000000" },
  budget: { amount_micros: "9000000", mode: "stop", reserved_micros: "250" },
};
const base: Input = { ...common, usage };

describe("project context credits and usage", () => {
  it("shows the project's use of the month, its daily charges, reservation and budget", () => {
    const { markdown, credit_access } = renderProjectContext(base);
    expect(credit_access).toBe("included");
    expect(markdown).toContain("Organization available: 5000000");
    expect(markdown).toContain("Project posted usage (2026-10): 1234");
    expect(markdown).toContain("Project reserved: 250");
    expect(markdown).toContain("Project budget: 9000000; mode: stop");
    expect(markdown).toContain("Project daily charges (UTC, last 14 days): 2026-10-29 1234");
    expect(markdown).toContain("Usage observed at: 2026-10-30T10:00:00.000Z");
  });

  it("reports zero use and no daily charges for a project without usage", () => {
    const { markdown } = renderProjectContext({
      ...base,
      usage: { ...usage, projects: [], days: [] },
    });
    expect(markdown).toContain("Project posted usage (2026-10): 0");
    expect(markdown).toContain("Project daily charges (UTC, last 14 days): none");
  });

  it("refuses usage that belongs to another project", () => {
    const foreign = "01K2F3G4H5J6K7M8N9P0QRSTVZ";
    expect(() =>
      renderProjectContext({
        ...base,
        usage: { ...usage, projects: [{ project_id: foreign, used_micros: "1" }] },
      }),
    ).toThrow("Usage is not scoped to this project");
    expect(() =>
      renderProjectContext({
        ...base,
        usage: {
          ...usage,
          days: [{ ...day, projects: [{ project_id: foreign, meters: [meter("1")] }] }],
        },
      }),
    ).toThrow("Usage is not scoped to this project");
  });

  it("refuses an authorized caller's incomplete report unless it is marked unavailable", () => {
    const withoutUsage = common;
    expect(() => renderProjectContext(withoutUsage)).toThrow(
      "Authorized credit report unavailable",
    );
    expect(
      renderProjectContext({ ...withoutUsage, financialUnavailable: true }).markdown,
    ).toContain("Credit and usage reporting is temporarily unavailable");
  });
});
