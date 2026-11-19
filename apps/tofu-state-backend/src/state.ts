export interface StateLock {
  readonly id: string;
  readonly info: Readonly<Record<string, unknown>>;
}

export interface StateRecord {
  readonly revision: number;
  readonly snapshotKey: string | null;
  readonly sha256: string | null;
  readonly bytes: number;
  readonly deleted: boolean;
  readonly lock: StateLock | null;
}

export interface StateMetadataStore {
  read(): Promise<StateRecord | null>;
  update<T>(
    change: (record: StateRecord) => Readonly<{ record: StateRecord; result: T }>,
  ): Promise<T>;
}

export interface StateSnapshotStore {
  /** Returns false only when the immutable key already exists. */
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
  read(key: string): Promise<Uint8Array | null>;
}

export const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024;
const STATE_NAME = /^[a-z0-9](?:[a-z0-9/_-]{0,158}[a-z0-9])?\.tfstate$/u;
const LOCK_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const empty = (): StateRecord => ({
  revision: 0,
  snapshotKey: null,
  sha256: null,
  bytes: 0,
  deleted: true,
  lock: null,
});

export function parseStateName(name: string): string {
  if (!STATE_NAME.test(name) || name.includes("//") || name.split("/").includes(".."))
    throw new TypeError("Invalid state name");
  return name;
}

export function createTofuStateService(input: {
  readonly name: string;
  readonly metadata: StateMetadataStore;
  readonly snapshots: StateSnapshotStore;
  readonly crypto: Pick<Crypto, "subtle">;
}) {
  const name = parseStateName(input.name);
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      try {
        switch (request.method) {
          case "GET":
            return await readState();
          case "LOCK":
            return await lockState(request);
          case "UNLOCK":
            return await unlockState(request);
          case "POST":
            return await writeState(request);
          case "DELETE":
            return await deleteState(request);
          default:
            return reply(405);
        }
      } catch {
        // Neither a state body, provider response nor a lock token belongs in diagnostics.
        return reply(503);
      }
    },
  });

  async function readState(): Promise<Response> {
    const record = (await input.metadata.read()) ?? empty();
    if (record.deleted || record.snapshotKey === null || record.sha256 === null) return reply(404);
    const body = await input.snapshots.read(record.snapshotKey);
    if (body === null || body.byteLength !== record.bytes || (await digest(body)) !== record.sha256)
      return reply(503);
    return reply(200, body, "application/json");
  }

  async function lockState(request: Request): Promise<Response> {
    const info = await lockInfo(request);
    if (info === null) return reply(400);
    const result = await input.metadata.update<{
      status: number;
      body: Readonly<Record<string, unknown>> | null;
    }>((record) => {
      if (record.lock !== null && record.lock.id !== info.id)
        return { record, result: { status: 423, body: record.lock.info } };
      if (record.lock !== null && JSON.stringify(record.lock.info) !== JSON.stringify(info.info))
        return { record, result: { status: 409, body: record.lock.info } };
      return { record: { ...record, lock: info }, result: { status: 200, body: info.info } };
    });
    return reply(result.status, JSON.stringify(result.body), "application/json");
  }

  async function unlockState(request: Request): Promise<Response> {
    const info = await lockInfo(request);
    if (info === null) return reply(400);
    const result = await input.metadata.update<{
      status: number;
      body: Readonly<Record<string, unknown>> | null;
    }>((record) => {
      if (record.lock === null) return { record, result: { status: 200, body: null } };
      if (record.lock.id !== info.id)
        return { record, result: { status: 409, body: record.lock.info } };
      return { record: { ...record, lock: null }, result: { status: 200, body: null } };
    });
    return result.body === null
      ? reply(result.status)
      : reply(result.status, JSON.stringify(result.body), "application/json");
  }

  async function writeState(request: Request): Promise<Response> {
    const lockId = new URL(request.url).searchParams.get("ID");
    if (lockId === null || !LOCK_ID.test(lockId)) return reply(409);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_STATE_BYTES) return reply(413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length < 2 || bytes.length > MAX_STATE_BYTES || !validState(bytes)) return reply(400);
    const sha256 = await digest(bytes);
    const current = (await input.metadata.read()) ?? empty();
    if (current.lock?.id !== lockId) return reply(409);
    if (
      !current.deleted &&
      current.snapshotKey !== null &&
      current.sha256 === sha256 &&
      current.bytes === bytes.length
    ) {
      const latest = await input.snapshots.read(current.snapshotKey);
      if (latest !== null && latest.length === bytes.length && (await digest(latest)) === sha256)
        return reply(200);
    }
    const revision = current.revision + 1;
    const snapshotKey = `snapshots/${name}/${String(revision).padStart(12, "0")}-${sha256}.tfstate`;
    await input.snapshots.putIfAbsent(snapshotKey, bytes);
    const verified = await input.snapshots.read(snapshotKey);
    if (
      verified === null ||
      verified.length !== bytes.length ||
      (await digest(verified)) !== sha256
    )
      return reply(503);
    const status = await input.metadata.update((record) => {
      if (record.lock?.id !== lockId || record.revision !== current.revision)
        return { record, result: 409 };
      return {
        record: { ...record, revision, snapshotKey, sha256, bytes: bytes.length, deleted: false },
        result: 200,
      };
    });
    return reply(status);
  }

  async function deleteState(request: Request): Promise<Response> {
    const lockId = new URL(request.url).searchParams.get("ID");
    if (lockId === null || !LOCK_ID.test(lockId)) return reply(409);
    const status = await input.metadata.update((record) => {
      if (record.lock?.id !== lockId) return { record, result: 409 };
      if (record.deleted) return { record, result: 200 };
      return { record: { ...record, revision: record.revision + 1, deleted: true }, result: 200 };
    });
    return reply(status);
  }

  async function digest(bytes: Uint8Array): Promise<string> {
    const stable = new Uint8Array(bytes.length);
    stable.set(bytes);
    const hash = new Uint8Array(await input.crypto.subtle.digest("SHA-256", stable.buffer));
    return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

async function lockInfo(request: Request): Promise<StateLock | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_LOCK_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_LOCK_BYTES) return null;
  let info: unknown;
  try {
    info = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (info === null || typeof info !== "object" || Array.isArray(info)) return null;
  const object = info as Record<string, unknown>;
  if (typeof object["ID"] !== "string" || !LOCK_ID.test(object["ID"])) return null;
  return { id: object["ID"], info: object };
}

function validState(bytes: Uint8Array): boolean {
  try {
    const state: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return (
      state !== null &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      Number.isSafeInteger((state as Record<string, unknown>)["version"]) &&
      Number.isSafeInteger((state as Record<string, unknown>)["serial"]) &&
      typeof (state as Record<string, unknown>)["lineage"] === "string"
    );
  } catch {
    return false;
  }
}

function reply(status: number, body?: string | Uint8Array, contentType?: string): Response {
  const responseBody =
    body === undefined || typeof body === "string" ? body : new Blob([Uint8Array.from(body)]);
  return new Response(responseBody, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(contentType ? { "content-type": contentType } : {}),
    },
  });
}
