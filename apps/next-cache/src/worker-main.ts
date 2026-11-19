import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CHUNK_BYTES = 1024 * 1024;
// Leave serialization headroom below Cloudflare's 32 MiB RPC message limit.
const VALUE_BYTES = 12 * 1024 * 1024;
const SCOPE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 8192;
const MAX_TAGS = 8192;
const MAX_BATCH = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
type CacheType = "cache" | "fetch" | "composable";
type Input = Record<string, unknown>;
type Meta = { generation: number; last_at: number; bytes: number; retired: number };
type Entry = { kind: "value" | "tombstone"; length: number; modified: number; generation: number };
type Tag = {
  tag: string;
  generation: number;
  revalidatedAt: number;
  stale: number | null;
  expire: number | null;
};
type CacheReply =
  | { kind: "missing" | "tombstone"; generation: number }
  | {
      kind: "value";
      generation: number;
      entryGeneration: number;
      lastModified: number;
      valueJson: string;
    };

interface ObjectStub {
  get(input: unknown): Promise<CacheReply>;
  put(input: unknown): Promise<{ kind: "stored"; generation: number; lastModified: number }>;
  delete(input: unknown): Promise<{ kind: "deleted"; generation: number }>;
  readTags(input: unknown): Promise<{ generation: number; tags: (Tag | null)[] }>;
  writeTags(input: unknown): Promise<{ generation: number; revalidatedAt: number }>;
  retire(): Promise<{ kind: "retired" }>;
}
interface CacheBindings {
  readonly NEXT_CACHE_OBJECT: {
    jurisdiction(region: "us" | "eu"): {
      getByName(name: string, options: { locationHint: "enam" | "weur" }): ObjectStub;
    };
  };
  readonly NEXT_CACHE_RETIREMENT_AUTHORITY: {
    authorizeRetirement(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  };
}
function invalid(): never {
  throw new TypeError("NEXT_CACHE_INVALID");
}
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const object = value as Input;
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid();
  return object;
}
function text(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    encoder.encode(value).byteLength > limit ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    )
  )
    return invalid();
  return value;
}
function generation(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function cacheType(value: unknown): CacheType {
  if (value !== "cache" && value !== "fetch" && value !== "composable") return invalid();
  return value;
}
function parseGet(raw: unknown) {
  const value = record(raw, ["key", "cacheType"]);
  return { key: text(value["key"], 2048), cacheType: cacheType(value["cacheType"]) };
}
function parsePut(raw: unknown) {
  const value = record(raw, ["key", "cacheType", "valueJson", "expectedGeneration"]);
  const json = value["valueJson"];
  if (typeof json !== "string" || encoder.encode(json).byteLength > VALUE_BYTES) return invalid();
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return invalid();
  } catch {
    return invalid();
  }
  return {
    key: text(value["key"], 2048),
    cacheType: cacheType(value["cacheType"]),
    valueJson: json,
    expectedGeneration: generation(value["expectedGeneration"]),
  };
}
function parseDelete(raw: unknown) {
  const value = record(raw, ["key", "expectedGeneration"]);
  return {
    key: text(value["key"], 2048),
    expectedGeneration: generation(value["expectedGeneration"]),
  };
}
function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_BATCH) return invalid();
  const tags = raw.map((tag: unknown) => text(tag, 512));
  if (new Set(tags).size !== tags.length) return invalid();
  return tags;
}
function parseTagWrites(raw: unknown) {
  const value = record(raw, ["tags"]),
    rawTags = value["tags"];
  if (!Array.isArray(rawTags) || rawTags.length < 1 || rawTags.length > MAX_BATCH) return invalid();
  const result = rawTags.map((rawTag: unknown) => {
    const entry = record(rawTag, ["tag"], ["stale", "expire"]);
    return {
      tag: text(entry["tag"], 512),
      stale: entry["stale"] === undefined ? null : generation(entry["stale"]),
      expire: entry["expire"] === undefined ? null : generation(entry["expire"]),
    };
  });
  if (new Set(result.map((entry) => entry.tag)).size !== result.length) return invalid();
  return result;
}
function cacheObject(bindings: CacheBindings, raw: unknown): ObjectStub {
  const scope = record(raw, [
    "organizationId",
    "projectId",
    "environmentId",
    "deploymentId",
    "region",
  ]);
  const region = scope["region"];
  if (region !== "us" && region !== "eu") return invalid();
  const ids = [
    scope["organizationId"],
    scope["projectId"],
    scope["environmentId"],
    scope["deploymentId"],
  ];
  if (ids.some((id) => typeof id !== "string" || !ULID.test(id))) return invalid();
  return bindings.NEXT_CACHE_OBJECT.jurisdiction(region).getByName([region, ...ids].join(":"), {
    locationHint: region === "eu" ? "weur" : "enam",
  });
}

/** The deployment binding fixes scope in provider-injected props. Inputs cannot select a tenant or deployment. */
export class NextCacheRuntime extends WorkerEntrypoint<CacheBindings, unknown> {
  #object(): ObjectStub {
    return cacheObject(this.env, this.ctx.props);
  }
  get(input: unknown) {
    return this.#object().get(input);
  }
  put(input: unknown) {
    return this.#object().put(input);
  }
  delete(input: unknown) {
    return this.#object().delete(input);
  }
  readTags(input: unknown) {
    return this.#object().readTags(input);
  }
  writeTags(input: unknown) {
    return this.#object().writeTags(input);
  }
}

/** Only lifecycle management receives this capability; Core must first prove irrevocable exact-scope retirement. */
export class NextCacheRetirementRuntime extends WorkerEntrypoint<CacheBindings, unknown> {
  async retire(input: unknown) {
    const scope = record(input, [
      "organizationId",
      "projectId",
      "environmentId",
      "deploymentId",
      "operationId",
      "cleanupRunId",
    ]);
    if (Object.values(scope).some((id) => typeof id !== "string" || !ULID.test(id)))
      return invalid();
    const decision = await this.env.NEXT_CACHE_RETIREMENT_AUTHORITY.authorizeRetirement(scope);
    if (decision === null) throw new Error("NEXT_CACHE_RETIREMENT_UNAUTHORIZED");
    const result = record(decision, ["region"]),
      region = result["region"];
    if (region !== "us" && region !== "eu") return invalid();
    return cacheObject(this.env, {
      organizationId: scope["organizationId"],
      projectId: scope["projectId"],
      environmentId: scope["environmentId"],
      deploymentId: scope["deploymentId"],
      region,
    }).retire();
  }
}

/** Strongly consistent storage for one immutable project/environment/deployment scope. */
export class NextCacheObject extends DurableObject<CacheBindings> {
  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: CacheBindings) {
    super(ctx, env);
    this.ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS cache_meta(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,last_at INTEGER NOT NULL,bytes INTEGER NOT NULL,retired INTEGER NOT NULL CHECK(retired IN(0,1)));
      INSERT OR IGNORE INTO cache_meta VALUES(1,0,0,0,0);
      CREATE TABLE IF NOT EXISTS cache_entries(cache_key TEXT NOT NULL,cache_type TEXT NOT NULL,kind TEXT NOT NULL,length INTEGER NOT NULL,modified INTEGER NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(cache_key,cache_type));
      CREATE TABLE IF NOT EXISTS cache_chunks(cache_key TEXT NOT NULL,cache_type TEXT NOT NULL,position INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(cache_key,cache_type,position));
      CREATE TABLE IF NOT EXISTS cache_tags(tag TEXT PRIMARY KEY,generation INTEGER NOT NULL,revalidated_at INTEGER NOT NULL,stale INTEGER,expire INTEGER);`);
  }
  #meta(): Meta {
    const rows = this.ctx.storage.sql
      .exec<Meta>("SELECT generation,last_at,bytes,retired FROM cache_meta WHERE id=1")
      .toArray();
    if (rows.length !== 1 || rows[0] === undefined) throw new Error("NEXT_CACHE_CORRUPT");
    return rows[0];
  }
  #entry(key: string, type: CacheType): Entry | null {
    return (
      this.ctx.storage.sql
        .exec<Entry>(
          "SELECT kind,length,modified,generation FROM cache_entries WHERE cache_key=? AND cache_type=?",
          key,
          type,
        )
        .toArray()[0] ?? null
    );
  }
  #advance(meta: Meta): number {
    const result = Math.max(Date.now(), meta.last_at + 1);
    if (!Number.isSafeInteger(result)) throw new Error("NEXT_CACHE_CLOCK_EXHAUSTED");
    return result;
  }
  #active(meta: Meta): void {
    if (meta.retired !== 0) throw new Error("NEXT_CACHE_RETIRED");
  }
  get(raw: unknown): CacheReply {
    const { key, cacheType: type } = parseGet(raw);
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta(),
        entry = this.#entry(key, type);
      this.#active(meta);
      if (entry === null) return { kind: "missing", generation: meta.generation };
      if (entry.kind === "tombstone") return { kind: "tombstone", generation: meta.generation };
      const rows = this.ctx.storage.sql
        .exec<{
          position: number;
          bytes: ArrayBuffer;
        }>(
          "SELECT position,bytes FROM cache_chunks WHERE cache_key=? AND cache_type=? ORDER BY position",
          key,
          type,
        )
        .toArray();
      const bytes = new Uint8Array(entry.length);
      let offset = 0;
      for (const [index, row] of rows.entries()) {
        const chunk = new Uint8Array(row.bytes);
        if (
          row.position !== index ||
          chunk.byteLength === 0 ||
          chunk.byteLength > CHUNK_BYTES ||
          offset + chunk.byteLength > bytes.byteLength
        )
          throw new Error("NEXT_CACHE_CORRUPT");
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== entry.length) throw new Error("NEXT_CACHE_CORRUPT");
      return {
        kind: "value",
        generation: meta.generation,
        entryGeneration: entry.generation,
        lastModified: entry.modified,
        valueJson: decoder.decode(bytes),
      };
    });
  }
  put(raw: unknown) {
    const input = parsePut(raw),
      bytes = encoder.encode(input.valueJson);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        meta = this.#meta(),
        old = this.#entry(input.key, input.cacheType);
      this.#active(meta);
      if (meta.generation !== input.expectedGeneration) throw new Error("NEXT_CACHE_STALE_WRITE");
      if (meta.bytes - (old?.length ?? 0) + bytes.byteLength > SCOPE_BYTES)
        throw new Error("NEXT_CACHE_CAPACITY");
      if (
        old === null &&
        (sql.exec<{ n: number }>("SELECT count(*) n FROM cache_entries").toArray()[0]?.n ??
          MAX_ENTRIES) >= MAX_ENTRIES
      )
        throw new Error("NEXT_CACHE_CAPACITY");
      const modified = this.#advance(meta);
      sql.exec(
        "DELETE FROM cache_chunks WHERE cache_key=? AND cache_type=?",
        input.key,
        input.cacheType,
      );
      for (let position = 0; position * CHUNK_BYTES < bytes.byteLength; position++) {
        const chunk = bytes.slice(position * CHUNK_BYTES, (position + 1) * CHUNK_BYTES);
        sql.exec(
          "INSERT INTO cache_chunks(cache_key,cache_type,position,bytes) VALUES(?,?,?,?)",
          input.key,
          input.cacheType,
          position,
          chunk.buffer,
        );
      }
      sql.exec(
        "INSERT INTO cache_entries(cache_key,cache_type,kind,length,modified,generation) VALUES(?,?,'value',?,?,?) ON CONFLICT(cache_key,cache_type) DO UPDATE SET kind='value',length=excluded.length,modified=excluded.modified,generation=excluded.generation",
        input.key,
        input.cacheType,
        bytes.byteLength,
        modified,
        meta.generation,
      );
      sql.exec(
        "UPDATE cache_meta SET bytes=?,last_at=? WHERE id=1",
        meta.bytes - (old?.length ?? 0) + bytes.byteLength,
        modified,
      );
      return { kind: "stored" as const, generation: meta.generation, lastModified: modified };
    });
  }
  delete(raw: unknown) {
    const input = parseDelete(raw);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        meta = this.#meta(),
        old = this.#entry(input.key, "cache");
      this.#active(meta);
      if (meta.generation !== input.expectedGeneration) throw new Error("NEXT_CACHE_STALE_WRITE");
      if (meta.generation >= Number.MAX_SAFE_INTEGER) throw new Error("NEXT_CACHE_CLOCK_EXHAUSTED");
      if (
        old === null &&
        (sql.exec<{ n: number }>("SELECT count(*) n FROM cache_entries").toArray()[0]?.n ??
          MAX_ENTRIES) >= MAX_ENTRIES
      )
        throw new Error("NEXT_CACHE_CAPACITY");
      const now = this.#advance(meta),
        next = meta.generation + 1;
      sql.exec("DELETE FROM cache_chunks WHERE cache_key=? AND cache_type='cache'", input.key);
      sql.exec(
        "INSERT INTO cache_entries(cache_key,cache_type,kind,length,modified,generation) VALUES(?,'cache','tombstone',0,?,?) ON CONFLICT(cache_key,cache_type) DO UPDATE SET kind='tombstone',length=0,modified=excluded.modified,generation=excluded.generation",
        input.key,
        now,
        next,
      );
      sql.exec(
        "UPDATE cache_meta SET bytes=?,last_at=?,generation=? WHERE id=1",
        meta.bytes - (old?.length ?? 0),
        now,
        next,
      );
      return { kind: "deleted" as const, generation: next };
    });
  }
  readTags(raw: unknown) {
    const input = record(raw, ["tags"]),
      tags = parseTags(input["tags"]);
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      this.#active(meta);
      const generation = meta.generation;
      return {
        generation,
        tags: tags.map(
          (tag) =>
            this.ctx.storage.sql
              .exec<Tag>(
                "SELECT tag,generation,revalidated_at AS revalidatedAt,stale,expire FROM cache_tags WHERE tag=?",
                tag,
              )
              .toArray()[0] ?? null,
        ),
      };
    });
  }
  writeTags(raw: unknown) {
    const tags = parseTagWrites(raw);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        meta = this.#meta();
      this.#active(meta);
      if (meta.generation >= Number.MAX_SAFE_INTEGER) throw new Error("NEXT_CACHE_CLOCK_EXHAUSTED");
      const existing = tags.filter(
        ({ tag }) => sql.exec("SELECT 1 FROM cache_tags WHERE tag=?", tag).toArray().length > 0,
      ).length;
      if (
        (sql.exec<{ n: number }>("SELECT count(*) n FROM cache_tags").toArray()[0]?.n ?? MAX_TAGS) +
          tags.length -
          existing >
        MAX_TAGS
      )
        throw new Error("NEXT_CACHE_CAPACITY");
      const now = this.#advance(meta),
        next = meta.generation + 1;
      for (const tag of tags)
        sql.exec(
          "INSERT INTO cache_tags(tag,generation,revalidated_at,stale,expire) VALUES(?,?,?,?,?) ON CONFLICT(tag) DO UPDATE SET generation=excluded.generation,revalidated_at=excluded.revalidated_at,stale=excluded.stale,expire=excluded.expire",
          tag.tag,
          next,
          now,
          tag.stale,
          tag.expire,
        );
      sql.exec("UPDATE cache_meta SET generation=?,last_at=? WHERE id=1", next, now);
      return { generation: next, revalidatedAt: now };
    });
  }
  retire() {
    return this.ctx.storage.transactionSync(() => {
      const meta = this.#meta();
      if (meta.retired === 1) return { kind: "retired" as const };
      if (meta.generation >= Number.MAX_SAFE_INTEGER) throw new Error("NEXT_CACHE_CLOCK_EXHAUSTED");
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM cache_chunks");
      sql.exec("DELETE FROM cache_entries");
      sql.exec("DELETE FROM cache_tags");
      sql.exec(
        "UPDATE cache_meta SET retired=1,bytes=0,generation=?,last_at=? WHERE id=1",
        meta.generation + 1,
        this.#advance(meta),
      );
      return { kind: "retired" as const };
    });
  }
}

// No public fetch handler: the named RPC entrypoint is the sole application-facing capability.
export default {};
