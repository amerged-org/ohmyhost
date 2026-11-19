import type { SourceArchiveIdentity } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  createBuildArchiveSink,
  SourceFetcherUncertainError,
  type BuildRunnerBinding,
} from "../src/index.js";

const identity: SourceArchiveIdentity = {
  context: {
    projectId: "01J00000000000000000000002" as never,
    environmentId: "01J00000000000000000000003" as never,
    operationId: "01J00000000000000000000004" as never,
    idempotencyKey: "deploy:one",
  },
  source: {
    provider: "github",
    sourceConnectionId: "01J00000000000000000000005" as never,
    externalRepositoryId: "1339976528",
    repository: { owner: "aixyte", name: "ohmyho.st" },
    requestedCommitSha: "e".repeat(40),
  },
};

const scope = {
  projectId: identity.context.projectId,
  environmentId: identity.context.environmentId,
  operationId: identity.context.operationId,
};
const VERSION = "0123456789abcdef0123456789abcdef";
const REPLAY_VERSION = "fedcba9876543210fedcba9876543210";
const upload = {
  bucket: "ohmyho-builds-development",
  key: `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`,
  uploadId: "multipart-1",
  scope,
};

function binding(): BuildRunnerBinding {
  return {
    observeArchive: vi.fn().mockResolvedValue(null),
    beginArchive: vi.fn().mockResolvedValue(upload),
    uploadArchivePart: vi.fn((input) =>
      Promise.resolve({
        partNumber: (input as { partNumber: number }).partNumber,
        eTag: '"part-etag"',
        checksumSha256: (input as { checksumSha256: string }).checksumSha256,
      }),
    ),
    completeArchive: vi.fn((input) =>
      Promise.resolve({
        bucket: upload.bucket,
        key: upload.key,
        versionId: VERSION,
        eTag: '"object-etag"',
        byteLength: (input as { byteLength: number }).byteLength,
        scope,
        sourceSha256: (input as { sourceSha256: string }).sourceSha256,
      }),
    ),
    abortArchive: vi.fn().mockResolvedValue(undefined),
  };
}

describe("build runner archive adapter", () => {
  it("streams bounded parts through the exact build runner RPC and returns an immutable receipt", async () => {
    const broker = binding();
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: "a".repeat(64),
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });

    await expect(sink.observe(identity)).resolves.toBeNull();
    expect(broker.observeArchive).toHaveBeenCalledWith({
      scope,
      bucket: upload.bucket,
      sourceSha256: "a".repeat(64),
    });
    const writer = await sink.begin(identity);
    const chunk = new Uint8Array([1, 2, 3]);
    await writer.write(chunk);
    const digest = "a".repeat(64);
    await expect(
      writer.commit({ archiveFormat: "tar.gz", byteLength: 3, sha256: digest }),
    ).resolves.toMatchObject({
      archiveId: `r2-version:ohmyho-builds-development/${upload.key}#${VERSION}`,
      byteLength: 3,
      sha256: digest,
    });
    expect(sink.archiveReceipt()).toEqual({
      bucket: upload.bucket,
      key: upload.key,
      versionId: VERSION,
      eTag: '"object-etag"',
      byteLength: 3,
      scope,
      sourceSha256: digest,
    });
    await writer.abort();
    expect(broker.beginArchive).toHaveBeenCalledWith({ scope, bucket: upload.bucket });
    expect(broker.uploadArchivePart).toHaveBeenCalledWith(
      expect.objectContaining({ upload, partNumber: 1, body: chunk }),
    );
    expect(broker.completeArchive).toHaveBeenCalledWith(
      expect.objectContaining({ upload, byteLength: 3, sourceSha256: digest }),
    );
    expect(broker.abortArchive).toHaveBeenCalledWith(upload);
  });

  it("observes a known digest for replay without creating a multipart upload", async () => {
    const digest = "b".repeat(64);
    const broker = binding();
    broker.observeArchive = vi.fn().mockResolvedValue({
      bucket: upload.bucket,
      key: upload.key,
      versionId: REPLAY_VERSION,
      eTag: '"object-etag"',
      byteLength: 7,
      scope,
      sourceSha256: digest,
    });
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: digest,
      expectedSourceSha256: digest,
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });

    await expect(sink.observe(identity)).resolves.toMatchObject({ sha256: digest, byteLength: 7 });
    expect(sink.archiveReceipt()).toMatchObject({
      versionId: REPLAY_VERSION,
      sourceSha256: digest,
    });
    expect(broker.observeArchive).toHaveBeenCalledWith({
      scope,
      bucket: upload.bucket,
      sourceSha256: digest,
    });
    expect(broker.beginArchive).not.toHaveBeenCalled();
  });

  it("rejects a replay object whose structured digest differs from the persisted digest", async () => {
    const digest = "b".repeat(64);
    const broker = binding();
    broker.observeArchive = vi.fn().mockResolvedValue({
      bucket: upload.bucket,
      key: upload.key,
      versionId: REPLAY_VERSION,
      eTag: '"object-etag"',
      byteLength: 7,
      scope,
      sourceSha256: "c".repeat(64),
    });
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: digest,
      expectedSourceSha256: digest,
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });
    await expect(sink.observe(identity)).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
    expect(() => sink.archiveReceipt()).toThrow("Source archive provider response is invalid");
  });

  it("buffers only one multipart-sized part and flushes the final remainder", async () => {
    const broker = binding();
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: "c".repeat(64),
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });
    const writer = await sink.begin(identity);
    const body = new Uint8Array(5 * 1024 * 1024 + 1);
    await writer.write(body);
    await writer.commit({
      archiveFormat: "tar.gz",
      byteLength: body.byteLength,
      sha256: "c".repeat(64),
    });

    const calls = vi.mocked(broker.uploadArchivePart).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[0]?.[0] as { body: Uint8Array }).body.byteLength).toBe(5 * 1024 * 1024);
    expect((calls[1]?.[0] as { body: Uint8Array }).body.byteLength).toBe(1);
  });

  it("treats a timed-out begin mutation as uncertain", async () => {
    const broker = binding();
    broker.beginArchive = vi.fn(() => new Promise(() => undefined));
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: "d".repeat(64),
      deadline: new Date(Date.now() + 100),
      now: () => new Date(),
      requestTimeoutMs: 1,
    });
    await expect(sink.begin(identity)).rejects.toBeInstanceOf(SourceFetcherUncertainError);
  });

  it("does not expose a structured receipt before a validated durable object exists", () => {
    const sink = createBuildArchiveSink({
      binding: binding(),
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: "d".repeat(64),
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });
    expect(() => sink.archiveReceipt()).toThrow("Source archive provider response is invalid");
  });

  it("aborts and never completes when the streamed digest differs from the immutable plan", async () => {
    const broker = binding();
    const sink = createBuildArchiveSink({
      binding: broker,
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: "e".repeat(64),
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });
    const writer = await sink.begin(identity);
    await writer.write(new Uint8Array([1]));
    await expect(
      writer.commit({ archiveFormat: "tar.gz", byteLength: 1, sha256: "f".repeat(64) }),
    ).rejects.toMatchObject({ code: "source_fetch_contract_invalid" });
    expect(broker.abortArchive).toHaveBeenCalledWith(upload);
    expect(broker.completeArchive).not.toHaveBeenCalled();
  });

  it("rejects a receipt that names another bucket or carries no R2 object version", async () => {
    const digest = "b".repeat(64);
    const stored = {
      bucket: upload.bucket,
      key: upload.key,
      versionId: REPLAY_VERSION,
      eTag: '"object-etag"',
      byteLength: 7,
      scope,
      sourceSha256: digest,
    };
    for (const receipt of [
      { ...stored, bucket: "ohmyho-builds-production" },
      { ...stored, versionId: "version-replay" },
    ]) {
      const broker = binding();
      broker.observeArchive = vi.fn().mockResolvedValue(receipt);
      const sink = createBuildArchiveSink({
        binding: broker,
        bucket: upload.bucket,
        knownArchiveSha256: digest,
        expectedSourceSha256: digest,
        deadline: new Date(Date.now() + 30_000),
        now: () => new Date(),
        requestTimeoutMs: 5_000,
      });
      await expect(sink.observe(identity)).rejects.toMatchObject({
        code: "source_fetch_contract_invalid",
      });
    }
    const foreign = binding();
    foreign.beginArchive = vi
      .fn()
      .mockResolvedValue({ ...upload, bucket: "ohmyho-builds-production" });
    const sink = createBuildArchiveSink({
      binding: foreign,
      bucket: upload.bucket,
      knownArchiveSha256: null,
      expectedSourceSha256: digest,
      deadline: new Date(Date.now() + 30_000),
      now: () => new Date(),
      requestTimeoutMs: 5_000,
    });
    await expect(sink.begin(identity)).rejects.toBeInstanceOf(SourceFetcherUncertainError);
    expect(foreign.uploadArchivePart).not.toHaveBeenCalled();
  });
});
