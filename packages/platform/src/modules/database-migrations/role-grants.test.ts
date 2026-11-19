import { describe, expect, it } from "vitest";

import {
  DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS,
  DATABASE_RUNTIME_GRANT_STATEMENTS,
  createDatabaseRoleBootstrapStatements,
} from "./role-grants.js";

describe("portable PostgreSQL role grants", () => {
  it("creates the exact bootstrap statements", () => {
    expect(createDatabaseRoleBootstrapStatements("appdb")).toEqual([
      "REVOKE CREATE ON DATABASE appdb FROM PUBLIC",
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
      "GRANT CREATE ON DATABASE appdb TO ohmyho_migration",
      "GRANT USAGE, CREATE ON SCHEMA public TO ohmyho_migration",
      "GRANT USAGE ON SCHEMA public TO ohmyho_runtime, ohmyho_readonly",
    ]);
    expect(createDatabaseRoleBootstrapStatements("ohmyhost_project")[0]).toBe(
      "REVOKE CREATE ON DATABASE ohmyhost_project FROM PUBLIC",
    );
    expect(Object.isFrozen(createDatabaseRoleBootstrapStatements("appdb"))).toBe(true);
  });

  it.each(["", "AppDB", "db-name", "db;drop database postgres", "a".repeat(64)])(
    "rejects unsafe database name %s",
    (value) => {
      expect(() => createDatabaseRoleBootstrapStatements(value)).toThrow(
        "Database name is invalid",
      );
    },
  );

  it("keeps runtime and read-only capabilities distinct", () => {
    expect(DATABASE_RUNTIME_GRANT_STATEMENTS).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ohmyho_runtime",
    );
    expect(DATABASE_RUNTIME_GRANT_STATEMENTS).toContain(
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO ohmyho_readonly",
    );
    expect(DATABASE_RUNTIME_GRANT_STATEMENTS.join("\n")).not.toMatch(
      /ohmyho_readonly.*(?:INSERT|UPDATE|DELETE|EXECUTE)/u,
    );
    expect(Object.isFrozen(DATABASE_RUNTIME_GRANT_STATEMENTS)).toBe(true);
  });

  it("adds auth-schema access only through the explicit customer-auth contract", () => {
    expect(DATABASE_RUNTIME_GRANT_STATEMENTS.join("\n")).not.toContain("SCHEMA auth");
    expect(DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO ohmyho_runtime",
    );
    expect(DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS.join("\n")).not.toMatch(
      /ohmyho_readonly.*(?:INSERT|UPDATE|DELETE)/u,
    );
    expect(DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS.join("\n")).not.toMatch(
      /GRANT .* TO ohmyho_readonly/u,
    );
    expect(DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM ohmyho_readonly",
    );
    expect(Object.isFrozen(DATABASE_CUSTOMER_AUTH_GRANT_STATEMENTS)).toBe(true);
  });
});
