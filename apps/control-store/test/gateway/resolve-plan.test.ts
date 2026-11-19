import { expect, it } from "vitest";

import { RESOLVE } from "../../src/catalog/gateway/reads.js";
import { createTestControl } from "../support/control-d1.js";

/** The plan of a cold miss: no top-level scan of a base table, whichever table the planner would start from. */
it("looks a hostname up through the origin index and the paid-hostname index, never a scan of a base table", async () => {
  const control = await createTestControl();
  try {
    const plan = (
      await control.core
        .prepare(`EXPLAIN QUERY PLAN ${RESOLVE}`)
        .bind("never-deployed-studio.check.omh.st")
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH route USING INDEX shared_gateway_routes_origin_idx/u),
    );
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH paid USING INDEX paid_project_domains_live_hostname/u),
    );
    // Only the materialized union may be scanned; any other SCAN reads a table once per miss.
    expect(
      plan.filter((detail) => /^SCAN /u.test(detail) && !/^SCAN \(?subquery/u.test(detail)),
    ).toEqual([]);
  } finally {
    await control.dispose();
  }
}, 120_000);
