import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/062_immutable_wfp_candidates.mjs";

function recorder() {
  return {
    addColumns: vi.fn(),
    addConstraint: vi.fn(),
    createTable: vi.fn(),
    createTrigger: vi.fn(),
    dropColumns: vi.fn(),
    dropConstraint: vi.fn(),
    dropTable: vi.fn(),
    dropTrigger: vi.fn(),
    sql: vi.fn(),
  };
}

describe("immutable WFP candidate migration", () => {
  it("refuses to infer immutable candidate identity from nonempty v5 runtime evidence", () => {
    const pgm = recorder();
    up(pgm);
    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "immutable WFP candidate cutover requires fresh v6 runtime evidence",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("SELECT 1 FROM wfp_publish_receipts");
    expect(pgm.sql.mock.calls[0]?.[0]).not.toContain("UPDATE wfp_publish_receipts");
  });

  it("creates append-only candidate and cleanup receipts with exact v6 identities", () => {
    const pgm = recorder();
    up(pgm);
    expect(pgm.createTable).toHaveBeenCalledWith(
      "wfp_candidate_receipts",
      expect.objectContaining({
        immutable_script_name: expect.objectContaining({ notNull: true }),
      }),
    );
    expect(pgm.createTable).toHaveBeenCalledWith(
      "wfp_candidate_cleanup_receipts",
      expect.objectContaining({
        observed_provider_tag: expect.objectContaining({ notNull: true }),
      }),
    );
    expect(pgm.createTrigger).toHaveBeenCalledWith(
      "wfp_candidate_receipts",
      "wfp_candidate_receipts_append_only",
      expect.any(Object),
    );
    expect(pgm.createTrigger).toHaveBeenCalledWith(
      "wfp_candidate_cleanup_receipts",
      "wfp_candidate_cleanup_receipts_append_only",
      expect.any(Object),
    );
    expect(pgm.addColumns).toHaveBeenCalledWith(
      "wfp_publish_receipts",
      expect.objectContaining({
        candidate_receipt_id: expect.objectContaining({ notNull: true }),
        product_deployment_id: expect.objectContaining({ notNull: true }),
        gateway_version_id: expect.objectContaining({ notNull: true }),
        gateway_deployment_id: expect.objectContaining({ notNull: true }),
      }),
    );
    const constraints = pgm.addConstraint.mock.calls.map((call) => JSON.stringify(call)).join("\n");
    expect(constraints).toContain("ohmyhost.project-gateway/v6");
    expect(constraints).toContain("gateway_target_script_name=script_name");
    expect(constraints).toContain("candidate_receipt_id");
    const functions = pgm.sql.mock.calls.map((call) => String(call[0])).join("\n");
    expect(functions).toContain("require_exact_wfp_candidate");
    expect(functions).toContain("WFP publish receipt does not match its immutable candidate");
    expect(functions).toContain("NEW.product_deployment_id<>candidate.product_deployment_id");
  });

  it("refuses a lossy downgrade while candidate, cleanup, or final evidence exists", () => {
    const pgm = recorder();
    down(pgm);
    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "immutable WFP candidate evidence prevents a lossless downgrade",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("wfp_candidate_receipts");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("wfp_candidate_cleanup_receipts");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("wfp_publish_receipts");
  });
});
