import { createHash } from "node:crypto";

import type { ObjectStore } from "@ohmyhost/build-broker";

/** The part of an R2 object the build runner reads. */
export interface R2ObjectHead {
  readonly version: string;
  readonly etag: string;
  readonly size: number;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

export interface R2ObjectBody extends R2ObjectHead {
  readonly body: ReadableStream<Uint8Array>;
}

export interface R2UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface R2MultipartUploadBinding {
  readonly uploadId: string;
  uploadPart(partNumber: number, body: Uint8Array): Promise<R2UploadedPart>;
  complete(parts: readonly R2UploadedPart[]): Promise<R2ObjectHead>;
  abort(): Promise<void>;
}

export interface R2PutOptions {
  /** Conditional headers; `if-none-match: *` makes the write create-only. */
  readonly onlyIf?: Headers;
  readonly httpMetadata?: Readonly<{ contentType: string }>;
  readonly customMetadata?: Readonly<Record<string, string>>;
}

/** The part of the R2 bucket binding `BUILD_OBJECTS` the build runner uses. */
export interface R2BucketBinding {
  head(key: string): Promise<R2ObjectHead | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  /** Resolves to null when `onlyIf` refused the write. */
  put(
    key: string,
    value: string | Uint8Array,
    options?: R2PutOptions,
  ): Promise<R2ObjectHead | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(
    key: string,
    options?: Omit<R2PutOptions, "onlyIf">,
  ): Promise<R2MultipartUploadBinding>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadBinding;
}

/** A rejection in the error protocol of the broker's `ObjectStore` port. */
export class ObjectStoreError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(`build_object_store:${code}`);
    this.name = "ObjectStoreError";
  }
}

export interface R2ObjectStoreDependencies {
  /** The bucket bindings by bucket name; a command that names another bucket is rejected. */
  readonly buckets: readonly Readonly<{ bucketName: string; bucket: R2BucketBinding }>[];
  readonly maximumObjectBytes: number;
}

/** Where the store remembers the one open multipart upload of an object key. */
export const MULTIPART_MARKER_PREFIX = "multipart-uploads/";
const MAXIMUM_MARKER_BYTES = 1024;
const R2_NO_SUCH_UPLOAD = "10024";

type UploadMarker = Readonly<{ state: "creating" }> | Readonly<{ state: "open"; uploadId: string }>;

type BucketCommands = {
  readonly [Method in keyof ObjectStore]: (
    command: Parameters<ObjectStore[Method]>[0],
  ) => ReturnType<ObjectStore[Method]>;
};

/**
 * The broker's `ObjectStore` over the R2 bucket bindings of every build region; each command is
 * routed to the binding of the bucket it names. R2 keeps only the current version of a key, so a
 * requested `versionId` that is not the current `version` names an object that is gone:
 * `headObject` answers null, a read is refused and `deleteObject` leaves the newer object alone.
 */
export function createR2ObjectStore(dependencies: R2ObjectStoreDependencies): ObjectStore {
  const { buckets, maximumObjectBytes } = dependencies;
  const stores = new Map(
    buckets.map(({ bucketName, bucket }) => [
      bucketName,
      bucketCommands(bucket, maximumObjectBytes),
    ]),
  );

  async function routed<T>(
    bucketOfCommand: string,
    run: (commands: BucketCommands) => Promise<T>,
  ): Promise<T> {
    const commands = stores.get(bucketOfCommand);
    if (commands === undefined) throw new ObjectStoreError("InvalidBucket", false);
    try {
      return await run(commands);
    } catch (error) {
      throw r2Failure(error);
    }
  }

  const store: ObjectStore = {
    listMultipartUploads: (command) =>
      routed(command.bucket, (commands) => commands.listMultipartUploads(command)),
    createMultipartUpload: (command) =>
      routed(command.bucket, (commands) => commands.createMultipartUpload(command)),
    uploadPart: (command) => routed(command.bucket, (commands) => commands.uploadPart(command)),
    completeMultipartUpload: (command) =>
      routed(command.bucket, (commands) => commands.completeMultipartUpload(command)),
    abortMultipartUpload: (command) =>
      routed(command.bucket, (commands) => commands.abortMultipartUpload(command)),
    headObject: (command) => routed(command.bucket, (commands) => commands.headObject(command)),
    verifyObjectSha256: (command) =>
      routed(command.bucket, (commands) => commands.verifyObjectSha256(command)),
    readObject: (command) => routed(command.bucket, (commands) => commands.readObject(command)),
    deleteObject: (command) => routed(command.bucket, (commands) => commands.deleteObject(command)),
  };
  return Object.freeze(store);
}

/** The object commands over one bucket binding; the caller has already routed by bucket name. */
function bucketCommands(bucket: R2BucketBinding, maximumObjectBytes: number): BucketCommands {
  async function readMarker(key: string): Promise<UploadMarker | null> {
    const object = await bucket.get(`${MULTIPART_MARKER_PREFIX}${key}`);
    if (object === null) return null;
    const { body } = await readBounded(object.body, MAXIMUM_MARKER_BYTES, true);
    const marker: unknown = JSON.parse(new TextDecoder().decode(body));
    if (marker !== null && typeof marker === "object") {
      if ("state" in marker && marker.state === "creating") return { state: "creating" };
      if (
        "state" in marker &&
        marker.state === "open" &&
        "uploadId" in marker &&
        typeof marker.uploadId === "string"
      ) {
        return { state: "open", uploadId: marker.uploadId };
      }
    }
    throw new ObjectStoreError("MalformedUploadMarker", false);
  }

  async function forgetUpload(key: string, uploadId: string): Promise<void> {
    const marker = await readMarker(key);
    if (marker?.state === "open" && marker.uploadId === uploadId) {
      await bucket.delete(`${MULTIPART_MARKER_PREFIX}${key}`);
    }
  }

  async function readExact(
    command: Readonly<{ key: string; versionId: string }>,
    maximumBytes: number,
    collect: boolean,
  ): Promise<Readonly<{ body: Uint8Array; byteLength: number; sha256: string }>> {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > maximumObjectBytes
    ) {
      throw new ObjectStoreError("InvalidRequest", false);
    }
    const object = await bucket.get(command.key);
    if (object === null || object.version !== command.versionId) {
      await object?.body.cancel();
      throw new ObjectStoreError("NoSuchVersion", false);
    }
    return readBounded(object.body, maximumBytes, collect);
  }

  const commands: BucketCommands = {
    listMultipartUploads: async (command) => {
      const marker = await readMarker(command.key);
      if (marker === null) return Object.freeze([]);
      // A create whose outcome was never recorded may have left an upload with an unknown id.
      if (marker.state === "creating") throw new ObjectStoreError("UploadStateUnknown", false);
      return Object.freeze([Object.freeze({ uploadId: marker.uploadId, key: command.key })]);
    },

    createMultipartUpload: async (command) => {
      const markerKey = `${MULTIPART_MARKER_PREFIX}${command.key}`;
      const claimed = await bucket.put(markerKey, JSON.stringify({ state: "creating" }), {
        onlyIf: new Headers({ "if-none-match": "*" }),
      });
      if (claimed === null) throw new ObjectStoreError("UploadAlreadyOpen", false);
      const upload = await bucket.createMultipartUpload(command.key, {
        httpMetadata: { contentType: command.contentType },
        customMetadata: { ...command.metadata },
      });
      await bucket.put(markerKey, JSON.stringify({ state: "open", uploadId: upload.uploadId }));
      return Object.freeze({ uploadId: upload.uploadId });
    },

    uploadPart: async (command) => {
      // The binding takes no part checksum, so the declared digest is verified before the write.
      if (sha256Hex(command.body) !== command.checksumSha256) {
        throw new ObjectStoreError("BadDigest", false);
      }
      const part = await bucket
        .resumeMultipartUpload(command.key, command.uploadId)
        .uploadPart(command.partNumber, command.body);
      return Object.freeze({ eTag: `"${part.etag}"` });
    },

    completeMultipartUpload: async (command) => {
      const object = await bucket.resumeMultipartUpload(command.key, command.uploadId).complete(
        command.parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.eTag.replace(/^"|"$/gu, ""),
        })),
      );
      await forgetUpload(command.key, command.uploadId);
      return Object.freeze({ versionId: object.version, eTag: `"${object.etag}"` });
    },

    abortMultipartUpload: async (command) => {
      let alreadyGone: ObjectStoreError | null = null;
      try {
        await bucket.resumeMultipartUpload(command.key, command.uploadId).abort();
      } catch (error) {
        alreadyGone = r2Failure(error);
        if (alreadyGone.code !== "NoSuchUpload") throw alreadyGone;
      }
      await forgetUpload(command.key, command.uploadId);
      if (alreadyGone !== null) throw alreadyGone;
    },

    headObject: async (command) => {
      const object = await bucket.head(command.key);
      if (
        object === null ||
        (command.versionId !== undefined && object.version !== command.versionId)
      ) {
        return null;
      }
      return Object.freeze({
        versionId: object.version,
        eTag: `"${object.etag}"`,
        byteLength: object.size,
        metadata: Object.freeze({ ...object.customMetadata }),
      });
    },

    verifyObjectSha256: async (command) => {
      const { byteLength, sha256 } = await readExact(command, maximumObjectBytes, false);
      return Object.freeze({ byteLength, sha256 });
    },

    readObject: async (command) => {
      const { body, sha256 } = await readExact(command, command.maximumBytes, true);
      return Object.freeze({ body, sha256 });
    },

    deleteObject: async (command) => {
      const object = await bucket.head(command.key);
      // Another version under the key is another object; the requested one is already gone.
      if (object === null || object.version !== command.versionId) return;
      await bucket.delete(command.key);
    },
  };
  return Object.freeze(commands);
}

/** Streams `body`, hashes it and refuses more than `maximumBytes`. */
export async function readBounded(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  collect: boolean,
): Promise<Readonly<{ body: Uint8Array; byteLength: number; sha256: string }>> {
  const reader = body.getReader();
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    byteLength += item.value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new ObjectStoreError("ResponseTooLarge", false);
    }
    hash.update(item.value);
    if (collect) chunks.push(item.value);
  }
  const collected = new Uint8Array(collect ? byteLength : 0);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ body: collected, byteLength, sha256: hash.digest("hex") });
}

function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** R2 reports `… (10024)` for a multipart upload that does not exist; other failures may be retried. */
function r2Failure(error: unknown): ObjectStoreError {
  if (error instanceof ObjectStoreError) return error;
  const code = /\((\d{5})\)\s*$/u.exec(error instanceof Error ? error.message : "")?.[1];
  if (code === R2_NO_SUCH_UPLOAD) return new ObjectStoreError("NoSuchUpload", false);
  return new ObjectStoreError(code === undefined ? "R2Error" : `R2Error${code}`, true);
}
