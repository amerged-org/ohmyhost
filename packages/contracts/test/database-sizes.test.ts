import { describe, expect, it } from "vitest";
import { assertDatabaseCompute } from "../src/database-compute.js";
import {
  assertDatabaseSizeChange,
  databaseSizeForClass,
  databaseSizeForMemory,
  parseDatabaseComputeChangeRequest,
} from "../src/database-sizes.js";

describe("fixed database size contract", () => {
  it("requires an exclusive confirmed fixed-size or transitional selection", () => {
    expect(
      parseDatabaseComputeChangeRequest({ environment: "prod", memory_mib: 512, confirm: true }),
    ).toEqual({ environment: "prod", selection: { memoryMiB: 512 } });
    expect(
      parseDatabaseComputeChangeRequest({ environment: "dev", profile: "standard", confirm: true })
        .selection,
    ).toEqual({ profile: "standard" });
    for (const input of [
      null,
      [],
      {},
      { environment: "prod", memory_mib: 512, confirm: false },
      { environment: "prod", memory_mib: 512, profile: "standard", confirm: true },
      { environment: "prod", memory_mib: "512", confirm: true },
      { environment: "prod", profile: "free", confirm: true },
    ])
      expect(() => parseDatabaseComputeChangeRequest(input)).toThrow();
  });
  it("enforces Free eligibility and refuses an implicit volume shrink", () => {
    expect(
      assertDatabaseSizeChange({ memoryMiB: 256, paid: false, currentStorageMiB: 0 }).storageMiB,
    ).toBe(500);
    expect(() =>
      assertDatabaseSizeChange({ memoryMiB: 512, paid: false, currentStorageMiB: 500 }),
    ).toThrow("Paid");
    expect(() =>
      assertDatabaseSizeChange({ memoryMiB: 256, paid: true, currentStorageMiB: 1024 }),
    ).toThrow("separate data migration");
    expect(() =>
      assertDatabaseSizeChange({ memoryMiB: 512, paid: true, currentStorageMiB: NaN }),
    ).toThrow("allocation");
    expect(
      assertDatabaseSizeChange({ memoryMiB: 1024, paid: true, currentStorageMiB: 1024 })
        .creditsPerAwakeHour,
    ).toBe(40);
    for (const value of ["512", 0, 768, 8192, null])
      expect(() => databaseSizeForMemory(value)).toThrow();
    expect(() => databaseSizeForClass("historical-dev-class")).toThrow();
  });

  it("reports exact PGCF resources and cold/warm state without inventing Neon CU values", () => {
    const size = databaseSizeForMemory(512);
    const report = {
      project_id: "01J00000000000000000000002",
      environment: "dev",
      data_mode: "isolated",
      observed_at: "2026-10-26T12:00:00.000Z",
      database: {
        provider: "pgcf",
        size_class_id: size.sizeClassId,
        memory_mib: 512,
        cpu_millicores: 250,
        storage_mib: 1024,
        max_connections: 40,
        suspend_timeout_seconds: 300,
        state: "cold",
        pending_state: null,
        disabled: false,
        region: "us",
      },
    };
    expect(() => assertDatabaseCompute(report)).not.toThrow();
    // The retired Neon CU object is refused as a whole, not accepted beside the PGCF shape.
    expect(() =>
      assertDatabaseCompute({
        ...report,
        database: {
          min_cu: 1,
          max_cu: 1,
          min_memory_gb: 4,
          max_memory_gb: 4,
          suspend_timeout_seconds: 0,
          state: "idle",
          pending_state: null,
          disabled: false,
          region: "aws-us-east-1",
        },
      }),
    ).toThrow("Invalid database compute configuration");
    for (const change of [
      { memory_mib: 1024 },
      { storage_mib: 500 },
      { region: "aws-us-east-1" },
      { state: "idle" },
      { pending_state: "active" },
      { min_cu: 0.25 },
      { disabled: null },
      { suspend_timeout_seconds: 0 },
      { max_connections: 100 },
    ]) {
      expect(() =>
        assertDatabaseCompute({ ...report, database: { ...report.database, ...change } }),
      ).toThrow();
    }
  });
});
