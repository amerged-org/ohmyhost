import { expect, it } from "vitest";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl } from "./support/control-d1.js";
import { seedProject } from "./support/platform-fixtures.js";
import { seedProviderClaim } from "./support/accepted-operation.js";
import {
  seedDeploymentPlan,
  seedWfpPublication,
  sourceFrameworkPlan,
} from "./support/provider-fixtures.js";

it("seeds a complete publication over real original-shaped parents and leaves every static FK enabled", async () => {
  const c = await createTestControl();
  try {
    const p = await seedProject(c),
      claim = await seedProviderClaim(p, p.prodEnvironmentId);
    const ids = await seedWfpPublication(p, {
      operationId: claim.operationId,
      frameworkPlan: sourceFrameworkPlan(true),
      headVersion: 2,
    });
    expect(
      await c.core
        .prepare("SELECT active_revision_id,active_version FROM deployments WHERE deployment_id=?")
        .bind(ids.deploymentId)
        .first(),
    ).toEqual({ active_revision_id: ids.revisionId, active_version: 1 });
    expect(
      await c.core
        .prepare(
          "SELECT artifact_id,build_execution_id,wfp_receipt_id FROM deployment_revisions WHERE revision_id=?",
        )
        .bind(ids.revisionId)
        .first(),
    ).toEqual({
      artifact_id: ids.artifactId,
      build_execution_id: ids.buildExecutionId,
      wfp_receipt_id: ids.wfpReceiptId,
    });
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='wfp_candidate_receipts_exact_identity'",
          )
          .all()
      ).results,
    ).toHaveLength(1);
  } finally {
    await c.dispose();
  }
});

it("never aliases source identities across projects and reuses exact scoped source/grant parents", async () => {
  const c = await createTestControl();
  try {
    const projects = [];
    for (let index = 0; index < 24; index++) {
      const p = await seedProject(c);
      projects.push(p);
      await seedDeploymentPlan(p, newUlid(), sourceFrameworkPlan(false), p.prodEnvironmentId);
      await seedDeploymentPlan(p, newUlid(), sourceFrameworkPlan(false), p.prodEnvironmentId);
    }
    for (const p of projects) {
      expect(
        await c.core
          .prepare(
            "SELECT count(*) n FROM source_connections WHERE organization_id=? AND project_id=?",
          )
          .bind(p.organizationId, p.projectId)
          .first(),
      ).toEqual({ n: 1 });
      expect(
        await c.core
          .prepare(
            "SELECT count(*) n FROM repository_grants WHERE organization_id=? AND project_id=?",
          )
          .bind(p.organizationId, p.projectId)
          .first(),
      ).toEqual({ n: 1 });
    }
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 120000);
