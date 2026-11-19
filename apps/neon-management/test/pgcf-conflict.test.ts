import { expect, it } from "vitest";
import { DatabaseProviderConflictError } from "@ohmyhost/database";

import { createPgcfManagement, type PgcfManagementDependencies } from "../src/pgcf-runtime.js";

const ids = {
  organizationId: "01H0000000000000000000A001",
  projectId: "01H0000000000000000000A002",
  environmentId: "01H0000000000000000000A003",
  operationId: "01H0000000000000000000A004",
  claimId: "01H0000000000000000000A005",
};

it("refuses to place a project whose recorded database target is not PGCF", async () => {
  const claim = {
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    physicalEnvironmentId: ids.environmentId,
    operationId: ids.operationId,
    claimId: ids.claimId,
    regionId: "us-dev" as const,
  };
  const management = createPgcfManagement({
    provider: {} as PgcfManagementDependencies["provider"],
    connect: async () => {
      throw new Error("no connection expected");
    },
    admin: () => {
      throw new Error("no registry expected");
    },
    persistence: {
      resolveClaim: async () => claim,
      readTarget: async () => ({ provider: "neon" }) as never,
    } as unknown as PgcfManagementDependencies["persistence"],
  });

  await expect(management.placeProject(ids)).rejects.toBeInstanceOf(DatabaseProviderConflictError);
});
