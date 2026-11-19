import { describe, expect, it } from "vitest";
import { planProjectDataChangeTransition } from "./project-data-environments.js";

const dev = "01H00000000000000000000801";
const prod = "01H00000000000000000000802";
const fresh = "01H00000000000000000000803";
const assignments = (shared: boolean) => ({
  dataMode: shared ? ("shared" as const) : ("isolated" as const),
  dev: {
    environmentId: dev,
    environment: "dev" as const,
    dataEnvironmentId: dev,
    assignmentVersion: 1,
    assignedAt: "2026-09-28T00:00:00.000Z",
  },
  prod: {
    environmentId: prod,
    environment: "prod" as const,
    dataEnvironmentId: shared ? dev : prod,
    assignmentVersion: 1,
    assignedAt: "2026-09-28T00:00:00.000Z",
  },
});

describe("project data identity transitions", () => {
  it("plans all four transitions without copying or deleting Prod and revokes retired Dev authority before switching", () => {
    for (const [change, losing] of [
      ["isolate_prod_keeps_data", "dev"],
      ["isolate_dev_keeps_data", "prod"],
    ] as const) {
      const result = planProjectDataChangeTransition({
        change,
        assignments: assignments(true),
        newDataEnvironmentId: fresh,
        prodDatabaseReady: true,
      });
      expect(result.after[losing].dataEnvironmentId).toBe(fresh);
      expect(result.after[losing === "dev" ? "prod" : "dev"].dataEnvironmentId).toBe(dev);
      expect(result.retiredDataEnvironmentIds).toEqual([]);
      expect(result.redeployEnvironments).toEqual([losing]);
      expect(result.reauthorizations[0]?.authorizedEnvironmentIds).toEqual([
        losing === "dev" ? prod : dev,
      ]);
    }
    const share = planProjectDataChangeTransition({
      change: "share_prod_keeps_data",
      assignments: assignments(false),
      newDataEnvironmentId: fresh,
      prodDatabaseReady: true,
    });
    expect(share.after.dev.dataEnvironmentId).toBe(prod);
    expect(share.after.prod.dataEnvironmentId).toBe(prod);
    expect(share.retiredDataEnvironmentIds).toEqual([dev]);
    expect(share.removeDevDeployment).toBe(true);
    const reset = planProjectDataChangeTransition({
      change: "reset_dev",
      assignments: assignments(false),
      newDataEnvironmentId: fresh,
      prodDatabaseReady: true,
    });
    expect(reset.after.dev.dataEnvironmentId).toBe(fresh);
    expect(reset.after.prod.dataEnvironmentId).toBe(prod);
    expect(reset.retiredDataEnvironmentIds).toEqual([dev]);
    expect(reset.reauthorizations).toEqual([
      { dataEnvironmentId: dev, authorizedEnvironmentIds: [], direction: "narrow" },
    ]);
  });
  it("refuses invalid modes, absent Prod data and reuse of a current identity", () => {
    for (const input of [
      {
        change: "reset_dev" as const,
        assignments: assignments(true),
        newDataEnvironmentId: fresh,
        prodDatabaseReady: true,
      },
      {
        change: "share_prod_keeps_data" as const,
        assignments: assignments(false),
        newDataEnvironmentId: fresh,
        prodDatabaseReady: false,
      },
      {
        change: "isolate_prod_keeps_data" as const,
        assignments: assignments(true),
        newDataEnvironmentId: dev,
        prodDatabaseReady: true,
      },
      {
        change: "isolate_dev_keeps_data" as const,
        assignments: assignments(false),
        newDataEnvironmentId: fresh,
        prodDatabaseReady: true,
      },
    ])
      expect(() => planProjectDataChangeTransition(input)).toThrow();
  });
});
