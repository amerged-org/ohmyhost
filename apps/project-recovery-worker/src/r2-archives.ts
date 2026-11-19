import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { RecoveryArchiveStore } from "./job.js";

interface ArchiveConfiguration {
  readonly accountId: string;
  readonly bucket: "ohmyho-development-backups" | "ohmyho-production-backups";
  readonly accessKeyId: string;
  readonly apiToken: string;
  readonly now: () => Date;
}
interface Target {
  readonly bucket: string;
  readonly key: string;
}
const KEY =
  /^(?:snapshots|native-exports)\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.zip$/u;
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const TOMBSTONE = Buffer.from("ohmyho-native-restore-pin-tombstone/v1\n", "utf8");
const EXPORT_TOMBSTONE = Buffer.from("ohmyho-native-export-tombstone/v1\n", "utf8");
const EXPORT_TOMBSTONE_TYPE = "application/vnd.ohmyho.native-export-tombstone";
const TOMBSTONE_TYPE = "application/vnd.ohmyho.restore-pin-tombstone";
type PinScope = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly restoreId: string;
};

/** Reject unknown filters and every enabled object-expiry rule that could match this exact pin. */
export function assertRestorePinLifecycle(rules: unknown, key: string): void {
  if (!Array.isArray(rules)) throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
  const object = (v: unknown): Record<string, unknown> => {
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    return v as Record<string, unknown>;
  };
  const allowed = (v: Record<string, unknown>, names: readonly string[]) => {
    if (Object.keys(v).some((k) => !names.includes(k)))
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
  };
  for (const value of rules) {
    const rule = object(value);
    allowed(rule, [
      "ID",
      "Status",
      "Filter",
      "Prefix",
      "Expiration",
      "Transitions",
      "NoncurrentVersionExpiration",
      "NoncurrentVersionTransitions",
      "AbortIncompleteMultipartUpload",
    ]);
    if (
      [
        "Transitions",
        "NoncurrentVersionExpiration",
        "NoncurrentVersionTransitions",
        "AbortIncompleteMultipartUpload",
      ].some((field) => rule[field] !== undefined)
    )
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    if (rule["Status"] !== "Enabled" && rule["Status"] !== "Disabled")
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    if (rule["ID"] !== undefined && typeof rule["ID"] !== "string")
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    if (rule["Filter"] !== undefined && rule["Prefix"] !== undefined)
      throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    let prefix = "";
    if (rule["Prefix"] !== undefined) {
      if (typeof rule["Prefix"] !== "string") throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      prefix = rule["Prefix"];
    }
    if (rule["Filter"] !== undefined) {
      const filter = object(rule["Filter"]);
      allowed(filter, ["Prefix", "Tag", "And", "ObjectSizeGreaterThan", "ObjectSizeLessThan"]);
      if (filter["And"] !== undefined && Object.keys(filter).length !== 1)
        throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      const source = filter["And"] === undefined ? filter : object(filter["And"]);
      allowed(
        source,
        filter["And"] === undefined
          ? ["Prefix", "Tag", "ObjectSizeGreaterThan", "ObjectSizeLessThan"]
          : ["Prefix", "Tags", "ObjectSizeGreaterThan", "ObjectSizeLessThan"],
      );
      if (source["Prefix"] !== undefined) {
        if (typeof source["Prefix"] !== "string")
          throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
        prefix = source["Prefix"];
      }
      for (const field of ["ObjectSizeGreaterThan", "ObjectSizeLessThan"])
        if (
          source[field] !== undefined &&
          (!Number.isSafeInteger(source[field]) || Number(source[field]) < 0)
        )
          throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      const tags =
        source["Tags"] === undefined
          ? source["Tag"] === undefined
            ? []
            : [source["Tag"]]
          : source["Tags"];
      if (!Array.isArray(tags)) throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      for (const tag of tags) {
        const t = object(tag);
        allowed(t, ["Key", "Value"]);
        if (typeof t["Key"] !== "string" || typeof t["Value"] !== "string")
          throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      }
    }
    if (rule["Expiration"] !== undefined) {
      const expiry = object(rule["Expiration"]);
      allowed(expiry, ["Date", "Days", "ExpiredObjectDeleteMarker"]);
      if (
        Object.keys(expiry).length !== 1 ||
        (expiry["Days"] !== undefined &&
          (!Number.isSafeInteger(expiry["Days"]) || Number(expiry["Days"]) < 1)) ||
        (expiry["Date"] !== undefined &&
          (!(expiry["Date"] instanceof Date) || !Number.isFinite(expiry["Date"].getTime()))) ||
        (expiry["ExpiredObjectDeleteMarker"] !== undefined &&
          typeof expiry["ExpiredObjectDeleteMarker"] !== "boolean")
      )
        throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      if (rule["Status"] === "Enabled" && key.startsWith(prefix))
        throw new Error("RECOVERY_PIN_EXPIRY_CONFLICT");
    }
  }
}

/** Private SQL ZIP storage only. Customer file buckets retain their independent five-minute contract. */
export function createRecoveryArchiveStore(
  configuration: ArchiveConfiguration,
  suppliedClient?: S3Client,
) {
  if (
    !/^[a-f0-9]{32}$/u.test(configuration.accountId) ||
    !["ohmyho-development-backups", "ohmyho-production-backups"].includes(configuration.bucket) ||
    !/^[a-f0-9]{32}$/u.test(configuration.accessKeyId) ||
    typeof configuration.apiToken !== "string" ||
    configuration.apiToken.length < 20 ||
    /\s/u.test(configuration.apiToken) ||
    typeof configuration.now !== "function"
  )
    throw new Error("RECOVERY_ARCHIVE_CONFIGURATION_INVALID");
  const configurationForClient: S3ClientConfig = {
    region: "auto",
    endpoint: `https://${configuration.accountId}.eu.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: createHash("sha256").update(configuration.apiToken).digest("hex"),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { requestTimeout: 30000, connectionTimeout: 5000 },
  };
  const client = suppliedClient ?? new S3Client({ ...configurationForClient, maxAttempts: 2 });
  // An SDK retry is another in-flight PUT, even when its first reply was lost.
  // Keep reads retryable, but let the durable job reconcile every mutation itself.
  const mutationConfiguration: S3ClientConfig = {
    ...configurationForClient,
    ...(suppliedClient instanceof S3Client
      ? { requestHandler: suppliedClient.config.requestHandler }
      : {}),
    maxAttempts: 1,
  };
  // Do not copy the supplied client's resolved retry strategy: it can already be
  // closed over a larger attempt count. Only its transport is an injection point.
  const mutationClient =
    suppliedClient !== undefined && !(suppliedClient instanceof S3Client)
      ? suppliedClient
      : new S3Client(mutationConfiguration);
  const target = (input: Target) => {
    if (
      input.bucket !== configuration.bucket ||
      typeof input.key !== "string" ||
      !KEY.test(input.key)
    )
      throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
    return { Bucket: configuration.bucket, Key: input.key };
  };
  const pinTarget = (bucket: string, scope: PinScope) => {
    if (
      bucket !== configuration.bucket ||
      !ID.test(scope.organizationId) ||
      !ID.test(scope.projectId) ||
      !ID.test(scope.restoreId)
    )
      throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
    return {
      Bucket: bucket,
      Key: `restore-pins/${scope.organizationId}/${scope.projectId}/${scope.restoreId}.zip`,
    };
  };
  const readExact = async (
    location: { Bucket: string; Key: string },
    input: { readonly bytes: number; readonly sha256: Uint8Array; readonly signal: AbortSignal },
  ) => {
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 269484032 ||
      !(input.sha256 instanceof Uint8Array) ||
      input.sha256.length !== 32
    )
      throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
    let body: Readable | undefined;
    try {
      const result = await client.send(new GetObjectCommand(location), {
        abortSignal: input.signal,
      });
      if (
        !(result.Body instanceof Readable) ||
        result.ContentLength !== input.bytes ||
        result.ContentType !== "application/zip"
      )
        throw new Error("archive mismatch");
      body = result.Body;
      const output = Buffer.allocUnsafe(input.bytes),
        digest = createHash("sha256");
      let count = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array) || count + chunk.byteLength > input.bytes)
          throw new Error("archive mismatch");
        output.set(chunk, count);
        count += chunk.byteLength;
        digest.update(chunk);
      }
      if (count !== input.bytes || !digest.digest().equals(Buffer.from(input.sha256)))
        throw new Error("archive mismatch");
      return output;
    } catch {
      throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
    } finally {
      body?.destroy();
    }
  };
  const verifyExact = async (
    location: { Bucket: string; Key: string },
    input: { readonly bytes: number; readonly sha256: Uint8Array; readonly signal: AbortSignal },
  ) => {
    let body: Readable | undefined;
    try {
      const result = await client.send(new GetObjectCommand(location), {
        abortSignal: input.signal,
      });
      if (
        !(result.Body instanceof Readable) ||
        result.ContentLength !== input.bytes ||
        result.ContentType !== "application/zip"
      )
        throw new Error("archive mismatch");
      body = result.Body;
      const digest = createHash("sha256");
      let count = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array) || count + chunk.length > input.bytes)
          throw new Error("archive mismatch");
        count += chunk.length;
        digest.update(chunk);
      }
      if (count !== input.bytes || !digest.digest().equals(Buffer.from(input.sha256)))
        throw new Error("archive mismatch");
      return "verified" as const;
    } catch (error) {
      if (isNotFound(error)) return "absent" as const;
      throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
    } finally {
      body?.destroy();
    }
  };
  const ensurePinLifecycle = async (
    location: { Bucket: string; Key: string },
    signal: AbortSignal,
  ) => {
    try {
      const lifecycle = await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: location.Bucket }),
        { abortSignal: signal },
      );
      if (Object.keys(lifecycle).some((key) => key !== "Rules" && key !== "$metadata"))
        throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
      assertRestorePinLifecycle(lifecycle.Rules, location.Key);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("name" in error) ||
        error.name !== "NoSuchLifecycleConfiguration"
      )
        throw new Error("RECOVERY_PIN_LIFECYCLE_UNAVAILABLE");
    }
  };
  return Object.freeze({
    /** Private restore reader, bound to the already verified Core archive length and digest. */
    async readVerified(
      input: Target & {
        readonly bytes: number;
        readonly sha256: Uint8Array;
        readonly signal: AbortSignal;
      },
    ): Promise<Uint8Array> {
      const location = target(input);
      if (input.key.startsWith("native-exports/")) await ensurePinLifecycle(location, input.signal);
      return readExact(location, input);
    },
    async pinVerified(input: {
      readonly bucket: string;
      readonly scope: PinScope;
      readonly archive: Uint8Array;
      readonly bytes: number;
      readonly sha256: Uint8Array;
      readonly signal: AbortSignal;
    }) {
      const location = pinTarget(input.bucket, input.scope);
      if (
        input.archive.length !== input.bytes ||
        input.bytes < 1 ||
        input.bytes > 269484032 ||
        input.sha256.length !== 32 ||
        !createHash("sha256").update(input.archive).digest().equals(Buffer.from(input.sha256))
      )
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      await ensurePinLifecycle(location, input.signal);
      try {
        await mutationClient.send(
          new PutObjectCommand({
            ...location,
            Body: input.archive,
            ContentType: "application/zip",
            ContentLength: input.bytes,
            IfNoneMatch: "*",
          }),
          { abortSignal: input.signal },
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("$metadata" in error) ||
          typeof error.$metadata !== "object" ||
          error.$metadata === null ||
          !("httpStatusCode" in error.$metadata) ||
          error.$metadata.httpStatusCode !== 412
        )
          throw new Error("RECOVERY_ARCHIVE_WRITE_FAILED");
      }
      if ((await verifyExact(location, input)) !== "verified")
        throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
      await ensurePinLifecycle(location, input.signal);
      return {
        bucket: location.Bucket,
        key: location.Key,
        bytes: input.bytes,
        sha256: input.sha256,
      };
    },
    readRestorePin(input: {
      readonly bucket: string;
      readonly scope: PinScope;
      readonly bytes: number;
      readonly sha256: Uint8Array;
      readonly signal: AbortSignal;
    }) {
      return readExact(pinTarget(input.bucket, input.scope), input);
    },
    async inspectRestorePin(input: {
      readonly bucket: string;
      readonly scope: PinScope;
      readonly bytes: number;
      readonly sha256: Uint8Array;
      readonly signal: AbortSignal;
      readonly allowTombstone: boolean;
    }): Promise<"verified" | "tombstoned"> {
      const location = pinTarget(input.bucket, input.scope);
      if (
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > 269484032 ||
        !(input.sha256 instanceof Uint8Array) ||
        input.sha256.length !== 32
      )
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      const classify = async (): Promise<"verified" | "tombstoned" | "missing"> => {
        let body: Readable | undefined;
        try {
          const result = await client.send(new GetObjectCommand(location), {
            abortSignal: input.signal,
          });
          if (!(result.Body instanceof Readable)) throw new Error("invalid body");
          body = result.Body;
          const isArchive =
            result.ContentType === "application/zip" && result.ContentLength === input.bytes;
          const isMarker =
            result.ContentType === TOMBSTONE_TYPE && result.ContentLength === TOMBSTONE.length;
          if (!isArchive && !isMarker) throw new Error("invalid pin");
          const expected = isArchive
            ? input.sha256
            : createHash("sha256").update(TOMBSTONE).digest();
          const limit = isArchive ? input.bytes : TOMBSTONE.length,
            digest = createHash("sha256");
          let count = 0;
          for await (const chunk of body) {
            if (!(chunk instanceof Uint8Array) || count + chunk.length > limit)
              throw new Error("invalid pin");
            count += chunk.length;
            digest.update(chunk);
          }
          if (count !== limit || !digest.digest().equals(Buffer.from(expected)))
            throw new Error("invalid pin");
          return isArchive ? "verified" : "tombstoned";
        } catch (error) {
          if (isNotFound(error)) return "missing";
          throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
        } finally {
          body?.destroy();
        }
      };
      await ensurePinLifecycle(location, input.signal);
      let result = await classify();
      if (result !== "missing") return result;
      if (!input.allowTombstone) throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      // The marker is never deleted. Its conditional creation competes atomically
      // with the one permitted archive PUT and fences any later arrival.
      try {
        await mutationClient.send(
          new PutObjectCommand({
            ...location,
            Body: TOMBSTONE,
            ContentType: TOMBSTONE_TYPE,
            ContentLength: TOMBSTONE.length,
            IfNoneMatch: "*",
          }),
          { abortSignal: input.signal },
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("$metadata" in error) ||
          typeof error.$metadata !== "object" ||
          error.$metadata === null ||
          !("httpStatusCode" in error.$metadata) ||
          error.$metadata.httpStatusCode !== 412
        )
          throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      }
      result = await classify();
      if (result === "missing") throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      await ensurePinLifecycle(location, input.signal);
      return result;
    },
    async inspectNativeExport(input: {
      readonly bucket: string;
      readonly key: string;
      readonly bytes: number;
      readonly sha256: Uint8Array;
      readonly signal: AbortSignal;
      readonly allowTombstone: boolean;
    }): Promise<"verified" | "tombstoned"> {
      const location = target(input);
      if (!input.key.startsWith("native-exports/"))
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      if (
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > 536870912 ||
        !(input.sha256 instanceof Uint8Array) ||
        input.sha256.length !== 32
      )
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      const classify = async (): Promise<"verified" | "tombstoned" | "missing"> => {
        let body: Readable | undefined;
        try {
          const result = await client.send(new GetObjectCommand(location), {
            abortSignal: input.signal,
          });
          if (!(result.Body instanceof Readable)) throw new Error("invalid body");
          body = result.Body;
          const isArchive =
            result.ContentType === "application/zip" && result.ContentLength === input.bytes;
          const isMarker =
            result.ContentType === EXPORT_TOMBSTONE_TYPE &&
            result.ContentLength === EXPORT_TOMBSTONE.length;
          if (!isArchive && !isMarker) throw new Error("invalid pin");
          const expected = isArchive
            ? input.sha256
            : createHash("sha256").update(EXPORT_TOMBSTONE).digest();
          const limit = isArchive ? input.bytes : EXPORT_TOMBSTONE.length,
            digest = createHash("sha256");
          let count = 0;
          for await (const chunk of body) {
            if (!(chunk instanceof Uint8Array) || count + chunk.length > limit)
              throw new Error("invalid pin");
            count += chunk.length;
            digest.update(chunk);
          }
          if (count !== limit || !digest.digest().equals(Buffer.from(expected)))
            throw new Error("invalid pin");
          return isArchive ? "verified" : "tombstoned";
        } catch (error) {
          if (isNotFound(error)) return "missing";
          throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
        } finally {
          body?.destroy();
        }
      };
      await ensurePinLifecycle(location, input.signal);
      let result = await classify();
      if (result !== "missing") return result;
      if (!input.allowTombstone) throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      // The marker is never deleted. Its conditional creation competes atomically
      // with the one permitted archive PUT and fences any later arrival.
      try {
        await mutationClient.send(
          new PutObjectCommand({
            ...location,
            Body: EXPORT_TOMBSTONE,
            ContentType: EXPORT_TOMBSTONE_TYPE,
            ContentLength: EXPORT_TOMBSTONE.length,
            IfNoneMatch: "*",
          }),
          { abortSignal: input.signal },
        );
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("$metadata" in error) ||
          typeof error.$metadata !== "object" ||
          error.$metadata === null ||
          !("httpStatusCode" in error.$metadata) ||
          error.$metadata.httpStatusCode !== 412
        )
          throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      }
      result = await classify();
      if (result === "missing") throw new Error("RECOVERY_PIN_OUTCOME_UNKNOWN");
      await ensurePinLifecycle(location, input.signal);
      return result;
    },
    async removeRestorePin(input: {
      readonly bucket: string;
      readonly scope: PinScope;
      readonly signal: AbortSignal;
    }) {
      const location = pinTarget(input.bucket, input.scope);
      try {
        try {
          const head = await client.send(new HeadObjectCommand(location), {
            abortSignal: input.signal,
          });
          if (head.ContentType !== "application/zip") throw new Error("pin is not an archive");
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        await mutationClient.send(new DeleteObjectCommand(location), { abortSignal: input.signal });
        try {
          await client.send(new HeadObjectCommand(location), { abortSignal: input.signal });
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        throw new Error("pin still exists");
      } catch {
        throw new Error("RECOVERY_ARCHIVE_DELETE_FAILED");
      }
    },
    async put(input: Parameters<RecoveryArchiveStore["put"]>[0]) {
      const location = target(input);
      let stream: ReturnType<typeof createReadStream> | undefined;
      if (input.key.startsWith("native-exports/")) await ensurePinLifecycle(location, input.signal);
      try {
        const file = await lstat(input.path);
        if (
          !file.isFile() ||
          !Number.isSafeInteger(input.archive.bytes) ||
          input.archive.bytes < 1 ||
          input.archive.bytes > 536870912 ||
          file.size !== input.archive.bytes
        )
          throw new Error("Invalid staged archive");
        stream = createReadStream(input.path);
        await mutationClient.send(
          new PutObjectCommand({
            ...location,
            Body: stream,
            ContentType: "application/zip",
            ContentLength: input.archive.bytes,
            IfNoneMatch: "*",
          }),
          { abortSignal: input.signal },
        );
      } catch {
        throw new Error("RECOVERY_ARCHIVE_WRITE_FAILED");
      } finally {
        stream?.destroy();
      }
    },
    async verify(
      input: Parameters<RecoveryArchiveStore["verify"]>[0],
    ): Promise<"verified" | "absent" | "different"> {
      const location = target(input);
      if (input.key.startsWith("native-exports/")) await ensurePinLifecycle(location, input.signal);
      let body: Readable | undefined;
      try {
        const value = await client.send(new GetObjectCommand(location), {
          abortSignal: input.signal,
        });
        if (!(value.Body instanceof Readable)) throw new Error("Invalid archive body");
        body = value.Body;
        if (value.ContentLength !== input.archive.bytes || value.ContentType !== "application/zip")
          return "different";
        let count = 0;
        const hash = createHash("sha256");
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Invalid archive bytes");
          count += chunk.byteLength;
          if (count > input.archive.bytes) return "different";
          hash.update(chunk);
        }
        return count === input.archive.bytes &&
          hash.digest().equals(Buffer.from(input.archive.sha256))
          ? "verified"
          : "different";
      } catch (error) {
        if (isNotFound(error)) return "absent";
        throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
      } finally {
        body?.destroy();
      }
    },
    async download(input: Target & { readonly archiveExpiresAt: string }) {
      const location = target(input),
        now = configuration.now(),
        expires = Date.parse(input.archiveExpiresAt);
      if (
        !Number.isFinite(now.getTime()) ||
        !Number.isFinite(expires) ||
        expires - now.getTime() < 86400000
      )
        throw new Error("RECOVERY_ARCHIVE_EXPIRED");
      if (input.key.startsWith("native-exports/"))
        await ensurePinLifecycle(location, AbortSignal.timeout(30_000));
      try {
        const url = await getSignedUrl(
          client,
          new GetObjectCommand({
            ...location,
            ResponseContentType: "application/zip",
            ResponseContentDisposition: 'attachment; filename="ohmyho-sql-export.zip"',
            ResponseCacheControl: "private, no-store",
          }),
          { expiresIn: 86400, signingDate: now },
        );
        return { url, expiresAt: new Date(now.getTime() + 86400000).toISOString() };
      } catch {
        throw new Error("RECOVERY_ARCHIVE_DOWNLOAD_FAILED");
      }
    },
    async removeVerifiedNativeExport(
      input: Target & {
        readonly bytes: number;
        readonly sha256: Uint8Array;
        readonly signal: AbortSignal;
      },
    ) {
      const location = target(input);
      if (!input.key.startsWith("native-exports/"))
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      await ensurePinLifecycle(location, input.signal);
      const existing = await verifyExact(location, input);
      if (existing === "absent") return;
      if (existing !== "verified") throw new Error("RECOVERY_ARCHIVE_READ_FAILED");
      await mutationClient.send(new DeleteObjectCommand(location), { abortSignal: input.signal });
      try {
        await client.send(new HeadObjectCommand(location), { abortSignal: input.signal });
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      throw new Error("RECOVERY_ARCHIVE_DELETE_FAILED");
    },
    async remove(input: Target & { readonly signal: AbortSignal }) {
      const location = target(input);
      if (input.key.startsWith("native-exports/"))
        throw new Error("RECOVERY_ARCHIVE_SCOPE_INVALID");
      try {
        await mutationClient.send(new DeleteObjectCommand(location), { abortSignal: input.signal });
        try {
          await client.send(new HeadObjectCommand(location), { abortSignal: input.signal });
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        throw new Error("Archive still exists");
      } catch {
        throw new Error("RECOVERY_ARCHIVE_DELETE_FAILED");
      }
    },
    close() {
      if (mutationClient !== client) mutationClient.destroy();
      client.destroy();
    },
  });
}
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 404
  );
}
