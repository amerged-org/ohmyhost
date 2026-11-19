import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/057_customer_database_binding.mjs";

const recorder = () => ({ sql: vi.fn() });

describe("customer database binding migration", () => {
  it("guards every persisted auth row before replacing the validator or mutating plans", () => {
    const pgm = recorder();

    up(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "persisted customer auth plan is not canonical for database binding cutover",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ohmyhost.framework-plan/v5");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("IS DISTINCT FROM");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("IS NOT TRUE");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("IN ('HYPERDRIVE','OHMYHOST_DATABASE')");
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ERRCODE='23514'");
  });

  it("installs only the platform-neutral binding and atomically rewrites old plans", () => {
    const pgm = recorder();

    up(pgm);

    expect(pgm.sql.mock.calls[1]?.[0]).toContain(
      "CREATE OR REPLACE FUNCTION valid_customer_auth_requirement",
    );
    expect(pgm.sql.mock.calls[1]?.[0]).toContain(
      "requirement->>'databaseBindingName'='OHMYHOST_DATABASE'",
    );
    expect(pgm.sql.mock.calls[1]?.[0]).not.toContain(
      "requirement->>'databaseBindingName'='HYPERDRIVE'",
    );
    expect(pgm.sql.mock.calls[2]?.[0]).toContain(
      "ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_append_only",
    );
    expect(pgm.sql.mock.calls[3]?.[0]).toContain("UPDATE deployment_plans");
    expect(pgm.sql.mock.calls[3]?.[0]).toContain("to_jsonb('OHMYHOST_DATABASE'::text)");
    expect(pgm.sql.mock.calls[3]?.[0]).toContain(
      "framework_plan->'auth'->>'databaseBindingName'='HYPERDRIVE'",
    );
    expect(pgm.sql.mock.calls[4]?.[0]).toContain(
      "ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_append_only",
    );
  });

  it("verifies all rewritten rows and the existing validated plan constraint", () => {
    const pgm = recorder();

    up(pgm);

    expect(pgm.sql.mock.calls[5]?.[0]).toContain(
      "valid_customer_auth_requirement(framework_plan->'auth') IS NOT TRUE",
    );
    expect(pgm.sql.mock.calls[5]?.[0]).toContain("conname='deployment_plans_framework_plan_check'");
    expect(pgm.sql.mock.calls[5]?.[0]).toContain("convalidated");
  });

  it("blocks downgrade with live Better Auth plans and restores the previous validator only when empty", () => {
    const pgm = recorder();

    down(pgm);

    expect(pgm.sql).toHaveBeenCalledTimes(2);
    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "customer database binding cutover cannot restore live HYPERDRIVE plans",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ERRCODE='23514'");
    expect(pgm.sql.mock.calls[1]?.[0]).toContain(
      "CREATE OR REPLACE FUNCTION valid_customer_auth_requirement",
    );
    expect(pgm.sql.mock.calls[1]?.[0]).toContain(
      "requirement->>'databaseBindingName'='HYPERDRIVE'",
    );
  });
});
