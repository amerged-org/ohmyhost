const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
// A listed object carries its key, HTTP metadata and custom metadata: a platform object lists with
// 650 to 750 bytes, so a page of 100 passes 64 KiB. 2 MiB leaves room for keys of 1,024 bytes and
// several KiB of metadata per object.
const MAXIMUM_OBJECT_PAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_BUCKET_BYTES = 1024 ** 3;
const OBJECTS_PER_PAGE = 100;
const DELETE_BATCH_SIZE = 25;
// One purge call may issue at most this many Cloudflare API requests. The budget stays below the subrequest limit of a
// single Worker invocation, so the rest of that invocation keeps its requests; the spare requests cover the bucket reads
// and the bucket deletion.
const PURGE_SUBREQUEST_BUDGET = 900;
// A purge round lists one page and deletes its objects: one listing plus one delete per object of a full page.
const PURGE_ROUND_SUBREQUESTS = 1 + OBJECTS_PER_PAGE;
const MAXIMUM_PURGE_ROUNDS = Math.floor(PURGE_SUBREQUEST_BUDGET / PURGE_ROUND_SUBREQUESTS);
const PURGE_TIME_BOX_MILLISECONDS = 100_000;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const ULID_PATTERN = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const BUCKET_NAME_PATTERN = /^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}-[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const BUCKET_ID_PATTERN = /^[0-9a-f]{32}$/u;

export interface R2BucketTarget {
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
  readonly storageClass: "Standard";
  readonly publicAccess: false;
}

export interface R2BucketReceipt extends R2BucketTarget {
  readonly bucketId: string;
  readonly observedAt: Date;
}

export type R2BucketObservation =
  | Readonly<{ state: "absent"; bucketName: string; jurisdiction: "eu" | "us" }>
  | Readonly<{ state: "found" } & R2BucketReceipt>;

export type R2BucketEnsureResult = Readonly<{
  outcome: "created" | "existing" | "recovered";
  receipt: R2BucketReceipt;
}>;

export type R2BucketDeleteResult = Readonly<{
  outcome: "absent" | "deleted";
  bucketName: string;
  objectCount: number;
  bytes: number;
}>;

export class CloudflareR2BucketInputError extends Error {
  public readonly code = "cloudflare_r2_bucket_input_invalid";
  public constructor() {
    super("Cloudflare R2 bucket input is invalid");
    this.name = "CloudflareR2BucketInputError";
  }
}

export class CloudflareR2BucketContractError extends Error {
  public readonly code = "cloudflare_r2_bucket_contract_invalid";
  public constructor() {
    super("Cloudflare R2 bucket response is invalid");
    this.name = "CloudflareR2BucketContractError";
  }
}

export class CloudflareR2BucketUncertainError extends Error {
  public readonly code = "cloudflare_r2_bucket_result_uncertain";
  public constructor() {
    super("Cloudflare R2 bucket result is uncertain");
    this.name = "CloudflareR2BucketUncertainError";
  }
}

export class CloudflareR2BucketRejectedError extends Error {
  public readonly code = "cloudflare_r2_bucket_request_rejected";
  public constructor() {
    super("Cloudflare R2 bucket request was rejected");
    this.name = "CloudflareR2BucketRejectedError";
  }
}

export class CloudflareR2BucketQuotaExceededError extends Error {
  public readonly code = "cloudflare_r2_bucket_quota_exceeded";
  public constructor() {
    super("Cloudflare R2 bucket exceeds the project deletion quota");
    this.name = "CloudflareR2BucketQuotaExceededError";
  }
}

export class CloudflareR2BucketReceiptMismatchError extends Error {
  public readonly code = "cloudflare_r2_bucket_receipt_mismatch";
  public constructor() {
    super("Cloudflare R2 bucket does not match the expected receipt");
    this.name = "CloudflareR2BucketReceiptMismatchError";
  }
}

export function projectR2BucketTarget(
  projectId: string,
  environmentId: string,
  jurisdiction: "eu" | "us",
): R2BucketTarget {
  if (jurisdiction !== "eu" && jurisdiction !== "us") throw new CloudflareR2BucketInputError();
  const canonicalProjectId = canonicalUlid(projectId);
  const canonicalEnvironmentId = canonicalUlid(environmentId);
  return Object.freeze({
    bucketName: `ohmyho-${canonicalProjectId}-${canonicalEnvironmentId}`,
    jurisdiction,
    storageClass: "Standard" as const,
    publicAccess: false as const,
  });
}

export function createCloudflareR2BucketProvider(dependencies: {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}) {
  validateDependencies(dependencies);
  const now = dependencies.now ?? (() => new Date());
  const bucketsApi = `https://api.cloudflare.com/client/v4/accounts/${dependencies.accountId}/r2/buckets`;
  const request = (url: string, init: RequestInit): Promise<Response> =>
    Reflect.apply(dependencies.fetch, globalThis, [url, init]);

  async function observeBucket(target: R2BucketTarget): Promise<R2BucketObservation> {
    validateTarget(target);
    const bucketUrl = `${bucketsApi}/${target.bucketName}`;
    const response = await sendRead(request, bucketUrl, target, dependencies.apiToken);
    if (response.status === 404) {
      await requireFailureEnvelope(response, 10006);
      return Object.freeze({
        state: "absent" as const,
        bucketName: target.bucketName,
        jurisdiction: target.jurisdiction,
      });
    }
    const bucketValue = await requireSuccessResult(response);
    parseBucket(bucketValue, target);

    const managedValue = await readSuccess(
      request,
      `${bucketUrl}/domains/managed`,
      target,
      dependencies.apiToken,
    );
    const bucketId = parsePrivateManagedDomain(managedValue);
    const customValue = await readSuccess(
      request,
      `${bucketUrl}/domains/custom`,
      target,
      dependencies.apiToken,
    );
    parseNoCustomDomains(customValue);

    return Object.freeze({
      state: "found" as const,
      ...target,
      bucketId,
      observedAt: canonicalNow(now),
    });
  }

  /**
   * `priorObservation` is the observation the caller made before it spent its create authorization. It is reused
   * as-is, so no read happens between that authorization and the create request.
   */
  async function ensureBucket(
    target: R2BucketTarget,
    priorObservation?: R2BucketObservation,
  ): Promise<R2BucketEnsureResult> {
    validateTarget(target);
    if (
      priorObservation !== undefined &&
      (priorObservation.bucketName !== target.bucketName ||
        priorObservation.jurisdiction !== target.jurisdiction)
    )
      throw new CloudflareR2BucketInputError();
    const before = priorObservation ?? (await observeBucket(target));
    if (before.state === "found") {
      return Object.freeze({ outcome: "existing" as const, receipt: receiptFrom(before) });
    }

    let response: Response;
    try {
      response = await request(bucketsApi, {
        method: "POST",
        headers: requestHeaders(dependencies.apiToken, target, true),
        body: JSON.stringify({
          name: target.bucketName,
          storageClass: target.storageClass,
          locationHint: target.jurisdiction === "us" ? "enam" : "weur",
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch {
      return recoverCreatedBucket(observeBucket, target);
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 409) {
      await discardBody(response);
      throw new CloudflareR2BucketRejectedError();
    }
    if (response.status !== 200) {
      await discardBody(response);
      return recoverCreatedBucket(observeBucket, target);
    }
    try {
      parseBucket(await requireSuccessResult(response), target);
    } catch {
      return recoverCreatedBucket(observeBucket, target);
    }
    const observed = await observeAfterMutation(observeBucket, target);
    if (observed.state !== "found") throw new CloudflareR2BucketUncertainError();
    return Object.freeze({ outcome: "created" as const, receipt: receiptFrom(observed) });
  }

  async function purgeAndDeleteBucket(expected: R2BucketReceipt): Promise<R2BucketDeleteResult> {
    validateReceipt(expected);
    const deadline = canonicalNow(now).getTime() + PURGE_TIME_BOX_MILLISECONDS;
    const target = targetFromReceipt(expected);
    const before = await observeBucket(target);
    if (before.state === "absent") {
      return Object.freeze({
        outcome: "absent" as const,
        bucketName: target.bucketName,
        objectCount: 0,
        bytes: 0,
      });
    }
    if (before.bucketId !== expected.bucketId) {
      throw new CloudflareR2BucketReceiptMismatchError();
    }
    const bucketUrl = `${bucketsApi}/${target.bucketName}`;
    // A round lists the first page and deletes its objects. A call starts no round and no delete batch once its 100-second
    // time box has passed, and it runs at most MAXIMUM_PURGE_ROUNDS rounds, which is its subrequest budget, even when the
    // clock does not advance. A bucket that still holds objects when the call ends is uncertain, and the caller's retry
    // starts a new call from the first page. Only an empty listing lets the bucket itself be deleted.
    const purged = new Map<string, R2InventoryObject>();
    let bytes = 0;
    let emptied = false;
    const withinTimeBox = (): boolean => canonicalNow(now).getTime() < deadline;
    for (let round = 0; round < MAXIMUM_PURGE_ROUNDS; round += 1) {
      if (!withinTimeBox()) break;
      const page = await listObjectPage(request, bucketUrl, target, dependencies.apiToken);
      if (page.length === 0) {
        emptied = true;
        break;
      }
      for (const object of page) {
        if (!purged.has(object.key)) {
          purged.set(object.key, object);
          bytes += object.size;
        }
      }
      if (!Number.isSafeInteger(bytes) || bytes > MAXIMUM_BUCKET_BYTES) {
        throw new CloudflareR2BucketQuotaExceededError();
      }
      await deleteObjectInventory(
        request,
        bucketUrl,
        target,
        dependencies.apiToken,
        page,
        withinTimeBox,
      );
    }
    if (!emptied) throw new CloudflareR2BucketUncertainError();
    const inventory = Object.freeze({ objects: Object.freeze([...purged.values()]), bytes });

    let response: Response;
    try {
      response = await request(bucketUrl, {
        method: "DELETE",
        headers: requestHeaders(dependencies.apiToken, target),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch {
      const deleted = await confirmDeletedBucket(observeBucket, target);
      return deletionResult(deleted, inventory);
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 404) {
      await discardBody(response);
      throw new CloudflareR2BucketRejectedError();
    }
    if (response.status === 200) {
      try {
        const result = await requireSuccessResult(response);
        if (!isRecord(result) || Object.keys(result).length !== 0) {
          throw new CloudflareR2BucketContractError();
        }
      } catch {
        const deleted = await confirmDeletedBucket(observeBucket, target);
        return deletionResult(deleted, inventory);
      }
    } else {
      await discardBody(response);
    }
    const deleted = await confirmDeletedBucket(observeBucket, target);
    return deletionResult(deleted, inventory);
  }

  return Object.freeze({ observeBucket, ensureBucket, purgeAndDeleteBucket });
}

async function recoverCreatedBucket(
  observe: (target: R2BucketTarget) => Promise<R2BucketObservation>,
  target: R2BucketTarget,
): Promise<R2BucketEnsureResult> {
  const observed = await observeAfterMutation(observe, target);
  if (observed.state !== "found") throw new CloudflareR2BucketUncertainError();
  return Object.freeze({ outcome: "recovered" as const, receipt: receiptFrom(observed) });
}

async function confirmDeletedBucket(
  observe: (target: R2BucketTarget) => Promise<R2BucketObservation>,
  target: R2BucketTarget,
): Promise<R2BucketDeleteResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const observed = await observe(target);
      if (observed.state === "absent") {
        return Object.freeze({
          outcome: "deleted" as const,
          bucketName: target.bucketName,
          objectCount: 0,
          bytes: 0,
        });
      }
    } catch {
      // A bounded readback retry may recover a transient transport failure.
    }
  }
  throw new CloudflareR2BucketUncertainError();
}

interface R2InventoryObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

function deletionResult(
  deleted: R2BucketDeleteResult,
  inventory: Readonly<{ objects: readonly R2InventoryObject[]; bytes: number }>,
): R2BucketDeleteResult {
  return Object.freeze({
    ...deleted,
    objectCount: inventory.objects.length,
    bytes: inventory.bytes,
  });
}

async function listObjectPage(
  request: (url: string, init: RequestInit) => Promise<Response>,
  bucketUrl: string,
  target: R2BucketTarget,
  apiToken: string,
): Promise<readonly R2InventoryObject[]> {
  const response = await sendRead(
    request,
    `${bucketUrl}/objects?per_page=${OBJECTS_PER_PAGE}`,
    target,
    apiToken,
  );
  // A rate-limited listing stops the call without a verdict. A Worker call cannot wait out Retry-After, so the objects stay
  // and the next call lists them again.
  if (response.status === 429) {
    await discardBody(response);
    throw new CloudflareR2BucketUncertainError();
  }
  const envelope = await requireSuccessEnvelope(response, MAXIMUM_OBJECT_PAGE_BYTES);
  const pageObjects = parseObjectPage(envelope["result"]);
  const pageInfo = parseObjectPageInfo(envelope["result_info"]);
  if (pageObjects.length > OBJECTS_PER_PAGE || pageInfo.perPage !== OBJECTS_PER_PAGE) {
    throw new CloudflareR2BucketContractError();
  }
  const keys = new Set<string>();
  for (const object of pageObjects) {
    if (keys.has(object.key)) throw new CloudflareR2BucketContractError();
    keys.add(object.key);
  }
  return Object.freeze(pageObjects);
}

async function deleteObjectInventory(
  request: (url: string, init: RequestInit) => Promise<Response>,
  bucketUrl: string,
  target: R2BucketTarget,
  apiToken: string,
  objects: readonly R2InventoryObject[],
  withinTimeBox: () => boolean,
): Promise<void> {
  for (let offset = 0; offset < objects.length; offset += DELETE_BATCH_SIZE) {
    // A batch starts only inside the time box, so the call overruns it by the requests already in flight.
    if (!withinTimeBox()) return;
    const batch = objects.slice(offset, offset + DELETE_BATCH_SIZE);
    await Promise.all(
      batch.map((object) => deleteOneObject(request, bucketUrl, target, apiToken, object.key)),
    );
  }
}

async function deleteOneObject(
  request: (url: string, init: RequestInit) => Promise<Response>,
  bucketUrl: string,
  target: R2BucketTarget,
  apiToken: string,
  key: string,
): Promise<void> {
  let response: Response;
  try {
    response = await request(`${bucketUrl}/objects/${encodeObjectKey(key)}`, {
      method: "DELETE",
      headers: requestHeaders(apiToken, target),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    return;
  }
  if (response.status === 404) {
    await requireFailureEnvelope(response, 10007);
    return;
  }
  // A rate-limited or failed delete leaves its object listed, so the next listing names it again.
  if (response.status === 429 || response.status >= 500) {
    await discardBody(response);
    return;
  }
  if (response.status >= 400) {
    await discardBody(response);
    throw new CloudflareR2BucketRejectedError();
  }
  const result = await requireSuccessResult(response);
  if (!isRecord(result) || Object.keys(result).join(",") !== "key" || result["key"] !== key) {
    throw new CloudflareR2BucketContractError();
  }
}

function parseObjectPage(value: unknown): readonly R2InventoryObject[] {
  if (!Array.isArray(value)) throw new CloudflareR2BucketContractError();
  return value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item["key"] !== "string" ||
      item["key"].length === 0 ||
      new TextEncoder().encode(item["key"]).byteLength > 1024 ||
      /\p{Cc}/u.test(item["key"]) ||
      typeof item["etag"] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(item["etag"]) ||
      !Number.isSafeInteger(item["size"]) ||
      Number(item["size"]) < 0
    ) {
      throw new CloudflareR2BucketContractError();
    }
    return Object.freeze({
      key: item["key"],
      size: Number(item["size"]),
      etag: item["etag"],
    });
  });
}

function parseObjectPageInfo(value: unknown): Readonly<{
  cursor: string | null;
  truncated: boolean;
  perPage: number;
}> {
  if (value === undefined) {
    return Object.freeze({ cursor: null, truncated: false, perPage: OBJECTS_PER_PAGE });
  }
  if (
    !isRecord(value) ||
    typeof value["is_truncated"] !== "boolean" ||
    !Number.isSafeInteger(value["per_page"]) ||
    Number(value["per_page"]) < 1 ||
    Number(value["per_page"]) > OBJECTS_PER_PAGE
  ) {
    throw new CloudflareR2BucketContractError();
  }
  const rawCursor = value["cursor"];
  const cursor =
    rawCursor === undefined || rawCursor === null || rawCursor === "" ? null : rawCursor;
  if (
    cursor !== null &&
    (typeof cursor !== "string" || cursor.length > 2_048 || /(?:\s|\p{Cc})/u.test(cursor))
  ) {
    throw new CloudflareR2BucketContractError();
  }
  if ((value["is_truncated"] && cursor === null) || (!value["is_truncated"] && cursor !== null)) {
    throw new CloudflareR2BucketContractError();
  }
  return Object.freeze({
    cursor,
    truncated: value["is_truncated"],
    perPage: Number(value["per_page"]),
  });
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

async function observeAfterMutation(
  observe: (target: R2BucketTarget) => Promise<R2BucketObservation>,
  target: R2BucketTarget,
): Promise<R2BucketObservation> {
  try {
    return await observe(target);
  } catch {
    throw new CloudflareR2BucketUncertainError();
  }
}

function receiptFrom(
  observation: Extract<R2BucketObservation, { state: "found" }>,
): R2BucketReceipt {
  return Object.freeze({
    bucketName: observation.bucketName,
    bucketId: observation.bucketId,
    jurisdiction: observation.jurisdiction,
    storageClass: observation.storageClass,
    publicAccess: observation.publicAccess,
    observedAt: new Date(observation.observedAt.getTime()),
  });
}

async function readSuccess(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  target: R2BucketTarget,
  apiToken: string,
): Promise<unknown> {
  const response = await sendRead(request, url, target, apiToken);
  return requireSuccessResult(response);
}

async function sendRead(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  target: R2BucketTarget,
  apiToken: string,
): Promise<Response> {
  try {
    return await request(url, {
      method: "GET",
      headers: requestHeaders(apiToken, target),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw new CloudflareR2BucketUncertainError();
  }
}

async function requireSuccessResult(response: Response): Promise<unknown> {
  const envelope = await requireSuccessEnvelope(response);
  return envelope["result"];
}

async function requireSuccessEnvelope(
  response: Response,
  maximumBytes = MAXIMUM_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  if (response.status >= 400 && response.status < 500) {
    await discardBody(response);
    throw new CloudflareR2BucketRejectedError();
  }
  if (response.status >= 500) {
    await discardBody(response);
    throw new CloudflareR2BucketUncertainError();
  }
  if (response.status !== 200) {
    await discardBody(response);
    throw new CloudflareR2BucketContractError();
  }
  const envelope = await readEnvelope(response, maximumBytes);
  if (
    envelope["success"] !== true ||
    !Array.isArray(envelope["errors"]) ||
    !Array.isArray(envelope["messages"]) ||
    !("result" in envelope)
  ) {
    throw new CloudflareR2BucketContractError();
  }
  return envelope;
}

async function requireFailureEnvelope(
  response: Response,
  expectedCode: 10006 | 10007,
): Promise<void> {
  const envelope = await readEnvelope(response);
  const errors = envelope["errors"];
  if (
    envelope["success"] !== false ||
    !Array.isArray(errors) ||
    errors.length !== 1 ||
    errors.some(
      (error) =>
        !isRecord(error) ||
        error["code"] !== expectedCode ||
        typeof error["message"] !== "string" ||
        error["message"].length === 0,
    ) ||
    !Array.isArray(envelope["messages"]) ||
    envelope["messages"].length !== 0 ||
    envelope["result"] !== null
  ) {
    throw new CloudflareR2BucketContractError();
  }
}

async function readEnvelope(
  response: Response,
  maximumBytes = MAXIMUM_RESPONSE_BYTES,
): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new CloudflareR2BucketContractError();
  }
  let body: Uint8Array;
  try {
    body = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new CloudflareR2BucketContractError();
  }
  if (body.byteLength > maximumBytes) throw new CloudflareR2BucketContractError();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new CloudflareR2BucketContractError();
  }
  if (!isRecord(value)) throw new CloudflareR2BucketContractError();
  return value;
}

function parseBucket(value: unknown, target: R2BucketTarget): void {
  if (
    !isRecord(value) ||
    value["name"] !== target.bucketName ||
    value["jurisdiction"] !== target.jurisdiction ||
    value["storage_class"] !== target.storageClass
  ) {
    throw new CloudflareR2BucketContractError();
  }
}

function parsePrivateManagedDomain(value: unknown): string {
  if (
    !isRecord(value) ||
    typeof value["bucketId"] !== "string" ||
    !BUCKET_ID_PATTERN.test(value["bucketId"]) ||
    value["domain"] !== `pub-${value["bucketId"]}.r2.dev` ||
    value["enabled"] !== false
  ) {
    throw new CloudflareR2BucketContractError();
  }
  return value["bucketId"];
}

function parseNoCustomDomains(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value["domains"]) || value["domains"].length !== 0) {
    throw new CloudflareR2BucketContractError();
  }
}

function requestHeaders(apiToken: string, target: R2BucketTarget, json = false): Headers {
  const headers = new Headers({
    authorization: `Bearer ${apiToken}`,
    "cf-r2-jurisdiction": target.jurisdiction,
  });
  if (json) headers.set("content-type", "application/json");
  return headers;
}

function validateDependencies(value: unknown): asserts value is {
  accountId: string;
  apiToken: string;
  fetch: typeof globalThis.fetch;
  now?: () => Date;
} {
  if (
    !isRecord(value) ||
    typeof value["accountId"] !== "string" ||
    !ACCOUNT_ID_PATTERN.test(value["accountId"]) ||
    typeof value["apiToken"] !== "string" ||
    value["apiToken"].length < 20 ||
    value["apiToken"].length > 2_048 ||
    /(?:\s|\p{Cc})/u.test(value["apiToken"]) ||
    typeof value["fetch"] !== "function" ||
    (value["now"] !== undefined && typeof value["now"] !== "function")
  ) {
    throw new CloudflareR2BucketInputError();
  }
}

function validateTarget(value: R2BucketTarget): void {
  if (
    !isRecord(value) ||
    typeof value["bucketName"] !== "string" ||
    !BUCKET_NAME_PATTERN.test(value["bucketName"]) ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "us") ||
    value["storageClass"] !== "Standard" ||
    value["publicAccess"] !== false
  ) {
    throw new CloudflareR2BucketInputError();
  }
}

function validateReceipt(value: R2BucketReceipt): void {
  validateTarget(value);
  if (
    typeof value.bucketId !== "string" ||
    !BUCKET_ID_PATTERN.test(value.bucketId) ||
    !(value.observedAt instanceof Date) ||
    !Number.isFinite(value.observedAt.getTime())
  ) {
    throw new CloudflareR2BucketInputError();
  }
}

function targetFromReceipt(receipt: R2BucketReceipt): R2BucketTarget {
  return Object.freeze({
    bucketName: receipt.bucketName,
    jurisdiction: receipt.jurisdiction,
    storageClass: receipt.storageClass,
    publicAccess: receipt.publicAccess,
  });
}

function canonicalUlid(value: string): string {
  if (typeof value !== "string") throw new CloudflareR2BucketInputError();
  const canonical = value.toLowerCase();
  if (!ULID_PATTERN.test(canonical)) throw new CloudflareR2BucketInputError();
  return canonical;
}

function canonicalNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CloudflareR2BucketContractError();
  }
  return new Date(value.getTime());
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request is rejected regardless of whether response cancellation succeeds.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
