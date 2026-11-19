import { CustomerRuntimeGatewayError } from "./errors.js";
import {
  configurationInvalid,
  exactRecord,
  fetchWithTimeout,
  invalidResponse,
  postGatewayJson,
  requireConfiguredUlid,
  validateGatewayConnection,
  throwGatewayRelayError,
  type GatewayConnection,
} from "./http.js";
import {
  decodeStorageBatch,
  readStorageBatchJson,
  type StorageReadResult,
  type StorageDeleteResult,
} from "./storage-batch-stream.js";
export type { StorageReadResult, StorageDeleteResult } from "./storage-batch-stream.js";

export interface StorageCapability {
  readonly operation: "GET" | "PUT";
  readonly objectKey: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly expectedContentLength: number | null;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface StorageUploadInput {
  readonly idempotencyKey: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** Server-only private files; use global fetch for gateway and signed-object transports. */
export function createPrivateStorageClient(
  configuration: GatewayConnection & {
    readonly projectId: string;
    readonly environmentId: string;
    /** Global fetch for short-lived signed object URLs; explicit transports remain test seams. */
    readonly capabilityFetch: (request: Request) => Promise<Response>;
  },
) {
  const connection = validateGatewayConnection(configuration);
  if (typeof configuration.capabilityFetch !== "function") {
    configurationInvalid("capabilityFetch is not a function; pass (request) => fetch(request)");
  }
  const capabilityFetch = configuration.capabilityFetch;
  const projectId = requireConfiguredUlid(
    configuration.projectId,
    "projectId",
    "OHMYHOST_PROJECT_ID",
  );
  const environmentId = requireConfiguredUlid(
    configuration.environmentId,
    "environmentId",
    "OHMYHOST_ENVIRONMENT_ID",
  );
  const authenticatedBody = Object.freeze({ projectId, environmentId });

  async function reserveUpload(
    input: Omit<StorageUploadInput, "bytes"> & { contentLength: number },
  ) {
    validateStorageMutation(input.idempotencyKey, input.objectKey);
    if (
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 0 ||
      input.contentLength > 1_073_741_824 ||
      !validContentType(input.contentType)
    ) {
      invalidRequest();
    }
    const response = await postGatewayJson(
      connection,
      "/v1/uploads",
      { ...authenticatedBody, ...input },
      8 * 1024,
      input.idempotencyKey,
    );
    if (response.status !== 200) throwStorageError(response.status, response.body, environmentId);
    const record = response.body as Record<string, unknown>;
    if (record?.["state"] === "completed") {
      const completed = exactRecord(response.body, ["state", "transfer_id"], response.status);
      return Object.freeze({
        state: "completed" as const,
        transferId: requireUlid(completed["transfer_id"], response.status),
      });
    }
    const ready = exactRecord(
      response.body,
      ["state", "transfer_id", "capability"],
      response.status,
    );
    if (ready["state"] !== "ready") invalidResponse(response.status);
    return Object.freeze({
      state: "ready" as const,
      transferId: requireUlid(ready["transfer_id"], response.status),
      capability: parseCapability(ready["capability"], "PUT", input.objectKey, response.status),
    });
  }

  async function completeUpload(transferId: string) {
    const response = await postGatewayJson(
      connection,
      "/v1/uploads/complete",
      {
        ...authenticatedBody,
        transferId: requireUlid(transferId),
      },
      8 * 1024,
    );
    if (response.status !== 200 && response.status !== 202) {
      throwStorageError(response.status, response.body, environmentId);
    }
    const record = exactRecord(response.body, ["state", "transfer_id"], response.status);
    if (record["state"] !== "completed" && record["state"] !== "pending")
      invalidResponse(response.status);
    return Object.freeze({
      state: record["state"],
      transferId: requireUlid(record["transfer_id"], response.status),
    });
  }

  async function createSignedRead(objectKey: string) {
    validateObjectKey(objectKey);
    const response = await postGatewayJson(
      connection,
      "/v1/downloads",
      {
        ...authenticatedBody,
        objectKey,
      },
      8 * 1024,
    );
    if (response.status !== 200) throwStorageError(response.status, response.body, environmentId);
    const record = exactRecord(response.body, ["state", "capability"], response.status);
    if (record["state"] !== "ready") invalidResponse(response.status);
    return parseCapability(record["capability"], "GET", objectKey, response.status);
  }

  async function deleteObject(input: { idempotencyKey: string; objectKey: string }) {
    validateStorageMutation(input.idempotencyKey, input.objectKey);
    const response = await postGatewayJson(
      connection,
      "/v1/deletions",
      { ...authenticatedBody, objectKey: input.objectKey },
      8 * 1024,
      input.idempotencyKey,
    );
    if (response.status !== 200) throwStorageError(response.status, response.body, environmentId);
    const record = exactRecord(response.body, ["state", "deletion_id"], response.status);
    if (record["state"] !== "completed") invalidResponse(response.status);
    return Object.freeze({
      state: "completed" as const,
      deletionId: requireUlid(record["deletion_id"], response.status),
    });
  }

  async function upload(input: StorageUploadInput) {
    const bytes = Uint8Array.from(input.bytes);
    const reservation = await reserveUpload({
      idempotencyKey: input.idempotencyKey,
      objectKey: input.objectKey,
      contentType: input.contentType,
      contentLength: bytes.byteLength,
    });
    if (reservation.state === "completed") return reservation;
    const uploaded = await fetchWithTimeout(
      capabilityFetch,
      new Request(reservation.capability.url, {
        method: "PUT",
        headers: reservation.capability.requiredHeaders,
        body: bytes,
      }),
      connection.timeoutMilliseconds,
    );
    // The create-only PUT answers 412 when an earlier attempt already stored these bytes under
    // this reservation; recording them is the retry's whole remaining work.
    if (uploaded.status === 412) return completeUpload(reservation.transferId);
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new CustomerRuntimeGatewayError(
        "storage_upload_rejected",
        uploaded.status,
        uploaded.status >= 500 || uploaded.status === 429,
        `the signed upload answered ${String(uploaded.status)}. For 5xx or 429, repeat upload() with the same idempotencyKey and objectKey.`,
      );
    }
    return completeUpload(reservation.transferId);
  }

  async function batchRequest(
    path: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    const serialized = JSON.stringify({ ...authenticatedBody, ...body });
    if (new TextEncoder().encode(serialized).byteLength > 4 * 1024 * 1024) invalidRequest();
    return fetchWithTimeout(
      connection.fetch,
      new Request(new URL(path, connection.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${connection.key}`, "content-type": "application/json" },
        body: serialized,
        ...(signal === undefined ? {} : { signal }),
      }),
      connection.timeoutMilliseconds,
    );
  }
  async function readMany(input: {
    readonly objectKeys: readonly string[];
  }): Promise<AsyncIterable<StorageReadResult>> {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).join(",") !== "objectKeys"
    )
      invalidRequest();
    const objectKeys = validateBatchKeys(input.objectKeys);
    const response = await batchRequest("/v1/downloads/batch", { objectKeys });
    if (response.status !== 200)
      throwStorageError(
        response.status,
        await readStorageBatchJson(response, connection.timeoutMilliseconds),
        environmentId,
      );
    return decodeStorageBatch(response, objectKeys, connection.timeoutMilliseconds);
  }
  async function deleteMany(input: {
    readonly objects: readonly { readonly objectKey: string; readonly idempotencyKey: string }[];
  }): Promise<readonly StorageDeleteResult[]> {
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).join(",") !== "objects" ||
      !Array.isArray(input.objects) ||
      input.objects.length === 0 ||
      input.objects.length > 4000
    )
      invalidRequest();
    const objects = input.objects.map((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Object.keys(item).sort().join(",") !== "idempotencyKey,objectKey" ||
        typeof item.objectKey !== "string" ||
        typeof item.idempotencyKey !== "string"
      )
        invalidRequest();
      validateStorageMutation(item.idempotencyKey, item.objectKey);
      return { objectKey: item.objectKey, idempotencyKey: item.idempotencyKey };
    });
    validateBatchKeys(objects.map((item) => item.objectKey));
    if (new Set(objects.map((item) => item.idempotencyKey)).size !== objects.length)
      invalidRequest();
    const controller = new AbortController();
    const deadline = Date.now() + connection.timeoutMilliseconds;
    const timer = setTimeout(() => controller.abort(), connection.timeoutMilliseconds);
    try {
      const response = await batchRequest("/v1/deletions/batch", { objects }, controller.signal);
      const value = await readStorageBatchJson(
        response,
        connection.timeoutMilliseconds,
        controller.signal,
      );
      if (response.status !== 200) throwStorageError(response.status, value, environmentId);
      const record = exactRecord(value, ["state", "results"], response.status);
      if (!Array.isArray(record["results"]) || record["results"].length !== objects.length)
        invalidResponse(response.status);
      const results = record["results"].map((value, index): StorageDeleteResult => {
        const candidate = value as Record<string, unknown>;
        const item = exactRecord(
          value,
          candidate?.["state"] === "completed"
            ? ["object_key", "state", "deletion_id"]
            : candidate?.["state"] === "pending"
              ? ["object_key", "state", "retry_at"]
              : ["object_key", "state", "code", "retryable"],
          response.status,
        );
        const requested = objects[index];
        if (requested === undefined || item["object_key"] !== requested.objectKey)
          invalidResponse(response.status);
        const objectKey = requested.objectKey;
        if (item["state"] === "completed")
          return Object.freeze({
            state: "completed",
            objectKey,
            deletionId: requireUlid(item["deletion_id"], response.status),
          });
        if (item["state"] === "pending") {
          return Object.freeze({
            state: "pending",
            objectKey,
            retryAt: requireRetryAt(item["retry_at"], response.status),
          });
        }
        if (
          item["state"] !== "failed" ||
          (item["code"] !== "object_not_found" && item["code"] !== "storage_gateway_unavailable") ||
          typeof item["retryable"] !== "boolean" ||
          (item["code"] === "object_not_found" && item["retryable"] !== false)
        )
          invalidResponse(response.status);
        return Object.freeze({
          state: "failed",
          objectKey,
          code: item["code"],
          retryable: item["retryable"],
        });
      });
      if (
        record["state"] !==
        (results.every((item) => item.state === "completed") ? "completed" : "partial")
      )
        invalidResponse(response.status);
      if (controller.signal.aborted || Date.now() >= deadline) {
        controller.abort();
        throw new CustomerRuntimeGatewayError("gateway_timeout", response.status, true);
      }
      return Object.freeze(results);
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    reserveUpload,
    completeUpload,
    createSignedRead,
    deleteObject,
    upload,
    readMany,
    deleteMany,
  });
}

function validateBatchKeys(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4000 ||
    new Set(value).size !== value.length
  )
    invalidRequest();
  for (const key of value) {
    if (typeof key !== "string") invalidRequest();
    validateObjectKey(key);
  }
  return Object.freeze(Array.from(value));
}

function parseCapability(
  value: unknown,
  operation: "GET" | "PUT",
  objectKey: string,
  status: number,
) {
  const record = exactRecord(
    value,
    ["operation", "objectKey", "url", "expiresAt", "expectedContentLength", "requiredHeaders"],
    status,
  );
  const headers = exactHeaders(record["requiredHeaders"], status);
  if (
    record["operation"] !== operation ||
    record["objectKey"] !== objectKey ||
    typeof record["url"] !== "string" ||
    !validSignedUrl(record["url"]) ||
    typeof record["expiresAt"] !== "string" ||
    !Number.isFinite(Date.parse(record["expiresAt"])) ||
    (record["expectedContentLength"] !== null &&
      (!Number.isSafeInteger(record["expectedContentLength"]) ||
        Number(record["expectedContentLength"]) < 0 ||
        Number(record["expectedContentLength"]) > 1_073_741_824))
  ) {
    invalidResponse(status);
  }
  return Object.freeze({
    operation,
    objectKey,
    url: record["url"],
    expiresAt: record["expiresAt"],
    expectedContentLength:
      record["expectedContentLength"] === null ? null : Number(record["expectedContentLength"]),
    requiredHeaders: headers,
  });
}

function exactHeaders(value: unknown, status: number): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse(status);
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length > 16 ||
    entries.some(
      ([name, header]) =>
        !/^[a-z0-9-]{1,64}$/u.test(name) ||
        /^(authorization|cookie|set-cookie)$/u.test(name) ||
        typeof header !== "string" ||
        header.length > 1_024 ||
        /[\r\n]/u.test(header),
    )
  ) {
    invalidResponse(status);
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function throwStorageError(status: number, body: unknown, environmentId: string): never {
  throwGatewayRelayError(status, body);
  const candidate = body as Record<string, unknown>;
  const record = exactRecord(
    body,
    candidate?.["code"] === "storage_delete_pending"
      ? ["code", "retry_at"]
      : candidate?.["code"] === "data_change_in_progress" ||
          candidate?.["code"] === "storage_binding_data_changed"
        ? ["code"]
        : typeof body === "object" && body !== null && "transfer_id" in body
          ? ["code", "transfer_id"]
          : ["code"],
    status,
  );
  const code = record["code"];
  if (status === 401 && code === "unauthorized") {
    throw new CustomerRuntimeGatewayError("unauthorized", status, false);
  }
  if (status === 404 && code === "object_not_found") {
    throw new CustomerRuntimeGatewayError("storage_object_not_found", status, false);
  }
  if (status === 409 && code === "upload_expired") {
    requireUlid(record["transfer_id"], status);
    throw new CustomerRuntimeGatewayError("storage_upload_expired", status, false);
  }
  if (status === 409 && code === "data_change_in_progress") {
    throw new CustomerRuntimeGatewayError(
      "data_change_in_progress",
      status,
      true,
      "a data change is running for this project; wait for that existing operation to finish, then repeat the same storage request with the same idempotency keys",
    );
  }
  if (status === 409 && code === "storage_binding_data_changed") {
    throw new CustomerRuntimeGatewayError(
      "storage_binding_data_changed",
      status,
      false,
      `the environment's data area changed while this request ran; read the current state for environment ${environmentId} and issue a new request`,
    );
  }
  if (status === 409 && code === "storage_delete_pending") {
    const retryAt = requireRetryAt(record["retry_at"], status);
    throw new CustomerRuntimeGatewayError(
      "storage_delete_pending",
      status,
      true,
      `a previously accepted upload or deletion is still settling; wait until ${retryAt}, then repeat deleteObject() with the same objectKey and idempotencyKey`,
    );
  }
  if (status === 409 && typeof code === "string") {
    throw new CustomerRuntimeGatewayError("storage_conflict", status, false);
  }
  if (status === 413 && typeof code === "string") {
    throw new CustomerRuntimeGatewayError("storage_quota_exceeded", status, false);
  }
  // The gateway's own input refusals are not protocol faults, and a transfer the provider rejected may succeed on retry.
  if (status === 400 && (code === "storage_gateway_input_invalid" || code === "invalid_request")) {
    throw new CustomerRuntimeGatewayError("gateway_request_invalid", status, false);
  }
  if (status === 502 && code === "cloudflare_r2_transfer_request_rejected") {
    throw new CustomerRuntimeGatewayError("gateway_unavailable", status, true);
  }
  return invalidResponse(status);
}

function requireRetryAt(value: unknown, status: number): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalidResponse(status);
  return value;
}

function validateStorageMutation(idempotencyKey: string, objectKey: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey)) invalidRequest();
  validateObjectKey(objectKey);
}

function validateObjectKey(value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (
    bytes < 1 ||
    bytes > 512 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    !value
      .split("/")
      .every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(segment))
  ) {
    invalidRequest();
  }
}

function validContentType(value: string): boolean {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(value);
}

function validSignedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      value.length <= 8_192
    );
  } catch {
    return false;
  }
}

function requireUlid(value: unknown, status: number | null = null): string {
  if (typeof value !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value))
    invalidResponse(status);
  return value;
}

function invalidRequest(): never {
  throw new CustomerRuntimeGatewayError("gateway_request_invalid", null, false);
}
