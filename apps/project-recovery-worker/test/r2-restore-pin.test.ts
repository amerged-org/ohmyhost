import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { assertRestorePinLifecycle, createRecoveryArchiveStore } from "../src/r2-archives.js";

const scope = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  restoreId: "00000000000000000000000003",
};
const bucket = "ohmyho-development-backups",
  key = `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip`;

it("does not let SDK retries create a second archive upload after an uncertain transport reply", async () => {
  const archive = Buffer.from("opaque encrypted fixture"),
    sha256 = createHash("sha256").update(archive).digest();
  let archiveAttempts = 0;
  let stored: { bytes: Buffer; type: string } | undefined;
  let lateArchive: (() => boolean) | undefined;
  const response = (statusCode: number, body = "", headers: Record<string, string> = {}) => ({
    response: { statusCode, headers, body: Readable.from([body]) },
  });
  const sdk = new S3Client({
    region: "auto",
    endpoint: "https://fixture.invalid",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      async handle(request: {
        readonly method: string;
        readonly query?: Readonly<Record<string, unknown>>;
        readonly headers: Readonly<Record<string, string>>;
        readonly body?: unknown;
      }) {
        if (request.query?.["lifecycle"] !== undefined)
          return response(404, "<Error><Code>NoSuchLifecycleConfiguration</Code></Error>");
        if (request.method === "PUT") {
          if (stored) return response(412, "<Error><Code>PreconditionFailed</Code></Error>");
          if (!(request.body instanceof Uint8Array)) throw new Error("unexpected fixture body");
          const incoming = {
            bytes: Buffer.from(request.body),
            type: request.headers["content-type"] ?? "",
          };
          if (incoming.type === "application/zip") {
            archiveAttempts++;
            if (archiveAttempts === 1) {
              lateArchive = () => {
                if (stored) return false;
                stored = incoming;
                return true;
              };
              throw Object.assign(new Error("uncertain transport reply"), { name: "TimeoutError" });
            }
          }
          stored = incoming;
          return response(200);
        }
        if (request.method === "GET") {
          if (!stored) return response(404, "<Error><Code>NoSuchKey</Code></Error>");
          return {
            response: {
              statusCode: 200,
              headers: {
                "content-type": stored.type,
                "content-length": String(stored.bytes.length),
              },
              body: Readable.from([stored.bytes]),
            },
          };
        }
        throw new Error("unexpected fixture operation");
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
  const input = { bucket, scope, bytes: archive.length, sha256, signal: AbortSignal.timeout(5000) };
  try {
    await expect(store.pinVerified({ ...input, archive })).rejects.toThrow(
      "RECOVERY_ARCHIVE_WRITE_FAILED",
    );
    expect(archiveAttempts).toBe(1);
    expect(stored).toBeUndefined();
    expect(await store.inspectRestorePin({ ...input, allowTombstone: true })).toBe("tombstoned");
    if (!lateArchive) throw new Error("missing uncertain fixture upload");
    expect(lateArchive()).toBe(false);
    expect(archiveAttempts).toBe(1);
    expect(await store.inspectRestorePin({ ...input, allowTombstone: false })).toBe("tombstoned");
  } finally {
    store.close();
  }
});
it("rejects matching or unknowable expiry rules and permits only demonstrably nonmatching rules", () => {
  expect(() =>
    assertRestorePinLifecycle(
      [{ Status: "Enabled", Filter: { Prefix: "restore-pins/" }, Expiration: { Days: 7 } }],
      key,
    ),
  ).toThrow();
  expect(() =>
    assertRestorePinLifecycle([{ Status: "Enabled", Filter: {}, Expiration: { Days: 7 } }], key),
  ).toThrow();
  expect(() =>
    assertRestorePinLifecycle(
      [{ Status: "Enabled", Filter: { Unexpected: "x" }, Expiration: { Days: 7 } }],
      key,
    ),
  ).toThrow();
  expect(() => assertRestorePinLifecycle(undefined, key)).toThrow();
  expect(() =>
    assertRestorePinLifecycle(
      [
        { Status: "Enabled", Filter: { Prefix: "snapshots/" }, Expiration: { Days: 7 } },
        { Status: "Disabled", Filter: { Prefix: "" }, Expiration: { Days: 7 } },
      ],
      key,
    ),
  ).not.toThrow();
});

it("pins only exact bytes, rechecks lifecycle, verifies readback and confirms terminal absence", async () => {
  const bytes = Buffer.from("encrypted fixture"),
    sha256 = createHash("sha256").update(bytes).digest();
  let stored: Buffer | undefined,
    storedType = "",
    lifecycleCalls = 0,
    block = false,
    unknown = false,
    losePutReply = false;
  const client = {
    async send(command: unknown) {
      if (command instanceof GetBucketLifecycleConfigurationCommand) {
        lifecycleCalls++;
        if (unknown)
          throw Object.assign(new Error("missing"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        if (block)
          return {
            Rules: [{ Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 1 } }],
          };
        throw Object.assign(new Error("no lifecycle"), { name: "NoSuchLifecycleConfiguration" });
      }
      if (command instanceof PutObjectCommand) {
        if (stored) throw { $metadata: { httpStatusCode: 412 } };
        stored = Buffer.from(command.input.Body as Uint8Array);
        storedType = String(command.input.ContentType);
        if (losePutReply) throw new Error("transport outcome unknown");
        return {};
      }
      if (command instanceof GetObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return {
          Body: Readable.from([stored]),
          ContentLength: stored.length,
          ContentType: storedType,
        };
      }
      if (command instanceof DeleteObjectCommand) {
        stored = undefined;
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentType: storedType };
      }
      throw new Error("unexpected command");
    },
    destroy() {},
  };
  const store = createRecoveryArchiveStore(
      {
        accountId: "a".repeat(32),
        bucket,
        accessKeyId: "b".repeat(32),
        apiToken: "private-token-value-long",
        now: () => new Date(),
      },
      client as never,
    ),
    signal = AbortSignal.timeout(5000);
  const input = { bucket, scope, archive: bytes, bytes: bytes.length, sha256, signal };
  try {
    block = true;
    await expect(store.pinVerified(input)).rejects.toThrow();
    expect(stored).toBeUndefined();
    block = false;
    unknown = true;
    await expect(store.pinVerified(input)).rejects.toThrow();
    expect(stored).toBeUndefined();
    unknown = false;
    expect(await store.pinVerified(input)).toMatchObject({ bucket, key, bytes: bytes.length });
    expect(lifecycleCalls).toBeGreaterThanOrEqual(4);
    await expect(store.pinVerified(input)).resolves.toMatchObject({ key });
    expect(
      Buffer.from(
        await store.readRestorePin({ bucket, scope, bytes: bytes.length, sha256, signal }),
      ),
    ).toEqual(bytes);
    await store.removeRestorePin({ bucket, scope, signal });
    await store.removeRestorePin({ bucket, scope, signal });
    losePutReply = true;
    await expect(store.pinVerified(input)).rejects.toThrow();
    expect(
      await store.inspectRestorePin({
        bucket,
        scope,
        bytes: bytes.length,
        sha256,
        signal,
        allowTombstone: false,
      }),
    ).toBe("verified");
    await expect(
      store.inspectRestorePin({
        bucket,
        scope,
        bytes: bytes.length,
        sha256: new Uint8Array(32),
        signal,
        allowTombstone: false,
      }),
    ).rejects.toThrow();
    await store.removeRestorePin({ bucket, scope, signal });
    losePutReply = false;
    await expect(
      store.inspectRestorePin({
        bucket,
        scope,
        bytes: bytes.length,
        sha256,
        signal,
        allowTombstone: false,
      }),
    ).rejects.toThrow("RECOVERY_PIN_OUTCOME_UNKNOWN");
    expect(stored).toBeUndefined();
    expect(
      await store.inspectRestorePin({
        bucket,
        scope,
        bytes: bytes.length,
        sha256,
        signal,
        allowTombstone: true,
      }),
    ).toBe("tombstoned");
    if (!stored) throw new Error("missing fixture marker");
    const marker = Buffer.from(stored);
    await expect(
      client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: "*" }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    await expect(store.pinVerified(input)).rejects.toThrow();
    expect(stored).toEqual(marker);
    await expect(store.removeRestorePin({ bucket, scope, signal })).rejects.toThrow();
    expect(stored).toEqual(marker);
    expect(
      await store.inspectRestorePin({
        bucket,
        scope,
        bytes: bytes.length,
        sha256,
        signal,
        allowTombstone: false,
      }),
    ).toBe("tombstoned");
  } finally {
    store.close();
  }
});
