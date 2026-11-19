import type {
  SourceArchiveCommit,
  SourceArchiveIdentity,
  SourceArchiveReceipt,
  SourceArchiveSink,
} from "@ohmyhost/platform";

import {
  SourceFetcherContractError,
  SourceFetcherTransportError,
  SourceFetcherUncertainError,
} from "./source-fetcher.js";

const PART_BYTES = 5 * 1024 * 1024;
const MAXIMUM_PARTS = 10_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ETAG_PATTERN = /^"[^"\r\n]{1,256}"$/u;
/** An R2 object version is 32 lowercase hexadecimal characters. */
const VERSION_PATTERN = /^[0-9a-f]{32}$/u;

export interface OperationScope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
}

interface ArchiveUploadReceipt {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly scope: OperationScope;
}

interface ArchivePartReceipt {
  readonly partNumber: number;
  readonly eTag: string;
  readonly checksumSha256: string;
}

export interface ArchiveObjectReceipt {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly eTag: string;
  readonly byteLength: number;
  readonly scope: OperationScope;
  readonly sourceSha256: string;
}

export interface BuildArchiveSink extends SourceArchiveSink {
  archiveReceipt(): ArchiveObjectReceipt;
}

/** `bucket` names the build objects bucket of the project's region on the calls that carry no receipt. */
export interface BuildRunnerBinding {
  beginArchive(input: Readonly<{ scope: OperationScope; bucket: string }>): Promise<unknown>;
  uploadArchivePart(
    input: Readonly<{
      upload: ArchiveUploadReceipt;
      partNumber: number;
      body: Uint8Array;
      checksumSha256: string;
    }>,
  ): Promise<unknown>;
  completeArchive(
    input: Readonly<{
      upload: ArchiveUploadReceipt;
      parts: readonly ArchivePartReceipt[];
      byteLength: number;
      sourceSha256: string;
    }>,
  ): Promise<unknown>;
  abortArchive(upload: ArchiveUploadReceipt): Promise<unknown>;
  observeArchive(
    input: Readonly<{
      scope: OperationScope;
      bucket: string;
      sourceSha256: string;
    }>,
  ): Promise<unknown>;
}

interface CreateBuildArchiveSinkInput {
  readonly binding: BuildRunnerBinding;
  /** The build objects bucket of the project's region; every receipt of the build runner must name it. */
  readonly bucket: string;
  readonly knownArchiveSha256: string | null;
  readonly expectedSourceSha256: string;
  readonly deadline: Date;
  readonly now: () => Date;
  readonly requestTimeoutMs: number;
  readonly crypto?: SubtleCrypto;
  /** Managed-source admission can retain its memory lease through timed-out binding work. */
  readonly underlyingOperation?: (operation: Promise<unknown>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isOpaque(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function operationScope(identity: SourceArchiveIdentity): OperationScope {
  return Object.freeze({
    projectId: identity.context.projectId,
    environmentId: identity.context.environmentId,
    operationId: identity.context.operationId,
  });
}

function sameScope(value: unknown, expected: OperationScope): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ["environmentId", "operationId", "projectId"]) &&
    value["projectId"] === expected.projectId &&
    value["environmentId"] === expected.environmentId &&
    value["operationId"] === expected.operationId
  );
}

function expectedKey(scope: OperationScope): string {
  return `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`;
}

function parseUpload(value: unknown, scope: OperationScope, bucket: string): ArchiveUploadReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["bucket", "key", "scope", "uploadId"]) ||
    value["bucket"] !== bucket ||
    value["key"] !== expectedKey(scope) ||
    typeof value["uploadId"] !== "string" ||
    !isOpaque(value["uploadId"]) ||
    !sameScope(value["scope"], scope)
  ) {
    throw new SourceFetcherContractError();
  }
  return value as unknown as ArchiveUploadReceipt;
}

function parsePart(value: unknown, partNumber: number, checksum: string): ArchivePartReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["checksumSha256", "eTag", "partNumber"]) ||
    value["partNumber"] !== partNumber ||
    value["checksumSha256"] !== checksum ||
    typeof value["eTag"] !== "string" ||
    !ETAG_PATTERN.test(value["eTag"])
  ) {
    throw new SourceFetcherContractError();
  }
  return value as unknown as ArchivePartReceipt;
}

function parseObject(
  value: unknown,
  scope: OperationScope,
  sourceSha256: string,
  bucket: string,
  expectedByteLength?: number,
): ArchiveObjectReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "bucket",
      "byteLength",
      "eTag",
      "key",
      "scope",
      "sourceSha256",
      "versionId",
    ]) ||
    value["bucket"] !== bucket ||
    value["key"] !== expectedKey(scope) ||
    typeof value["versionId"] !== "string" ||
    !VERSION_PATTERN.test(value["versionId"]) ||
    typeof value["eTag"] !== "string" ||
    !ETAG_PATTERN.test(value["eTag"]) ||
    !Number.isSafeInteger(value["byteLength"]) ||
    typeof value["byteLength"] !== "number" ||
    value["byteLength"] <= 0 ||
    value["sourceSha256"] !== sourceSha256 ||
    !sameScope(value["scope"], scope) ||
    (expectedByteLength !== undefined && value["byteLength"] !== expectedByteLength)
  ) {
    throw new SourceFetcherContractError();
  }
  return Object.freeze({
    bucket,
    key: value["key"],
    versionId: value["versionId"],
    eTag: value["eTag"],
    byteLength: value["byteLength"],
    scope: Object.freeze({ ...scope }),
    sourceSha256: value["sourceSha256"],
  }) as ArchiveObjectReceipt;
}

function archiveId(object: ArchiveObjectReceipt): string {
  return `r2-version:${object.bucket}/${object.key}#${object.versionId}`;
}

function sourceReceipt(
  identity: SourceArchiveIdentity,
  object: ArchiveObjectReceipt,
): SourceArchiveReceipt {
  return Object.freeze({
    identity,
    archiveId: archiveId(object),
    archiveFormat: "tar.gz" as const,
    byteLength: object.byteLength,
    sha256: object.sourceSha256,
  });
}

function mutationFailure(error: unknown): SourceFetcherUncertainError {
  if (error instanceof SourceFetcherUncertainError) return error;
  return new SourceFetcherUncertainError();
}

async function bounded<T>(
  input: CreateBuildArchiveSinkInput,
  mutation: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const remaining = input.deadline.getTime() - input.now().getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw mutation ? new SourceFetcherUncertainError() : new SourceFetcherTransportError();
  }
  const timeout = Math.max(1, Math.min(input.requestTimeoutMs, Math.floor(remaining)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const underlying = operation();
    input.underlyingOperation?.(underlying);
    return await Promise.race([
      underlying,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              mutation ? new SourceFetcherUncertainError() : new SourceFetcherTransportError(),
            ),
          timeout,
        );
      }),
    ]);
  } catch (error) {
    if (mutation) throw mutationFailure(error);
    if (error instanceof SourceFetcherTransportError) throw error;
    throw new SourceFetcherTransportError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function sha256(body: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(body.byteLength));
  owned.set(body);
  const digest = await subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createBuildArchiveSink(input: CreateBuildArchiveSinkInput): BuildArchiveSink {
  if (
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs <= 0 ||
    !DIGEST_PATTERN.test(input.expectedSourceSha256) ||
    (input.knownArchiveSha256 !== null && !DIGEST_PATTERN.test(input.knownArchiveSha256))
  ) {
    throw new SourceFetcherTransportError();
  }
  const subtle = input.crypto ?? globalThis.crypto.subtle;
  let durableObject: ArchiveObjectReceipt | undefined;
  return Object.freeze({
    async observe(identity: SourceArchiveIdentity): Promise<SourceArchiveReceipt | null> {
      const sourceSha256 = input.knownArchiveSha256 ?? input.expectedSourceSha256;
      const scope = operationScope(identity);
      const result = await bounded(input, false, () =>
        input.binding.observeArchive({ scope, bucket: input.bucket, sourceSha256 }),
      );
      if (result === null) return null;
      durableObject = parseObject(result, scope, sourceSha256, input.bucket);
      return sourceReceipt(identity, durableObject);
    },
    async begin(identity: SourceArchiveIdentity) {
      const scope = operationScope(identity);
      let upload: ArchiveUploadReceipt;
      try {
        upload = parseUpload(
          await bounded(input, true, () =>
            input.binding.beginArchive({ scope, bucket: input.bucket }),
          ),
          scope,
          input.bucket,
        );
      } catch (error) {
        throw mutationFailure(error);
      }
      const parts: ArchivePartReceipt[] = [];
      let pending = new Uint8Array(PART_BYTES);
      let pendingLength = 0;
      let byteLength = 0;

      const flush = async (): Promise<void> => {
        if (pendingLength === 0) return;
        const partNumber = parts.length + 1;
        if (partNumber > MAXIMUM_PARTS) throw new SourceFetcherUncertainError();
        const body = pendingLength === PART_BYTES ? pending : pending.slice(0, pendingLength);
        const checksumSha256 = await sha256(body, subtle);
        let receipt: ArchivePartReceipt;
        try {
          receipt = parsePart(
            await bounded(input, true, () =>
              input.binding.uploadArchivePart({
                upload,
                partNumber,
                body,
                checksumSha256,
              }),
            ),
            partNumber,
            checksumSha256,
          );
        } catch (error) {
          throw mutationFailure(error);
        }
        parts.push(receipt);
        pending = new Uint8Array(PART_BYTES);
        pendingLength = 0;
      };

      return Object.freeze({
        async write(chunk: Uint8Array): Promise<void> {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new SourceFetcherContractError();
          }
          byteLength += chunk.byteLength;
          let offset = 0;
          while (offset < chunk.byteLength) {
            const copied = Math.min(PART_BYTES - pendingLength, chunk.byteLength - offset);
            pending.set(chunk.subarray(offset, offset + copied), pendingLength);
            pendingLength += copied;
            offset += copied;
            if (pendingLength === PART_BYTES) await flush();
          }
        },
        async commit(metadata: SourceArchiveCommit): Promise<SourceArchiveReceipt> {
          if (
            metadata.archiveFormat !== "tar.gz" ||
            !DIGEST_PATTERN.test(metadata.sha256) ||
            metadata.byteLength !== byteLength ||
            byteLength <= 0
          ) {
            throw new SourceFetcherContractError();
          }
          if (metadata.sha256 !== input.expectedSourceSha256) {
            try {
              await bounded(input, true, () => input.binding.abortArchive(upload));
            } catch (error) {
              throw mutationFailure(error);
            }
            throw new SourceFetcherContractError();
          }
          await flush();
          let object: ArchiveObjectReceipt;
          try {
            object = parseObject(
              await bounded(input, true, () =>
                input.binding.completeArchive({
                  upload,
                  parts,
                  byteLength,
                  sourceSha256: metadata.sha256,
                }),
              ),
              scope,
              metadata.sha256,
              input.bucket,
              byteLength,
            );
          } catch (error) {
            throw mutationFailure(error);
          }
          durableObject = object;
          return sourceReceipt(identity, object);
        },
        async abort(): Promise<void> {
          await bounded(input, true, () => input.binding.abortArchive(upload));
        },
      });
    },
    archiveReceipt(): ArchiveObjectReceipt {
      if (durableObject === undefined) throw new SourceFetcherContractError();
      return durableObject;
    },
  });
}
