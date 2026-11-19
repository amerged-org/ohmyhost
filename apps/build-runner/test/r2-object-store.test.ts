import { createHash } from "node:crypto";

import {
  BuildBrokerConflictError,
  BuildBrokerUncertainError,
  createBuildBroker,
  operationPaths,
  type BuildExecutor,
} from "@ohmyhost/build-broker";
import { describe, expect, it } from "vitest";

import {
  createR2ObjectStore,
  MULTIPART_MARKER_PREFIX,
  ObjectStoreError,
  readBounded,
} from "../src/r2-object-store.js";
import { MemoryR2Bucket } from "./doubles.js";

const BUCKET = "ohmyho-builds-test";
const BUCKET_EU = "ohmyho-builds-test-eu";
const KEY = "runs/p/e/o/input/source.tar.gz";
const signal = new AbortController().signal;
const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function setup(maximumObjectBytes = 1024) {
  const bucket = new MemoryR2Bucket();
  const bucketEu = new MemoryR2Bucket();
  const store = createR2ObjectStore({
    buckets: [
      { bucketName: BUCKET, bucket },
      { bucketName: BUCKET_EU, bucket: bucketEu },
    ],
    maximumObjectBytes,
  });
  return { bucket, bucketEu, store };
}

describe("R2 object store", () => {
  it("routes each command to the binding of the bucket it names", async () => {
    const { bucket, bucketEu, store } = setup();
    const body = encoder.encode("eu object");
    const seeded = bucketEu.seed(KEY, body);

    await expect(store.headObject({ bucket: BUCKET, key: KEY }, signal)).resolves.toBeNull();
    await expect(store.headObject({ bucket: BUCKET_EU, key: KEY }, signal)).resolves.toMatchObject({
      versionId: seeded.version,
      byteLength: body.byteLength,
    });
    await expect(
      store.readObject(
        { bucket: BUCKET_EU, key: KEY, versionId: seeded.version, maximumBytes: 64 },
        signal,
      ),
    ).resolves.toEqual({ body, sha256: sha256(body) });
    await store.deleteObject({ bucket: BUCKET_EU, key: KEY, versionId: seeded.version }, signal);
    await expect(store.headObject({ bucket: BUCKET_EU, key: KEY }, signal)).resolves.toBeNull();
    expect(bucket.calls).toEqual(["head"]);
  });

  it("rejects every command that names another bucket before touching R2", async () => {
    const { bucket, bucketEu, store } = setup();
    const other = { bucket: "another-bucket", key: KEY };
    const calls = [
      () => store.listMultipartUploads(other, signal),
      () =>
        store.createMultipartUpload(
          { ...other, contentType: "application/gzip", metadata: {} },
          signal,
        ),
      () =>
        store.uploadPart(
          { ...other, uploadId: "u", partNumber: 1, body: new Uint8Array(1), checksumSha256: "" },
          signal,
        ),
      () => store.completeMultipartUpload({ ...other, uploadId: "u", parts: [] }, signal),
      () => store.abortMultipartUpload({ ...other, uploadId: "u" }, signal),
      () => store.headObject(other, signal),
      () => store.verifyObjectSha256({ ...other, versionId: "v", expectedSha256: "" }, signal),
      () => store.readObject({ ...other, versionId: "v", maximumBytes: 1 }, signal),
      () => store.deleteObject({ ...other, versionId: "v" }, signal),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "InvalidBucket", retryable: false });
    }
    expect(bucket.calls).toEqual([]);
    expect(bucketEu.calls).toEqual([]);
  });

  it("uploads, completes and reports the R2 version and the quoted entity tag", async () => {
    const { bucket, store } = setup();
    const first = encoder.encode("first-part:");
    const second = encoder.encode("second");
    const { uploadId } = await store.createMultipartUpload(
      {
        bucket: BUCKET,
        key: KEY,
        contentType: "application/gzip",
        metadata: { operation: "o" },
      },
      signal,
    );
    const parts = [];
    for (const [index, body] of [first, second].entries()) {
      const part = await store.uploadPart(
        {
          bucket: BUCKET,
          key: KEY,
          uploadId,
          partNumber: index + 1,
          body,
          checksumSha256: sha256(body),
        },
        signal,
      );
      expect(part.eTag).toBe(`"part-${index + 1}-${body.byteLength}"`);
      parts.push({ partNumber: index + 1, eTag: part.eTag, checksumSha256: sha256(body) });
    }

    const completed = await store.completeMultipartUpload(
      { bucket: BUCKET, key: KEY, uploadId, parts },
      signal,
    );

    const stored = bucket.objects.get(KEY);
    expect(bucket.text(KEY)).toBe("first-part:second");
    expect(bucket.contentType(KEY)).toBe("application/gzip");
    expect(completed).toEqual({
      versionId: stored?.head.version,
      eTag: `"${stored?.head.etag}"`,
    });
    await expect(store.headObject({ bucket: BUCKET, key: KEY }, signal)).resolves.toEqual({
      versionId: completed.versionId,
      eTag: completed.eTag,
      byteLength: 17,
      metadata: { operation: "o" },
    });
    // The completed upload is no longer open.
    await expect(store.listMultipartUploads({ bucket: BUCKET, key: KEY }, signal)).resolves.toEqual(
      [],
    );
  });

  it("refuses a part whose bytes do not match the declared digest", async () => {
    const { bucket, store } = setup();
    const { uploadId } = await store.createMultipartUpload(
      { bucket: BUCKET, key: KEY, contentType: "application/gzip", metadata: {} },
      signal,
    );
    await expect(
      store.uploadPart(
        {
          bucket: BUCKET,
          key: KEY,
          uploadId,
          partNumber: 1,
          body: encoder.encode("tampered"),
          checksumSha256: sha256(encoder.encode("declared")),
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: "BadDigest", retryable: false });
    expect(bucket.calls).not.toContain("uploadPart");
  });

  it("remembers the one open upload of a key and never reports an empty list while one may exist", async () => {
    const { bucket, store } = setup();
    const command = { bucket: BUCKET, key: KEY };
    await expect(store.listMultipartUploads(command, signal)).resolves.toEqual([]);

    const { uploadId } = await store.createMultipartUpload(
      { ...command, contentType: "application/gzip", metadata: {} },
      signal,
    );
    await expect(store.listMultipartUploads(command, signal)).resolves.toEqual([
      { uploadId, key: KEY },
    ]);
    // A second create for the same key cannot open a second upload.
    await expect(
      store.createMultipartUpload(
        { ...command, contentType: "application/gzip", metadata: {} },
        signal,
      ),
    ).rejects.toMatchObject({ code: "UploadAlreadyOpen", retryable: false });
    expect(bucket.uploads.size).toBe(1);

    await store.abortMultipartUpload({ ...command, uploadId }, signal);
    await expect(store.listMultipartUploads(command, signal)).resolves.toEqual([]);
    expect(bucket.uploads.size).toBe(0);
  });

  it("reports an unknown upload state when a create was claimed but its outcome never recorded", async () => {
    const { bucket, store } = setup();
    const command = { bucket: BUCKET, key: KEY };
    bucket.failNext("createMultipartUpload", new Error("internal error (10001)"));
    await expect(
      store.createMultipartUpload(
        { ...command, contentType: "application/gzip", metadata: {} },
        signal,
      ),
    ).rejects.toMatchObject({ code: "R2Error10001", retryable: true });

    await expect(store.listMultipartUploads(command, signal)).rejects.toMatchObject({
      code: "UploadStateUnknown",
      retryable: false,
    });

    bucket.seed(`${MULTIPART_MARKER_PREFIX}${KEY}`, encoder.encode('{"state":"other"}'));
    await expect(store.listMultipartUploads(command, signal)).rejects.toMatchObject({
      code: "MalformedUploadMarker",
    });
  });

  it("maps an upload that no longer exists to NoSuchUpload and forgets only that upload", async () => {
    const { bucket, store } = setup();
    const command = { bucket: BUCKET, key: KEY };
    const first = await store.createMultipartUpload(
      { ...command, contentType: "application/gzip", metadata: {} },
      signal,
    );
    await store.abortMultipartUpload({ ...command, uploadId: first.uploadId }, signal);
    const second = await store.createMultipartUpload(
      { ...command, contentType: "application/gzip", metadata: {} },
      signal,
    );

    // A stale receipt aborts again: the upload is gone, the newer upload stays remembered.
    await expect(
      store.abortMultipartUpload({ ...command, uploadId: first.uploadId }, signal),
    ).rejects.toMatchObject({ code: "NoSuchUpload", retryable: false });
    await expect(store.listMultipartUploads(command, signal)).resolves.toEqual([
      { uploadId: second.uploadId, key: KEY },
    ]);

    bucket.failNext("abort", new Error("network"));
    await expect(
      store.abortMultipartUpload({ ...command, uploadId: second.uploadId }, signal),
    ).rejects.toMatchObject({ code: "R2Error", retryable: true });
    expect(bucket.uploads.size).toBe(1);
  });

  it("treats another current version as an object that is gone", async () => {
    const { bucket, store } = setup();
    const old = bucket.seed(KEY, encoder.encode("old"));
    const current = bucket.seed(KEY, encoder.encode("current"));
    const exactOld = { bucket: BUCKET, key: KEY, versionId: old.version };

    await expect(store.headObject(exactOld, signal)).resolves.toBeNull();
    await expect(
      store.readObject({ ...exactOld, maximumBytes: 100 }, signal),
    ).rejects.toMatchObject({ code: "NoSuchVersion", retryable: false });
    await expect(
      store.verifyObjectSha256({ ...exactOld, expectedSha256: "0".repeat(64) }, signal),
    ).rejects.toMatchObject({ code: "NoSuchVersion" });
    await store.deleteObject(exactOld, signal);
    expect(bucket.text(KEY)).toBe("current");

    await store.deleteObject({ ...exactOld, versionId: current.version }, signal);
    expect(bucket.objects.has(KEY)).toBe(false);
    await expect(store.headObject({ bucket: BUCKET, key: KEY }, signal)).resolves.toBeNull();
    await expect(
      store.readObject({ ...exactOld, maximumBytes: 100 }, signal),
    ).rejects.toMatchObject({ code: "NoSuchVersion" });
    await expect(store.deleteObject(exactOld, signal)).resolves.toBeUndefined();
  });

  it("streams, hashes and bounds object reads", async () => {
    const { bucket, store } = setup(16);
    const bytes = encoder.encode("0123456789");
    const { version } = bucket.seed(KEY, bytes);
    const exact = { bucket: BUCKET, key: KEY, versionId: version };

    await expect(
      store.verifyObjectSha256({ ...exact, expectedSha256: sha256(bytes) }, signal),
    ).resolves.toEqual({ byteLength: 10, sha256: sha256(bytes) });
    const read = await store.readObject({ ...exact, maximumBytes: 10 }, signal);
    expect(read.sha256).toBe(sha256(bytes));
    expect(new TextDecoder().decode(read.body)).toBe("0123456789");

    await expect(store.readObject({ ...exact, maximumBytes: 9 }, signal)).rejects.toMatchObject({
      code: "ResponseTooLarge",
      retryable: false,
    });
    for (const maximumBytes of [0, 17, 1.5]) {
      await expect(store.readObject({ ...exact, maximumBytes }, signal)).rejects.toMatchObject({
        code: "InvalidRequest",
      });
    }
    const large = bucket.seed(KEY, new Uint8Array(17));
    await expect(
      store.verifyObjectSha256(
        { ...exact, versionId: large.version, expectedSha256: "0".repeat(64) },
        signal,
      ),
    ).rejects.toMatchObject({ code: "ResponseTooLarge" });
  });

  it("marks R2 failures retryable and keeps its own rejections", async () => {
    const { bucket, store } = setup();
    bucket.failNext("head", new Error("We encountered an internal error. (10001)"));
    const failure = await store.headObject({ bucket: BUCKET, key: KEY }, signal).catch((e) => e);
    expect(failure).toBeInstanceOf(ObjectStoreError);
    expect(failure).toMatchObject({ code: "R2Error10001", retryable: true });
    expect(String(failure.message)).not.toContain("internal error");

    bucket.failNext("head", "not an error object");
    await expect(store.headObject({ bucket: BUCKET, key: KEY }, signal)).rejects.toMatchObject({
      code: "R2Error",
      retryable: true,
    });
  });

  it("collects nothing when only the digest is wanted", async () => {
    const stream = new Response("abcdef").body;
    if (stream === null) throw new Error("stream expected");
    await expect(readBounded(stream, 6, false)).resolves.toEqual({
      body: new Uint8Array(0),
      byteLength: 6,
      sha256: sha256(encoder.encode("abcdef")),
    });
  });
});

describe("build broker over the R2 object store", () => {
  const scope = {
    projectId: "01J00000000000000000000001",
    environmentId: "01J00000000000000000000002",
    operationId: "01J00000000000000000000003",
  };
  const executor = {
    startBuild: async () => Promise.reject(new Error("unused")),
  } as never as BuildExecutor;

  function brokerOver(bucket: MemoryR2Bucket) {
    return createBuildBroker({
      objectStore: createR2ObjectStore({
        buckets: [{ bucketName: BUCKET, bucket }],
        maximumObjectBytes: 1024,
      }),
      executor,
      now: () => new Date("2026-09-17T12:00:00.000Z"),
      sleep: async () => undefined,
      bucket: BUCKET,
      buildProject: "test-build",
      requestTimeoutMs: 1_000,
      retryDelayMs: 1,
      maximumAttempts: 2,
    });
  }

  it("takes an archive in, verifies it, observes it and removes the exact version", async () => {
    const bucket = new MemoryR2Bucket();
    const broker = brokerOver(bucket);
    const body = encoder.encode("source archive bytes");

    const upload = await broker.beginArchive({ scope });
    // A replay after a lost response finds the open upload instead of opening a second one.
    await expect(broker.beginArchive({ scope })).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    const part = await broker.uploadArchivePart({
      upload,
      partNumber: 1,
      body,
      checksumSha256: sha256(body),
    });
    const archive = await broker.completeArchive({
      upload,
      parts: [part],
      byteLength: body.byteLength,
      sourceSha256: sha256(body),
    });

    expect(archive).toMatchObject({
      bucket: BUCKET,
      key: operationPaths(scope).inputKey,
      versionId: bucket.objects.get(operationPaths(scope).inputKey)?.head.version,
      byteLength: body.byteLength,
    });
    await expect(broker.beginArchive({ scope })).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(broker.observeArchive({ scope, sourceSha256: sha256(body) })).resolves.toEqual(
      archive,
    );
    await expect(broker.removeArchive(archive)).resolves.toMatchObject({
      state: "absent",
      versionId: archive.versionId,
    });
    expect(bucket.objects.size).toBe(0);
    // Removing the version that is already gone stays a success.
    await expect(broker.removeArchive(archive)).resolves.toMatchObject({ state: "absent" });
  });

  it("opens a new upload after an abort and treats a repeated abort as done", async () => {
    const bucket = new MemoryR2Bucket();
    const broker = brokerOver(bucket);
    const upload = await broker.beginArchive({ scope });
    await broker.abortArchive(upload);
    await expect(broker.abortArchive(upload)).resolves.toBeUndefined();
    const next = await broker.beginArchive({ scope });
    expect(next.uploadId).not.toBe(upload.uploadId);
  });

  it("retries a failed R2 read once", async () => {
    const bucket = new MemoryR2Bucket();
    bucket.failNext("head", new Error("Service unavailable (10043)"));
    await expect(
      brokerOver(bucket).observeArchive({ scope, sourceSha256: "b".repeat(64) }),
    ).resolves.toBeNull();
    expect(bucket.calls).toEqual(["head", "head"]);
  });
});
