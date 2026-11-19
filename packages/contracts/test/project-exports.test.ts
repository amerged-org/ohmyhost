import { describe, expect, it } from "vitest";
import { assertProjectExport } from "../src/project-exports.js";

describe("project export archive files", () => {
  it("accepts legacy and Native archive inventories and rejects fabricated combinations", () => {
    const value = {
      id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      state: "succeeded",
      requested_at: "2026-11-04T00:00:00.000Z",
      next_request_at: "2026-11-04T00:00:00.000Z",
      next_poll_after_seconds: null,
      error: null,
      archive: {
        bytes: 1,
        sha256: `sha256:${"a".repeat(64)}`,
        sql_files: [] as string[],
        captured_at: "2026-11-04T00:00:00.000Z",
        expires_at: "2026-11-05T00:00:00.000Z",
        download_url: null,
        download_expires_at: null,
      },
    };
    for (const files of [
      ["dev.sql"],
      ["shared.sql"],
      ["auth.sql"],
      ["dev.sql", "auth.sql"],
      ["prod.sql", "auth.sql"],
      ["dev.sql", "prod.sql", "auth.sql"],
      ["shared.sql", "auth.sql"],
    ]) {
      expect(() =>
        assertProjectExport({ ...value, archive: { ...value.archive, sql_files: files } }),
      ).not.toThrow();
    }
    for (const files of [
      [],
      ["shared.sql", "dev.sql", "auth.sql"],
      ["auth.sql", "dev.sql"],
      ["auth.sql", "auth.sql"],
    ]) {
      expect(() =>
        assertProjectExport({ ...value, archive: { ...value.archive, sql_files: files } }),
      ).toThrow();
    }
  });
});
