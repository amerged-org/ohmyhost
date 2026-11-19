import type { ProjectDatabaseSqlTarget } from "@ohmyhost/database";
import { describe, expect, it } from "vitest";

import { queryPgcfProject } from "../src/pgcf-data-operations.js";

const PGCF_PROJECT = "prj_abcdefghij0123456789";
const ORG = "01J5ABCDEFGHJKMNPQRSTVWXYZ";
const OMH_PROJECT = "01J7ABCDEFGHJKMNPQRSTVWXYZ";

const unexpected = (): never => {
  throw new Error("Unexpected provider call");
};

const request = {
  organizationId: ORG,
  projectId: OMH_PROJECT,
  environment: "dev",
  statement: "SELECT 1",
  parameters: [],
};

const provider = { projectId: PGCF_PROJECT, readConnection: unexpected };
const connect = unexpected;

function pgcfTarget(providerProjectId: string): ProjectDatabaseSqlTarget {
  return {
    provider: "pgcf",
    dataEnvironmentId: "01J8ABCDEFGHJKMNPQRSTVWXYZ",
    providerProjectId,
    roleName: "ohmyho_rw_01j6abcdefghjkmnpqrstvwxyz",
    originHost: "db.example.com",
    databaseId: "aaaaaaaaaaaaaaaaaaaa",
  };
}

describe("queryPgcfProject", () => {
  it("answers absent for an environment without a database yet, without any provider call", async () => {
    await expect(
      queryPgcfProject({ readTarget: async () => null, provider, connect }, request),
    ).resolves.toEqual({ status: "absent" });
  });

  it("refuses a database that PGCF does not place in this provider project", async () => {
    const readTarget = async () => pgcfTarget("prj_otherprojectxxxxxxxx");
    await expect(queryPgcfProject({ readTarget, provider, connect }, request)).rejects.toThrow(
      "Project database diagnostics are unavailable",
    );
  });
});
