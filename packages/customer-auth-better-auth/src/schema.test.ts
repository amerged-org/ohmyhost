import { readFile } from "node:fs/promises";

import { admitExpandOnlyMigrations } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import { renderCustomerAuthMigration } from "./schema.js";

describe("official Better Auth PostgreSQL schema", () => {
  it("renders the checked-in auth-schema migration and passes production admission", async () => {
    const generated = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    const migration = await readFile(
      new URL("../migrations/20260822000000_better_auth.sql", import.meta.url),
      "utf8",
    );

    expect(renderCustomerAuthMigration(generated)).toBe(migration);
    expect(
      admitExpandOnlyMigrations([
        {
          path: "20260822000000_better_auth.sql",
          body: new TextEncoder().encode(migration),
        },
      ]),
    ).toMatchObject({ statementCount: 9 });
  });

  it.each([
    "",
    "drop table user;",
    'create table "unexpected" ("id" text);',
    `${'create table "user" ("id" text);\n'.repeat(20_000)}`,
  ])("rejects schema drift before rendering %#", (value) => {
    expect(() => renderCustomerAuthMigration(value)).toThrow(
      "Generated Better Auth schema is invalid",
    );
  });
});
