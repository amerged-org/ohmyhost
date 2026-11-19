import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/058_project_handles_environments.mjs";

const recorder = () => ({ sql: vi.fn() });

describe("project handles and environments migration", () => {
  it("fails closed before installing constraints when existing project evidence is incomplete", () => {
    const pgm = recorder();

    up(pgm);

    const cutover = pgm.sql.mock.calls[0]?.[0];
    expect(cutover).toContain("project handle cutover requires truthful staged evidence");
    expect(cutover).toContain(
      "project environment cutover requires exact staged dev and prod rows",
    );
    expect(cutover).not.toContain("legacy-sequence-v1");
    expect(cutover).not.toContain("row_number()");
  });

  it("refuses to infer environment gateway evidence from legacy receipts", () => {
    const pgm = recorder();

    up(pgm);

    const cutover = pgm.sql.mock.calls[0]?.[0];
    expect(cutover).toContain(
      "project gateway cutover requires fresh environment-specific provider receipts",
    );
    expect(cutover).toContain(
      "SELECT 1 FROM wfp_publish_receipts WHERE gateway_contract_version IS NOT NULL",
    );
    expect(cutover).not.toContain("UPDATE wfp_publish_receipts");
  });

  it("installs immutable handle and exact dev/prod environment constraints", () => {
    const pgm = recorder();

    up(pgm);

    const cutover = pgm.sql.mock.calls[0]?.[0];
    expect(cutover).toContain("projects_handle_key");
    expect(cutover).toContain("projects_handle_shape_check");
    expect(cutover).toContain("length(handle)<=59");
    expect(cutover).toContain("projects_handle_evidence_check");
    expect(cutover).toContain("human-id-4.2.0-sha256-project-handle-words-v1");
    expect(cutover).toContain("environments_poc_name_check");
    expect(cutover).toContain("environments_project_environment_key");
    expect(cutover).toContain("environments_project_id_distinct_check");
    expect(cutover).toContain("CHECK (name IN ('dev','prod'))");
    expect(cutover).toContain("ALTER TABLE environments DROP COLUMN is_default");
    expect(cutover).not.toContain("NEW.is_default");
    expect(cutover).toContain("projects_exact_poc_environments");
    expect(cutover).toContain("environments_exact_poc_set");
    expect(cutover).toContain("DROP CONSTRAINT wfp_publish_receipts_gateway_shape_check");
    expect(cutover).toContain("ADD COLUMN gateway_egress_policy_sha256 bytea");
    expect(cutover).toContain("octet_length(gateway_egress_policy_sha256)=32");
    expect(cutover).toContain("gateway_contract_version='ohmyhost.project-gateway/v5'");
    expect(cutover).toContain("WHEN 'prod' THEN project_handle");
    expect(cutover).toContain("WHEN 'dev' THEN 'dev-'||project_handle");
    expect(cutover).toContain(
      "NEW.gateway_target_script_name<>'p-'||lower(NEW.project_id::text)||'-'||environment_name",
    );
    expect(cutover).toContain("NEW.deployment_url<>NEW.gateway_public_origin");
    expect(cutover).not.toContain("gateway_script_name='g-'");
    expect(cutover).not.toContain("gateway_public_origin||'/p/'");
    expect(cutover.match(/FOREIGN KEY \(project_id,environment_id\)/gu)).toHaveLength(16);
    expect(cutover.match(/ON UPDATE CASCADE/gu)).toHaveLength(2);
  });

  it("guards project handle and environment creation identity against mutation or deletion", () => {
    const pgm = recorder();

    up(pgm);

    const cutover = pgm.sql.mock.calls[0]?.[0];
    expect(cutover).toContain("NEW.handle IS DISTINCT FROM OLD.handle");
    expect(cutover).toContain("NEW.handle_version IS DISTINCT FROM OLD.handle_version");
    expect(cutover).toContain("NEW.handle_attempt IS DISTINCT FROM OLD.handle_attempt");
    expect(cutover).toContain("environment creation identity is immutable");
    expect(cutover).toContain("project environments cannot be deleted");
  });

  it("refuses a lossy downgrade while any project exists", () => {
    const pgm = recorder();

    down(pgm);

    expect(pgm.sql).toHaveBeenCalledTimes(1);
    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "project handle cutover cannot be downgraded while projects exist",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ERRCODE='23514'");
    expect(
      pgm.sql.mock.calls[0]?.[0].match(
        /FOREIGN KEY \(organization_id,project_id,environment_id\)/gu,
      ),
    ).toHaveLength(18);
  });
});
