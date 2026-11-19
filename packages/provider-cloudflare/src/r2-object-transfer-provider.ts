import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { parseUlid } from "@ohmyhost/platform";

import type { R2BucketTarget } from "./r2-bucket-provider.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_TRANSFER_TTL_SECONDS = 300;
const MAXIMUM_OBJECT_BYTES = 1024 * 1024 * 1024;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const BUCKET_NAME_PATTERN = /^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}-[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const ACCESS_KEY_ID_PATTERN = /^[A-Za-z0-9]{16,128}$/u;
const OBJECT_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const encoder = new TextEncoder();
export const R2_ERASURE_CONCURRENCY = 4;

export interface R2PayloadErasureInput {
  readonly target: R2BucketTarget;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly dataEnvironmentId: string;
  readonly transferId: string;
  readonly objectKey: string;
}
export type R2PayloadErasureResult =
  | Readonly<{
      status: "erased";
      objectKey: string;
      transferId: string;
      markerSha256: Uint8Array;
      erasedAt: Date;
    }>
  | Readonly<{ status: "pending"; objectKey: string; transferId: string }>
  | Readonly<{ status: "failed"; objectKey: string; transferId: string; retryable: boolean }>;

export type R2ObjectTransferOperation = "DELETE" | "GET" | "PUT";

export interface R2ObjectTransferCapability {
  readonly operation: R2ObjectTransferOperation;
  readonly objectKey: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly expectedContentLength: number | null;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export type R2ObjectObservation =
  | Readonly<{ readonly state: "absent"; readonly objectKey: string }>
  | Readonly<{
      readonly state: "found";
      readonly objectKey: string;
      readonly contentLength: number;
      readonly contentType: string;
      readonly etag: string;
      readonly uploadedAt: Date;
    }>;

interface R2SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface TransferRequest {
  readonly target: R2BucketTarget;
  readonly objectKey: string;
  readonly operation: R2ObjectTransferOperation;
  readonly expiresInSeconds: number;
  readonly contentLength: number | null;
  readonly contentType: string | null;
}

export class CloudflareR2TransferInputError extends Error {
  public readonly code = "cloudflare_r2_transfer_input_invalid";
  public constructor() {
    super("Cloudflare R2 transfer input is invalid");
    this.name = "CloudflareR2TransferInputError";
  }
}

export class CloudflareR2TransferContractError extends Error {
  public readonly code = "cloudflare_r2_transfer_contract_invalid";
  public constructor() {
    super("Cloudflare R2 transfer response is invalid");
    this.name = "CloudflareR2TransferContractError";
  }
}

export class CloudflareR2TransferRejectedError extends Error {
  public readonly code = "cloudflare_r2_transfer_request_rejected";
  public constructor(
    public readonly providerCode: number | null = null,
    public readonly providerStatus: number | null = null,
  ) {
    super("Cloudflare R2 transfer request was rejected");
    this.name = "CloudflareR2TransferRejectedError";
  }
}

export class CloudflareR2TransferUncertainError extends Error {
  public readonly code = "cloudflare_r2_transfer_result_uncertain";
  public constructor() {
    super("Cloudflare R2 transfer result is uncertain");
    this.name = "CloudflareR2TransferUncertainError";
  }
}

export function createCloudflareR2ObjectTransferProvider(dependencies: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly parentAccessKeyId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}) {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());

  const createTransfer = async (value: unknown): Promise<R2ObjectTransferCapability> => {
    const request = parseTransferRequest(value);
    const issuedAt = canonicalNow(now);
    const credentials = await deriveR2SigningCredentials(
      dependencies.apiToken,
      dependencies.parentAccessKeyId,
    );
    const url = await signObjectRequest(dependencies.accountId, request, credentials, issuedAt);
    validateSignedUrl(url, dependencies.accountId, request);
    return Object.freeze({
      operation: request.operation,
      objectKey: request.objectKey,
      url,
      expiresAt: new Date(issuedAt.getTime() + request.expiresInSeconds * 1_000),
      expectedContentLength: request.contentLength,
      requiredHeaders: Object.freeze<Record<string, string>>(
        request.contentType === null
          ? {}
          : {
              "content-length": String(request.contentLength),
              "content-type": request.contentType,
              "if-none-match": "*",
            },
      ),
    });
  };
  const observeObject = async (
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<R2ObjectObservation> => {
    const request = parseObjectObservationRequest(value);
    const issuedAt = canonicalNow(now);
    const credentials = await deriveR2SigningCredentials(
      dependencies.apiToken,
      dependencies.parentAccessKeyId,
    );
    let response: Response;
    try {
      const url = await signHeadObjectRequest(
        dependencies.accountId,
        request.target,
        request.objectKey,
        credentials,
        issuedAt,
      );
      response = await Reflect.apply(dependencies.fetch, globalThis, [
        url,
        {
          method: "HEAD",
          redirect: "manual",
          signal:
            options.signal === undefined
              ? AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
              : AbortSignal.any([
                  options.signal,
                  AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
                ]),
        },
      ]);
    } catch {
      throw new CloudflareR2TransferUncertainError();
    }
    if (response.status === 404) {
      return Object.freeze({ state: "absent" as const, objectKey: request.objectKey });
    }
    if (response.status !== 200) throw new CloudflareR2TransferUncertainError();
    return parseHeadObject(response, request.objectKey);
  };
  const deleteObject = async (value: unknown) => {
    const request = parseObjectObservationRequest(value);
    const capability = await createTransfer({
      ...request,
      operation: "DELETE",
      expiresInSeconds: 60,
    });
    let response: Response;
    try {
      response = await Reflect.apply(dependencies.fetch, globalThis, [
        capability.url,
        {
          method: "DELETE",
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
        },
      ]);
    } catch {
      return confirmDeletedObject(observeObject, request);
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 404) {
      await discardBody(response);
      throw new CloudflareR2TransferRejectedError();
    }
    await discardBody(response);
    return confirmDeletedObject(observeObject, request);
  };
  const readObject = async (value: unknown) => {
    const request = parseObjectObservationRequest(value);
    const capability = await createTransfer({ ...request, operation: "GET", expiresInSeconds: 60 });
    // Only the wait for headers is bounded. The timer is cleared once fetch answers, so a body that streams for longer
    // than the bound is not cut off; a stalled body is bounded by the caller's own deadline.
    const headers = new AbortController();
    const headersTimeout = setTimeout(() => headers.abort(), REQUEST_TIMEOUT_MILLISECONDS);
    let response: Response;
    try {
      response = await Reflect.apply(dependencies.fetch, globalThis, [
        capability.url,
        {
          method: "GET",
          redirect: "manual",
          signal: headers.signal,
        },
      ]);
    } catch {
      throw new CloudflareR2TransferUncertainError();
    } finally {
      clearTimeout(headersTimeout);
    }
    if (response.status === 404) {
      await discardBody(response);
      return { state: "absent" as const, objectKey: request.objectKey };
    }
    if (response.status !== 200) {
      await discardBody(response);
      throw new CloudflareR2TransferUncertainError();
    }
    const observed = parseHeadObject(response, request.objectKey);
    if (observed.state !== "found") throw new CloudflareR2TransferContractError();
    if (response.body === null && observed.contentLength !== 0)
      throw new CloudflareR2TransferContractError();
    return {
      ...observed,
      body:
        response.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
    };
  };
  const deleteObjects = async (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new CloudflareR2TransferInputError();
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "objectKeys,target" ||
      !Array.isArray(record["objectKeys"]) ||
      record["objectKeys"].length === 0 ||
      record["objectKeys"].length > 1000 ||
      new Set(record["objectKeys"]).size !== record["objectKeys"].length
    )
      throw new CloudflareR2TransferInputError();
    const parsed = record["objectKeys"].map((objectKey) =>
      parseObjectObservationRequest({ target: record["target"], objectKey }),
    );
    const first = parsed[0];
    if (first === undefined) throw new CloudflareR2TransferInputError();
    const target = first.target;
    const credentials = await deriveR2SigningCredentials(
      dependencies.apiToken,
      dependencies.parentAccessKeyId,
    );
    const client = new S3Client({
      region: "auto",
      endpoint: r2Endpoint(dependencies.accountId, target),
      forcePathStyle: true,
      credentials: { ...credentials },
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: {
        async handle(request: {
          protocol: string;
          hostname: string;
          port?: number;
          path: string;
          method: string;
          headers: Record<string, string>;
          body?: BodyInit;
          query?: Record<string, string | string[] | null>;
        }) {
          const url = new URL(
            `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`,
          );
          for (const [name, value] of Object.entries(request.query ?? {})) {
            for (const part of Array.isArray(value) ? value : [value])
              url.searchParams.append(name, part ?? "");
          }
          const response = await Reflect.apply(dependencies.fetch, globalThis, [
            url.href,
            {
              method: request.method,
              headers: request.headers,
              body: request.body,
              redirect: "manual",
              signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
            },
          ]);
          return {
            response: {
              statusCode: response.status,
              headers: Object.fromEntries(response.headers),
              body: await boundedControlBody(response),
            },
          };
        },
      },
    });
    try {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: target.bucketName,
          Delete: { Objects: parsed.map((request) => ({ Key: request.objectKey })), Quiet: false },
        }),
      );
      const outcomes = [
        ...(result.Deleted ?? []).map((item) => ({
          objectKey: item.Key,
          status: "deleted" as const,
        })),
        ...(result.Errors ?? []).map((item) => ({
          objectKey: item.Key,
          status: "failed" as const,
          retryable:
            item.Code === "InternalError" ||
            item.Code === "SlowDown" ||
            item.Code === "ServiceUnavailable",
        })),
      ];
      if (
        outcomes.length !== parsed.length ||
        new Set(outcomes.map((item) => item.objectKey)).size !== parsed.length ||
        outcomes.some(
          (item) =>
            typeof item.objectKey !== "string" ||
            !parsed.some((request) => request.objectKey === item.objectKey),
        )
      )
        throw new CloudflareR2TransferContractError();
      return outcomes.map((item) => {
        if (typeof item.objectKey !== "string") throw new CloudflareR2TransferContractError();
        return { ...item, objectKey: item.objectKey };
      });
    } catch (error) {
      if (error instanceof CloudflareR2TransferContractError) throw error;
      throw new CloudflareR2TransferUncertainError();
    } finally {
      client.destroy();
    }
  };
  const erasePayloads = async (
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly R2PayloadErasureResult[]> => {
    const requests = parseErasureBatch(value);
    const first = requests[0];
    if (first === undefined) throw new CloudflareR2TransferInputError();
    const credentials = await deriveR2SigningCredentials(
      dependencies.apiToken,
      dependencies.parentAccessKeyId,
    );
    const client = createNativeR2Client(
      dependencies.accountId,
      first.target,
      credentials,
      dependencies.fetch,
      options.signal,
    );
    const results: R2PayloadErasureResult[] = new Array(requests.length);
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(R2_ERASURE_CONCURRENCY, requests.length) }, async () => {
          while (cursor < requests.length) {
            const index = cursor++;
            const request = requests[index];
            if (request === undefined) throw new CloudflareR2TransferContractError();
            const identity = { objectKey: request.objectKey, transferId: request.transferId };
            if (options.signal?.aborted) {
              results[index] = { ...identity, status: "pending" };
              continue;
            }
            try {
              const markerSha256 = await sha256(erasurePreimage(request));
              const metadata = erasureMetadata(request, markerSha256);
              // Replacing with a marker has no absence window, including after a lost earlier reply.
              try {
                await client.send(
                  new PutObjectCommand({
                    Bucket: request.target.bucketName,
                    Key: request.objectKey,
                    Body: new Uint8Array(),
                    ContentLength: 0,
                    ContentType: "application/octet-stream",
                    CacheControl: "no-store",
                    Metadata: metadata,
                  }),
                );
              } catch {
                // Only an exact HEAD proof can recover a lost PUT response.
              }
              if (options.signal?.aborted) throw new CloudflareR2TransferUncertainError();
              const headUrl = await signHeadObjectRequest(
                dependencies.accountId,
                request.target,
                request.objectKey,
                credentials,
                canonicalNow(now),
              );
              const response = await Reflect.apply(dependencies.fetch, globalThis, [
                headUrl,
                {
                  method: "HEAD",
                  redirect: "manual",
                  signal:
                    options.signal === undefined
                      ? AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
                      : AbortSignal.any([
                          options.signal,
                          AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
                        ]),
                },
              ]);
              if (response.status !== 200) throw new CloudflareR2TransferUncertainError();
              const observed = parseHeadObject(response, request.objectKey);
              if (
                observed.state !== "found" ||
                observed.contentLength !== 0 ||
                observed.contentType !== "application/octet-stream" ||
                observed.etag !== "d41d8cd98f00b204e9800998ecf8427e" ||
                Object.entries(metadata).some(
                  ([name, value]) => response.headers.get(`x-amz-meta-${name}`) !== value,
                )
              )
                throw new CloudflareR2TransferContractError();
              results[index] = {
                ...identity,
                status: "erased",
                markerSha256,
                erasedAt: canonicalNow(now),
              };
            } catch (error) {
              results[index] = options.signal?.aborted
                ? { ...identity, status: "pending" }
                : {
                    ...identity,
                    status: "failed",
                    retryable: !(
                      error instanceof CloudflareR2TransferContractError ||
                      error instanceof CloudflareR2TransferInputError
                    ),
                  };
            }
          }
        }),
      );
    } finally {
      client.destroy();
    }
    return Object.freeze(results);
  };
  const erasePayload = async (value: unknown, options: { readonly signal?: AbortSignal } = {}) => {
    const request = parseErasureInput(value);
    const results = await erasePayloads(
      {
        target: request.target,
        objects: [
          {
            organizationId: request.organizationId,
            projectId: request.projectId,
            environmentId: request.environmentId,
            dataEnvironmentId: request.dataEnvironmentId,
            transferId: request.transferId,
            objectKey: request.objectKey,
          },
        ],
      },
      options,
    );
    const result = results[0];
    if (result?.status === "erased") return result;
    if (result?.status === "failed" && !result.retryable)
      throw new CloudflareR2TransferContractError();
    throw new CloudflareR2TransferUncertainError();
  };
  return Object.freeze({
    createTransfer,
    observeObject,
    deleteObject,
    readObject,
    deleteObjects,
    erasePayload,
    erasePayloads,
  });
}

function parseErasureInput(value: unknown): R2PayloadErasureInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "target",
      "organizationId",
      "projectId",
      "environmentId",
      "dataEnvironmentId",
      "transferId",
      "objectKey",
    ])
  )
    throw new CloudflareR2TransferInputError();
  try {
    const target = parseTarget(value["target"]);
    const readId = (name: string) => {
      const identifier = value[name];
      if (typeof identifier !== "string") throw new CloudflareR2TransferInputError();
      return parseUlid(identifier);
    };
    const organizationId = readId("organizationId");
    const projectId = readId("projectId");
    const environmentId = readId("environmentId");
    const dataEnvironmentId = readId("dataEnvironmentId");
    const transferId = readId("transferId");
    if (target.bucketName !== `ohmyho-${projectId.toLowerCase()}-${environmentId.toLowerCase()}`)
      throw new CloudflareR2TransferInputError();
    return {
      target,
      organizationId,
      projectId,
      environmentId,
      dataEnvironmentId,
      transferId,
      objectKey: parseObjectKey(value["objectKey"]),
    };
  } catch {
    throw new CloudflareR2TransferInputError();
  }
}
function parseErasureBatch(value: unknown): readonly R2PayloadErasureInput[] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["target", "objects"]) ||
    !Array.isArray(value["objects"]) ||
    value["objects"].length < 1 ||
    value["objects"].length > 4000
  )
    throw new CloudflareR2TransferInputError();
  const objects = value["objects"].map((object) => {
    if (
      !isRecord(object) ||
      !hasExactKeys(object, [
        "organizationId",
        "projectId",
        "environmentId",
        "dataEnvironmentId",
        "transferId",
        "objectKey",
      ])
    )
      throw new CloudflareR2TransferInputError();
    return parseErasureInput({ ...object, target: value["target"] });
  });
  if (
    new Set(objects.map((object) => object.objectKey)).size !== objects.length ||
    new Set(objects.map((object) => object.transferId)).size !== objects.length
  )
    throw new CloudflareR2TransferInputError();
  return objects;
}
function erasurePreimage(input: R2PayloadErasureInput): string {
  return [
    "ohmyhost.r2-erasure/v1",
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.dataEnvironmentId,
    input.transferId,
    input.objectKey,
  ].join("\n");
}
function erasureMetadata(
  input: R2PayloadErasureInput,
  markerSha256: Uint8Array,
): Record<string, string> {
  return {
    "ohmyhost-deletion-barrier": "1",
    "ohmyhost-scope-sha256": hex(markerSha256),
    "ohmyhost-organization-id": input.organizationId,
    "ohmyhost-project-id": input.projectId,
    "ohmyhost-origin-environment-id": input.environmentId,
    "ohmyhost-data-environment-id": input.dataEnvironmentId,
    "ohmyhost-transfer-id": input.transferId,
  };
}
function createNativeR2Client(
  accountId: string,
  target: R2BucketTarget,
  credentials: R2SigningCredentials,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(accountId, target),
    forcePathStyle: true,
    credentials: { ...credentials },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      async handle(request: {
        protocol: string;
        hostname: string;
        port?: number;
        path: string;
        method: string;
        headers: Record<string, string>;
        body?: BodyInit;
        query?: Record<string, string | string[] | null>;
      }) {
        const url = new URL(
          `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}`,
        );
        for (const [name, value] of Object.entries(request.query ?? {}))
          for (const part of Array.isArray(value) ? value : [value])
            url.searchParams.append(name, part ?? "");
        const requestSignal =
          signal === undefined
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
            : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]);
        const response = await Reflect.apply(fetcher, globalThis, [
          url.href,
          {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: "manual",
            signal: requestSignal,
          },
        ]);
        return {
          response: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
            body: await boundedControlBody(response, requestSignal),
          },
        };
      },
    },
  });
}

async function boundedControlBody(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation = reader.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    while (true) {
      const next = await reader.read();
      if (signal?.aborted) throw new CloudflareR2TransferUncertainError();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new CloudflareR2TransferContractError();
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    try {
      await (cancellation ?? reader.cancel());
    } catch {
      /* The bounded read outcome remains authoritative. */
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function signHeadObjectRequest(
  accountId: string,
  target: R2BucketTarget,
  objectKey: string,
  credentials: R2SigningCredentials,
  signingDate: Date,
): Promise<string> {
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(accountId, target),
    forcePathStyle: true,
    credentials: { ...credentials },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    return await getSignedUrl(
      client,
      new HeadObjectCommand({ Bucket: target.bucketName, Key: objectKey }),
      { expiresIn: 60, signingDate },
    );
  } finally {
    client.destroy();
  }
}

async function deriveR2SigningCredentials(
  apiToken: string,
  parentAccessKeyId: string,
): Promise<R2SigningCredentials> {
  try {
    return Object.freeze({
      accessKeyId: parentAccessKeyId,
      secretAccessKey: hex(await sha256(apiToken)),
    });
  } catch {
    throw new CloudflareR2TransferContractError();
  }
}

async function confirmDeletedObject(
  observeObject: (value: unknown) => Promise<R2ObjectObservation>,
  request: Readonly<{ target: R2BucketTarget; objectKey: string }>,
) {
  let observed: R2ObjectObservation;
  try {
    observed = await observeObject(request);
  } catch {
    throw new CloudflareR2TransferUncertainError();
  }
  if (observed.state !== "absent") throw new CloudflareR2TransferUncertainError();
  return Object.freeze({ status: "deleted" as const, objectKey: request.objectKey });
}

async function signObjectRequest(
  accountId: string,
  request: TransferRequest,
  credentials: R2SigningCredentials,
  signingDate: Date,
): Promise<string> {
  const client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(accountId, request.target),
    forcePathStyle: true,
    credentials: { ...credentials },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    const command =
      request.operation === "GET"
        ? new GetObjectCommand({ Bucket: request.target.bucketName, Key: request.objectKey })
        : request.operation === "DELETE"
          ? new DeleteObjectCommand({ Bucket: request.target.bucketName, Key: request.objectKey })
          : new PutObjectCommand({
              Bucket: request.target.bucketName,
              Key: request.objectKey,
              ContentType: request.contentType ?? undefined,
              ContentLength: request.contentLength ?? undefined,
              IfNoneMatch: "*",
            });
    return await getSignedUrl(client, command, {
      expiresIn: request.expiresInSeconds,
      signingDate,
      ...(request.operation === "PUT"
        ? { signableHeaders: new Set(["content-length", "content-type", "if-none-match"]) }
        : {}),
    });
  } catch {
    throw new CloudflareR2TransferContractError();
  } finally {
    client.destroy();
  }
}

function parseTransferRequest(value: unknown): TransferRequest {
  if (!isRecord(value)) throw new CloudflareR2TransferInputError();
  const operation = value["operation"];
  const expectedKeys =
    operation === "GET" || operation === "DELETE"
      ? ["expiresInSeconds", "objectKey", "operation", "target"]
      : ["contentLength", "contentType", "expiresInSeconds", "objectKey", "operation", "target"];
  if (
    !hasExactKeys(value, expectedKeys) ||
    (operation !== "DELETE" && operation !== "GET" && operation !== "PUT")
  ) {
    throw new CloudflareR2TransferInputError();
  }
  const target = parseTarget(value["target"]);
  const objectKey = parseObjectKey(value["objectKey"]);
  const expiresInSeconds = value["expiresInSeconds"];
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    Number(expiresInSeconds) < 60 ||
    Number(expiresInSeconds) > MAXIMUM_TRANSFER_TTL_SECONDS
  ) {
    throw new CloudflareR2TransferInputError();
  }
  if (operation === "GET" || operation === "DELETE") {
    return Object.freeze({
      target,
      objectKey,
      operation,
      expiresInSeconds: Number(expiresInSeconds),
      contentLength: null,
      contentType: null,
    });
  }
  const contentLength = value["contentLength"];
  const contentType = value["contentType"];
  if (
    !Number.isSafeInteger(contentLength) ||
    Number(contentLength) < 0 ||
    Number(contentLength) > MAXIMUM_OBJECT_BYTES ||
    typeof contentType !== "string" ||
    !CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw new CloudflareR2TransferInputError();
  }
  return Object.freeze({
    target,
    objectKey,
    operation,
    expiresInSeconds: Number(expiresInSeconds),
    contentLength: Number(contentLength),
    contentType,
  });
}

function parseObjectObservationRequest(value: unknown): {
  readonly target: R2BucketTarget;
  readonly objectKey: string;
} {
  if (!isRecord(value) || !hasExactKeys(value, ["objectKey", "target"])) {
    throw new CloudflareR2TransferInputError();
  }
  return Object.freeze({
    target: parseTarget(value["target"]),
    objectKey: parseObjectKey(value["objectKey"]),
  });
}

function parseHeadObject(response: Response, objectKey: string): R2ObjectObservation {
  const contentLengthValue = response.headers.get("content-length");
  const contentLength =
    contentLengthValue !== null && /^[0-9]+$/u.test(contentLengthValue)
      ? Number(contentLengthValue)
      : NaN;
  const contentTypeValue = response.headers.get("content-type");
  const etagValue = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  const uploadedAt = lastModified === null ? null : new Date(lastModified);
  const etag = typeof etagValue === "string" ? etagValue.replace(/^"|"$/gu, "") : "";
  if (
    !Number.isSafeInteger(contentLength) ||
    Number(contentLength) < 0 ||
    Number(contentLength) > MAXIMUM_OBJECT_BYTES ||
    typeof contentTypeValue !== "string" ||
    !CONTENT_TYPE_PATTERN.test(contentTypeValue) ||
    !/^[0-9a-f]{32}(?:-[1-9][0-9]{0,4})?$/u.test(etag) ||
    uploadedAt === null ||
    !Number.isFinite(uploadedAt.getTime())
  ) {
    throw new CloudflareR2TransferContractError();
  }
  return Object.freeze({
    state: "found" as const,
    objectKey,
    contentLength: Number(contentLength),
    contentType: contentTypeValue,
    etag,
    uploadedAt: new Date(uploadedAt.getTime()),
  });
}

function parseTarget(value: unknown): R2BucketTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["bucketName", "jurisdiction", "publicAccess", "storageClass"]) ||
    typeof value["bucketName"] !== "string" ||
    !BUCKET_NAME_PATTERN.test(value["bucketName"]) ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "us") ||
    value["storageClass"] !== "Standard" ||
    value["publicAccess"] !== false
  ) {
    throw new CloudflareR2TransferInputError();
  }
  return Object.freeze({
    bucketName: value["bucketName"],
    jurisdiction: value["jurisdiction"],
    storageClass: "Standard" as const,
    publicAccess: false as const,
  });
}

function parseObjectKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength > (/^d\/[0-9A-HJKMNP-TV-Z]{26}\//u.test(value) ? 541 : 512)
  ) {
    throw new CloudflareR2TransferInputError();
  }
  const segments = value.split("/");
  if (segments.length < 1 || segments.some((segment) => !OBJECT_SEGMENT_PATTERN.test(segment))) {
    throw new CloudflareR2TransferInputError();
  }
  return value;
}

function validateSignedUrl(value: string, accountId: string, request: TransferRequest): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflareR2TransferContractError();
  }
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== r2Endpoint(accountId, request.target) ||
    decodeURIComponent(url.pathname) !== `/${request.target.bucketName}/${request.objectKey}` ||
    url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    url.searchParams.get("X-Amz-Expires") !== String(request.expiresInSeconds) ||
    url.searchParams.has("X-Amz-Security-Token") ||
    !/^[0-9a-f]{64}$/u.test(url.searchParams.get("X-Amz-Signature") ?? "") ||
    !signedHeaders.includes("host") ||
    (request.operation === "PUT" &&
      (!signedHeaders.includes("content-length") ||
        !signedHeaders.includes("content-type") ||
        !signedHeaders.includes("if-none-match")))
  ) {
    throw new CloudflareR2TransferContractError();
  }
}

function r2Endpoint(accountId: string, target: R2BucketTarget): string {
  return `https://${accountId}.${target.jurisdiction}.r2.cloudflarestorage.com`;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The typed outcome never depends on successful response cancellation.
  }
}

function validateDependencies(value: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly parentAccessKeyId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}): void {
  if (
    !ACCOUNT_ID_PATTERN.test(value.accountId) ||
    !validSecret(value.apiToken, 20, 1_024) ||
    !ACCESS_KEY_ID_PATTERN.test(value.parentAccessKeyId) ||
    typeof value.fetch !== "function" ||
    (value.now !== undefined && typeof value.now !== "function")
  ) {
    throw new CloudflareR2TransferInputError();
  }
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CloudflareR2TransferContractError();
  }
  return new Date(value.getTime());
}

function validSecret(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/(?:\s|\p{Cc})/u.test(value)
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
