import { describe, expect, it, vi } from "vitest";

import { up as installMigration053 } from "../migrations/053_application_scheduled_functions_contract.mjs";
import { down, up } from "../migrations/056_framework_build_commands.mjs";

const recorder = () => ({ sql: vi.fn(), dropConstraint: vi.fn(), addConstraint: vi.fn() });

describe("portable framework build command migration", () => {
  it("guards persisted rows before creating the immutable command predicate", () => {
    const pgm = recorder();

    up(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "persisted framework plan uses unsupported build commands",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ERRCODE='23514'");
    expect(pgm.sql.mock.calls[1]?.[0]).toContain("CREATE FUNCTION valid_framework_build_commands");
    expect(pgm.sql.mock.calls[1]?.[0]).toContain("IMMUTABLE PARALLEL SAFE");
  });

  it("installs one validated v5 constraint that delegates every runtime shape to the predicate", () => {
    const pgm = recorder();

    up(pgm);

    const check = pgm.addConstraint.mock.calls[0]?.[2]?.check;
    expect(pgm.dropConstraint).toHaveBeenCalledWith(
      "deployment_plans",
      "deployment_plans_framework_plan_check",
    );
    expect(check).toContain("ohmyhost.framework-plan/v5");
    expect(check?.match(/valid_framework_build_commands\(framework_plan\)/gu)).toHaveLength(5);
    expect(check).toContain("valid_functions_requirement(framework_plan->'functions')");
    expect(check).not.toContain("NOT VALID");
  });

  it("refuses a lossy downgrade before restoring the migration 053 contract", () => {
    const pgm = recorder();
    const previous = recorder();

    down(pgm);
    installMigration053(previous);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "portable framework build commands prevent migration downgrade",
    );
    expect(pgm.sql.mock.calls[0]?.[0]).toContain("ERRCODE='23514'");
    expect(pgm.sql).toHaveBeenCalledWith("DROP FUNCTION valid_framework_build_commands(jsonb)");
    expect(pgm.addConstraint.mock.calls[0]?.[2]?.check).toBe(
      previous.addConstraint.mock.calls[0]?.[2]?.check,
    );
  });
});
