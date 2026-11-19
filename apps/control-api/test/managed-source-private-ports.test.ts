import { describe, expect, it } from "vitest";
import { MANAGED_SOURCE_LIMITS } from "@ohmyhost/contracts/managed-sources";
import {
  createManagedSourceCompositionFromStore,
  createManagedSourcePrivatePorts,
  type ManagedSourcePrivateBinding,
} from "../src/managed-source-composition.js";
import { ManagedSourceGitInputRefusedError } from "../src/managed-source-surface.js";

const COMMIT = "a".repeat(40);
const PARENT = "b".repeat(40);
const repository = { namespace: "omh-test-eu", repositoryName: "repo-one" };
const INVALID = "Managed source service returned an invalid scoped result";

/** The source-fetcher service binding is the external boundary: it answers each call with the next prepared reply. */
function binding(reply: unknown) {
  const calls: { service: "git" | "blob"; method: string; input: unknown }[] = [];
  return {
    calls,
    managedGit: async (method: string, input: unknown) => {
      calls.push({ service: "git", method, input });
      return reply;
    },
    managedBlob: async (method: string, input: unknown) => {
      calls.push({ service: "blob", method, input });
      return reply;
    },
  };
}
const file = (path: string, bytes = new Uint8Array([1, 2, 3]), executable = false) => ({
  path,
  bytes,
  executable,
});

describe("managed source private ports", () => {
  it("lists the files of a commit and refuses every malformed or oversized reply", async () => {
    const good = [file("src/index.ts", new Uint8Array([7]), true), file("README.md")];
    const accepted = binding(good);
    expect(await createManagedSourcePrivatePorts(accepted).git.files(repository, COMMIT)).toEqual(
      good,
    );
    expect(accepted.calls).toEqual([
      { service: "git", method: "files", input: { repository, commitSha: COMMIT } },
    ]);

    const oversized = new Uint8Array(MANAGED_SOURCE_LIMITS.fileBytes + 1);
    const wholeTree = Array.from({ length: 5 }, (_, index) =>
      file(`part-${index}.bin`, new Uint8Array(MANAGED_SOURCE_LIMITS.fileBytes)),
    );
    for (const reply of [
      { path: "not-an-array" },
      Array.from({ length: MANAGED_SOURCE_LIMITS.files + 1 }, (_, index) => file(`f${index}`)),
      [null],
      [file("../escape.ts")],
      [{ ...file("a.ts"), executable: "yes" }],
      [{ ...file("a.ts"), bytes: [1, 2, 3] }],
      [file("a.ts"), file("a.ts")],
      [file("big.bin", oversized)],
      wholeTree,
    ])
      await expect(
        createManagedSourcePrivatePorts(binding(reply)).git.files(repository, COMMIT),
      ).rejects.toThrow(INVALID);
  });

  it("reads bounded history and refuses replies that exceed the request or carry unusable commits", async () => {
    const page = [
      {
        commitSha: COMMIT,
        parentSha: PARENT,
        message: "Second",
        createdAt: "2026-10-29T10:00:00Z",
      },
      { commitSha: PARENT, parentSha: null, message: "First", createdAt: "2026-10-29T09:00:00Z" },
    ];
    const accepted = binding(page);
    expect(
      await createManagedSourcePrivatePorts(accepted).git.history(repository, { limit: 5 }),
    ).toEqual(page);
    expect(accepted.calls[0]).toMatchObject({
      method: "history",
      input: { repository, input: { limit: 5 } },
    });

    for (const reply of [
      "not-an-array",
      page,
      [null],
      [{ ...page[0], message: "x".repeat(4097) }],
      [{ ...page[0], message: 7 }],
      [{ ...page[0], createdAt: "yesterday" }],
      [{ ...page[0], commitSha: "0".repeat(40) }],
      [{ ...page[0], parentSha: "ABC" }],
    ])
      await expect(
        createManagedSourcePrivatePorts(binding(reply)).git.history(repository, { limit: 1 }),
      ).rejects.toThrow(INVALID);
  });

  it("answers containment only with a strict boolean", async () => {
    const input = {
      branch: "main" as const,
      headCommitSha: PARENT,
      candidateCommitSha: COMMIT,
      maxCommits: 100,
    };
    expect(
      await createManagedSourcePrivatePorts(binding(true)).git.containsCommit(repository, input),
    ).toBe(true);
    expect(
      await createManagedSourcePrivatePorts(binding(false)).git.containsCommit(repository, input),
    ).toBe(false);
    await expect(
      createManagedSourcePrivatePorts(binding("true")).git.containsCommit(repository, input),
    ).rejects.toThrow(INVALID);
  });

  it("stores and reads blobs only with a fully bounded receipt and the exact byte length", async () => {
    const receipt = { bucket: "artifacts", key: "org/project/blob", versionId: "v1", eTag: "etag" };
    const scope = {
      organizationId: "01M21T9VB6J0P0QWQJ4J3086ZH",
      projectId: "01M21T9VB6J0P0QWQJ4J3086ZJ",
      operationId: "01M21T9VB6J0P0QWQJ4J3086ZK",
    };
    const upload = {
      ...scope,
      path: "src/index.ts",
      bytes: new Uint8Array([1]),
      sha256: "c".repeat(64),
      executable: false,
      region: "eu" as const,
    };
    const stored = binding({ ...receipt, extra: "ignored" });
    expect(await createManagedSourcePrivatePorts(stored).blobs.put(upload)).toEqual(receipt);
    expect(stored.calls[0]).toMatchObject({ service: "blob", method: "put" });
    for (const reply of [
      null,
      { ...receipt, bucket: "" },
      { ...receipt, key: "k".repeat(1025) },
      { ...receipt, versionId: "v\u0000" },
      { ...receipt, eTag: 7 },
    ])
      await expect(
        createManagedSourcePrivatePorts(binding(reply)).blobs.put(upload),
      ).rejects.toThrow(INVALID);

    const read = {
      ...scope,
      ...receipt,
      path: "src/index.ts",
      sha256: "c".repeat(64),
      byteLength: 3,
    };
    const bytes = new Uint8Array([4, 5, 6]);
    expect(await createManagedSourcePrivatePorts(binding(bytes)).blobs.get(read as never)).toBe(
      bytes,
    );
    for (const reply of [new Uint8Array(2), [4, 5, 6], "abc"])
      await expect(
        createManagedSourcePrivatePorts(binding(reply)).blobs.get(read as never),
      ).rejects.toThrow(INVALID);
    const huge = MANAGED_SOURCE_LIMITS.fileBytes + 1;
    await expect(
      createManagedSourcePrivatePorts(binding(new Uint8Array(huge))).blobs.get({
        ...read,
        byteLength: huge,
      } as never),
    ).rejects.toThrow(INVALID);
  });

  it("refuses colliding or malformed Git namespaces before any store is used", () => {
    const unused = {
      store: {} as never,
      clock: { now: () => new Date() },
      ids: { next: () => "unused" as never },
      binding: binding(null),
      wake: async () => undefined,
    };
    for (const namespaces of [
      { us: "same", eu: "same" },
      { us: "Upper", eu: "omh-eu" },
      { us: "omh-us", eu: "-leading" },
    ])
      expect(() => createManagedSourceCompositionFromStore({ ...unused, namespaces })).toThrow(
        "Invalid managed Git namespaces",
      );
  });

  it("maps a Git preparation the source service refuses as an invalid input to the typed refusal only", async () => {
    const input = {
      expectedCommitSha: null,
      files: [],
      metadata: { message: "Seal a snapshot", operationId: "a".repeat(26), timestampSeconds: 0 },
    };
    const refusing: ManagedSourcePrivateBinding = {
      managedGit: async () => {
        throw new Error("managed_source_input_invalid");
      },
      managedBlob: async () => null,
    };
    const refused = await createManagedSourcePrivatePorts(refusing)
      .git.prepare(repository, input)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "source_snapshot_invalid", status: 409 });
    expect(refused).toBeInstanceOf(ManagedSourceGitInputRefusedError);

    // A transient service failure is not a refusal of the snapshot: it stays retryable as it is.
    const unavailable: ManagedSourcePrivateBinding = {
      managedGit: async () => {
        throw new Error("managed_source_unavailable");
      },
      managedBlob: async () => null,
    };
    await expect(
      createManagedSourcePrivatePorts(unavailable).git.prepare(repository, input),
    ).rejects.toThrow("managed_source_unavailable");
  });
});
