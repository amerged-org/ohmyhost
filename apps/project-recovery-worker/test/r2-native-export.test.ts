import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { createRecoveryArchiveStore } from "../src/r2-archives.js";

it("leaves a permanent conditional marker that defeats a delayed Native export PUT", async () => {
  const bucket = "ohmyho-development-backups";
  const key =
    "native-exports/00000000000000000000000001/00000000000000000000000002/00000000000000000000000003.zip";
  const archive = Buffer.from("encrypted fixture");
  let stored: { body: Buffer; type: string } | undefined;
  const client = {
    async send(command: unknown) {
      if (command instanceof GetBucketLifecycleConfigurationCommand)
        throw Object.assign(new Error(), { name: "NoSuchLifecycleConfiguration" });
      if (command instanceof GetObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return {
          Body: Readable.from([stored.body]),
          ContentLength: stored.body.length,
          ContentType: stored.type,
        };
      }
      if (command instanceof PutObjectCommand) {
        if (stored) throw { $metadata: { httpStatusCode: 412 } };
        expect(command.input.IfNoneMatch).toBe("*");
        stored = {
          body: Buffer.from(command.input.Body as Uint8Array),
          type: String(command.input.ContentType),
        };
        return {};
      }
      throw new Error("unexpected operation");
    },
    destroy() {},
  };
  const store = createRecoveryArchiveStore(
    {
      accountId: "a".repeat(32),
      bucket,
      accessKeyId: "b".repeat(32),
      apiToken: "fixture-private-token-long",
      now: () => new Date(),
    },
    client as never,
  );
  const input = {
    bucket,
    key,
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest(),
    signal: AbortSignal.timeout(5000),
  };
  await expect(
    store.inspectNativeExport({ ...input, bytes: 536870913, allowTombstone: true }),
  ).rejects.toThrow("RECOVERY_ARCHIVE_SCOPE_INVALID");
  expect(
    await store.inspectNativeExport({ ...input, bytes: 536870912, allowTombstone: true }),
  ).toBe("tombstoned");
  await expect(
    client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: archive, IfNoneMatch: "*" }),
    ),
  ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
  expect(await store.inspectNativeExport({ ...input, allowTombstone: false })).toBe("tombstoned");
  store.close();
});

it("uses one actual SDK attempt for an uncertain Native export PUT", async () => {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bucket = "ohmyho-development-backups";
  const key =
    "native-exports/00000000000000000000000001/00000000000000000000000002/00000000000000000000000003.zip";
  const bytes = Buffer.from("encrypted archive fixture");
  const directory = await mkdtemp(join(tmpdir(), "native-export-test-"));
  const path = join(directory, "archive.zip");
  await writeFile(path, bytes);
  let attempts = 0;
  const sdk = new S3Client({
    region: "auto",
    endpoint: "https://fixture.invalid",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      async handle(request: { method: string; query?: Record<string, unknown> }) {
        if (request.query?.["lifecycle"] !== undefined)
          return {
            response: {
              statusCode: 404,
              headers: {},
              body: Readable.from(["<Error><Code>NoSuchLifecycleConfiguration</Code></Error>"]),
            },
          };
        if (request.method === "PUT") {
          attempts++;
          throw Object.assign(new Error("uncertain"), { name: "TimeoutError" });
        }
        throw new Error("unexpected request");
      },
      destroy() {},
    },
  });
  const store = createRecoveryArchiveStore(
    {
      accountId: "a".repeat(32),
      bucket,
      accessKeyId: "b".repeat(32),
      apiToken: "fixture-private-token-long",
      now: () => new Date(),
    },
    sdk,
  );
  try {
    await expect(
      store.put({
        bucket,
        key,
        path,
        signal: AbortSignal.timeout(5000),
        archive: {
          sqlFiles: ["auth.sql"],
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest(),
          capturedAt: "2026-11-04T00:00:00.000Z",
          nativeManifest: "{}",
          nativeManifestSha256: new Uint8Array(32),
        },
      }),
    ).rejects.toThrow("RECOVERY_ARCHIVE_WRITE_FAILED");
    expect(attempts).toBe(1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("deletes only a verified Native archive and confirms absence without deleting a marker", async () => {
  const bucket = "ohmyho-development-backups",
    key =
      "native-exports/00000000000000000000000001/00000000000000000000000002/00000000000000000000000003.zip";
  const archive = Buffer.from("encrypted native archive");
  let stored: { bytes: Buffer; type: string } | undefined = {
    bytes: archive,
    type: "application/zip",
  };
  let deletes = 0;
  const client = {
    async send(command: unknown) {
      if (command instanceof GetBucketLifecycleConfigurationCommand)
        return {
          Rules: [{ Status: "Enabled", Filter: { Prefix: "snapshots/" }, Expiration: { Days: 7 } }],
        };
      if (command instanceof GetObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return {
          Body: Readable.from([stored.bytes]),
          ContentType: stored.type,
          ContentLength: stored.bytes.length,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        deletes++;
        stored = undefined;
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentLength: stored.bytes.length, ContentType: stored.type };
      }
      if (command instanceof PutObjectCommand) {
        if (stored) throw { $metadata: { httpStatusCode: 412 } };
        stored = {
          bytes: Buffer.from(command.input.Body as Uint8Array),
          type: String(command.input.ContentType),
        };
        return {};
      }
      throw new Error("unexpected provider operation");
    },
    destroy() {},
  };
  const store = createRecoveryArchiveStore(
    {
      accountId: "a".repeat(32),
      bucket,
      accessKeyId: "b".repeat(32),
      apiToken: "fixture-private-token-long",
      now: () => new Date(),
    },
    client as never,
  );
  const input = {
    bucket,
    key,
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest(),
    signal: AbortSignal.timeout(5000),
  };
  await expect(
    store.removeVerifiedNativeExport({ ...input, sha256: new Uint8Array(32) }),
  ).rejects.toThrow("RECOVERY_ARCHIVE_READ_FAILED");
  expect(deletes).toBe(0);
  await store.removeVerifiedNativeExport(input);
  expect(deletes).toBe(1);
  await store.removeVerifiedNativeExport(input);
  expect(deletes).toBe(1);
  expect(await store.inspectNativeExport({ ...input, allowTombstone: true })).toBe("tombstoned");
  await expect(store.removeVerifiedNativeExport(input)).rejects.toThrow(
    "RECOVERY_ARCHIVE_READ_FAILED",
  );
  expect(deletes).toBe(1);
  store.close();
});
