import { expect, it } from "vitest";
import type { PreviewRuntimeRecord } from "@ohmyhost/contracts/previews";
import { authorizePreviewDatabase } from "../src/preview-database.js";
import { readDatabaseRegistrationReceipt } from "../src/registry.js";

it("uses the current logical assignment for shared data and rejects foreign or changed scope", async () => {
  const id = (n: number) => String(n).padStart(26, "0");
  const fence = { previewId: id(1), runtimeGeneration: 1, tokenGeneration: 1 };
  let preview = {
    ...fence,
    organizationId: id(2),
    projectId: id(3),
    environmentId: id(4),
    dataEnvironmentId: id(5),
    region: "eu",
    retirement: "none",
    state: "ready",
    assignmentVersion: 1,
    authGeneration: 1,
  } as unknown as PreviewRuntimeRecord;
  const binding = readDatabaseRegistrationReceipt({
    organizationId: id(2),
    projectId: id(3),
    physicalEnvironmentId: id(5),
    region: "eu",
    operationId: id(6),
    registrationVersion: 1,
    provider: "pgcf",
    providerProjectId: "p1234567890123456789",
    databaseId: "d1234567890123456789",
    originHost: "database.example.com",
    originDatabase: "d1234567890123456789",
    originUser: `ohmyho_rw_${id(5)}`,
    authorizedEnvironmentIds: [id(4), id(7)],
    status: "active",
  });
  if (binding.provider !== "pgcf") throw new Error("test registration is not PGCF");
  const authority = {
    PROJECT_PREVIEW_AUTHORITY: { authorizeDatabase: async () => ({ preview, binding }) },
  };
  const inspect = async () => binding;
  const admitted = await authorizePreviewDatabase(authority, fence, inspect);
  expect(admitted.scope).toMatchObject({ environmentId: id(4), physicalEnvironmentId: id(5) });
  preview = { ...preview, assignmentVersion: 2 };
  await expect(authorizePreviewDatabase(authority, fence, inspect, admitted)).rejects.toThrow();
  preview = { ...preview, environmentId: id(8) };
  await expect(authorizePreviewDatabase(authority, fence, inspect)).rejects.toThrow();
  preview = { ...preview, environmentId: id(4), dataEnvironmentId: id(8) };
  await expect(authorizePreviewDatabase(authority, fence, inspect)).rejects.toThrow();
});
