import { parseUlid } from "@ohmyhost/platform";
import { expect, it } from "vitest";
import { createProjectExports } from "../src/project-exports.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001"),
  PROJECT_ID = parseUlid("00000000000000000000000002"),
  OPERATION_ID = parseUlid("00000000000000000000000003"),
  NOW = "2026-09-09T12:00:00.000Z",
  BUCKET = "ohmyho-development-backups",
  ORIGIN = "https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com";

function exportsWith(sqlFiles: string[], key: string, origin = ORIGIN) {
  const archive = {
    bytes: 10,
    sha256: "a".repeat(64),
    sqlFiles,
    capturedAt: NOW,
    expiresAt: "2026-09-20T12:00:00.000Z",
  };
  const url = `${origin}/${BUCKET}/${key}/${ORGANIZATION_ID}/${PROJECT_ID}/${OPERATION_ID}.zip?X-Amz-Date=20260909T120000Z&X-Amz-Expires=86400&X-Amz-Signature=${"b".repeat(64)}`;
  return createProjectExports({
    key: new Uint8Array(32),
    crypto: globalThis.crypto,
    clock: { now: () => new Date(NOW) },
    ids: { next: () => OPERATION_ID },
    archiveBucket: BUCKET,
    r2AccountId: "00000000000000000000000000000001",
    downloadBinding: {
      invokeRecovery: async () => ({
        status: "ready",
        operationId: OPERATION_ID,
        bytes: archive.bytes,
        sha256: archive.sha256,
        sqlFiles,
        capturedAt: NOW,
        archiveExpiresAt: archive.expiresAt,
        downloadExpiresAt: "2026-09-10T12:00:00.000Z",
        url,
      }),
    },
    persistence: {
      replay: async () => null,
      recordDownloadLink: async () => true,
      inventory: async () => null,
      accept: async () => {
        throw new Error("unused");
      },
      status: async () => ({
        state: "succeeded",
        requestedAt: NOW,
        nextRequestAt: NOW,
        failureCode: null,
        archive,
      }),
    } as never,
  });
}
const scope = {
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  principalId: "user:owner",
  requestId: "request",
  operationId: OPERATION_ID,
};

it("returns the native-exports download URL of a Native Auth project export", async () => {
  const exports = exportsWith(["prod.sql", "auth.sql"], "native-exports");
  const result = await exports.issueDownloadLink(scope);
  expect(result?.body).toMatchObject({
    download_url: expect.stringContaining("/native-exports/"),
  });
});

it("refuses a snapshots URL for a Native Auth export and a native-exports URL for a plain export", async () => {
  await expect(
    exportsWith(["prod.sql", "auth.sql"], "snapshots").issueDownloadLink(scope),
  ).rejects.toThrow("Project export download unavailable");
  await expect(
    exportsWith(["prod.sql"], "native-exports").issueDownloadLink(scope),
  ).rejects.toThrow("Project export download unavailable");
});

it("keeps the snapshots URL for a plain export", async () => {
  const result = await exportsWith(["prod.sql"], "snapshots").issueDownloadLink(scope);
  expect(result?.body).toMatchObject({
    download_url: expect.stringContaining("/snapshots/"),
  });
});

it("refuses an otherwise matching download URL from another R2 account", async () => {
  const otherOrigin = "https://00000000000000000000000000000002.eu.r2.cloudflarestorage.com";
  await expect(
    exportsWith(["prod.sql"], "snapshots", otherOrigin).issueDownloadLink(scope),
  ).rejects.toThrow("Project export download unavailable");
});
