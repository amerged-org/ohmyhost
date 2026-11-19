import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { expect, it } from "vitest";
import { createRecoveryArchiveStore } from "../src/r2-archives.js";

const accountId = "a".repeat(32),
  accessKeyId = "b".repeat(32),
  apiToken = "private-archive-token";
const bucket = "ohmyho-development-backups" as const;
const key =
  "snapshots/00000000000000000000000001/00000000000000000000000002/00000000000000000000000003.zip";
const now = new Date("2026-09-09T20:00:00.000Z");
class S3Transport {
  readonly objects = new Map<string, Buffer>();
  failure = false;
  async handle(request: {
    method: string;
    hostname: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  }) {
    expect(request.hostname).toBe(`${accountId}.eu.r2.cloudflarestorage.com`);
    expect(request.headers["authorization"]).toContain(`Credential=${accessKeyId}/`);
    let statusCode = 200,
      headers: Record<string, string> = {};
    let body: Buffer = Buffer.alloc(0);
    if (this.failure) {
      statusCode = 503;
      body = Buffer.from(
        "<Error><Code>ServiceUnavailable</Code><Message>private provider detail</Message></Error>",
      );
    } else if (request.method === "PUT") {
      expect(request.headers["if-none-match"]).toBe("*");
      expect(request.headers["content-type"]).toBe("application/zip");
      if (this.objects.has(request.path)) {
        statusCode = 412;
        body = Buffer.from("<Error><Code>PreconditionFailed</Code></Error>");
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of request.body as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        expect(bytes.length).toBe(Number(request.headers["content-length"]));
        this.objects.set(request.path, bytes);
        headers = { etag: '"ciphertext"' };
      }
    } else if (request.method === "DELETE") {
      this.objects.delete(request.path);
      statusCode = 204;
    } else {
      const bytes = this.objects.get(request.path);
      if (!bytes) {
        statusCode = 404;
        body = Buffer.from("<Error><Code>NoSuchKey</Code></Error>");
      } else {
        headers = { "content-type": "application/zip", "content-length": String(bytes.length) };
        if (request.method !== "HEAD") body = bytes;
      }
    }
    return { response: { statusCode, headers, body: Readable.from([body]) } };
  }
  destroy() {}
}
function setup() {
  const transport = new S3Transport();
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId,
      secretAccessKey: createHash("sha256").update(apiToken).digest("hex"),
    },
    requestHandler: transport,
  });
  return {
    transport,
    store: createRecoveryArchiveStore(
      { accountId, bucket, accessKeyId, apiToken, now: () => now },
      client,
    ),
  };
}

it("stores create-only ZIPs, verifies complete ciphertext and signs exactly 24-hour owner downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omh-r2-archive-test-"));
  const { store } = setup();
  try {
    const bytes = Buffer.from("encrypted SQL ZIP fixture"),
      path = join(directory, "archive.zip");
    await writeFile(path, bytes, { mode: 0o600 });
    const archive = {
      bytes: bytes.length,
      sha256: new Uint8Array(createHash("sha256").update(bytes).digest()),
      sqlFiles: ["shared.sql"],
      capturedAt: now.toISOString(),
    };
    const input = { bucket, key, archive, signal: AbortSignal.timeout(5000) };
    expect(await store.verify(input)).toBe("absent");
    await store.put({ ...input, path });
    expect(await store.verify(input)).toBe("verified");
    expect(
      Buffer.from(
        await store.readVerified({
          bucket,
          key,
          bytes: archive.bytes,
          sha256: archive.sha256,
          signal: input.signal,
        }),
      ),
    ).toEqual(bytes);
    await expect(
      store.readVerified({
        bucket,
        key,
        bytes: archive.bytes,
        sha256: new Uint8Array(32),
        signal: input.signal,
      }),
    ).rejects.toThrow("RECOVERY_ARCHIVE_READ_FAILED");
    await expect(store.put({ ...input, path })).rejects.toThrow("RECOVERY_ARCHIVE_WRITE_FAILED");
    expect(
      await store.verify({ ...input, archive: { ...archive, sha256: new Uint8Array(32) } }),
    ).toBe("different");
    const download = await store.download({
      bucket,
      key,
      archiveExpiresAt: "2026-09-16T20:00:00.000Z",
    });
    const url = new URL(download.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe(`${accountId}.eu.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${bucket}/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(download.expiresAt).toBe("2026-09-10T20:00:00.000Z");
    expect(download.url).not.toContain(apiToken);
    expect(url.searchParams.get("response-content-type")).toBe("application/zip");
    await store.remove({ bucket, key, signal: input.signal });
    expect(await store.verify(input)).toBe("absent");
    await store.remove({ bucket, key, signal: input.signal });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects foreign targets and short retention without disguising failed provider reads", async () => {
  const { store, transport } = setup();
  try {
    for (const target of [
      { bucket: "customer-files", key },
      { bucket, key: "../credentials" },
      { bucket, key: key.replace(".zip", ".tar.age") },
    ])
      await expect(
        store.download({ ...target, archiveExpiresAt: "2026-09-16T20:00:00.000Z" }),
      ).rejects.toThrow("RECOVERY_ARCHIVE_SCOPE_INVALID");
    await expect(
      store.download({ bucket, key, archiveExpiresAt: "2026-09-10T19:59:59.999Z" }),
    ).rejects.toThrow("RECOVERY_ARCHIVE_EXPIRED");
    transport.failure = true;
    const input = {
      bucket,
      key,
      archive: {
        bytes: 1,
        sha256: new Uint8Array(32),
        sqlFiles: ["shared.sql"],
        capturedAt: now.toISOString(),
      },
      signal: AbortSignal.timeout(5000),
    };
    await expect(store.verify(input)).rejects.toThrow("RECOVERY_ARCHIVE_READ_FAILED");
    await expect(store.remove(input)).rejects.toThrow("RECOVERY_ARCHIVE_DELETE_FAILED");
    expect(() =>
      createRecoveryArchiveStore({
        accountId: "bad",
        bucket,
        accessKeyId,
        apiToken,
        now: () => now,
      }),
    ).toThrow("RECOVERY_ARCHIVE_CONFIGURATION_INVALID");
  } finally {
    store.close();
  }
});
