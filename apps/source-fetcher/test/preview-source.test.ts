import { describe, expect, it } from "vitest";
import { createPreviewSourceReader } from "../src/preview-source.js";
import { gzipTar, viteEntries } from "./tar-fixture.js";

const previewId = "01J00000000000000000000001";
const sourceConnectionId = "01J00000000000000000000002";
const version = (sequence: number) => ({
  sourceConnectionId,
  sourceGeneration: 1,
  sequence,
  commitSha: String(sequence).repeat(40),
});
const descriptor = {
  targetSource: version(2),
  provider: "managed" as const,
  organizationId: previewId,
  billingEpochId: previewId,
  projectId: previewId,
  environmentId: previewId,
  sourceConnectionId,
  region: "eu" as const,
  repository: { owner: "repo", name: "repo", externalRepositoryId: "repo/repo" },
  grant: {
    status: "approved" as const,
    grantId: previewId,
    organizationId: previewId,
    billingEpochId: previewId,
    projectId: previewId,
    sourceConnectionId,
    installationId: null,
    repositoryId: "repo/repo",
    owner: "repo",
    repository: "repo",
    permission: "contents:read" as const,
    grantedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  },
};

describe("preview exact source", () => {
  it("sends the exact changed bytes and deletes, with frozen install facts", async () => {
    const first = await gzipTar(
      viteEntries([
        { path: "fixture/a.txt", content: "old" },
        { path: "fixture/gone.txt", content: "gone" },
        { path: "fixture/script.sh", content: "echo ok", executable: false },
      ]),
    );
    const second = await gzipTar(
      viteEntries([
        { path: "fixture/a.txt", content: "new" },
        { path: "fixture/script.sh", content: "echo ok", executable: true },
      ]),
    );
    const source = createPreviewSourceReader({
      readSource: async () => descriptor,
      readArchive: async (_source, commit) => (commit === version(1).commitSha ? first : second),
    });
    const result = await source.diff({
      previewId,
      runtimeGeneration: 1,
      tokenGeneration: 1,
      from: version(1),
      to: version(2),
    });
    expect(result.operations.map((item) => [item.kind, item.path])).toEqual([
      ["delete", "gone.txt"],
      ["write", "a.txt"],
      ["write", "script.sh"],
    ]);
    const write = result.operations[1];
    expect(write?.kind === "write" && new TextDecoder().decode(write.bytes)).toBe("new");
    expect(result.operations[2]).toMatchObject({
      kind: "write",
      path: "script.sh",
      executable: true,
    });
    expect(result.dependenciesChanged).toBe(false);
    expect(result.install).toMatchObject({
      manager: "pnpm",
      command: "pnpm install --frozen-lockfile --ignore-scripts",
    });
    expect(result.inspection.frameworkPlan.adapter).toBe("vite-static");
    const wake = await source.diff({
      previewId,
      runtimeGeneration: 1,
      tokenGeneration: 1,
      from: version(2),
      to: version(2),
    });
    expect(wake.operations).toEqual([]);
    expect(wake.dependenciesChanged).toBe(false);
  });

  it("rejects traversal, symbolic links and stale authorization before publishing content", async () => {
    for (const entries of [
      [
        { path: "fixture/", type: 53 },
        { path: "fixture/../outside", content: "bad" },
      ],
      [
        { path: "fixture/", type: 53 },
        { path: "fixture/link", type: 50, content: "" },
      ],
    ]) {
      const archive = await gzipTar(entries);
      const source = createPreviewSourceReader({
        readSource: async () => descriptor,
        readArchive: async () => archive,
      });
      await expect(
        source.diff({
          previewId,
          runtimeGeneration: 1,
          tokenGeneration: 1,
          from: null,
          to: version(2),
        }),
      ).rejects.toThrow();
    }
    const archive = await gzipTar(viteEntries([{ path: "fixture/a.txt", content: "safe" }]));
    let reads = 0;
    const source = createPreviewSourceReader({
      readSource: async () => (++reads === 1 ? descriptor : null),
      readArchive: async () => archive,
    });
    await expect(
      source.diff({
        previewId,
        runtimeGeneration: 1,
        tokenGeneration: 1,
        from: null,
        to: version(2),
      }),
    ).rejects.toThrow();
  });
  it("returns a current full snapshot when the old base is unavailable, and rejects a forged or revoked target", async () => {
    const archive = await gzipTar(viteEntries([{ path: "fixture/a.txt", content: "current" }]));
    let archiveReads = 0;
    let revoked = false;
    const source = createPreviewSourceReader({
      readSource: async () => (revoked ? null : descriptor),
      readArchive: async (_source, _commit, sequence) => {
        archiveReads++;
        if (sequence === 1) throw new Error("base unavailable");
        return archive;
      },
    });
    const request = {
      previewId,
      runtimeGeneration: 1,
      tokenGeneration: 1,
      from: version(1),
      to: version(2),
    };
    const snapshot = await source.diff(request);
    expect(snapshot.from).toBeNull();
    expect(snapshot.to).toEqual(version(2));
    expect(snapshot.dependenciesChanged).toBe(true);
    expect(snapshot.operations.every((item) => item.kind === "write")).toBe(true);
    expect(snapshot.operations.find((item) => item.path === "a.txt")).toMatchObject({
      kind: "write",
      bytes: new TextEncoder().encode("current"),
    });
    const reads = archiveReads;
    for (const to of [
      { ...version(2), commitSha: "f".repeat(40) },
      { ...version(2), sourceGeneration: 2 },
    ])
      await expect(source.diff({ ...request, from: null, to })).rejects.toThrow();
    expect(archiveReads).toBe(reads);
    const losesAuthority = createPreviewSourceReader({
      readSource: async () => (revoked ? null : descriptor),
      readArchive: async (_source, _commit, sequence) => {
        if (sequence === 1) {
          revoked = true;
          throw new Error("base unavailable");
        }
        return archive;
      },
    });
    await expect(losesAuthority.diff(request)).rejects.toThrow("authority changed");
  });
});
